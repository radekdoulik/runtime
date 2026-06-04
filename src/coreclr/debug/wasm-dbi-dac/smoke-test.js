// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { performance } = require("perf_hooks");
const { pathToFileURL } = require("url");
const { spawnSync } = require("child_process");

const ExpectedAbiVersion = 1;
const ExpectedComponentMask = 0xf;
const ExpectedVersionBlobMagic = 0x42564457;
const ExpectedVersionBlobSize = 32;
const ExpectedProtocolBreakingChangeCounter = 12;
const HrIncompatibleProtocol = 0x8013134b | 0;
const ContractDescriptorMagic = 0x0043414443434e44n;
const TestDataMagic = 0x43445744;
const E_NOTIMPL = -2147467263;
const TransportMessage = "dbi-command:set-breakpoint";

// CorDebugPlatform value the wasm sidecar reports. Matches
// CORDB_PLATFORM_WASM32 = 14 in src/coreclr/pal/prebuilt/inc/cordebug.h.
const CORDB_PLATFORM_WASM32 = 14;

function fail(message) {
    throw new Error(message);
}

function resolvePath(filePath) {
    return path.resolve(process.cwd(), filePath);
}

function requireFile(filePath, description) {
    if (!fs.existsSync(filePath)) {
        fail(`${description} not found: ${filePath}`);
    }
}

function buildTypeSystemEnumerationApp(repoRoot) {
    const testDirectory = path.join(repoRoot, "artifacts", "wasm-dbi-dac-smoke", "type-system-enumeration");
    const assemblyName = "TypeSystemEnumeration";
    fs.rmSync(testDirectory, { recursive: true, force: true });
    fs.mkdirSync(testDirectory, { recursive: true });

    const projectPath = path.join(testDirectory, `${assemblyName}.csproj`);
    const programPath = path.join(testDirectory, "Program.cs");
    fs.writeFileSync(projectPath, `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <AssemblyName>${assemblyName}</AssemblyName>
    <TargetFramework>net11.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
  </PropertyGroup>
</Project>
`);

    fs.writeFileSync(programPath, `// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System;
using System.Reflection;

namespace TypeSystemEnumerationSmoke;

public static class Program
{
    public static void Main()
    {
        string[] assemblyNames =
        [
            "System.Console",
            "System.Linq",
            "System.Text.Json",
            "System.Text.RegularExpressions",
            "System.Net.Http",
            "System.Xml.XDocument",
            "System.Runtime.Numerics",
            "System.IO.Compression",
            "System.Collections.Concurrent",
            "System.Threading.Channels",
            "System.Diagnostics.TraceSource",
            "System.Private.Uri",
            "System.ComponentModel.Primitives",
        ];

        foreach (string assemblyName in assemblyNames)
        {
            try
            {
                Assembly.Load(new AssemblyName(assemblyName));
            }
            catch (Exception ex)
            {
                Console.WriteLine($"load-failed:{assemblyName}:{ex.GetType().Name}");
            }
        }

        Console.WriteLine("type-system-enumeration-smoke");
    }
}
`);

    const result = spawnSync(
        path.join(repoRoot, "dotnet.sh"),
        ["build", projectPath, "-c", "Debug", "-v:minimal"],
        { encoding: "utf8" });
    if (result.status !== 0) {
        process.stdout.write(result.stdout);
        process.stderr.write(result.stderr);
        fail(`failed to build type-system enumeration test app: ${result.status}`);
    }

    const outputMatch = [...result.stdout.matchAll(/-> (.*\.dll)$/gm)]
        .map(match => match[1])
        .find(outputPath => path.basename(outputPath) === `${assemblyName}.dll`);
    if (outputMatch !== undefined) {
        return outputMatch;
    }

    return path.join(testDirectory, "bin/Debug/net11.0", `${assemblyName}.dll`);
}

async function loadRuntime(runtimeJsPath, runtimeArguments) {
    const runtimeDirectory = path.dirname(runtimeJsPath);
    let source = fs.readFileSync(runtimeJsPath, "utf8");

    source = source.replaceAll("import.meta.url", JSON.stringify(pathToFileURL(runtimeJsPath).href));
    source = source.replaceAll(
        "dotnetLogger = {};",
        "dotnetLogger = { debug() {}, info() {}, warn() {}, error() {} };");
    source = source.replace(/if \(_isNode\) \{\s*selfRun\(\);\s*\}\s*$/m, "");

    let instance;
    const moduleFactory = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
    const moduleConfig = {
        noExitRuntime: true,
        arguments: runtimeArguments,
        locateFile: fileName => path.join(runtimeDirectory, fileName),
        print() {},
        printErr() {},
        instantiateWasm(imports, receiveInstance) {
            const wasmPath = path.join(runtimeDirectory, `${path.basename(runtimeJsPath, ".js")}.wasm`);
            WebAssembly.instantiate(fs.readFileSync(wasmPath), imports).then(({ instance: wasmInstance, module }) => {
                instance = wasmInstance;
                receiveInstance(wasmInstance, module);
            }).catch(error => {
                throw error;
            });

            return {};
        }
    };

    moduleFactory.selfRun(moduleConfig);

    return {
        module: await moduleConfig.ready,
        exports: instance.exports
    };
}

function loadDebugger(debuggerJsPath, configureImports) {
    const debuggerDirectory = path.dirname(debuggerJsPath);
    const source = fs.readFileSync(debuggerJsPath, "utf8");
    let instance;
    let context;

    return new Promise((resolve, reject) => {
        const moduleConfig = {
            noInitialRun: true,
            locateFile: fileName => path.join(debuggerDirectory, fileName),
            print() {},
            printErr() {},
            onAbort: reason => reject(new Error(String(reason))),
            onRuntimeInitialized: () => resolve({
                module: context.Module,
                exports: instance.exports
            })
        };

        context = {
            Module: moduleConfig,
            require,
            process,
            console,
            WebAssembly,
            __dirname: debuggerDirectory,
            __filename: debuggerJsPath,
            setTimeout,
            clearTimeout,
            TextDecoder,
            TextEncoder,
            URL,
            fetch,
            performance
        };

        moduleConfig.instantiateWasm = (imports, receiveInstance) => {
            configureImports(imports);
            const wasmPath = path.join(debuggerDirectory, `${path.basename(debuggerJsPath, ".js")}.wasm`);
            WebAssembly.instantiate(fs.readFileSync(wasmPath), imports).then(({ instance: wasmInstance, module }) => {
                instance = wasmInstance;
                receiveInstance(wasmInstance, module);
            }).catch(reject);

            return {};
        };

        try {
            vm.runInNewContext(source, context, { filename: debuggerJsPath });
        } catch (error) {
            reject(error);
        }
    });
}

function writeUint64(memory, address, value) {
    new DataView(memory.buffer).setBigUint64(address, BigInt(value), true);
}

function writeAscii(memory, address, value) {
    for (let index = 0; index < value.length; index++) {
        memory[address + index] = value.charCodeAt(index);
    }
}

function writeBytes(memory, address, bytes) {
    memory.set(bytes, address);
}

function readAscii(memory, address, byteCount) {
    let result = "";
    for (let index = 0; index < byteCount; index++) {
        result += String.fromCharCode(memory[address + index]);
    }

    return result;
}

function readDescriptor(memory, address) {
    const view = new DataView(memory.buffer, address, 32);
    return {
        magic: view.getBigUint64(0, true),
        flags: view.getUint32(8, true),
        descriptorSize: view.getUint32(12, true),
        descriptorAddress: view.getUint32(16, true),
        pointerDataCount: view.getUint32(20, true),
        pointerDataAddress: view.getUint32(28, true)
    };
}

function readNullTerminatedAscii(memory, address, byteCount) {
    let result = "";
    for (let index = 0; index < byteCount && memory[address + index] !== 0; index++) {
        result += String.fromCharCode(memory[address + index]);
    }

    return result;
}

function readBreakpointEnumeration(memory, address, capacity, slotSize) {
    const view = new DataView(memory.buffer);
    const slots = [];
    for (let index = 0; index < capacity; index++) {
        const slotAddress = address + 8 + (index * slotSize);
        slots.push({
            armed: memory[slotAddress] !== 0,
            isOneShot: memory[slotAddress + 1] !== 0,
            methodName: readNullTerminatedAscii(memory, slotAddress + 2, 64),
            methodToken: view.getUint32(slotAddress + 68, true),
            patchAddress: view.getUint32(slotAddress + 72, true),
            originalOpcode: view.getInt32(slotAddress + 76, true),
            patchActive: memory[slotAddress + 80] !== 0,
            hitCount: view.getUint32(slotAddress + 84, true)
        });
    }

    return {
        capacity: view.getUint32(address, true),
        activeCount: view.getUint32(address + 4, true),
        slots
    };
}

function readAppDomainEnumeration(memory, address) {
    const view = new DataView(memory.buffer);
    const count = view.getUint32(address + 4, true);
    const entries = [];
    for (let index = 0; index < count; index++) {
        const entryAddress = address + 8 + (index * 68);
        entries.push({
            id: view.getUint32(entryAddress, true),
            name: readNullTerminatedAscii(memory, entryAddress + 4, 64)
        });
    }

    return {
        capacity: view.getUint32(address, true),
        count,
        entries
    };
}

function readAssemblyEnumeration(memory, address) {
    const view = new DataView(memory.buffer);
    const count = view.getUint32(address + 4, true);
    const entries = [];
    for (let index = 0; index < count; index++) {
        const entryAddress = address + 8 + (index * 264);
        entries.push({
            address: view.getBigUint64(entryAddress, true),
            name: readNullTerminatedAscii(memory, entryAddress + 8, 128),
            path: readNullTerminatedAscii(memory, entryAddress + 136, 128)
        });
    }

    return {
        capacity: view.getUint32(address, true),
        count,
        entries
    };
}

function readModuleEnumeration(memory, address) {
    const view = new DataView(memory.buffer);
    const count = view.getUint32(address + 4, true);
    const entries = [];
    for (let index = 0; index < count; index++) {
        const entryAddress = address + 8 + (index * 144);
        entries.push({
            address: view.getBigUint64(entryAddress, true),
            assemblyAddress: view.getBigUint64(entryAddress + 8, true),
            name: readNullTerminatedAscii(memory, entryAddress + 16, 128)
        });
    }

    return {
        capacity: view.getUint32(address, true),
        count,
        entries
    };
}

function readPageCacheStats(memory, address) {
    const view = new DataView(memory.buffer, address, 24);
    return {
        epoch: view.getUint32(0, true),
        hits: view.getUint32(4, true),
        misses: view.getUint32(8, true),
        bypasses: view.getUint32(12, true),
        invalidations: view.getUint32(16, true)
    };
}

