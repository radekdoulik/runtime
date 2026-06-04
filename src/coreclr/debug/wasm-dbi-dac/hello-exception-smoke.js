// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { performance } = require("perf_hooks");
const { pathToFileURL } = require("url");
const { spawnSync } = require("child_process");

const CommandRecordMagic = 0x434d4457;
const CommandRecordSize = 80;
const ExpectedVersionBlobMagic = 0x42564457;
const ExpectedAbiVersion = 1;
const ExpectedProtocolBreakingChangeCounter = 12;
const IpcModuleLoadSize = 312;
const IpcExceptionSize = 144;
const IpcExceptionMagic = 0x58435049;
const IpcExceptionType = 0x0103;
const InvalidOperationHr = 0x80131509 | 0;
const ExpectedThrowHereToken = 0x06000002;
const ExpectedRethrowHereToken = 0x06000003;

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

function decodeIpcExceptionPayload(memory, address) {
    const view = new DataView(memory.buffer, address, IpcExceptionSize);
    return {
        magic: view.getUint32(0, true),
        type: view.getUint32(4, true),
        processId: view.getUint32(8, true),
        threadId: view.getUint32(12, true),
        hr: view.getInt32(32, true),
        flags: view.getUint32(36, true),
        exceptionToken: view.getBigUint64(40, true),
        funcMetadataToken: view.getUint32(48, true),
        ilOffset: view.getUint32(52, true),
        exceptionAddress: view.getBigUint64(64, true),
        exceptionTypeName: readNullTerminatedAscii(memory, address + 72, 64)
    };
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

function buildHelloException(repoRoot) {
    const testDirectory = path.join(repoRoot, "artifacts", "wasm-dbi-dac-smoke", "hello-exception");
    const assemblyName = "HelloException";
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
using System.Runtime.CompilerServices;

namespace HelloSmoke;

public static class Program
{
    public static void Main()
    {
        Console.WriteLine("before");
        try
        {
            HelloExceptionTarget.ThrowHere();
        }
        catch (InvalidOperationException ex)
        {
            Console.WriteLine($"caught:{ex.GetType().FullName}:{ex.Message}");
        }
        try
        {
            HelloExceptionTarget.RethrowHere();
        }
        catch (InvalidOperationException ex)
        {
            Console.WriteLine($"recaught:{ex.GetType().FullName}:{ex.Message}");
        }
        Console.WriteLine("after");
    }
}

public static class HelloExceptionTarget
{
    [MethodImpl(MethodImplOptions.NoInlining)]
    public static void ThrowHere()
    {
        Console.WriteLine($"throw-token=0x{MethodBase.GetCurrentMethod()!.MetadataToken:x8}");
        throw new InvalidOperationException("wasm-dbi-dac test");
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    public static void RethrowHere()
    {
        Console.WriteLine($"rethrow-token=0x{MethodBase.GetCurrentMethod()!.MetadataToken:x8}");
        try
        {
            throw new InvalidOperationException("wasm-dbi-dac rethrow");
        }
        catch
        {
            throw;
        }
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
        fail(`failed to build HelloException test app: ${result.status}`);
    }

    const outputMatch = [...result.stdout.matchAll(/-> (.*\.dll)$/gm)]
        .map(match => match[1])
        .find(outputPath => path.basename(outputPath) === `${assemblyName}.dll`);
    if (outputMatch !== undefined) {
        return outputMatch;
    }

    return path.join(testDirectory, "bin/Debug/net11.0", `${assemblyName}.dll`);
}

async function loadAndRunRuntime(runtimeJsPath, appPath, sharedFrameworkPath, onRuntimeInstantiated, runtimeOutput) {
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
            let stdoutLine = "";
            const appendRuntimeLine = line => {
                runtimeOutput.push(line);
                process.stdout.write(`${line}\n`);
            };
            const moduleConfig = {
                noExitRuntime: true,
                arguments: ["-c", sharedFrameworkPath, appPath],
                locateFile: fileName => path.join(runtimeDirectory, fileName),
                print(text) {
                    appendRuntimeLine(String(text));
                },
                stdout(charCode) {
                    if (charCode === 10) {
                        appendRuntimeLine(stdoutLine);
                        stdoutLine = "";
                    } else if (charCode !== 13) {
                        stdoutLine += String.fromCharCode(charCode);
                    }
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

function pollDbiIpcException(debuggerInstance) {
    const stack = debuggerInstance.exports.stackSave();
    const eventAddress = debuggerInstance.exports.stackAlloc(IpcExceptionSize);
    const bytesWrittenAddress = debuggerInstance.exports.stackAlloc(4);
    const pollResult = debuggerInstance.module._coreclr_wasm_dbi_dac_dbi_poll_ipc_exception(eventAddress, IpcExceptionSize, bytesWrittenAddress);
    const bytesWritten = new DataView(debuggerInstance.module.HEAPU8.buffer, bytesWrittenAddress, 4).getUint32(0, true);
    let payload = null;
    if (pollResult === 0 && bytesWritten === IpcExceptionSize) {
        payload = decodeIpcExceptionPayload(debuggerInstance.module.HEAPU8, eventAddress);
    }
    debuggerInstance.exports.stackRestore(stack);

    return { pollResult, bytesWritten, payload };
}

function readRuntimeIpcException(runtimeExports, runtimeHeap) {
    const stack = runtimeExports.stackSave();
    const eventAddress = runtimeExports.stackAlloc(IpcExceptionSize);
    const readBytes = runtimeExports.CoreClrWasmDebugReadLastIpcException(eventAddress, IpcExceptionSize);
    const payload = readBytes === IpcExceptionSize ? decodeIpcExceptionPayload(runtimeHeap, eventAddress) : null;
    const secondReadBytes = runtimeExports.CoreClrWasmDebugReadLastIpcException(eventAddress, IpcExceptionSize);
    runtimeExports.stackRestore(stack);

    return { readBytes, secondReadBytes, payload };
}

async function waitForExceptionEvents(exceptionEvents, expectedCount) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
        if (exceptionEvents.length >= expectedCount) {
            return true;
        }

        await new Promise(resolve => setTimeout(resolve, 10));
    }

    return false;
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

    const appPath = buildHelloException(repoRoot);

    let runtimeExports;
    let debuggerInstance;
    let fireEventToPauseCount = 0;
    let fireEventToPauseLastLength = 0;
    const exceptionEvents = [];
    const runtimeExceptionReads = [];
    const postRuntimeDrainPolls = [];
    const runtimeOutput = [];

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
            if (typeof runtimeExports.CoreClrWasmDebugGetLastIpcExceptionSize !== "function") {
                fail("runtime export CoreClrWasmDebugGetLastIpcExceptionSize is missing");
            }
            if ((runtimeExports.CoreClrWasmDebugGetLastIpcExceptionSize() | 0) !== IpcExceptionSize) {
                fail(`unexpected runtime IPC exception size: ${runtimeExports.CoreClrWasmDebugGetLastIpcExceptionSize()}`);
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
                    symbolName === "g_wasmDebugLastIpcModuleLoad" ? runtimeExports.Getg_wasmDebugLastIpcModuleLoad() >>> 0 :
                    symbolName === "g_wasmDebugLastIpcModuleLoadValid" ? runtimeExports.Getg_wasmDebugLastIpcModuleLoadValid() >>> 0 :
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
            globalThis.CoreClrWasmDebugSubmitContinueRequest = () => -1;
            globalThis.CoreClrWasmDebugSubmitStepIntoRequest = () => -1;
            globalThis.coreClrDebugFireEventToPause = (eventAddress, eventLength) => {
                if ((eventLength >>> 0) === IpcModuleLoadSize) {
                    return 0;
                }
                fireEventToPauseCount++;
                fireEventToPauseLastLength = eventLength >>> 0;
                const exception = pollDbiIpcException(debuggerInstance);
                if (exception.payload !== null) {
                    exceptionEvents.push(exception);
                }
                runtimeExceptionReads.push(readRuntimeIpcException(runtimeExports, getRuntimeHeap()));
                postRuntimeDrainPolls.push(pollDbiIpcException(debuggerInstance));
                return 0;
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

            const prevConnected = runtimeExports.CoreClrWasmDebugSetDebuggerConnected(1);
            if (prevConnected !== 0) {
                fail(`expected CoreClrWasmDebugSetDebuggerConnected to return 0, got ${prevConnected}`);
            }
        }, runtimeOutput);

        const sawException = await waitForExceptionEvents(exceptionEvents, 3);
        const expectedMethodToken = ExpectedThrowHereToken;
        const matchingEvent = exceptionEvents.find(event =>
            event.payload?.funcMetadataToken === expectedMethodToken &&
            event.payload?.exceptionTypeName === "System.InvalidOperationException");
        const matchingRethrowEvents = exceptionEvents.filter(event =>
            event.payload?.funcMetadataToken === ExpectedRethrowHereToken &&
            event.payload?.exceptionTypeName === "System.InvalidOperationException");
        const matchingRuntimeRead = runtimeExceptionReads.find(event =>
            event.payload?.funcMetadataToken === expectedMethodToken &&
            event.payload?.exceptionTypeName === "System.InvalidOperationException");
        const disconnectResult = debuggerInstance.module._coreclr_wasm_dbi_dac_dbi_disconnect_runtime();
        const sessionDestroyResult = debuggerInstance.module._coreclr_wasm_dbi_dac_dbi_session_destroy();

        const summary = {
            sawException,
            fireEventToPauseCount,
            fireEventToPauseLastLength,
            expectedMethodToken: `0x${expectedMethodToken.toString(16)}`,
            eventCount: exceptionEvents.length,
            runtimeReadCount: runtimeExceptionReads.length,
            rethrowEventCount: matchingRethrowEvents.length,
            postRuntimeDrainPollCount: postRuntimeDrainPolls.length,
            matchingEvent: matchingEvent?.payload !== undefined ? {
                pollResult: matchingEvent.pollResult,
                bytesWritten: matchingEvent.bytesWritten,
                magic: `0x${matchingEvent.payload.magic.toString(16)}`,
                type: `0x${matchingEvent.payload.type.toString(16)}`,
                processId: matchingEvent.payload.processId,
                threadId: matchingEvent.payload.threadId,
                hr: `0x${(matchingEvent.payload.hr >>> 0).toString(16)}`,
                flags: matchingEvent.payload.flags,
                exceptionToken: `0x${matchingEvent.payload.exceptionToken.toString(16)}`,
                funcMetadataToken: `0x${matchingEvent.payload.funcMetadataToken.toString(16)}`,
                ilOffset: matchingEvent.payload.ilOffset,
                exceptionAddress: `0x${matchingEvent.payload.exceptionAddress.toString(16)}`,
                exceptionTypeName: matchingEvent.payload.exceptionTypeName
            } : null,
            matchingRuntimeRead: matchingRuntimeRead?.payload !== undefined ? {
                readBytes: matchingRuntimeRead.readBytes,
                secondReadBytes: matchingRuntimeRead.secondReadBytes,
                magic: `0x${matchingRuntimeRead.payload.magic.toString(16)}`,
                type: `0x${matchingRuntimeRead.payload.type.toString(16)}`,
                exceptionToken: `0x${matchingRuntimeRead.payload.exceptionToken.toString(16)}`,
                funcMetadataToken: `0x${matchingRuntimeRead.payload.funcMetadataToken.toString(16)}`,
                exceptionTypeName: matchingRuntimeRead.payload.exceptionTypeName
            } : null,
            runtimeOutput,
            disconnectResult,
            sessionDestroyResult
        };
        console.log(JSON.stringify(summary, null, 2));

        if (!sawException ||
            expectedMethodToken === 0 ||
            matchingEvent === undefined ||
            matchingEvent.pollResult !== 0 ||
            matchingEvent.bytesWritten !== IpcExceptionSize ||
            matchingEvent.payload?.magic !== IpcExceptionMagic ||
            matchingEvent.payload?.type !== IpcExceptionType ||
            matchingEvent.payload?.processId !== 1 ||
            matchingEvent.payload?.threadId !== 1 ||
            matchingEvent.payload?.hr !== InvalidOperationHr ||
            matchingEvent.payload?.flags !== 0 ||
            matchingEvent.payload?.exceptionToken === 0n ||
            matchingEvent.payload?.funcMetadataToken !== expectedMethodToken ||
            matchingEvent.payload?.exceptionAddress === 0n ||
            matchingRuntimeRead === undefined ||
            matchingRuntimeRead.readBytes !== IpcExceptionSize ||
            matchingRuntimeRead.secondReadBytes !== 0 ||
            matchingRuntimeRead.payload?.magic !== IpcExceptionMagic ||
            matchingRuntimeRead.payload?.type !== IpcExceptionType ||
            matchingRuntimeRead.payload?.funcMetadataToken !== expectedMethodToken ||
            runtimeExceptionReads.length !== 3 ||
            runtimeExceptionReads.some(event => event.readBytes !== IpcExceptionSize || event.secondReadBytes !== 0) ||
            postRuntimeDrainPolls.length !== 3 ||
            postRuntimeDrainPolls.some(event => event.pollResult !== 0 || event.bytesWritten !== 0) ||
            matchingRethrowEvents.length < 2 ||
            fireEventToPauseCount < 3 ||
            fireEventToPauseLastLength !== IpcExceptionSize ||
            disconnectResult !== 0 ||
            sessionDestroyResult !== 0) {
            fail("HelloWorld exception event was not observed");
        }
    } finally {
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
