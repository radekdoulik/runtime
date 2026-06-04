// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { performance } = require("perf_hooks");
const { pathToFileURL } = require("url");
const { spawnSync } = require("child_process");

const BreakpointMethodName = "BreakHereWithLocals";
const CommandRecordMagic = 0x434d4457;
const CommandRecordSize = 80;
const ExpectedLocalTypeTags = [0x08, 0x0a, 0x0d]; // int, long, double

// Must match VersionBlob in dbi_dac_wasm.cpp / smoke-test.js. The host has
// to acknowledge the protocol once per session before any gated DBI entry
// point will run (CORDBG_E_INCOMPATIBLE_PROTOCOL otherwise).
const ExpectedVersionBlobMagic = 0x42564457; // 'WDVB' little-endian
const ExpectedAbiVersion = 1;
const ExpectedProtocolBreakingChangeCounter = 9;

function fail(message) {
    throw new Error(message);
}

function requireFile(filePath, description) {
    if (!fs.existsSync(filePath)) {
        fail(`${description} not found: ${filePath}`);
    }
}

function writeBytes(memory, address, bytes) {
    memory.set(bytes, address);
}

function writeUint64(memory, address, value) {
    new DataView(memory.buffer).setBigUint64(address, BigInt(value), true);
}

function readAscii(memory, address, byteCount) {
    let result = "";
    for (let index = 0; index < byteCount; index++) {
        result += String.fromCharCode(memory[address + index]);
    }

    return result;
}

function readNullTerminatedAscii(memory, address, byteCount) {
    let result = "";
    for (let index = 0; index < byteCount && memory[address + index] !== 0; index++) {
        result += String.fromCharCode(memory[address + index]);
    }

    return result;
}