async function main() {
    const coreclrObjDirectory = resolvePath(process.argv[2] ?? "artifacts/obj/coreclr/browser.wasm.Debug");
    const repoRoot = path.resolve(__dirname, "../../../..");
    const runtimeJsPath = resolvePath(process.argv[3] ?? path.join(coreclrObjDirectory, "hosts/corerun/corerun.js"));
    const debuggerJsPath = resolvePath(process.argv[4] ?? path.join(coreclrObjDirectory, "debug/wasm-dbi-dac/coreclr-dbi-dac-tests.js"));
    const sharedFrameworkPath = path.join(repoRoot, "artifacts/bin/testhost/net11.0-browser-Debug-wasm/shared/Microsoft.NETCore.App/11.0.0");

    requireFile(runtimeJsPath, "runtime JS wrapper");
    requireFile(`${runtimeJsPath.slice(0, -3)}.wasm`, "runtime WASM module");
    requireFile(debuggerJsPath, "debugger JS wrapper");
    requireFile(`${debuggerJsPath.slice(0, -3)}.wasm`, "debugger WASM module");
    requireFile(sharedFrameworkPath, "browser-wasm testhost shared framework");

    const typeSystemAppPath = buildTypeSystemEnumerationApp(repoRoot);

    const runtime = await loadRuntime(runtimeJsPath, ["-c", sharedFrameworkPath, typeSystemAppPath]);
    const runtimeExports = runtime.exports;

    if (typeof runtimeExports.memory === "undefined" || typeof runtimeExports.memory.buffer === "undefined") {
        fail("runtime export 'memory' is missing or does not expose a buffer");
    }

    if (typeof runtimeExports.GetDotNetRuntimeContractDescriptor !== "function") {
        fail("runtime export GetDotNetRuntimeContractDescriptor is missing");
    }

    if (typeof runtimeExports.Getg_dacTable !== "function") {
        fail("runtime export Getg_dacTable is missing");
    }

    if (typeof runtimeExports.GetWasmDbiDacTestData !== "function") {
        fail("runtime export GetWasmDbiDacTestData is missing");
    }

    if (typeof runtimeExports.CoreClrWasmDebugReadDacGlobalsProbe !== "function") {
        fail("runtime export CoreClrWasmDebugReadDacGlobalsProbe is missing");
    }

    if (typeof runtimeExports.CoreClrWasmDebugCallInterpreterStepHelperProbe !== "function") {
        fail("runtime export CoreClrWasmDebugCallInterpreterStepHelperProbe is missing");
    }

    if (typeof runtimeExports.CoreClrWasmDebugGetMethodEnterEnabledQueryCount !== "function") {
        fail("runtime export CoreClrWasmDebugGetMethodEnterEnabledQueryCount is missing");
    }

    if (typeof runtimeExports.CoreClrWasmDebugReceiveCommand !== "function" ||
        typeof runtimeExports.CoreClrWasmDebugGetLastCommandLength !== "function" ||
        typeof runtimeExports.CoreClrWasmDebugCopyLastCommand !== "function") {
        fail("runtime debug bridge exports are missing");
    }

    let debuggerModule;
    let debuggerExports;
    const hostImports = {};

    // Re-fetch typed-array views on every host callback. WebAssembly.Memory
    // can grow at any time (stack expansion, heap allocation, etc.); after
    // growth, any cached Uint8Array becomes detached and access throws
    // "memory access out of bounds". Reading `.buffer` from a live wasm
    // `memory` export always returns the current backing ArrayBuffer.
    //
    // The helpers reference late-bound `let`s by name. If a host import
    // somehow fires before the runtime/debugger module finishes binding
    // (e.g., a future change that invokes an import from WASM init), the
    // descriptive throw is friendlier than a raw "cannot read .memory of
    // undefined". Our sidecar does not call any imports during module init
    // today, so these checks are a forward-compatibility guard.
    const getRuntimeHeap = () => {
        if (typeof runtimeExports === "undefined" || !runtimeExports.memory) {
            fail("getRuntimeHeap called before runtimeExports.memory was bound");
        }
        return new Uint8Array(runtimeExports.memory.buffer);
    };
    const getDebuggerHeap = () => {
        if (typeof debuggerExports === "undefined" || !debuggerExports.memory) {
            fail("getDebuggerHeap called before debuggerExports.memory was bound");
        }
        return new Uint8Array(debuggerExports.memory.buffer);
    };

    hostImports.read_target_memory = (targetAddressArg, debuggerAddressArg, byteCountArg) => {
        const targetAddress = targetAddressArg >>> 0;
        const debuggerAddress = debuggerAddressArg >>> 0;
        const byteCount = byteCountArg >>> 0;

        const runtimeHeap = getRuntimeHeap();
        const debuggerHeap = getDebuggerHeap();
        if (targetAddress + byteCount > runtimeHeap.length ||
            debuggerAddress + byteCount > debuggerHeap.length) {
            return -1;
        }

        debuggerHeap.set(runtimeHeap.subarray(targetAddress, targetAddress + byteCount), debuggerAddress);
        return 0;
    };

    hostImports.get_symbol_address = (baseAddressArg, symbolNameAddressArg, symbolNameLengthArg, addressOutAddressArg) => {
        const symbolNameAddress = symbolNameAddressArg >>> 0;
        const symbolNameLength = symbolNameLengthArg >>> 0;
        const addressOutAddress = addressOutAddressArg >>> 0;
        const debuggerHeap = getDebuggerHeap();
        if (symbolNameAddress + symbolNameLength > debuggerHeap.length ||
            addressOutAddress + 8 > debuggerHeap.length) {
            return -1;
        }

        const symbolName = new TextDecoder().decode(debuggerHeap.subarray(symbolNameAddress, symbolNameAddress + symbolNameLength));
        const symbolAddress =
            symbolName === "DotNetRuntimeContractDescriptor" ? runtimeExports.GetDotNetRuntimeContractDescriptor() >>> 0 :
            symbolName === "g_dacTable" ? runtimeExports.Getg_dacTable() >>> 0 :
            symbolName === "WasmDbiDacTestData" ? runtimeExports.GetWasmDbiDacTestData() >>> 0 :
            symbolName === "g_wasmDebugBreakpoints" ? runtimeExports.Getg_wasmDebugBreakpoints() >>> 0 :
            symbolName === "g_wasmDebugLastIpcException" ? runtimeExports.Getg_wasmDebugLastIpcException() >>> 0 :
            symbolName === "g_wasmDebugLastIpcExceptionValid" ? runtimeExports.Getg_wasmDebugLastIpcExceptionValid() >>> 0 :
            symbolName === "g_wasmDebugLastIpcStepComplete" ? runtimeExports.Getg_wasmDebugLastIpcStepComplete() >>> 0 :
            symbolName === "g_wasmDebugLastIpcStepCompleteValid" ? runtimeExports.Getg_wasmDebugLastIpcStepCompleteValid() >>> 0 :
            symbolName === "g_wasmDebugLastIpcModuleLoad" ? runtimeExports.Getg_wasmDebugLastIpcModuleLoad() >>> 0 :
            symbolName === "g_wasmDebugLastIpcModuleLoadValid" ? runtimeExports.Getg_wasmDebugLastIpcModuleLoadValid() >>> 0 :
            symbolName === "g_wasmDebugLastLocalsRecord" ? runtimeExports.Getg_wasmDebugLastLocalsRecord() >>> 0 :
            0;

        if (symbolAddress === 0) {
            return -1;
        }

        writeUint64(debuggerHeap, addressOutAddress, symbolAddress >>> 0);
        return 0;
    };

    hostImports.get_target_module_base = (imageNameAddressArg, imageNameCharCountArg, addressOutAddressArg) => {
        const addressOutAddress = addressOutAddressArg >>> 0;
        const debuggerHeap = getDebuggerHeap();
        if (addressOutAddress + 8 > debuggerHeap.length) {
            return -1;
        }

        writeUint64(debuggerHeap, addressOutAddress, 1);
        return 0;
    };
    hostImports.send_ipc_to_runtime = (messageAddressArg, messageLengthArg) => {
        const messageAddress = messageAddressArg >>> 0;
        const messageLength = messageLengthArg >>> 0;
        const debuggerHeapForRead = getDebuggerHeap();
        if (messageAddress + messageLength > debuggerHeapForRead.length) {
            return -1;
        }

        const savedRuntimeStack = runtime.exports.stackSave();
        const runtimeMessageAddress = runtime.exports.stackAlloc(messageLength);
        // Re-fetch both heaps after the stackAlloc above: it can grow the
        // runtime's linear memory and detach any prior view.
        getRuntimeHeap().set(getDebuggerHeap().subarray(messageAddress, messageAddress + messageLength), runtimeMessageAddress);
        const receiveResult = runtimeExports.CoreClrWasmDebugReceiveCommand(runtimeMessageAddress, messageLength);
        runtime.exports.stackRestore(savedRuntimeStack);
        if (receiveResult !== 0) {
            return receiveResult;
        }

        const runtimeCommandLength = runtimeExports.CoreClrWasmDebugGetLastCommandLength();
        const savedCopyStack = runtime.exports.stackSave();
        const runtimeCopyAddress = runtime.exports.stackAlloc(runtimeCommandLength);
        const copyResult = runtimeExports.CoreClrWasmDebugCopyLastCommand(runtimeCopyAddress, runtimeCommandLength);
        const message = copyResult === 0 ? readAscii(getRuntimeHeap(), runtimeCopyAddress, runtimeCommandLength) : "";
        runtime.exports.stackRestore(savedCopyStack);
        if (copyResult !== 0) {
            return copyResult;
        }

        const event = new TextEncoder().encode(`runtime-event:${message}`);
        const savedStack = debuggerExports.stackSave();
        const eventAddress = debuggerExports.stackAlloc(event.length);
        writeBytes(getDebuggerHeap(), eventAddress, event);
        const result = debuggerModule._coreclr_wasm_dbi_dac_receive_runtime_event(eventAddress, event.length);
        debuggerExports.stackRestore(savedStack);
        return result;
    };
    hostImports.submit_continue_request = (requestBytesAddressArg, requestBytesLengthArg) => {
        const requestBytesAddress = requestBytesAddressArg >>> 0;
        const requestBytesLength = requestBytesLengthArg >>> 0;
        const debuggerHeapForRead = getDebuggerHeap();
        if (requestBytesAddress + requestBytesLength > debuggerHeapForRead.length ||
            typeof runtimeExports.CoreClrWasmDebugSubmitContinueRequest !== "function") {
            return -1;
        }

        const requestBytes = debuggerHeapForRead.slice(requestBytesAddress, requestBytesAddress + requestBytesLength);
        const savedRuntimeStack = runtime.exports.stackSave();
        try {
            const runtimeRequestAddress = runtime.exports.stackAlloc(requestBytesLength);
            getRuntimeHeap().set(requestBytes, runtimeRequestAddress);
            return runtimeExports.CoreClrWasmDebugSubmitContinueRequest(runtimeRequestAddress, requestBytesLength) | 0;
        } finally {
            runtime.exports.stackRestore(savedRuntimeStack);
        }
    };
    hostImports.submit_step_into_request = (requestBytesAddressArg, requestBytesLengthArg) => {
        const requestBytesAddress = requestBytesAddressArg >>> 0;
        const requestBytesLength = requestBytesLengthArg >>> 0;
        const debuggerHeapForRead = getDebuggerHeap();
        if (requestBytesAddress + requestBytesLength > debuggerHeapForRead.length ||
            typeof runtimeExports.CoreClrWasmDebugSubmitStepIntoRequest !== "function") {
            return -1;
        }

        const requestBytes = debuggerHeapForRead.slice(requestBytesAddress, requestBytesAddress + requestBytesLength);
        const savedRuntimeStack = runtime.exports.stackSave();
        try {
            const runtimeRequestAddress = runtime.exports.stackAlloc(requestBytesLength);
            getRuntimeHeap().set(requestBytes, runtimeRequestAddress);
            return runtimeExports.CoreClrWasmDebugSubmitStepIntoRequest(runtimeRequestAddress, requestBytesLength) | 0;
        } finally {
            runtime.exports.stackRestore(savedRuntimeStack);
        }
    };

    const debuggerInstance = await loadDebugger(debuggerJsPath, imports => {
        Object.assign(imports.env, hostImports);
        imports.coreclr_dbi_dac = hostImports;
    });

    debuggerModule = debuggerInstance.module;
    debuggerExports = debuggerInstance.exports;

    if (typeof debuggerExports.memory === "undefined" || typeof debuggerExports.memory.buffer === "undefined") {
        fail("debugger export 'memory' is missing or does not expose a buffer");
    }

    if (getRuntimeHeap().buffer === getDebuggerHeap().buffer) {
        fail("runtime and debugger modules unexpectedly share the same WebAssembly memory");
    }

    const abiVersion = debuggerModule._coreclr_wasm_dbi_dac_get_abi_version();
    const componentMask = debuggerModule._coreclr_wasm_dbi_dac_get_component_mask();
    const cordbFirstResult = debuggerModule._coreclr_wasm_dbi_dac_create_cordb_object();

    const stack = debuggerExports.stackSave();
    const descriptorAddress = debuggerExports.stackAlloc(32);
    const pointerDataAddress = debuggerExports.stackAlloc(8);
    const testDataAddress = debuggerExports.stackAlloc(48);
    const controlProbeAddress = debuggerExports.stackAlloc(16);
    const copyAddress = debuggerExports.stackAlloc(8);
    const sessionEventAddress = debuggerExports.stackAlloc(64);
    const sessionEventBytesWrittenAddress = debuggerExports.stackAlloc(4);
    const versionBlobAddress = debuggerExports.stackAlloc(ExpectedVersionBlobSize);
    const platformAddress = debuggerExports.stackAlloc(4);
    const versionBlobBytesWrittenAddress = debuggerExports.stackAlloc(4);
    const transportMessageBytes = new TextEncoder().encode(TransportMessage);
    const transportMessageAddress = debuggerExports.stackAlloc(transportMessageBytes.length);
    const symbolName = "DotNetRuntimeContractDescriptor";
    const symbolNameAddress = debuggerExports.stackAlloc(symbolName.length);
    const symbolOutAddress = debuggerExports.stackAlloc(8);
    const pageCacheStatsAddress = debuggerExports.stackAlloc(24);
    const pageCacheStatsAfterAddress = debuggerExports.stackAlloc(24);
    const pageCacheStatsPostInvalidateAddress = debuggerExports.stackAlloc(24);

    writeAscii(debuggerModule.HEAPU8, symbolNameAddress, symbolName);
    writeBytes(debuggerModule.HEAPU8, transportMessageAddress, transportMessageBytes);

    const versionBlobResult = debuggerModule._coreclr_wasm_dbi_dac_get_version_blob(versionBlobAddress, ExpectedVersionBlobSize, versionBlobBytesWrittenAddress);
    const versionBlobBytesWritten = new DataView(debuggerModule.HEAPU8.buffer, versionBlobBytesWrittenAddress, 4).getUint32(0, true);
    const versionBlobView = new DataView(debuggerModule.HEAPU8.buffer, versionBlobAddress, ExpectedVersionBlobSize);
    const versionBlob = {
        magic: versionBlobView.getUint32(0, true),
        blobSize: versionBlobView.getUint32(4, true),
        abiVersion: versionBlobView.getUint32(8, true),
        protocolBreakingChangeCounter: versionBlobView.getUint32(12, true),
        componentMask: versionBlobView.getUint32(16, true),
        sidecarBuildVersionMS: versionBlobView.getUint32(20, true),
        sidecarBuildVersionLS: versionBlobView.getUint32(24, true),
        reserved: versionBlobView.getUint32(28, true)
    };

    const checkProtocolMatchResult = debuggerModule._coreclr_wasm_dbi_dac_check_protocol(
        ExpectedVersionBlobMagic, ExpectedAbiVersion, ExpectedProtocolBreakingChangeCounter);
    const checkProtocolBadMagicResult = debuggerModule._coreclr_wasm_dbi_dac_check_protocol(
        ExpectedVersionBlobMagic ^ 1, ExpectedAbiVersion, ExpectedProtocolBreakingChangeCounter) | 0;
    const checkProtocolBadAbiResult = debuggerModule._coreclr_wasm_dbi_dac_check_protocol(
        ExpectedVersionBlobMagic, ExpectedAbiVersion + 1, ExpectedProtocolBreakingChangeCounter) | 0;
    const checkProtocolBadCounterResult = debuggerModule._coreclr_wasm_dbi_dac_check_protocol(
        ExpectedVersionBlobMagic, ExpectedAbiVersion, ExpectedProtocolBreakingChangeCounter + 1) | 0;

    // Negative-path coverage: gated entry points must refuse work
    // until acknowledge_protocol succeeds. session_destroy is intentionally
    // ungated so a host that lost handshake state can still tear down,
    // so it must succeed even before any acknowledge.
    const asyncBreakRequestBeforeAckResult = debuggerModule._coreclr_wasm_dbi_dac_dbi_async_break_request() | 0;
    const sessionDestroyBeforeAckResult = debuggerModule._coreclr_wasm_dbi_dac_dbi_session_destroy() | 0;
    const sessionCreateBeforeAckResult = debuggerModule._coreclr_wasm_dbi_dac_dbi_session_create() | 0;
    const ackBadMagicResult = debuggerModule._coreclr_wasm_dbi_dac_acknowledge_protocol(
        ExpectedVersionBlobMagic ^ 1, ExpectedAbiVersion, ExpectedProtocolBreakingChangeCounter) | 0;
    const sessionCreateAfterBadAckResult = debuggerModule._coreclr_wasm_dbi_dac_dbi_session_create() | 0;
    const ackBadAbiResult = debuggerModule._coreclr_wasm_dbi_dac_acknowledge_protocol(
        ExpectedVersionBlobMagic, ExpectedAbiVersion + 1, ExpectedProtocolBreakingChangeCounter) | 0;
    const ackBadCounterResult = debuggerModule._coreclr_wasm_dbi_dac_acknowledge_protocol(
        ExpectedVersionBlobMagic, ExpectedAbiVersion, ExpectedProtocolBreakingChangeCounter + 1) | 0;

    // Acknowledge the protocol so all subsequent gated entry points
    // can proceed. acknowledge_protocol is idempotent on a correct triple.
    const ackResult = debuggerModule._coreclr_wasm_dbi_dac_acknowledge_protocol(
        ExpectedVersionBlobMagic, ExpectedAbiVersion, ExpectedProtocolBreakingChangeCounter);
    const ackAgainResult = debuggerModule._coreclr_wasm_dbi_dac_acknowledge_protocol(
        ExpectedVersionBlobMagic, ExpectedAbiVersion, ExpectedProtocolBreakingChangeCounter);

    const descriptorResult = debuggerModule._coreclr_wasm_dbi_dac_probe_runtime_contract_descriptor(1, descriptorAddress);
    const pointerDataResult = debuggerModule._coreclr_wasm_dbi_dac_probe_contract_pointer_data(1, 2, pointerDataAddress);
    const testDataResult = debuggerModule._coreclr_wasm_dbi_dac_probe_test_data(1, testDataAddress);
    const platformResult = debuggerModule._coreclr_wasm_dbi_dac_probe_get_platform(1, platformAddress) | 0;
    const platformValue = new DataView(debuggerModule.HEAPU8.buffer, platformAddress, 4).getInt32(0, true);
    const platformNullOutResult = debuggerModule._coreclr_wasm_dbi_dac_probe_get_platform(1, 0) | 0;
    const breakpointControlResult = debuggerModule._coreclr_wasm_dbi_dac_probe_breakpoint_control(controlProbeAddress);
    const symbolResult = debuggerModule._coreclr_wasm_dbi_dac_try_get_symbol(symbolNameAddress, symbolName.length, symbolOutAddress);

    // Symbol-name robustness coverage: confirm coreclr_wasm_dbi_dac_try_get_symbol
    // rejects malformed symbol-name buffers before forwarding them to
    // the host callback. All five cases should fail-fast inside the
    // sidecar without ever touching JS.
    const InvalidSymbolName = -9;
    const symbolEmptyResult = debuggerModule._coreclr_wasm_dbi_dac_try_get_symbol(symbolNameAddress, 0, symbolOutAddress) | 0;
    const symbolNullAddressResult = debuggerModule._coreclr_wasm_dbi_dac_try_get_symbol(0, symbolName.length, symbolOutAddress) | 0;
    const symbolTooLongResult = debuggerModule._coreclr_wasm_dbi_dac_try_get_symbol(symbolNameAddress, 0x1000 >>> 0, symbolOutAddress) | 0;
    const symbolAddressOverflowResult = debuggerModule._coreclr_wasm_dbi_dac_try_get_symbol(0xffffff00 >>> 0, 0x200 >>> 0, symbolOutAddress) | 0;
    const symbolNullOutResult = debuggerModule._coreclr_wasm_dbi_dac_try_get_symbol(symbolNameAddress, symbolName.length, 0) | 0;

    // Page-cache coverage: the three probes above all went through
    // dataTarget.ReadVirtual, which routes through the in-sidecar 4 KiB
    // page cache. The descriptor + pointer-data + test-data flow re-
    // reads the descriptor region multiple times across overlapping
    // single-page reads, so by this point we expect at least one cache
    // hit (the second + third descriptor read) and at least one miss
    // (the cold descriptor + cold WasmDbiDacTestData fetch). Bypasses
    // should still be 0 because every probe read fits in a single page.
    const pageCacheStatsResult = debuggerModule._coreclr_wasm_dbi_dac_get_page_cache_stats(pageCacheStatsAddress) | 0;
    const pageCacheStatsBefore = readPageCacheStats(debuggerModule.HEAPU8, pageCacheStatsAddress);

    // Invalidate via the product export. The next stats read must show
    // epoch and invalidations both incremented by exactly one; hits and
    // misses are cumulative so they should be unchanged.
    const pageCacheInvalidateResult = debuggerModule._coreclr_wasm_dbi_dac_invalidate_page_cache() | 0;
    const pageCacheStatsAfterInvalidateResult = debuggerModule._coreclr_wasm_dbi_dac_get_page_cache_stats(pageCacheStatsAfterAddress) | 0;
    const pageCacheStatsAfterInvalidate = readPageCacheStats(debuggerModule.HEAPU8, pageCacheStatsAfterAddress);

    // Re-issue a probe that uses the cached path. Because we just
    // invalidated, the next descriptor fetch must be a miss (or
    // bypass), not a hit; the hit counter must remain at the
    // post-invalidate baseline. This proves epoch invalidation
    // actually drops the cached page rather than serving stale data.
    const reprobeResult = debuggerModule._coreclr_wasm_dbi_dac_probe_runtime_contract_descriptor(1, descriptorAddress) | 0;
    const pageCacheStatsAfterReprobeResult = debuggerModule._coreclr_wasm_dbi_dac_get_page_cache_stats(pageCacheStatsPostInvalidateAddress) | 0;
    const pageCacheStatsAfterReprobe = readPageCacheStats(debuggerModule.HEAPU8, pageCacheStatsPostInvalidateAddress);

    const runtimeDescriptorAddress = runtimeExports.GetDotNetRuntimeContractDescriptor() >>> 0;
    const copyResult = debuggerModule._coreclr_wasm_dbi_dac_copy_from_target(runtimeDescriptorAddress, copyAddress, 8);

    // Memory-read robustness coverage: confirm the hardened
    // copy_from_target rejects malformed reads before forwarding them
    // to the host callback. All four cases should fail-fast inside the
    // sidecar without ever touching JS.
    const InvalidArgument = -1;
    const BufferTooSmall = -7;
    const InvalidReadRange = -8;
    const copyZeroBytesResult = debuggerModule._coreclr_wasm_dbi_dac_copy_from_target(0, 0, 0) | 0;
    const copyNullDebuggerDestResult = debuggerModule._coreclr_wasm_dbi_dac_copy_from_target(runtimeDescriptorAddress, 0, 8) | 0;
    const copyTargetOverflowResult = debuggerModule._coreclr_wasm_dbi_dac_copy_from_target(0xffffff00 >>> 0, copyAddress, 0x200) | 0;
    const copyDebuggerOverflowResult = debuggerModule._coreclr_wasm_dbi_dac_copy_from_target(runtimeDescriptorAddress, 0xffffff00 >>> 0, 0x200) | 0;
    const copyOversizedResult = debuggerModule._coreclr_wasm_dbi_dac_copy_from_target(0, copyAddress, 0x20000000 >>> 0) | 0;

    const sessionCreateResult = debuggerModule._coreclr_wasm_dbi_dac_dbi_session_create();
    const sessionCreateProcessResult = debuggerModule._coreclr_wasm_dbi_dac_dbi_session_create_process();
    const sessionConnectResult = debuggerModule._coreclr_wasm_dbi_dac_dbi_connect_runtime(1);
    const transportSendResult = debuggerModule._coreclr_wasm_dbi_dac_transport_send_test_message(transportMessageAddress, transportMessageBytes.length);
    const transportGetResult = debuggerModule._coreclr_wasm_dbi_dac_transport_get_last_event(sessionEventAddress, 64, sessionEventBytesWrittenAddress);
    const sessionDisconnectResult = debuggerModule._coreclr_wasm_dbi_dac_dbi_disconnect_runtime();
    const sessionDestroyResult = debuggerModule._coreclr_wasm_dbi_dac_dbi_session_destroy();

    const descriptor = readDescriptor(debuggerModule.HEAPU8, descriptorAddress);
    const pointerDataView = new DataView(debuggerModule.HEAPU8.buffer, pointerDataAddress, 8);
    const symbolAddress = Number(new DataView(debuggerModule.HEAPU8.buffer, symbolOutAddress, 8).getBigUint64(0, true));
    const copiedMagic = new DataView(debuggerModule.HEAPU8.buffer, copyAddress, 8).getBigUint64(0, true);
    const threadStoreGlobalSlot = pointerDataView.getUint32(0, true);
    const threadStoreValue = pointerDataView.getUint32(4, true);
    const testDataView = new DataView(debuggerModule.HEAPU8.buffer, testDataAddress, 48);
    const testData = {
        magic: testDataView.getUint32(0, true),
        int32Value: testDataView.getInt32(4, true),
        doubleValue: testDataView.getFloat64(8, true),
        vectorLanes: [
            testDataView.getUint32(16, true),
            testDataView.getUint32(20, true),
            testDataView.getUint32(24, true),
            testDataView.getUint32(28, true)
        ],
        message: readNullTerminatedAscii(debuggerModule.HEAPU8, testDataAddress + 32, 16)
    };
    const controlProbeView = new DataView(debuggerModule.HEAPU8.buffer, controlProbeAddress, 16);
    const controlProbe = {
        createCordbResult: controlProbeView.getInt32(0, true),
        initializeResult: controlProbeView.getInt32(4, true),
        createProcessResult: controlProbeView.getInt32(8, true),
        breakpointResult: controlProbeView.getInt32(12, true)
    };
    const sessionEventBytesWritten = new DataView(debuggerModule.HEAPU8.buffer, sessionEventBytesWrittenAddress, 4).getUint32(0, true);
    const sessionEvent = readAscii(debuggerModule.HEAPU8, sessionEventAddress, sessionEventBytesWritten);

    debuggerExports.stackRestore(stack);

    const clrDataResult = debuggerModule._coreclr_wasm_dbi_dac_create_clr_data_instance(1);
    const dacDbiResult = debuggerModule._coreclr_wasm_dbi_dac_create_dac_dbi_interface(1);
    const cordbSecondResult = debuggerModule._coreclr_wasm_dbi_dac_create_cordb_object();

    // Phase 3 onramp probe: confirm IDacDbiInterface::DacSetTargetConsistencyChecks
    // is reachable from the in-sidecar DAC. The desktop V3 attach
    // (CordbProcess::CreateDacDbiInterface) calls this immediately after binding
    // the DAC, so if it ever drops out of our build a future real-CordbProcess
    // slice would regress silently. Calling against runtimeBase=1 mirrors the
    // existing dacDbiResult probe: creation succeeds without touching target
    // memory, and DacSetTargetConsistencyChecks just toggles a flag on the
    // ClrDataAccess base, so both should return S_OK.
    const dacConsistencyStack = debuggerExports.stackSave();
    const dacConsistencyHrAddress = debuggerExports.stackAlloc(4);
    const dacConsistencyProbeResult = debuggerModule._coreclr_wasm_dbi_dac_probe_dac_consistency_checks(1, dacConsistencyHrAddress);
    const dacConsistencyHr = new DataView(debuggerModule.HEAPU8.buffer, dacConsistencyHrAddress, 4).getInt32(0, true);
    debuggerExports.stackRestore(dacConsistencyStack);

    // Phase 3 onramp probe: surface which IIDs WasmDacDataTarget already
    // implements. The desktop V3 connect path QIs the data target for
    // ICorDebugDataTarget, ICorDebugMutableDataTarget, and
    // ICorDebugMetaDataLocator; mscordbi tolerates E_NOINTERFACE on the
    // metadata locator but expects mutable data target. Today the sidecar
    // implements only IUnknown / ICLRDataTarget / ICLRRuntimeLocator /
    // ICorDebugDataTarget, so the expected bitmask is 0x0F. Bits 0x10
    // (mutable data target) and 0x20 (metadata locator) are documented
    // Phase 3 gaps that this probe surfaces.
    const dataTargetQiStack = debuggerExports.stackSave();
    const dataTargetQiFlagsAddress = debuggerExports.stackAlloc(4);
    const dataTargetQiResult = debuggerModule._coreclr_wasm_dbi_dac_probe_data_target_qi(dataTargetQiFlagsAddress);
    const dataTargetQiFlags = new DataView(debuggerModule.HEAPU8.buffer, dataTargetQiFlagsAddress, 4).getUint32(0, true);
    debuggerExports.stackRestore(dataTargetQiStack);

    // Phase 3 onramp probe: resolve the runtime contract descriptor address
    // via the same TryGetSymbol host callback that the V3 attach path
    // (CordbProcess::OpenVirtualProcessImpl, EnsureClrInstanceIdSet) will
    // pass as clrInstanceId. The expected value matches the host-side
    // GetDotNetRuntimeContractDescriptor() export and must equal the
    // existing `descriptorAddress` field this smoke already reads from
    // probe_runtime_contract_descriptor — proving the same address flows
    // through both probe paths and the eventual real attach call.
    const clrInstanceIdStack = debuggerExports.stackSave();
    const clrInstanceIdAddress = debuggerExports.stackAlloc(4);
    const clrInstanceIdHrAddress = debuggerExports.stackAlloc(4);
    // runtimeBase=1 matches the convention used by the other probes here
    // (clrDataResult / dacDbiResult / dacConsistencyProbeResult). The
    // TryGetSymbol callback resolves "DotNetRuntimeContractDescriptor" by
    // host-side symbol lookup, so the runtime-base value is not actually
    // dereferenced for the probe; the host bridge looks it up by name.
    const clrInstanceIdProbeResult = debuggerModule._coreclr_wasm_dbi_dac_probe_clr_instance_id(
        1,
        clrInstanceIdAddress,
        clrInstanceIdHrAddress);
    const clrInstanceIdValue = new DataView(debuggerModule.HEAPU8.buffer, clrInstanceIdAddress, 4).getUint32(0, true);
    const clrInstanceIdHr = new DataView(debuggerModule.HEAPU8.buffer, clrInstanceIdHrAddress, 4).getInt32(0, true);
    debuggerExports.stackRestore(clrInstanceIdStack);

    // Phase 3 onramp probe: replicate the three unconditional CreateEvent
    // calls CordbProcess::Init makes (process.cpp:1679-1695) and verify
    // the browser-wasm PAL emulates the API surface. Expected: flags=0x7
    // (all three created), HR=0 (no failures). Today the wasm PAL provides
    // these via the single-threaded event implementation; the probe locks
    // that contract in so that a future PAL change that breaks any of the
    // three event shapes fails CI loud — before it would silently break
    // real V3 attach.
    const createEventsStack = debuggerExports.stackSave();
    const createEventsFlagsAddress = debuggerExports.stackAlloc(4);
    const createEventsHrAddress = debuggerExports.stackAlloc(4);
    const createEventsProbeResult = debuggerModule._coreclr_wasm_dbi_dac_probe_create_events(
        createEventsFlagsAddress,
        createEventsHrAddress);
    const createEventsFlags = new DataView(debuggerModule.HEAPU8.buffer, createEventsFlagsAddress, 4).getUint32(0, true);
    const createEventsHr = new DataView(debuggerModule.HEAPU8.buffer, createEventsHrAddress, 4).getInt32(0, true);
    debuggerExports.stackRestore(createEventsStack);

    // Phase 3 onramp probe: walk the in-sidecar static DAC binding path
    // that the real CordbProcess::CreateDacDbiInterface (process.cpp:
    // 650-701) will use on wasm — bypasses GetProcAddress and calls
    // DacDbiInterfaceInstance directly, then DacSetTargetConsistencyChecks.
    // Expected: both HRs == 0. Uses the real clrInstanceId resolved by
    // probe_clr_instance_id so we exercise the same input shape attach
    // will use.
    const staticDacBindingStack = debuggerExports.stackSave();
    const staticDacBindingCreateHrAddress = debuggerExports.stackAlloc(4);
    const staticDacBindingConsistencyHrAddress = debuggerExports.stackAlloc(4);
    const staticDacBindingProbeResult = debuggerModule._coreclr_wasm_dbi_dac_probe_static_dac_binding(
        clrInstanceIdValue,
        staticDacBindingCreateHrAddress,
        staticDacBindingConsistencyHrAddress);
    const staticDacBindingCreateHr = new DataView(debuggerModule.HEAPU8.buffer, staticDacBindingCreateHrAddress, 4).getInt32(0, true);
    const staticDacBindingConsistencyHr = new DataView(debuggerModule.HEAPU8.buffer, staticDacBindingConsistencyHrAddress, 4).getInt32(0, true);
    debuggerExports.stackRestore(staticDacBindingStack);

    // Phase 3 acceptance probe: invoke real V3 OpenVirtualProcessImpl.
    // EXPECTED TO FAIL today — CordbProcess::CreateDacDbiInterface
    // (process.cpp:687) calls GetProcAddress(m_hDacModule, ...) which
    // requires a loaded DAC module, and wasm has none. The probe captures
    // the HR so the failure is documented; once Phase 3 lands a
    // wasm-specialized branch in process.cpp that uses the static-binding
    // helper (the one probe_static_dac_binding exercises), hr flips to 0
    // and hasRealCordbProcess flips to 1.
    //
    // The smoke records the result for diagnostics but does NOT assert
    // success today. The assertion will be tightened in the implementation
    // slice that wires the wasm-specialized branch.
    const openVirtualProcessStack = debuggerExports.stackSave();
    const openVirtualProcessHrAddress = debuggerExports.stackAlloc(4);
    const openVirtualProcessHasRealAddress = debuggerExports.stackAlloc(4);
    const openVirtualProcessProbeResult = debuggerModule._coreclr_wasm_dbi_dac_probe_open_virtual_process(
        clrInstanceIdValue,
        openVirtualProcessHrAddress,
        openVirtualProcessHasRealAddress);
    const openVirtualProcessHr = new DataView(debuggerModule.HEAPU8.buffer, openVirtualProcessHrAddress, 4).getInt32(0, true);
    const openVirtualProcessHasReal = new DataView(debuggerModule.HEAPU8.buffer, openVirtualProcessHasRealAddress, 4).getUint32(0, true);
    debuggerExports.stackRestore(openVirtualProcessStack);

    // Phase 4 first slice: DebuggerIPCEvent (DB_IPCE_BREAKPOINT) wire-
    // format round-trip probe. Constructs a synthetic
    // WasmDbgIpcEventBreakpoint with deterministic field values,
    // serializes via memcpy, deserializes back, and asserts field-by-
    // field equality. Validates the on-wire format before the Phase 4
    // transport layer starts sending real DebuggerIPCEvents through
    // the JSON-RPC + binary channels designed in
    // docs/design/coreclr/wasm-debug-transport.md. Expected: probe
    // result 0, equal=1, magic=0x42435049 ('IPCB'),
    // type=0x100 (DB_IPCE_BREAKPOINT).
    const dbgIpcEventStack = debuggerExports.stackSave();
    const DbgIpcEventBreakpointBytes = 96;
    const dbgIpcEventBufferAddress = debuggerExports.stackAlloc(DbgIpcEventBreakpointBytes);
    const dbgIpcEventEqualAddress = debuggerExports.stackAlloc(4);
    const dbgIpcEventProbeResult = debuggerModule._coreclr_wasm_dbi_dac_probe_dbg_ipc_event_breakpoint_roundtrip(
        dbgIpcEventBufferAddress,
        DbgIpcEventBreakpointBytes,
        dbgIpcEventEqualAddress);
    const dbgIpcEventEqual = new DataView(debuggerModule.HEAPU8.buffer, dbgIpcEventEqualAddress, 4).getUint32(0, true);
    const dbgIpcEventBufferView = new DataView(debuggerModule.HEAPU8.buffer, dbgIpcEventBufferAddress, DbgIpcEventBreakpointBytes);
    const dbgIpcEventMagic = dbgIpcEventBufferView.getUint32(0, true);
    const dbgIpcEventType = dbgIpcEventBufferView.getUint32(4, true);
    const dbgIpcEventFuncToken = dbgIpcEventBufferView.getUint32(48, true);
    const dbgIpcEventOffset = dbgIpcEventBufferView.getUint32(68, true);
    debuggerExports.stackRestore(dbgIpcEventStack);

    // Phase 6 connection-state gate probe. Verifies the
    // CoreClrWasmDebugSetDebuggerConnected / IsDebuggerConnected exports
    // exist, default to disconnected (= 0), accept the round-trip set
    // (1 → was 0, isConnected → 1), and accept the round-trip clear
    // (0 → was 1, isConnected → 0). Mirrors Mono
    // mono_wasm_set_is_debugger_attached (mini-wasm-debugger.c:38-373).
    // The actual gating behavior (no patch when disconnected) is
    // validated end-to-end by the hello-breakpoint smoke, which
    // explicitly flips the flag on before triggering the breakpoint.
    const connectionInitial = runtimeExports.CoreClrWasmDebugIsDebuggerConnected() | 0;
    const connectionPrevOnSet = runtimeExports.CoreClrWasmDebugSetDebuggerConnected(1) | 0;
    const connectionAfterSet = runtimeExports.CoreClrWasmDebugIsDebuggerConnected() | 0;
    const connectionPrevOnClear = runtimeExports.CoreClrWasmDebugSetDebuggerConnected(0) | 0;
    const connectionAfterClear = runtimeExports.CoreClrWasmDebugIsDebuggerConnected() | 0;
    const asyncBreakInitial = runtimeExports.CoreClrWasmDebugIsAsyncBreakInProgress() | 0;
    const asyncBreakPrevOnSet = runtimeExports.CoreClrWasmDebugSetAsyncBreakInProgress(1) | 0;
    const asyncBreakAfterSet = runtimeExports.CoreClrWasmDebugIsAsyncBreakInProgress() | 0;
    const asyncBreakPrevOnClear = runtimeExports.CoreClrWasmDebugSetAsyncBreakInProgress(0) | 0;
    const asyncBreakAfterClear = runtimeExports.CoreClrWasmDebugIsAsyncBreakInProgress() | 0;
    const asyncBreakRequestAfterAckResult = debuggerModule._coreclr_wasm_dbi_dac_dbi_async_break_request() | 0;

    // Path A-lite slice 4 link probe: the exported runtime wrapper calls into
    // interpreterstephelper.cpp, proving that source is present in the live
    // runtime link graph without constructing the helper yet.
    const interpreterStepHelperProbeSize = runtimeExports.CoreClrWasmDebugCallInterpreterStepHelperProbe() >>> 0;
    const methodEnterQueryCount = runtimeExports.CoreClrWasmDebugGetMethodEnterEnabledQueryCount() >>> 0;

    // DAC-completeness probe: read 13 well-known DacGlobals slot addresses
    // from the runtime via CoreClrWasmDebugReadDacGlobalsProbe. With the
    // dactable migration + wasm-debuggee-stubs in place, ALL ~145
    // DacGlobals dacvar slots are wired (the 5 vtable identity slots
    // remain zero by design — no Debugger/DebuggerController instances
    // exist on wasm). The 7 baseline slots (ThreadStore, AppDomain,
    // SystemDomain, g_pConfig, g_pGCHeap, g_pObjectClass, g_pStringClass)
    // come from runtime VM globals. The 6 additional slots (g_pDebugger,
    // g_pEEInterface, CLRJitAttachState, DebuggerController::g_patches,
    // DebuggerController::g_patchTableValid, Debugger::s_fCanChangeNgenFlags)
    // come from src/coreclr/vm/wasm/wasm-debuggee-stubs.cpp — they're
    // address-of-stub values; DAC reads them as null/zero, which is the
    // truthful "no debugger EE attached" state.
    const DacGlobalsProbeSlotCount = 13;
    const dacGlobalsProbeStack = runtimeExports.stackAlloc
        ? runtimeExports.stackAlloc(DacGlobalsProbeSlotCount * 4)
        : null;
    const dacGlobalsProbeBuffer = dacGlobalsProbeStack !== null
        ? dacGlobalsProbeStack
        : 0;
    let dacGlobalsProbeResult = -1;
    const dacGlobalsSlots = new Array(DacGlobalsProbeSlotCount).fill(0);
    if (dacGlobalsProbeBuffer !== 0) {
        dacGlobalsProbeResult = runtimeExports.CoreClrWasmDebugReadDacGlobalsProbe(
            dacGlobalsProbeBuffer,
            DacGlobalsProbeSlotCount * 4) | 0;
        const view = new DataView(runtimeExports.memory.buffer, dacGlobalsProbeBuffer, DacGlobalsProbeSlotCount * 4);
        for (let i = 0; i < DacGlobalsProbeSlotCount; i++) {
            dacGlobalsSlots[i] = view.getUint32(i * 4, true);
        }
    }
    const dacGlobals = {
        threadStore: `0x${dacGlobalsSlots[0].toString(16)}`,
        appDomain: `0x${dacGlobalsSlots[1].toString(16)}`,
        systemDomain: `0x${dacGlobalsSlots[2].toString(16)}`,
        pConfig: `0x${dacGlobalsSlots[3].toString(16)}`,
        pGCHeap: `0x${dacGlobalsSlots[4].toString(16)}`,
        pObjectClass: `0x${dacGlobalsSlots[5].toString(16)}`,
        pStringClass: `0x${dacGlobalsSlots[6].toString(16)}`,
        pDebugger: `0x${dacGlobalsSlots[7].toString(16)}`,
        pEEInterface: `0x${dacGlobalsSlots[8].toString(16)}`,
        clrJitAttachState: `0x${dacGlobalsSlots[9].toString(16)}`,
        debuggerControllerGPatches: `0x${dacGlobalsSlots[10].toString(16)}`,
        debuggerControllerGPatchTableValid: `0x${dacGlobalsSlots[11].toString(16)}`,
        debuggerSFCanChangeNgenFlags: `0x${dacGlobalsSlots[12].toString(16)}`
    };
    const dacGlobalsAllNonZero = dacGlobalsSlots.every(v => v !== 0);

    // Phase 7 multi-bp probe: verify ArmWasmDebugBreakpoint slot allocation,
    // CountActiveWasmDebugBreakpoints / GetActiveBreakpointCount, and the
    // by-name / by-token clear paths. Uses runtime-side breakpoint helpers
    // directly via the legacy text-command transport (ReceiveCommand path)
    // so the probe is independent of the DBI session lifecycle and the
    // hello-breakpoint smoke. The expected steady-state is "no armed
    // breakpoints" at the end of the probe; the smoke fails loudly if any
    // armed slot leaks into the rest of the test.
    function sendCommand(text) {
        const stack = runtimeExports.stackSave();
        const buf = runtimeExports.stackAlloc(text.length + 1);
        const view = new Uint8Array(runtimeExports.memory.buffer, buf, text.length + 1);
        for (let i = 0; i < text.length; i++) view[i] = text.charCodeAt(i);
        view[text.length] = 0;
        const rc = runtimeExports.CoreClrWasmDebugReceiveCommand(buf, text.length) | 0;
        runtimeExports.stackRestore(stack);
        return rc;
    }
    function clearByName(name) {
        const stack = runtimeExports.stackSave();
        const buf = runtimeExports.stackAlloc(name.length);
        const view = new Uint8Array(runtimeExports.memory.buffer, buf, name.length);
        for (let i = 0; i < name.length; i++) view[i] = name.charCodeAt(i);
        const rc = runtimeExports.CoreClrWasmDebugClearBreakpointByName(buf, name.length) | 0;
        runtimeExports.stackRestore(stack);
        return rc;
    }

    const multiBpInitialCount = runtimeExports.CoreClrWasmDebugGetActiveBreakpointCount() | 0;
    const multiBpSendA = sendCommand("dbi-command:set-breakpoint:name=BpA");
    const multiBpSendB = sendCommand("dbi-command:set-breakpoint:name=BpB");
    const multiBpSendC = sendCommand("dbi-command:set-breakpoint:name=BpC");
    const multiBpCountAfterThree = runtimeExports.CoreClrWasmDebugGetActiveBreakpointCount() | 0;
    const ExpectedBreakpointSlotSize = 88;
    const BreakpointEnumerationHeaderSize = 8;
    const multiBpSlotSize = runtimeExports.CoreClrWasmDebugGetBreakpointSlotSize() >>> 0;
    const multiBpSlotCapacity = runtimeExports.CoreClrWasmDebugGetBreakpointSlotCapacity() >>> 0;
    const multiBpEnumerationLength = BreakpointEnumerationHeaderSize + (multiBpSlotCapacity * multiBpSlotSize);
    const multiBpEnumerationStack = debuggerExports.stackSave();
    const multiBpEnumerationAddress = debuggerExports.stackAlloc(multiBpEnumerationLength);
    const multiBpEnumerationBytesWrittenAddress = debuggerExports.stackAlloc(4);
    const multiBpAckResult = debuggerModule._coreclr_wasm_dbi_dac_acknowledge_protocol(
        ExpectedVersionBlobMagic, ExpectedAbiVersion, ExpectedProtocolBreakingChangeCounter) | 0;
    const multiBpSessionCreateResult = debuggerModule._coreclr_wasm_dbi_dac_dbi_session_create() | 0;
    const multiBpSessionConnectResult = debuggerModule._coreclr_wasm_dbi_dac_dbi_connect_runtime(1) | 0;
    const multiBpEnumerateSmallResult = debuggerModule._coreclr_wasm_dbi_dac_dbi_enumerate_breakpoints(
        multiBpEnumerationAddress,
        multiBpEnumerationLength - 1,
        multiBpEnumerationBytesWrittenAddress) | 0;
    const multiBpEnumerateSmallBytesWritten = new DataView(
        getDebuggerHeap().buffer,
        multiBpEnumerationBytesWrittenAddress,
        4).getUint32(0, true);
    const multiBpEnumerateResult = debuggerModule._coreclr_wasm_dbi_dac_dbi_enumerate_breakpoints(
        multiBpEnumerationAddress,
        multiBpEnumerationLength,
        multiBpEnumerationBytesWrittenAddress) | 0;
    const multiBpEnumerateBytesWritten = new DataView(
        getDebuggerHeap().buffer,
        multiBpEnumerationBytesWrittenAddress,
        4).getUint32(0, true);
    const multiBpEnumeration = readBreakpointEnumeration(
        getDebuggerHeap(),
        multiBpEnumerationAddress,
        multiBpSlotCapacity,
        multiBpSlotSize);
    const multiBpArmedSlots = multiBpEnumeration.slots.filter(slot => slot.armed);
    const multiBpArmedNames = multiBpArmedSlots.map(slot => slot.methodName);
    const multiBpExpectedNames = ["BpA", "BpB", "BpC"];
    const multiBpExpectedNamesPresent = multiBpExpectedNames.every(name => multiBpArmedNames.includes(name));
    const multiBpNamedSlotsHaveExpectedFields = multiBpExpectedNames.every(name => {
        const slot = multiBpArmedSlots.find(armedSlot => armedSlot.methodName === name);
        return slot !== undefined &&
            !slot.isOneShot &&
            slot.methodToken === 0 &&
            slot.patchAddress === 0 &&
            slot.originalOpcode === 0 &&
            !slot.patchActive &&
            slot.hitCount === 0;
    });
    const multiBpClearedB = clearByName("BpB");
    const multiBpCountAfterClearB = runtimeExports.CoreClrWasmDebugGetActiveBreakpointCount() | 0;
    const multiBpClearedA = clearByName("BpA");
    const multiBpClearedC = clearByName("BpC");
    const multiBpCountFinal = runtimeExports.CoreClrWasmDebugGetActiveBreakpointCount() | 0;
    const multiBpEnumerateAfterClearResult = debuggerModule._coreclr_wasm_dbi_dac_dbi_enumerate_breakpoints(
        multiBpEnumerationAddress,
        multiBpEnumerationLength,
        multiBpEnumerationBytesWrittenAddress) | 0;
    const multiBpEnumerateAfterClearBytesWritten = new DataView(
        getDebuggerHeap().buffer,
        multiBpEnumerationBytesWrittenAddress,
        4).getUint32(0, true);
    const multiBpEnumerationAfterClear = readBreakpointEnumeration(
        getDebuggerHeap(),
        multiBpEnumerationAddress,
        multiBpSlotCapacity,
        multiBpSlotSize);
    const multiBpAfterClearArmedNames = multiBpEnumerationAfterClear.slots
        .filter(slot => slot.armed)
        .map(slot => slot.methodName);
    const multiBpExpectedNamesCleared = multiBpExpectedNames.every(name => !multiBpAfterClearArmedNames.includes(name));
    const multiBpDisconnectResult = debuggerModule._coreclr_wasm_dbi_dac_dbi_disconnect_runtime() | 0;
    const multiBpSessionDestroyResult = debuggerModule._coreclr_wasm_dbi_dac_dbi_session_destroy() | 0;
    debuggerExports.stackRestore(multiBpEnumerationStack);

    // Type-system enumeration probe: exercise the legacy DAC
    // IXCLRDataProcess cursor APIs through sidecar exports.
    const typeSystemAppRunResult = 0;
    const AppDomainEntrySize = 68;
    const AssemblyEntrySize = 264;
    const ModuleEntrySize = 144;
    const EnumerationHeaderSize = 8;
    const AppDomainEnumerationCapacity = 16;
    const AssemblyEnumerationCapacity = 128;
    const ModuleEnumerationCapacity = 8;
    const appDomainsEnumerationLength = EnumerationHeaderSize + (AppDomainEnumerationCapacity * AppDomainEntrySize);
    const assembliesEnumerationLength = EnumerationHeaderSize + (AssemblyEnumerationCapacity * AssemblyEntrySize);
    const modulesEnumerationLength = EnumerationHeaderSize + (ModuleEnumerationCapacity * ModuleEntrySize);
    const typeSystemStack = debuggerExports.stackSave();
    const appDomainsBufferAddress = debuggerExports.stackAlloc(appDomainsEnumerationLength);
    const assembliesBufferAddress = debuggerExports.stackAlloc(assembliesEnumerationLength);
    const modulesBufferAddress = debuggerExports.stackAlloc(modulesEnumerationLength);
    const typeSystemBytesWrittenAddress = debuggerExports.stackAlloc(4);
    const typeSystemAckResult = debuggerModule._coreclr_wasm_dbi_dac_acknowledge_protocol(
        ExpectedVersionBlobMagic, ExpectedAbiVersion, ExpectedProtocolBreakingChangeCounter) | 0;
    const typeSystemSessionCreateResult = debuggerModule._coreclr_wasm_dbi_dac_dbi_session_create() | 0;
    const typeSystemSessionConnectResult = debuggerModule._coreclr_wasm_dbi_dac_dbi_connect_runtime(1) | 0;
    const appDomainsResult = debuggerModule._coreclr_wasm_dbi_dac_dbi_enumerate_appdomains(
        appDomainsBufferAddress,
        appDomainsEnumerationLength,
        typeSystemBytesWrittenAddress) | 0;
    const appDomainsBytesWritten = new DataView(
        getDebuggerHeap().buffer,
        typeSystemBytesWrittenAddress,
        4).getUint32(0, true);
    const appDomainsEnumeration = readAppDomainEnumeration(getDebuggerHeap(), appDomainsBufferAddress);
    const defaultAppDomain = appDomainsEnumeration.entries.find(domain => domain.name.includes("Default")) ??
        appDomainsEnumeration.entries[0];
    const assemblyEnumerations = [];
    for (const appDomain of appDomainsEnumeration.entries) {
        const enumerateAssembliesResult = debuggerModule._coreclr_wasm_dbi_dac_dbi_enumerate_assemblies(
            appDomain.id,
            assembliesBufferAddress,
            assembliesEnumerationLength,
            typeSystemBytesWrittenAddress) | 0;
        const enumerateAssembliesBytesWritten = new DataView(
            getDebuggerHeap().buffer,
            typeSystemBytesWrittenAddress,
            4).getUint32(0, true);
        assemblyEnumerations.push({
            appDomain,
            result: enumerateAssembliesResult,
            bytesWritten: enumerateAssembliesBytesWritten,
            enumeration: readAssemblyEnumeration(getDebuggerHeap(), assembliesBufferAddress)
        });
    }
    const defaultAssemblyEnumeration = assemblyEnumerations.find(entry => entry.appDomain.id === defaultAppDomain.id)?.enumeration ??
        { count: 0, entries: [] };
    const defaultAssemblies = defaultAssemblyEnumeration.entries;
    const coreLibAssembly = defaultAssemblies.find(assembly =>
        assembly.name === "System.Private.CoreLib" ||
        assembly.path.includes("System.Private.CoreLib"));
    const userAssembly = defaultAssemblies.find(assembly =>
        coreLibAssembly === undefined || assembly.address !== coreLibAssembly.address);
    const enumerateCoreLibModulesResult = coreLibAssembly
        ? debuggerModule._coreclr_wasm_dbi_dac_dbi_enumerate_modules(
            Number(coreLibAssembly.address & 0xffffffffn),
            modulesBufferAddress,
            modulesEnumerationLength,
            typeSystemBytesWrittenAddress) | 0
        : -1;
    const enumerateCoreLibModulesBytesWritten = new DataView(
        getDebuggerHeap().buffer,
        typeSystemBytesWrittenAddress,
        4).getUint32(0, true);
    const coreLibModulesEnumeration = coreLibAssembly
        ? readModuleEnumeration(getDebuggerHeap(), modulesBufferAddress)
        : { capacity: 0, count: 0, entries: [] };
    const enumerateUserModulesResult = userAssembly
        ? debuggerModule._coreclr_wasm_dbi_dac_dbi_enumerate_modules(
            Number(userAssembly.address & 0xffffffffn),
            modulesBufferAddress,
            modulesEnumerationLength,
            typeSystemBytesWrittenAddress) | 0
        : -1;
    const enumerateUserModulesBytesWritten = new DataView(
        getDebuggerHeap().buffer,
        typeSystemBytesWrittenAddress,
        4).getUint32(0, true);
    const userModulesEnumeration = userAssembly
        ? readModuleEnumeration(getDebuggerHeap(), modulesBufferAddress)
        : { capacity: 0, count: 0, entries: [] };
    const typeSystemDisconnectResult = debuggerModule._coreclr_wasm_dbi_dac_dbi_disconnect_runtime() | 0;
    const typeSystemSessionDestroyResult = debuggerModule._coreclr_wasm_dbi_dac_dbi_session_destroy() | 0;
    debuggerExports.stackRestore(typeSystemStack);
    const assemblyEnumerationsAllSucceeded = assemblyEnumerations.every(entry => entry.result === 0);
    const assemblyNamesAndPathsNonEmpty = defaultAssemblies.every(assembly =>
        assembly.address !== 0n && assembly.name.length > 0 && assembly.path.length > 0);
    const coreLibModulesNonEmpty = coreLibModulesEnumeration.entries.every(module =>
        module.address !== 0n &&
        module.assemblyAddress === (coreLibAssembly?.address ?? 0n) &&
        module.name.length > 0);
    const userModulesNonEmpty = userModulesEnumeration.entries.every(module =>
        module.address !== 0n &&
        module.assemblyAddress === (userAssembly?.address ?? 0n) &&
        module.name.length > 0);
    const typeSystemEnumeration = {
        appRunResult: typeSystemAppRunResult,
        ackResult: typeSystemAckResult,
        sessionCreateResult: typeSystemSessionCreateResult,
        sessionConnectResult: typeSystemSessionConnectResult,
        appDomainsResult,
        appDomainsBytesWritten,
        appDomains: appDomainsEnumeration,
        assemblyEnumerations: assemblyEnumerations.map(entry => ({
            appDomain: entry.appDomain,
            result: entry.result,
            bytesWritten: entry.bytesWritten,
            capacity: entry.enumeration.capacity,
            count: entry.enumeration.count,
            assemblies: entry.enumeration.entries.map(assembly => ({
                address: `0x${assembly.address.toString(16)}`,
                name: assembly.name,
                path: assembly.path
            }))
        })),
        defaultAppDomain,
        coreLibAssembly: coreLibAssembly ? {
            address: `0x${coreLibAssembly.address.toString(16)}`,
            name: coreLibAssembly.name,
            path: coreLibAssembly.path
        } : null,
        userAssembly: userAssembly ? {
            address: `0x${userAssembly.address.toString(16)}`,
            name: userAssembly.name,
            path: userAssembly.path
        } : null,
        coreLibModules: {
            result: enumerateCoreLibModulesResult,
            bytesWritten: enumerateCoreLibModulesBytesWritten,
            capacity: coreLibModulesEnumeration.capacity,
            count: coreLibModulesEnumeration.count,
            modules: coreLibModulesEnumeration.entries.map(module => ({
                address: `0x${module.address.toString(16)}`,
                assemblyAddress: `0x${module.assemblyAddress.toString(16)}`,
                name: module.name
            }))
        },
        userModules: {
            result: enumerateUserModulesResult,
            bytesWritten: enumerateUserModulesBytesWritten,
            capacity: userModulesEnumeration.capacity,
            count: userModulesEnumeration.count,
            modules: userModulesEnumeration.entries.map(module => ({
                address: `0x${module.address.toString(16)}`,
                assemblyAddress: `0x${module.assemblyAddress.toString(16)}`,
                name: module.name
            }))
        },
        assemblyEnumerationsAllSucceeded,
        assemblyNamesAndPathsNonEmpty,
        coreLibModulesNonEmpty,
        userModulesNonEmpty,
        disconnectResult: typeSystemDisconnectResult,
        sessionDestroyResult: typeSystemSessionDestroyResult
    };

    // No-such-name clear must succeed and report 0 cleared. We use a
    // distinct name that cannot match any existing slot to avoid wiping
    // an unrelated bp that some future smoke section might have left.
    const multiBpClearedMissing = clearByName("ThisBreakpointNameDoesNotExist");

    // Slot-exhaustion error path: fill every remaining slot, then
    // verify the next set-breakpoint command returns -1 (was 0 before
    // the code-review-driven fix made the text transport surface
    // ArmWasmDebugBreakpoint's bool failure). Clean up after by
    // clearing each filler. WasmDebugMaxBreakpoints is 16.
    const slotCapacity = 16;
    const remainingSlots = slotCapacity - (runtimeExports.CoreClrWasmDebugGetActiveBreakpointCount() | 0);
    const fillerNames = [];
    let fillerSendNonZero = 0;
    for (let i = 0; i < remainingSlots; i++) {
        const n = `Filler${i}`;
        fillerNames.push(n);
        const rc = sendCommand(`dbi-command:set-breakpoint:name=${n}`);
        if (rc !== 0) fillerSendNonZero++;
    }
    const exhaustionOverflowRc = sendCommand("dbi-command:set-breakpoint:name=Overflow");
    const exhaustionCountAtCap = runtimeExports.CoreClrWasmDebugGetActiveBreakpointCount() | 0;
    let fillerClearedTotal = 0;
    for (const n of fillerNames) {
        fillerClearedTotal += clearByName(n);
    }
    const exhaustionCountAfterCleanup = runtimeExports.CoreClrWasmDebugGetActiveBreakpointCount() | 0;
    const multiBpProbe = {
        initialCount: multiBpInitialCount,
        sendA: multiBpSendA,
        sendB: multiBpSendB,
        sendC: multiBpSendC,
        countAfterThree: multiBpCountAfterThree,
        slotSize: multiBpSlotSize,
        slotCapacityFromRuntime: multiBpSlotCapacity,
        enumerateLength: multiBpEnumerationLength,
        enumerateSmallResult: multiBpEnumerateSmallResult,
        enumerateSmallBytesWritten: multiBpEnumerateSmallBytesWritten,
        enumerateResult: multiBpEnumerateResult,
        enumerateBytesWritten: multiBpEnumerateBytesWritten,
        enumerateCapacity: multiBpEnumeration.capacity,
        enumerateActiveCount: multiBpEnumeration.activeCount,
        enumerateArmedNames: multiBpArmedNames,
        expectedNamesPresent: multiBpExpectedNamesPresent,
        namedSlotsHaveExpectedFields: multiBpNamedSlotsHaveExpectedFields,
        clearedB: multiBpClearedB,
        countAfterClearB: multiBpCountAfterClearB,
        clearedA: multiBpClearedA,
        clearedC: multiBpClearedC,
        countFinal: multiBpCountFinal,
        enumerateAfterClearResult: multiBpEnumerateAfterClearResult,
        enumerateAfterClearBytesWritten: multiBpEnumerateAfterClearBytesWritten,
        enumerateAfterClearActiveCount: multiBpEnumerationAfterClear.activeCount,
        expectedNamesCleared: multiBpExpectedNamesCleared,
        ackResult: multiBpAckResult,
        sessionCreateResult: multiBpSessionCreateResult,
        sessionConnectResult: multiBpSessionConnectResult,
        disconnectResult: multiBpDisconnectResult,
        sessionDestroyResult: multiBpSessionDestroyResult,
        clearedMissing: multiBpClearedMissing,
        slotCapacity,
        fillerCount: fillerNames.length,
        fillerSendNonZero,
        exhaustionOverflowRc,
        exhaustionCountAtCap,
        fillerClearedTotal,
        exhaustionCountAfterCleanup
    };

    // Memory-growth resilience: deliberately grow both wasm linear memories
    // and re-issue a positive copy_from_target. Growth invalidates every
    // previously-captured Uint8Array view; if the host bridge cached a
    // stale view we would either get -1 from the bounds check or throw
    // "memory access out of bounds" inside the host callback. With
    // per-call buffer refetching, the second copy must succeed and the
    // re-read descriptor magic must equal the pre-growth value.
    // Run this AFTER every other read from debugger memory, because the
    // smoke body itself caches DataView buffer references that would also
    // become detached. The host bridge's per-call refetch keeps the next
    // copy_from_target working even though the smoke body cannot.
    const postGrowthStack = debuggerExports.stackSave();
    const postGrowthCopyAddress = debuggerExports.stackAlloc(8);
    const runtimePagesBefore = runtimeExports.memory.buffer.byteLength / 0x10000;
    const debuggerPagesBefore = debuggerExports.memory.buffer.byteLength / 0x10000;
    const runtimeGrowResult = runtimeExports.memory.grow(1);
    const debuggerGrowResult = debuggerExports.memory.grow(1);
    const runtimePagesAfter = runtimeExports.memory.buffer.byteLength / 0x10000;
    const debuggerPagesAfter = debuggerExports.memory.buffer.byteLength / 0x10000;
    const postGrowthCopyResult = debuggerModule._coreclr_wasm_dbi_dac_copy_from_target(runtimeDescriptorAddress, postGrowthCopyAddress, 8) | 0;
    const postGrowthCopiedMagic = new DataView(getDebuggerHeap().buffer, postGrowthCopyAddress, 8).getBigUint64(0, true);
    debuggerExports.stackRestore(postGrowthStack);

    const result = {
        abiVersion,
        componentMask,
        separateMemories: true,
        cordbFirstResult,
        versionBlobResult,
        versionBlobBytesWritten,
        versionBlob: {
            magic: `0x${versionBlob.magic.toString(16)}`,
            blobSize: versionBlob.blobSize,
            abiVersion: versionBlob.abiVersion,
            protocolBreakingChangeCounter: versionBlob.protocolBreakingChangeCounter,
            componentMask: `0x${versionBlob.componentMask.toString(16)}`,
            sidecarBuildVersionMS: versionBlob.sidecarBuildVersionMS,
            sidecarBuildVersionLS: versionBlob.sidecarBuildVersionLS,
            reserved: versionBlob.reserved
        },
        checkProtocol: {
            match: checkProtocolMatchResult,
            badMagic: `0x${(checkProtocolBadMagicResult >>> 0).toString(16)}`,
            badAbi: `0x${(checkProtocolBadAbiResult >>> 0).toString(16)}`,
            badCounter: `0x${(checkProtocolBadCounterResult >>> 0).toString(16)}`
        },
        handshake: {
            sessionDestroyBeforeAck: `0x${(sessionDestroyBeforeAckResult >>> 0).toString(16)}`,
            sessionCreateBeforeAck: `0x${(sessionCreateBeforeAckResult >>> 0).toString(16)}`,
            ackBadMagic: `0x${(ackBadMagicResult >>> 0).toString(16)}`,
            sessionCreateAfterBadAck: `0x${(sessionCreateAfterBadAckResult >>> 0).toString(16)}`,
            ackBadAbi: `0x${(ackBadAbiResult >>> 0).toString(16)}`,
            ackBadCounter: `0x${(ackBadCounterResult >>> 0).toString(16)}`,
            ack: ackResult,
            ackAgain: ackAgainResult
        },
        descriptorResult,
        magic: `0x${descriptor.magic.toString(16)}`,
        flags: descriptor.flags,
        descriptorSize: descriptor.descriptorSize,
        descriptorAddress: `0x${descriptor.descriptorAddress.toString(16)}`,
        pointerDataCount: descriptor.pointerDataCount,
        pointerDataAddress: `0x${descriptor.pointerDataAddress.toString(16)}`,
        pointerDataResult,
        threadStoreGlobalSlot: `0x${threadStoreGlobalSlot.toString(16)}`,
        threadStoreValue: `0x${threadStoreValue.toString(16)}`,
        testDataResult,
        testData: {
            magic: `0x${testData.magic.toString(16)}`,
            int32Value: testData.int32Value,
            doubleValue: testData.doubleValue,
            vectorLanes: testData.vectorLanes.map(value => `0x${value.toString(16)}`),
            message: testData.message
        },
        breakpointControlResult,
        breakpointControl: controlProbe,
        platform: {
            result: platformResult,
            value: `0x${(platformValue >>> 0).toString(16)}`,
            isWasm32: platformValue === CORDB_PLATFORM_WASM32,
            nullOutResult: platformNullOutResult
        },
        session: {
            createResult: sessionCreateResult,
            createProcessResult: sessionCreateProcessResult,
            connectResult: sessionConnectResult,
            transportSendResult,
            transportGetResult,
            event: sessionEvent,
            disconnectResult: sessionDisconnectResult,
            destroyResult: sessionDestroyResult
        },
        symbolResult,
        symbolAddress: `0x${symbolAddress.toString(16)}`,
        symbolRobustness: {
            empty: symbolEmptyResult,
            nullAddress: symbolNullAddressResult,
            tooLong: symbolTooLongResult,
            addressOverflow: symbolAddressOverflowResult,
            nullOut: symbolNullOutResult
        },
        copyResult,
        copyRobustness: {
            zeroBytes: copyZeroBytesResult,
            nullDebuggerDest: copyNullDebuggerDestResult,
            targetOverflow: copyTargetOverflowResult,
            debuggerOverflow: copyDebuggerOverflowResult,
            oversized: copyOversizedResult
        },
        pageCache: {
            getStatsResult: pageCacheStatsResult,
            invalidateResult: pageCacheInvalidateResult,
            statsAfterInvalidateResult: pageCacheStatsAfterInvalidateResult,
            statsAfterReprobeResult: pageCacheStatsAfterReprobeResult,
            reprobeResult,
            before: pageCacheStatsBefore,
            afterInvalidate: pageCacheStatsAfterInvalidate,
            afterReprobe: pageCacheStatsAfterReprobe
        },
        memoryGrowth: {
            runtimeGrowResult,
            debuggerGrowResult,
            runtimePagesBefore,
            runtimePagesAfter,
            debuggerPagesBefore,
            debuggerPagesAfter,
            postGrowthCopyResult,
            postGrowthCopiedMagic: `0x${postGrowthCopiedMagic.toString(16)}`
        },
        copiedMagic: `0x${copiedMagic.toString(16)}`,
        gDacTable: `0x${(runtimeExports.Getg_dacTable() >>> 0).toString(16)}`,
        clrDataResult,
        dacDbiResult,
        cordbSecondResult,
        dacConsistencyProbeResult,
        dacConsistencyHr: `0x${(dacConsistencyHr >>> 0).toString(16)}`,
        dataTargetQiResult,
        dataTargetQiFlags: `0x${dataTargetQiFlags.toString(16)}`,
        clrInstanceIdProbe: {
            result: clrInstanceIdProbeResult,
            value: `0x${clrInstanceIdValue.toString(16)}`,
            hr: `0x${(clrInstanceIdHr >>> 0).toString(16)}`,
            matchesHostDescriptor: clrInstanceIdValue === (runtimeDescriptorAddress >>> 0)
        },
        createEventsProbe: {
            result: createEventsProbeResult,
            flags: `0x${createEventsFlags.toString(16)}`,
            hr: `0x${(createEventsHr >>> 0).toString(16)}`
        },
        staticDacBindingProbe: {
            result: staticDacBindingProbeResult,
            createHr: `0x${(staticDacBindingCreateHr >>> 0).toString(16)}`,
            consistencyHr: `0x${(staticDacBindingConsistencyHr >>> 0).toString(16)}`
        },
        openVirtualProcessProbe: {
            result: openVirtualProcessProbeResult,
            hr: `0x${(openVirtualProcessHr >>> 0).toString(16)}`,
            hasRealCordbProcess: openVirtualProcessHasReal
        },
        dbgIpcEventBreakpointRoundtrip: {
            result: dbgIpcEventProbeResult,
            equal: dbgIpcEventEqual,
            magic: `0x${dbgIpcEventMagic.toString(16)}`,
            type: `0x${dbgIpcEventType.toString(16)}`,
            funcMetadataToken: `0x${dbgIpcEventFuncToken.toString(16)}`,
            offset: `0x${dbgIpcEventOffset.toString(16)}`
        },
        connectionStateGate: {
            initial: connectionInitial,
            prevOnSet: connectionPrevOnSet,
            afterSet: connectionAfterSet,
            prevOnClear: connectionPrevOnClear,
            afterClear: connectionAfterClear
        },
        asyncBreakFacade: {
            requestBeforeAck: asyncBreakRequestBeforeAckResult,
            requestAfterAck: asyncBreakRequestAfterAckResult,
            initial: asyncBreakInitial,
            prevOnSet: asyncBreakPrevOnSet,
            afterSet: asyncBreakAfterSet,
            prevOnClear: asyncBreakPrevOnClear,
            afterClear: asyncBreakAfterClear
        },
        interpreterStepHelperProbe: {
            size: interpreterStepHelperProbeSize
        },
        methodEnterQueryProbe: {
            count: methodEnterQueryCount
        },
        dacGlobalsProbeResult,
        dacGlobalsAllNonZero,
        dacGlobals,
        multiBpProbe,
        typeSystemEnumeration
    };

    console.log(JSON.stringify(result, null, 2));

    if (abiVersion !== ExpectedAbiVersion ||
        componentMask !== ExpectedComponentMask ||
        cordbFirstResult !== 0 ||
        versionBlobResult !== 0 ||
        versionBlobBytesWritten !== ExpectedVersionBlobSize ||
        versionBlob.magic !== ExpectedVersionBlobMagic ||
        versionBlob.blobSize !== ExpectedVersionBlobSize ||
        versionBlob.abiVersion !== ExpectedAbiVersion ||
        versionBlob.protocolBreakingChangeCounter !== ExpectedProtocolBreakingChangeCounter ||
        versionBlob.componentMask !== ExpectedComponentMask ||
        versionBlob.sidecarBuildVersionMS !== 0 ||
        versionBlob.sidecarBuildVersionLS !== 0 ||
        versionBlob.reserved !== 0 ||
        checkProtocolMatchResult !== 0 ||
        checkProtocolBadMagicResult !== HrIncompatibleProtocol ||
        checkProtocolBadAbiResult !== HrIncompatibleProtocol ||
        checkProtocolBadCounterResult !== HrIncompatibleProtocol ||
        asyncBreakRequestBeforeAckResult !== 0 ||
        sessionCreateBeforeAckResult !== HrIncompatibleProtocol ||
        sessionDestroyBeforeAckResult !== 0 ||
        ackBadMagicResult !== HrIncompatibleProtocol ||
        sessionCreateAfterBadAckResult !== HrIncompatibleProtocol ||
        ackBadAbiResult !== HrIncompatibleProtocol ||
        ackBadCounterResult !== HrIncompatibleProtocol ||
        ackResult !== 0 ||
        ackAgainResult !== 0 ||
        descriptorResult !== 0 ||
        descriptor.magic !== ContractDescriptorMagic ||
        descriptor.descriptorSize === 0 ||
        descriptor.descriptorAddress === 0 ||
        descriptor.pointerDataCount === 0 ||
        descriptor.pointerDataAddress === 0 ||
        pointerDataResult !== 0 ||
        threadStoreGlobalSlot === 0 ||
        testDataResult !== 0 ||
        testData.magic !== TestDataMagic ||
        testData.int32Value !== 123456789 ||
        testData.doubleValue !== 1234.5 ||
        testData.vectorLanes[0] !== 0x01234567 ||
        testData.vectorLanes[1] !== 0x89abcdef ||
        testData.vectorLanes[2] !== 0xfedcba98 ||
        testData.vectorLanes[3] !== 0x76543210 ||
        testData.message !== "wasm-dbi-dac" ||
        breakpointControlResult !== 0 ||
        controlProbe.createCordbResult !== 0 ||
        controlProbe.initializeResult !== 0 ||
        controlProbe.createProcessResult !== E_NOTIMPL ||
        controlProbe.breakpointResult !== E_NOTIMPL ||
        platformResult !== 0 ||
        platformValue !== CORDB_PLATFORM_WASM32 ||
        platformNullOutResult !== -1 ||
        sessionCreateResult !== 0 ||
        sessionCreateProcessResult !== E_NOTIMPL ||
        sessionConnectResult !== 0 ||
        transportSendResult !== 0 ||
        transportGetResult !== 0 ||
        sessionEvent !== `runtime-event:${TransportMessage}` ||
        sessionDisconnectResult !== 0 ||
        sessionDestroyResult !== 0 ||
        symbolResult !== 0 ||
        symbolAddress !== runtimeDescriptorAddress ||
        symbolEmptyResult !== InvalidSymbolName ||
        symbolNullAddressResult !== InvalidSymbolName ||
        symbolTooLongResult !== InvalidSymbolName ||
        symbolAddressOverflowResult !== InvalidSymbolName ||
        symbolNullOutResult !== InvalidArgument ||
        copyResult !== 0 ||
        copyZeroBytesResult !== 0 ||
        copyNullDebuggerDestResult !== InvalidArgument ||
        copyTargetOverflowResult !== InvalidReadRange ||
        copyDebuggerOverflowResult !== InvalidReadRange ||
        copyOversizedResult !== InvalidReadRange ||
        pageCacheStatsResult !== 0 ||
        pageCacheInvalidateResult !== 0 ||
        pageCacheStatsAfterInvalidateResult !== 0 ||
        pageCacheStatsAfterReprobeResult !== 0 ||
        reprobeResult !== 0 ||
        pageCacheStatsBefore.epoch < 1 ||
        pageCacheStatsBefore.hits < 1 ||
        pageCacheStatsBefore.misses < 1 ||
        pageCacheStatsBefore.bypasses !== 0 ||
        pageCacheStatsAfterInvalidate.epoch !== pageCacheStatsBefore.epoch + 1 ||
        pageCacheStatsAfterInvalidate.invalidations !== pageCacheStatsBefore.invalidations + 1 ||
        pageCacheStatsAfterInvalidate.hits !== pageCacheStatsBefore.hits ||
        pageCacheStatsAfterInvalidate.misses !== pageCacheStatsBefore.misses ||
        pageCacheStatsAfterReprobe.epoch !== pageCacheStatsAfterInvalidate.epoch ||
        pageCacheStatsAfterReprobe.invalidations !== pageCacheStatsAfterInvalidate.invalidations ||
        pageCacheStatsAfterReprobe.misses !== pageCacheStatsAfterInvalidate.misses + 1 ||
        pageCacheStatsAfterReprobe.hits !== pageCacheStatsAfterInvalidate.hits ||
        runtimeGrowResult < 0 ||
        debuggerGrowResult < 0 ||
        runtimePagesAfter !== runtimePagesBefore + 1 ||
        debuggerPagesAfter !== debuggerPagesBefore + 1 ||
        postGrowthCopyResult !== 0 ||
        postGrowthCopiedMagic !== ContractDescriptorMagic ||
        copiedMagic !== ContractDescriptorMagic ||
        clrDataResult !== 0 ||
        dacDbiResult !== 0 ||
        cordbSecondResult !== 0 ||
        dacConsistencyProbeResult !== 0 ||
        dacConsistencyHr !== 0 ||
        dataTargetQiResult !== 0 ||
        dataTargetQiFlags !== 0x0f ||
        clrInstanceIdProbeResult !== 0 ||
        clrInstanceIdHr !== 0 ||
        clrInstanceIdValue === 0 ||
        clrInstanceIdValue !== (runtimeDescriptorAddress >>> 0) ||
        createEventsProbeResult !== 0 ||
        createEventsFlags !== 0x7 ||
        createEventsHr !== 0 ||
        staticDacBindingProbeResult !== 0 ||
        staticDacBindingCreateHr !== 0 ||
        staticDacBindingConsistencyHr !== 0 ||
        openVirtualProcessProbeResult !== 0 ||
        openVirtualProcessHr !== 0 ||
        openVirtualProcessHasReal !== 1 ||
        dbgIpcEventProbeResult !== 0 ||
        dbgIpcEventEqual !== 1 ||
        dbgIpcEventMagic !== 0x42435049 ||
        dbgIpcEventType !== 0x100 ||
        dbgIpcEventFuncToken !== 0x06000042 ||
        dbgIpcEventOffset !== 0x10 ||
        connectionInitial !== 0 ||
        connectionPrevOnSet !== 0 ||
        connectionAfterSet !== 1 ||
        connectionPrevOnClear !== 1 ||
        connectionAfterClear !== 0 ||
        asyncBreakInitial !== 0 ||
        asyncBreakPrevOnSet !== 0 ||
        asyncBreakAfterSet !== 1 ||
        asyncBreakPrevOnClear !== 1 ||
        asyncBreakAfterClear !== 0 ||
        asyncBreakRequestAfterAckResult !== 0 ||
        interpreterStepHelperProbeSize === 0 ||
        dacGlobalsProbeResult !== DacGlobalsProbeSlotCount ||
        !dacGlobalsAllNonZero ||
        multiBpSendA !== 0 ||
        multiBpSendB !== 0 ||
        multiBpSendC !== 0 ||
        multiBpCountAfterThree !== multiBpInitialCount + 3 ||
        multiBpSlotSize !== ExpectedBreakpointSlotSize ||
        multiBpSlotCapacity !== 16 ||
        multiBpAckResult !== 0 ||
        multiBpSessionCreateResult !== 0 ||
        multiBpSessionConnectResult !== 0 ||
        multiBpEnumerateSmallResult !== BufferTooSmall ||
        multiBpEnumerateSmallBytesWritten !== multiBpEnumerationLength ||
        multiBpEnumerateResult !== 0 ||
        multiBpEnumerateBytesWritten !== multiBpEnumerationLength ||
        multiBpEnumeration.capacity !== 16 ||
        multiBpEnumeration.activeCount !== multiBpInitialCount + 3 ||
        !multiBpExpectedNamesPresent ||
        !multiBpNamedSlotsHaveExpectedFields ||
        multiBpClearedB !== 1 ||
        multiBpCountAfterClearB !== multiBpInitialCount + 2 ||
        multiBpClearedA !== 1 ||
        multiBpClearedC !== 1 ||
        multiBpCountFinal !== multiBpInitialCount ||
        multiBpEnumerateAfterClearResult !== 0 ||
        multiBpEnumerateAfterClearBytesWritten !== multiBpEnumerationLength ||
        multiBpEnumerationAfterClear.capacity !== 16 ||
        multiBpEnumerationAfterClear.activeCount !== multiBpInitialCount ||
        !multiBpExpectedNamesCleared ||
        multiBpDisconnectResult !== 0 ||
        multiBpSessionDestroyResult !== 0 ||
        typeSystemAppRunResult !== 0 ||
        typeSystemAckResult !== 0 ||
        typeSystemSessionCreateResult !== 0 ||
        typeSystemSessionConnectResult !== 0 ||
        appDomainsResult !== 0 ||
        appDomainsBytesWritten !== EnumerationHeaderSize + (appDomainsEnumeration.count * AppDomainEntrySize) ||
        appDomainsEnumeration.capacity !== AppDomainEnumerationCapacity ||
        appDomainsEnumeration.count < 1 ||
        defaultAppDomain === undefined ||
        assemblyEnumerations.length !== appDomainsEnumeration.count ||
        !assemblyEnumerationsAllSucceeded ||
        defaultAssemblyEnumeration.count <= 10 ||
        !assemblyNamesAndPathsNonEmpty ||
        coreLibAssembly === undefined ||
        enumerateCoreLibModulesResult !== 0 ||
        enumerateCoreLibModulesBytesWritten !== EnumerationHeaderSize + (coreLibModulesEnumeration.count * ModuleEntrySize) ||
        coreLibModulesEnumeration.count < 1 ||
        !coreLibModulesNonEmpty ||
        userAssembly === undefined ||
        enumerateUserModulesResult !== 0 ||
        enumerateUserModulesBytesWritten !== EnumerationHeaderSize + (userModulesEnumeration.count * ModuleEntrySize) ||
        userModulesEnumeration.count !== 1 ||
        !userModulesNonEmpty ||
        typeSystemDisconnectResult !== 0 ||
        typeSystemSessionDestroyResult !== 0 ||
        multiBpClearedMissing !== 0 ||
        fillerSendNonZero !== 0 ||
        exhaustionOverflowRc !== -1 ||
        exhaustionCountAtCap !== 16 ||
        fillerClearedTotal !== remainingSlots ||
        exhaustionCountAfterCleanup !== multiBpInitialCount) {
        fail("WASM DBI/DAC smoke test failed");
    }
}

main().catch(error => {
    console.error(error.stack || error);
    process.exitCode = 1;
});