async function loadDebugger(debuggerJsPath, sendToRuntime) {
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
            const hostImports = {
                read_target_memory(targetAddress, debuggerAddress, byteCount) {
                    if (typeof globalThis.CoreClrWasmDebugReadTargetMemory !== "function") {
                        return -1;
                    }

                    return globalThis.CoreClrWasmDebugReadTargetMemory(targetAddress >>> 0, debuggerAddress >>> 0, byteCount >>> 0);
                },
                get_symbol_address(baseAddress, symbolNameAddress, symbolNameLength, addressOutAddress) {
                    if (typeof globalThis.CoreClrWasmDebugGetSymbolAddress !== "function") {
                        return -1;
                    }

                    return globalThis.CoreClrWasmDebugGetSymbolAddress(
                        baseAddress >>> 0,
                        symbolNameAddress >>> 0,
                        symbolNameLength >>> 0,
                        addressOutAddress >>> 0);
                },
                get_target_module_base(imageNameAddress, imageNameCharCount, addressOutAddress) {
                    if (typeof globalThis.CoreClrWasmDebugGetTargetModuleBase !== "function") {
                        return -1;
                    }

                    return globalThis.CoreClrWasmDebugGetTargetModuleBase(
                        imageNameAddress >>> 0,
                        imageNameCharCount >>> 0,
                        addressOutAddress >>> 0);
                },
                send_ipc_to_runtime(messageAddress, messageLength) {
                    return sendToRuntime(messageAddress >>> 0, messageLength >>> 0);
                },
                submit_continue_request(requestBytesAddress, requestBytesLength) {
                    if (typeof globalThis.CoreClrWasmDebugSubmitContinueRequest !== "function") {
                        return -1;
                    }

                    return globalThis.CoreClrWasmDebugSubmitContinueRequest(
                        requestBytesAddress >>> 0,
                        requestBytesLength >>> 0);
                },
                submit_step_into_request(requestBytesAddress, requestBytesLength) {
                    if (typeof globalThis.CoreClrWasmDebugSubmitStepIntoRequest !== "function") {
                        return -1;
                    }

                    return globalThis.CoreClrWasmDebugSubmitStepIntoRequest(
                        requestBytesAddress >>> 0,
                        requestBytesLength >>> 0);
                }
            };

            Object.assign(imports.env, hostImports);
            imports.coreclr_dbi_dac = hostImports;

            const wasmPath = path.join(debuggerDirectory, "coreclr-dbi-dac-tests.wasm");
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

function buildHelloWorld(repoRoot) {
    const testDirectory = path.join(repoRoot, "artifacts", "wasm-dbi-dac-smoke", "hello-breakpoint");
    const assemblyName = "HelloBreakpoint";
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
using System.Runtime.CompilerServices;

namespace HelloSmoke;

public static class Program
{
    public static void Main()
    {
        Console.WriteLine("before");
        HelloBreakpointTarget.BreakHereWithLocals();
        Console.WriteLine("after");
    }
}

public static class HelloBreakpointTarget
{
    [MethodImpl(MethodImplOptions.NoInlining)]
    public static void BreakHere() => Console.WriteLine("break here");

    [MethodImpl(MethodImplOptions.NoInlining)]
    public static void BreakHereWithLocals()
    {
        int localInt = 42;
        long localLong = localInt + 1L;
        double localDouble = localLong + 0.5;
        Consume(localInt, localLong, localDouble);
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void Consume(int localInt, long localLong, double localDouble)
        => Console.WriteLine($"break here {localInt} {localLong} {localDouble}");
}
`);

    const result = spawnSync(
        path.join(repoRoot, "dotnet.sh"),
        ["build", projectPath, "-c", "Debug", "-v:minimal"],
        { encoding: "utf8" });
    if (result.status !== 0) {
        process.stdout.write(result.stdout);
        process.stderr.write(result.stderr);
        fail(`failed to build HelloWorld test app: ${result.status}`);
    }

    const outputMatch = [...result.stdout.matchAll(/-> (.*\.dll)$/gm)]
        .map(match => match[1])
        .find(outputPath => path.basename(outputPath) === `${assemblyName}.dll`);
    if (outputMatch !== undefined) {
        return outputMatch;
    }

    return path.join(testDirectory, "bin/Debug/net11.0", `${assemblyName}.dll`);
}

async function loadAndRunRuntime(runtimeJsPath, appPath, sharedFrameworkPath, onRuntimeInstantiated) {
    const runtimeDirectory = path.dirname(runtimeJsPath);
    let source = fs.readFileSync(runtimeJsPath, "utf8");

    source = source.replaceAll("import.meta.url", JSON.stringify(pathToFileURL(runtimeJsPath).href));
    source = source.replaceAll(
        "dotnetLogger = {};",
        "dotnetLogger = { debug() {}, info() {}, warn() {}, error() {} };");
    source = source.replace(/if \(_isNode\) \{\s*selfRun\(\);\s*\}\s*$/m, "");

    const moduleFactory = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
    const oldInterpMode = process.env.DOTNET_InterpMode;
    const oldReadyToRun = process.env.DOTNET_ReadyToRun;
    process.env.DOTNET_InterpMode = "3";
    process.env.DOTNET_ReadyToRun = "0";
    try {
        await new Promise((resolve, reject) => {
            const moduleConfig = {
                noExitRuntime: true,
                arguments: ["-c", sharedFrameworkPath, appPath],
                locateFile: fileName => path.join(runtimeDirectory, fileName),
                print(text) {
                    process.stdout.write(`${text}\n`);
                },
                printErr(text) {
                    if (!String(text).startsWith("program exited (with status: 0), but keepRuntimeAlive()")) {
                        process.stderr.write(`${text}\n`);
                    }
                },
                instantiateWasm(imports, receiveInstance) {
                    const wasmPath = path.join(runtimeDirectory, "corerun.wasm");
                    WebAssembly.instantiate(fs.readFileSync(wasmPath), imports).then(({ instance, module }) => {
                        onRuntimeInstantiated(instance);
                        receiveInstance(instance, module);
                        resolve();
                    }).catch(reject);

                    return {};
                }
            };

            moduleFactory.selfRun(moduleConfig);
        });
    } finally {
        if (oldInterpMode === undefined) {
            delete process.env.DOTNET_InterpMode;
        } else {
            process.env.DOTNET_InterpMode = oldInterpMode;
        }

        if (oldReadyToRun === undefined) {
            delete process.env.DOTNET_ReadyToRun;
        } else {
            process.env.DOTNET_ReadyToRun = oldReadyToRun;
        }
    }
}

async function waitForBreakpointHit(runtimeExports) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
        const hitCount = runtimeExports.CoreClrWasmDebugGetBreakpointHitCount();
        if (hitCount !== 0) {
            const runtimeMemory = new Uint8Array(runtimeExports.memory.buffer);
            const eventLength = runtimeExports.CoreClrWasmDebugGetLastEventLength();
            const stack = runtimeExports.stackSave();
            const eventAddress = runtimeExports.stackAlloc(eventLength);
            const copyResult = runtimeExports.CoreClrWasmDebugCopyLastEvent(eventAddress, eventLength);
            const event = copyResult === 0 ? readAscii(runtimeMemory, eventAddress, eventLength) : "";
            runtimeExports.stackRestore(stack);

            return { hitCount, event, copyResult };
        }

        await new Promise(resolve => setTimeout(resolve, 10));
    }

    return { hitCount: 0, event: "", copyResult: -1 };
}

function pollDbiEvent(debuggerInstance) {
    const stack = debuggerInstance.exports.stackSave();
    const eventAddress = debuggerInstance.exports.stackAlloc(256);
    const bytesWrittenAddress = debuggerInstance.exports.stackAlloc(4);
    const pollResult = debuggerInstance.module._coreclr_wasm_dbi_dac_dbi_poll_event(eventAddress, 256, bytesWrittenAddress);
    const bytesWritten = new DataView(debuggerInstance.module.HEAPU8.buffer, bytesWrittenAddress, 4).getUint32(0, true);
    const event = pollResult === 0 ? readAscii(debuggerInstance.module.HEAPU8, eventAddress, bytesWritten) : "";
    debuggerInstance.exports.stackRestore(stack);

    return { pollResult, event, bytesWritten };
}

function readEventRecord(memory, address) {
    const view = new DataView(memory.buffer, address, 340);
    return {
        kind: view.getUint32(0, true),
        methodToken: view.getUint32(4, true),
        ilOffset: view.getUint32(8, true),
        hitCount: view.getUint32(12, true),
        continueCount: view.getUint32(16, true),
        methodName: readNullTerminatedAscii(memory, address + 20, 64),
        message: readNullTerminatedAscii(memory, address + 84, 256)
    };
}

function pollDbiEventRecord(debuggerInstance) {
    const stack = debuggerInstance.exports.stackSave();
    const recordAddress = debuggerInstance.exports.stackAlloc(340);
    const bytesWrittenAddress = debuggerInstance.exports.stackAlloc(4);
    const pollResult = debuggerInstance.module._coreclr_wasm_dbi_dac_dbi_poll_event_record(recordAddress, 340, bytesWrittenAddress);
    const bytesWritten = new DataView(debuggerInstance.module.HEAPU8.buffer, bytesWrittenAddress, 4).getUint32(0, true);
    const record = pollResult === 0 ? readEventRecord(debuggerInstance.module.HEAPU8, recordAddress) : null;
    debuggerInstance.exports.stackRestore(stack);

    return { pollResult, bytesWritten, record };
}

// Phase 4 slice 3: poll the structured DebuggerIPCEvent payload via
// the sidecar's coreclr_wasm_dbi_dac_dbi_poll_ipc_event export. The
// sidecar resolves the runtime symbols (g_wasmDebugLastIpcEventValid,
// g_wasmDebugLastIpcEvent) once and drains via WasmDacDataTarget
// ReadVirtual — the same DAC path real mscordbi would use. Field
// offsets match WasmDbgIpcEventBreakpointRuntime in
// src/coreclr/vm/wasm/dbi-control-plane.cpp:
//   0:Magic 4:Type 8:ProcessId 12:ThreadId
//   16:VmAppDomain(8) 24:VmThread(8)
//   32:Hr 36:Flags 40:BreakpointToken(8)
//   48:FuncMetadataToken 52:Reserved0
//   56:VmAssembly(8) 64:IsIL 68:Offset 72:EncVersion
//   76:Reserved1 80:NativeCodeMethodDescToken(8) 88:CodeStartAddress(8)
function pollDbiIpcEvent(debuggerInstance) {
    const stack = debuggerInstance.exports.stackSave();
    const eventAddress = debuggerInstance.exports.stackAlloc(96);
    const bytesWrittenAddress = debuggerInstance.exports.stackAlloc(4);
    const pollResult = debuggerInstance.module._coreclr_wasm_dbi_dac_dbi_poll_ipc_event(eventAddress, 96, bytesWrittenAddress);
    const bytesWritten = new DataView(debuggerInstance.module.HEAPU8.buffer, bytesWrittenAddress, 4).getUint32(0, true);
    let payload = null;
    if (pollResult === 0 && bytesWritten === 96) {
        const view = new DataView(debuggerInstance.module.HEAPU8.buffer, eventAddress, 96);
        payload = {
            magic: view.getUint32(0, true),
            type: view.getUint32(4, true),
            processId: view.getUint32(8, true),
            threadId: view.getUint32(12, true),
            hr: view.getInt32(32, true),
            flags: view.getUint32(36, true),
            breakpointToken: view.getBigUint64(40, true),
            funcMetadataToken: view.getUint32(48, true),
            isIL: view.getUint32(64, true),
            offset: view.getUint32(68, true),
            encVersion: view.getUint32(72, true)
        };
    }
    debuggerInstance.exports.stackRestore(stack);

    return { pollResult, bytesWritten, payload };
}

function readFrameRecord(memory, address) {
    const view = new DataView(memory.buffer, address, 88);
    return {
        methodToken: view.getUint32(0, true),
        ilOffset: view.getUint32(4, true),
        interpreterIP: view.getUint32(8, true),
        frameAddress: view.getUint32(12, true),
        stackAddress: view.getUint32(16, true),
        firstStackSlotI32: view.getInt32(20, true),
        methodName: readNullTerminatedAscii(memory, address + 24, 64)
    };
}

function pollDbiFrameRecord(debuggerInstance) {
    const stack = debuggerInstance.exports.stackSave();
    const recordAddress = debuggerInstance.exports.stackAlloc(88);
    const bytesWrittenAddress = debuggerInstance.exports.stackAlloc(4);
    const pollResult = debuggerInstance.module._coreclr_wasm_dbi_dac_dbi_poll_frame_record(recordAddress, 88, bytesWrittenAddress);
    const bytesWritten = new DataView(debuggerInstance.module.HEAPU8.buffer, bytesWrittenAddress, 4).getUint32(0, true);
    const record = pollResult === 0 ? readFrameRecord(debuggerInstance.module.HEAPU8, recordAddress) : null;
    debuggerInstance.exports.stackRestore(stack);

    return { pollResult, bytesWritten, record };
}

function readLocalsRecord(memory, address) {
    const view = new DataView(memory.buffer, address, 1552);
    const localCount = view.getUint32(12, true);
    const locals = [];
    for (let index = 0; index < Math.min(localCount, 32); index++) {
        const localOffset = 16 + (index * 48);
        locals.push({
            ilSlot: view.getUint32(localOffset, true),
            typeTag: view.getUint32(localOffset + 4, true),
            byteOffset: view.getUint32(localOffset + 8, true),
            byteSize: view.getUint32(localOffset + 12, true),
            name: readNullTerminatedAscii(memory, address + localOffset + 16, 32)
        });
    }

    return {
        magic: view.getUint32(0, true),
        version: view.getUint32(4, true),
        methodToken: view.getUint32(8, true),
        localCount,
        locals
    };
}

function pollDbiLocals(debuggerInstance) {
    const recordSize = 1552;
    const stack = debuggerInstance.exports.stackSave();
    const recordAddress = debuggerInstance.exports.stackAlloc(recordSize);
    const bytesWrittenAddress = debuggerInstance.exports.stackAlloc(4);
    const pollResult = debuggerInstance.module._coreclr_wasm_dbi_dac_dbi_enumerate_locals(recordAddress, recordSize, bytesWrittenAddress);
    const bytesWritten = new DataView(debuggerInstance.module.HEAPU8.buffer, bytesWrittenAddress, 4).getUint32(0, true);
    const record = pollResult === 0 ? readLocalsRecord(debuggerInstance.module.HEAPU8, recordAddress) : null;
    debuggerInstance.exports.stackRestore(stack);

    return { pollResult, bytesWritten, record };
}

function pollDbiProcessState(debuggerInstance) {
    const stack = debuggerInstance.exports.stackSave();
    const stateAddress = debuggerInstance.exports.stackAlloc(40);
    const bytesWrittenAddress = debuggerInstance.exports.stackAlloc(4);
    const pollResult = debuggerInstance.module._coreclr_wasm_dbi_dac_dbi_poll_process_state(stateAddress, 40, bytesWrittenAddress);
    const bytesWritten = new DataView(debuggerInstance.module.HEAPU8.buffer, bytesWrittenAddress, 4).getUint32(0, true);
    const view = new DataView(debuggerInstance.module.HEAPU8.buffer, stateAddress, 40);
    const state = pollResult === 0 ? {
        sessionCreated: view.getUint32(0, true),
        connected: view.getUint32(4, true),
        runtimeBase: view.getUint32(8, true),
        syntheticProcessId: view.getUint32(12, true),
        hasRealCordbProcess: view.getUint32(16, true),
        lastEventKind: view.getUint32(20, true),
        lastMethodToken: view.getUint32(24, true),
        lastILOffset: view.getUint32(28, true),
        breakpointHitCount: view.getUint32(32, true),
        continueCount: view.getUint32(36, true)
    } : null;
    debuggerInstance.exports.stackRestore(stack);

    return { pollResult, bytesWritten, state };
}

function readTestData(memory, address) {
    const view = new DataView(memory.buffer, address, 48);
    return {
        magic: view.getUint32(0, true),
        int32Value: view.getInt32(4, true),
        doubleValue: view.getFloat64(8, true),
        vectorLanes: [
            view.getUint32(16, true),
            view.getUint32(20, true),
            view.getUint32(24, true),
            view.getUint32(28, true)
        ],
        message: readNullTerminatedAscii(memory, address + 32, 16)
    };
}

function readDbiTestData(debuggerInstance) {
    const stack = debuggerInstance.exports.stackSave();
    const testDataAddress = debuggerInstance.exports.stackAlloc(48);
    const readResult = debuggerInstance.module._coreclr_wasm_dbi_dac_dbi_read_test_data(testDataAddress);
    const testData = readResult === 0 ? readTestData(debuggerInstance.module.HEAPU8, testDataAddress) : null;
    debuggerInstance.exports.stackRestore(stack);

    return { readResult, testData };
}

async function main() {
    const coreclrObjDirectory = path.resolve(process.cwd(), process.argv[2] ?? "artifacts/obj/coreclr/browser.wasm.Debug");
    const repoRoot = path.resolve(__dirname, "../../../..");
    const runtimeJsPath = path.join(coreclrObjDirectory, "hosts/corerun/corerun.js");
    const debuggerJsPath = path.join(coreclrObjDirectory, "debug/wasm-dbi-dac/coreclr-dbi-dac-tests.js");
    const sharedFrameworkPath = path.join(repoRoot, "artifacts/bin/testhost/net11.0-browser-Debug-wasm/shared/Microsoft.NETCore.App/11.0.0");

    requireFile(runtimeJsPath, "runtime JS wrapper");
    requireFile(debuggerJsPath, "debugger JS wrapper");
    requireFile(sharedFrameworkPath, "browser-wasm testhost shared framework");

    const appPath = buildHelloWorld(repoRoot);

    let runtimeExports;
    let debuggerInstance;
    let sawBreakpointBeforeContinue = false;
    let callbackEvent = "";
    // Phase 6 stop-trigger counter: incremented every time the runtime
    // calls coreClrDebugFireEventToPause (the Mono-pattern JS import that
    // executes `debugger;`). In Node smoke context the `debugger;` is a
    // no-op when no inspector is attached; we only verify the import is
    // actually being invoked with the expected payload.
    let fireEventToPauseCount = 0;
    let fireEventToPauseLastEvent = "";
    let dbiEventDuringCallback = { pollResult: -1, event: "", bytesWritten: 0 };
    let dbiEventRecordDuringCallback = { pollResult: -1, bytesWritten: 0, record: null };
    let dbiFrameRecordDuringCallback = { pollResult: -1, bytesWritten: 0, record: null };
    let dbiLocalsDuringCallback = { pollResult: -1, bytesWritten: 0, record: null };
    let dbiProcessStateDuringCallback = { pollResult: -1, bytesWritten: 0, state: null };
    let testDataDuringCallback = { readResult: -1, testData: null };
    let dbiIpcEventDuringCallback = { pollResult: -1, bytesWritten: 0, payload: null };
    let continueDuringCallbackResult = -1;
    // Phase 4 slice 2: structured DebuggerIPCEvent payload captured by
    // CoreClrWasmDebugReadLastIpcEvent during the breakpoint callback.
    // Asserts the runtime fills the 96-byte WasmDbgIpcEventBreakpoint
    // shape with the expected magic, type, method-token, and a
    // monotonically-incrementing BreakpointToken. The full sidecar
    // end-to-end drain (resolve symbol, copy_from_target, clear flag)
    // is the next slice; this one verifies the runtime side is wired.
    let ipcEventDuringCallback = {
        readBytes: -1,
        magic: 0,
        type: 0,
        funcMetadataToken: 0,
        breakpointToken: 0n,
        isIL: 0,
        offset: 0,
        size: 0
    };

    // Re-fetch typed-array views on every callback. WebAssembly.Memory can
    // grow at any time during real runtime execution (GC heap, stack
    // expansion, native heap allocations); after growth, every prior
    // Uint8Array view becomes detached and access throws "memory access
    // out of bounds". Reading `.buffer` from a live wasm `memory` export
    // always returns the current backing ArrayBuffer.
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
        if (typeof debuggerInstance === "undefined" || !debuggerInstance.exports.memory) {
            fail("getDebuggerHeap called before debuggerInstance.exports.memory was bound");
        }
        return new Uint8Array(debuggerInstance.exports.memory.buffer);
    };

    debuggerInstance = await loadDebugger(debuggerJsPath, (messageAddress, messageLength) => {
        const message = getDebuggerHeap().slice(messageAddress, messageAddress + messageLength);
        const stack = runtimeExports.stackSave();
        const runtimeMessageAddress = runtimeExports.stackAlloc(messageLength);
        // Re-fetch after stackAlloc: it may grow the runtime's memory and
        // detach prior views.
        getRuntimeHeap().set(message, runtimeMessageAddress);
        const result =
            messageLength === CommandRecordSize &&
            new DataView(message.buffer, message.byteOffset, message.byteLength).getUint32(0, true) === CommandRecordMagic
                ? runtimeExports.CoreClrWasmDebugReceiveCommandRecord(runtimeMessageAddress, messageLength)
                : runtimeExports.CoreClrWasmDebugReceiveCommand(runtimeMessageAddress, messageLength);
        runtimeExports.stackRestore(stack);
        return result;
    });

    if (typeof debuggerInstance.exports.memory === "undefined" || typeof debuggerInstance.exports.memory.buffer === "undefined") {
        fail("debugger export 'memory' is missing or does not expose a buffer");
    }

    try {
        await loadAndRunRuntime(runtimeJsPath, appPath, sharedFrameworkPath, instance => {
            runtimeExports = instance.exports;
            if (typeof runtimeExports.memory === "undefined" || typeof runtimeExports.memory.buffer === "undefined") {
                fail("runtime export 'memory' is missing or does not expose a buffer");
            }
            if (typeof runtimeExports.CoreClrWasmDebugGetMethodEnterEnabledQueryCount !== "function") {
                fail("runtime export CoreClrWasmDebugGetMethodEnterEnabledQueryCount is missing");
            }
            globalThis.CoreClrWasmDebugReadTargetMemory = (targetAddress, debuggerAddress, byteCount) => {
                const runtimeHeap = getRuntimeHeap();
                const debuggerHeap = getDebuggerHeap();
                if (targetAddress + byteCount > runtimeHeap.length ||
                    debuggerAddress + byteCount > debuggerHeap.length) {
                    return -1;
                }

                debuggerHeap.set(runtimeHeap.subarray(targetAddress, targetAddress + byteCount), debuggerAddress);
                return 0;
            };
            globalThis.CoreClrWasmDebugGetSymbolAddress = (baseAddress, symbolNameAddress, symbolNameLength, addressOutAddress) => {
                const debuggerHeap = getDebuggerHeap();
                const symbolName = readAscii(debuggerHeap, symbolNameAddress, symbolNameLength);
                const symbolAddress =
                    symbolName === "DotNetRuntimeContractDescriptor" ? runtimeExports.GetDotNetRuntimeContractDescriptor() >>> 0 :
                    symbolName === "g_dacTable" ? runtimeExports.Getg_dacTable() >>> 0 :
                    symbolName === "WasmDbiDacTestData" ? runtimeExports.GetWasmDbiDacTestData() >>> 0 :
                    symbolName === "g_wasmDebugLastIpcEvent" ? runtimeExports.Getg_wasmDebugLastIpcEvent() >>> 0 :
                    symbolName === "g_wasmDebugLastIpcEventValid" ? runtimeExports.Getg_wasmDebugLastIpcEventValid() >>> 0 :
                    symbolName === "g_wasmDebugLastIpcException" ? runtimeExports.Getg_wasmDebugLastIpcException() >>> 0 :
                    symbolName === "g_wasmDebugLastIpcExceptionValid" ? runtimeExports.Getg_wasmDebugLastIpcExceptionValid() >>> 0 :
                    symbolName === "g_wasmDebugLastIpcStepComplete" ? runtimeExports.Getg_wasmDebugLastIpcStepComplete() >>> 0 :
                    symbolName === "g_wasmDebugLastIpcStepCompleteValid" ? runtimeExports.Getg_wasmDebugLastIpcStepCompleteValid() >>> 0 :
                    symbolName === "g_wasmDebugBreakpoints" ? runtimeExports.Getg_wasmDebugBreakpoints() >>> 0 :
                    symbolName === "g_wasmDebugLastLocalsRecord" ? runtimeExports.Getg_wasmDebugLastLocalsRecord() >>> 0 :
                    0;
                if (symbolAddress === 0 || addressOutAddress + 8 > debuggerHeap.length) {
                    return -1;
                }

                writeUint64(debuggerHeap, addressOutAddress, symbolAddress);
                return 0;
            };
            globalThis.CoreClrWasmDebugGetTargetModuleBase = (imageNameAddress, imageNameCharCount, addressOutAddress) => {
                const debuggerHeap = getDebuggerHeap();
                if (addressOutAddress + 8 > debuggerHeap.length) {
                    return -1;
                }

                writeUint64(debuggerHeap, addressOutAddress, 1);
                return 0;
            };
            globalThis.CoreClrWasmDebugSubmitContinueRequest = (requestBytesAddress, requestBytesLength) => {
                const debuggerHeap = getDebuggerHeap();
                if (requestBytesAddress + requestBytesLength > debuggerHeap.length ||
                    typeof runtimeExports.CoreClrWasmDebugSubmitContinueRequest !== "function") {
                    return -1;
                }

                const requestBytes = debuggerHeap.slice(requestBytesAddress, requestBytesAddress + requestBytesLength);
                const savedRuntimeStack = runtimeExports.stackSave();
                try {
                    const runtimeRequestAddress = runtimeExports.stackAlloc(requestBytesLength);
                    getRuntimeHeap().set(requestBytes, runtimeRequestAddress);
                    return runtimeExports.CoreClrWasmDebugSubmitContinueRequest(runtimeRequestAddress, requestBytesLength) | 0;
                } finally {
                    runtimeExports.stackRestore(savedRuntimeStack);
                }
            };
            globalThis.CoreClrWasmDebugSubmitStepIntoRequest = (requestBytesAddress, requestBytesLength) => {
                const debuggerHeap = getDebuggerHeap();
                if (requestBytesAddress + requestBytesLength > debuggerHeap.length ||
                    typeof runtimeExports.CoreClrWasmDebugSubmitStepIntoRequest !== "function") {
                    return -1;
                }

                const requestBytes = debuggerHeap.slice(requestBytesAddress, requestBytesAddress + requestBytesLength);
                const savedRuntimeStack = runtimeExports.stackSave();
                try {
                    const runtimeRequestAddress = runtimeExports.stackAlloc(requestBytesLength);
                    getRuntimeHeap().set(requestBytes, runtimeRequestAddress);
                    return runtimeExports.CoreClrWasmDebugSubmitStepIntoRequest(runtimeRequestAddress, requestBytesLength) | 0;
                } finally {
                    runtimeExports.stackRestore(savedRuntimeStack);
                }
            };
            globalThis.coreClrDebugFireEventToPause = (eventAddress, eventLength) => {
                fireEventToPauseCount++;
                fireEventToPauseLastEvent = readAscii(getRuntimeHeap(), eventAddress >>> 0, eventLength >>> 0);
                return 0;
            };
            globalThis.CoreClrWasmDebugOnBreakpointHit = (eventAddress, eventLength) => {
                const event = readAscii(getRuntimeHeap(), eventAddress >>> 0, eventLength >>> 0);
                callbackEvent = event;
                const eventBytes = new TextEncoder().encode(event);
                const stack = debuggerInstance.exports.stackSave();
                const debuggerEventAddress = debuggerInstance.exports.stackAlloc(eventBytes.length);
                writeBytes(getDebuggerHeap(), debuggerEventAddress, eventBytes);
                const receiveResult = debuggerInstance.module._coreclr_wasm_dbi_dac_receive_runtime_event(debuggerEventAddress, eventBytes.length);
                debuggerInstance.exports.stackRestore(stack);

                if (event.includes(`breakpoint-hit:name=${BreakpointMethodName}`)) {
                    const recordSize = runtimeExports.CoreClrWasmDebugGetLastEventRecordSize();
                    const runtimeStack = runtimeExports.stackSave();
                    const runtimeRecordAddress = runtimeExports.stackAlloc(recordSize);
                    const copyRecordResult = runtimeExports.CoreClrWasmDebugCopyLastEventRecord(runtimeRecordAddress, recordSize);
                    const recordBytes = getRuntimeHeap().slice(runtimeRecordAddress, runtimeRecordAddress + recordSize);
                    runtimeExports.stackRestore(runtimeStack);
                    if (copyRecordResult !== 0) {
                        return copyRecordResult;
                    }

                    const debuggerStack = debuggerInstance.exports.stackSave();
                    const debuggerRecordAddress = debuggerInstance.exports.stackAlloc(recordBytes.length);
                    writeBytes(getDebuggerHeap(), debuggerRecordAddress, recordBytes);
                    const receiveRecordResult = debuggerInstance.module._coreclr_wasm_dbi_dac_receive_runtime_event_record(debuggerRecordAddress, recordBytes.length);
                    debuggerInstance.exports.stackRestore(debuggerStack);
                    if (receiveRecordResult !== 0) {
                        return receiveRecordResult;
                    }

                    const frameRecordSize = runtimeExports.CoreClrWasmDebugGetLastFrameRecordSize();
                    const runtimeFrameStack = runtimeExports.stackSave();
                    const runtimeFrameRecordAddress = runtimeExports.stackAlloc(frameRecordSize);
                    const copyFrameRecordResult = runtimeExports.CoreClrWasmDebugCopyLastFrameRecord(runtimeFrameRecordAddress, frameRecordSize);
                    const frameRecordBytes = getRuntimeHeap().slice(runtimeFrameRecordAddress, runtimeFrameRecordAddress + frameRecordSize);
                    runtimeExports.stackRestore(runtimeFrameStack);
                    if (copyFrameRecordResult !== 0) {
                        return copyFrameRecordResult;
                    }

                    const debuggerFrameStack = debuggerInstance.exports.stackSave();
                    const debuggerFrameRecordAddress = debuggerInstance.exports.stackAlloc(frameRecordBytes.length);
                    writeBytes(getDebuggerHeap(), debuggerFrameRecordAddress, frameRecordBytes);
                    const receiveFrameRecordResult = debuggerInstance.module._coreclr_wasm_dbi_dac_receive_runtime_frame_record(debuggerFrameRecordAddress, frameRecordBytes.length);
                    debuggerInstance.exports.stackRestore(debuggerFrameStack);
                    if (receiveFrameRecordResult !== 0) {
                        return receiveFrameRecordResult;
                    }

                    dbiEventDuringCallback = pollDbiEvent(debuggerInstance);
                    dbiEventRecordDuringCallback = pollDbiEventRecord(debuggerInstance);
                    dbiFrameRecordDuringCallback = pollDbiFrameRecord(debuggerInstance);
                    dbiProcessStateDuringCallback = pollDbiProcessState(debuggerInstance);
                    testDataDuringCallback = readDbiTestData(debuggerInstance);
                    // Phase 4 slice 3: drain the structured DebuggerIPCEvent
                    // payload via the sidecar's poll_ipc_event export. This
                    // is the real DAC path — sidecar resolves runtime
                    // symbols and copies via WasmDacDataTarget ReadVirtual,
                    // no JS-side runtime call. Must run BEFORE the
                    // runtime-side CoreClrWasmDebugReadLastIpcEvent drain
                    // below or the Valid flag will already be 0 when the
                    // sidecar reads it.
                    dbiIpcEventDuringCallback = pollDbiIpcEvent(debuggerInstance);
                    dbiLocalsDuringCallback = pollDbiLocals(debuggerInstance);
                    // Phase 4 slice 2: drain the structured DebuggerIPCEvent
                    // payload directly from the runtime via
                    // CoreClrWasmDebugReadLastIpcEvent. This is the runtime
                    // side of the wire-format the round-trip probe in
                    // smoke-test.js validated; the future sidecar slice 3
                    // will resolve the runtime symbol and drain via
                    // copy_from_target instead.
                    const ipcStack = runtimeExports.stackSave();
                    const ipcSize = runtimeExports.CoreClrWasmDebugGetLastIpcEventSize() | 0;
                    const ipcBuf = runtimeExports.stackAlloc(ipcSize);
                    const ipcReadBytes = runtimeExports.CoreClrWasmDebugReadLastIpcEvent(ipcBuf, ipcSize) | 0;
                    if (ipcReadBytes === 96) {
                        const ipcView = new DataView(runtimeExports.memory.buffer, ipcBuf, ipcSize);
                        // Layout (matches WasmDbgIpcEventBreakpointRuntime in
                        // dbi-control-plane.cpp and WasmDbgIpcEventBreakpoint
                        // in dbi_dac_wasm.cpp byte-for-byte):
                        //   0:Magic 4:Type 8:ProcessId 12:ThreadId
                        //   16:VmAppDomain(8) 24:VmThread(8)
                        //   32:Hr 36:Flags 40:BreakpointToken(8)
                        //   48:FuncMetadataToken 52:Reserved0
                        //   56:VmAssembly(8) 64:IsIL 68:Offset 72:EncVersion
                        //   76:Reserved1 80:NativeCodeMethodDescToken(8)
                        //   88:CodeStartAddress(8)
                        ipcEventDuringCallback = {
                            readBytes: ipcReadBytes,
                            magic: ipcView.getUint32(0, true),
                            type: ipcView.getUint32(4, true),
                            breakpointToken: ipcView.getBigUint64(40, true),
                            funcMetadataToken: ipcView.getUint32(48, true),
                            isIL: ipcView.getUint32(64, true),
                            offset: ipcView.getUint32(68, true),
                            size: ipcSize
                        };
                    } else {
                        ipcEventDuringCallback = { readBytes: ipcReadBytes, magic: 0, type: 0, funcMetadataToken: 0, breakpointToken: 0n, isIL: 0, offset: 0, size: ipcSize };
                    }
                    runtimeExports.stackRestore(ipcStack);
                    const continueToken = dbiIpcEventDuringCallback.payload.breakpointToken;
                    continueDuringCallbackResult = debuggerInstance.module._coreclr_wasm_dbi_dac_dbi_send_ipc_continue_request(
                        Number(continueToken & 0xffffffffn),
                        Number(continueToken >> 32n));
                    sawBreakpointBeforeContinue = true;
                }

                return receiveResult;
            };

            const ackResult = debuggerInstance.module._coreclr_wasm_dbi_dac_acknowledge_protocol(
                ExpectedVersionBlobMagic, ExpectedAbiVersion, ExpectedProtocolBreakingChangeCounter);
            if (ackResult !== 0) {
                fail(`failed to acknowledge sidecar protocol: ${ackResult}`);
            }

            const sessionCreateResult = debuggerInstance.module._coreclr_wasm_dbi_dac_dbi_session_create();
            if (sessionCreateResult !== 0) {
                fail(`failed to create DBI session: ${sessionCreateResult}`);
            }

            const connectResult = debuggerInstance.module._coreclr_wasm_dbi_dac_dbi_connect_runtime(1);
            if (connectResult !== 0) {
                fail(`failed to connect DBI session to runtime: ${connectResult}`);
            }

            // Phase 6 gate: the runtime must not patch interpreter opcodes
            // unless a debugger is connected. The smoke is acting as the
            // debugger here, so flip the connected flag on. Returns the
            // previous value (0 = was disconnected) for sanity-check.
            const prevConnected = runtimeExports.CoreClrWasmDebugSetDebuggerConnected(1);
            if (prevConnected !== 0) {
                fail(`expected CoreClrWasmDebugSetDebuggerConnected to return 0 (was disconnected), got ${prevConnected}`);
            }
            const isConnected = runtimeExports.CoreClrWasmDebugIsDebuggerConnected();
            if (isConnected !== 1) {
                fail(`expected CoreClrWasmDebugIsDebuggerConnected to return 1 after flip, got ${isConnected}`);
            }

            const methodName = new TextEncoder().encode(BreakpointMethodName);
            const stack = debuggerInstance.exports.stackSave();
            const methodNameAddress = debuggerInstance.exports.stackAlloc(methodName.length);
            writeBytes(getDebuggerHeap(), methodNameAddress, methodName);
            const breakpointResult = debuggerInstance.module._coreclr_wasm_dbi_dac_dbi_set_breakpoint_by_name(methodNameAddress, methodName.length);
            debuggerInstance.exports.stackRestore(stack);
            if (breakpointResult !== 0) {
                fail(`failed to set breakpoint: ${breakpointResult}`);
            }
        });

        const result = await waitForBreakpointHit(runtimeExports);
        const continueCount = runtimeExports.CoreClrWasmDebugGetContinueCount();
        const methodEnterQueryCount = runtimeExports.CoreClrWasmDebugGetMethodEnterEnabledQueryCount() >>> 0;
        const disconnectResult = debuggerInstance.module._coreclr_wasm_dbi_dac_dbi_disconnect_runtime();
        const sessionDestroyResult = debuggerInstance.module._coreclr_wasm_dbi_dac_dbi_session_destroy();
        result.callbackEvent = callbackEvent;
        result.fireEventToPauseCount = fireEventToPauseCount;
        result.fireEventToPauseLastEvent = fireEventToPauseLastEvent;
        result.dbiEvent = dbiEventDuringCallback;
        result.dbiEventRecord = dbiEventRecordDuringCallback;
        result.dbiFrameRecord = dbiFrameRecordDuringCallback;
        result.dbiLocalsDuringCallback = dbiLocalsDuringCallback;
        result.dbiProcessState = dbiProcessStateDuringCallback;
        result.testDataAtBreakpoint = testDataDuringCallback;
        result.continueDuringCallbackResult = continueDuringCallbackResult;
        result.continueCount = continueCount;
        result.methodEnterQueryCount = methodEnterQueryCount;
        result.disconnectResult = disconnectResult;
        result.sessionDestroyResult = sessionDestroyResult;
        result.sawBreakpointBeforeContinue = sawBreakpointBeforeContinue;
        result.ipcEventDuringCallback = {
            ...ipcEventDuringCallback,
            magic: `0x${ipcEventDuringCallback.magic.toString(16)}`,
            type: `0x${ipcEventDuringCallback.type.toString(16)}`,
            funcMetadataToken: `0x${ipcEventDuringCallback.funcMetadataToken.toString(16)}`,
            breakpointToken: `0x${ipcEventDuringCallback.breakpointToken.toString(16)}`
        };
        result.dbiIpcEventDuringCallback = dbiIpcEventDuringCallback.payload
            ? {
                pollResult: dbiIpcEventDuringCallback.pollResult,
                bytesWritten: dbiIpcEventDuringCallback.bytesWritten,
                magic: `0x${dbiIpcEventDuringCallback.payload.magic.toString(16)}`,
                type: `0x${dbiIpcEventDuringCallback.payload.type.toString(16)}`,
                processId: dbiIpcEventDuringCallback.payload.processId,
                threadId: dbiIpcEventDuringCallback.payload.threadId,
                hr: dbiIpcEventDuringCallback.payload.hr,
                flags: dbiIpcEventDuringCallback.payload.flags,
                breakpointToken: `0x${dbiIpcEventDuringCallback.payload.breakpointToken.toString(16)}`,
                funcMetadataToken: `0x${dbiIpcEventDuringCallback.payload.funcMetadataToken.toString(16)}`,
                isIL: dbiIpcEventDuringCallback.payload.isIL,
                offset: dbiIpcEventDuringCallback.payload.offset,
                encVersion: dbiIpcEventDuringCallback.payload.encVersion
            }
            : dbiIpcEventDuringCallback;
        console.log(JSON.stringify(result, null, 2));

        if (result.hitCount !== 1 ||
            result.copyResult !== 0 ||
            !result.event.includes(`breakpoint-hit:name=${BreakpointMethodName}`) ||
            dbiEventDuringCallback.pollResult !== 0 ||
            !dbiEventDuringCallback.event.includes(`breakpoint-hit:name=${BreakpointMethodName}`) ||
            dbiEventRecordDuringCallback.pollResult !== 0 ||
            dbiEventRecordDuringCallback.bytesWritten !== 340 ||
            dbiEventRecordDuringCallback.record?.kind !== 1 ||
            dbiEventRecordDuringCallback.record?.methodName !== BreakpointMethodName ||
            dbiEventRecordDuringCallback.record?.message !== result.event ||
            dbiFrameRecordDuringCallback.pollResult !== 0 ||
            dbiFrameRecordDuringCallback.bytesWritten !== 88 ||
            dbiFrameRecordDuringCallback.record?.methodName !== BreakpointMethodName ||
            dbiFrameRecordDuringCallback.record?.methodToken !== dbiEventRecordDuringCallback.record?.methodToken ||
            dbiFrameRecordDuringCallback.record?.ilOffset !== 0 ||
            dbiFrameRecordDuringCallback.record?.interpreterIP === 0 ||
            dbiFrameRecordDuringCallback.record?.frameAddress === 0 ||
            dbiFrameRecordDuringCallback.record?.stackAddress === 0 ||
            dbiLocalsDuringCallback.pollResult !== 0 ||
            dbiLocalsDuringCallback.bytesWritten !== 1552 ||
            dbiLocalsDuringCallback.record?.magic !== 0x524C4457 ||
            dbiLocalsDuringCallback.record?.version !== 1 ||
            dbiLocalsDuringCallback.record?.methodToken !== dbiEventRecordDuringCallback.record?.methodToken ||
            dbiLocalsDuringCallback.record?.localCount !== ExpectedLocalTypeTags.length ||
            !ExpectedLocalTypeTags.every((typeTag, index) =>
                dbiLocalsDuringCallback.record?.locals[index]?.ilSlot === index &&
                dbiLocalsDuringCallback.record?.locals[index]?.typeTag === typeTag &&
                dbiLocalsDuringCallback.record?.locals[index]?.typeTag !== 0 &&
                dbiLocalsDuringCallback.record?.locals[index]?.byteSize > 0) ||
            dbiProcessStateDuringCallback.pollResult !== 0 ||
            dbiProcessStateDuringCallback.bytesWritten !== 40 ||
            dbiProcessStateDuringCallback.state?.sessionCreated !== 1 ||
            dbiProcessStateDuringCallback.state?.connected !== 1 ||
            dbiProcessStateDuringCallback.state?.runtimeBase !== 1 ||
            dbiProcessStateDuringCallback.state?.syntheticProcessId !== 1 ||
            dbiProcessStateDuringCallback.state?.hasRealCordbProcess !== 1 ||
            dbiProcessStateDuringCallback.state?.lastEventKind !== 1 ||
            dbiProcessStateDuringCallback.state?.lastMethodToken !== dbiEventRecordDuringCallback.record?.methodToken ||
            testDataDuringCallback.readResult !== 0 ||
            testDataDuringCallback.testData?.magic !== 0x43445744 ||
            testDataDuringCallback.testData?.int32Value !== 123456789 ||
            testDataDuringCallback.testData?.doubleValue !== 1234.5 ||
            testDataDuringCallback.testData?.message !== "wasm-dbi-dac" ||
            continueDuringCallbackResult !== 0 ||
            continueCount !== 1 ||
            methodEnterQueryCount === 0 ||
            disconnectResult !== 0 ||
            sessionDestroyResult !== 0 ||
            !sawBreakpointBeforeContinue ||
            fireEventToPauseCount !== 1 ||
            !fireEventToPauseLastEvent.includes(`breakpoint-hit:name=${BreakpointMethodName}`) ||
            ipcEventDuringCallback.readBytes !== 96 ||
            ipcEventDuringCallback.magic !== 0x42435049 ||
            ipcEventDuringCallback.type !== 0x100 ||
            ipcEventDuringCallback.funcMetadataToken !== dbiEventRecordDuringCallback.record?.methodToken ||
            ipcEventDuringCallback.breakpointToken === 0n ||
            ipcEventDuringCallback.isIL !== 1 ||
            ipcEventDuringCallback.offset !== 0 ||
            dbiIpcEventDuringCallback.pollResult !== 0 ||
            dbiIpcEventDuringCallback.bytesWritten !== 96 ||
            dbiIpcEventDuringCallback.payload?.magic !== 0x42435049 ||
            dbiIpcEventDuringCallback.payload?.type !== 0x100 ||
            dbiIpcEventDuringCallback.payload?.funcMetadataToken !== ipcEventDuringCallback.funcMetadataToken ||
            dbiIpcEventDuringCallback.payload?.breakpointToken !== ipcEventDuringCallback.breakpointToken ||
            dbiIpcEventDuringCallback.payload?.isIL !== 1 ||
            dbiIpcEventDuringCallback.payload?.offset !== 0) {
            fail("HelloWorld breakpoint was not reached");
        }
    } finally {
        delete globalThis.CoreClrWasmDebugOnBreakpointHit;
        delete globalThis.coreClrDebugFireEventToPause;
        delete globalThis.CoreClrWasmDebugGetTargetModuleBase;
        delete globalThis.CoreClrWasmDebugGetSymbolAddress;
        delete globalThis.CoreClrWasmDebugReadTargetMemory;
        delete globalThis.CoreClrWasmDebugSubmitContinueRequest;
        delete globalThis.CoreClrWasmDebugSubmitStepIntoRequest;
    }
}

main().catch(error => {
    console.error(error.stack || error);
    process.exit(1);
});
