// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { performance } = require("perf_hooks");
const { pathToFileURL } = require("url");
const { spawnSync } = require("child_process");

const BreakpointMethodName = "BreakHere";
const ExpectedLandingMethodToken = 0x06000002;
const ForbiddenLandingMethodToken = 0x06000003;
const StepKind = 1;
const StepKindName = "step-over";
const CommandRecordMagic = 0x434d4457;
const CommandRecordSize = 80;
const IpcStepCompleteSize = 96;
const IpcStepCompleteMagic = 0x54435049;
const IpcStepCompleteType = 0x0104;

const ExpectedVersionBlobMagic = 0x42564457;
const ExpectedAbiVersion = 1;
const ExpectedProtocolBreakingChangeCounter = 12;
const IpcModuleLoadSize = 312;

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

function decodeIpcBreakpointPayload(memory, address) {
    const view = new DataView(memory.buffer, address, 96);
    return {
        magic: view.getUint32(0, true),
        type: view.getUint32(4, true),
        hr: view.getInt32(32, true),
        flags: view.getUint32(36, true),
        breakpointToken: view.getBigUint64(40, true),
        funcMetadataToken: view.getUint32(48, true),
        isIL: view.getUint32(64, true),
        offset: view.getUint32(68, true)
    };
}

function decodeStepCompletePayload(memory, address) {
    const view = new DataView(memory.buffer, address, IpcStepCompleteSize);
    return {
        magic: view.getUint32(0, true),
        type: view.getUint32(4, true),
        hr: view.getInt32(32, true),
        flags: view.getUint32(36, true),
        stepToken: view.getBigUint64(40, true),
        originalStepRequestToken: view.getBigUint64(48, true),
        funcMetadataToken: view.getUint32(56, true),
        ilOffset: view.getUint32(60, true),
        isIL: view.getUint32(72, true),
        codeStartAddress: view.getBigUint64(88, true)
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
                    return globalThis.CoreClrWasmDebugSubmitContinueRequest(requestBytesAddress >>> 0, requestBytesLength >>> 0);
                },
                submit_step_into_request(requestBytesAddress, requestBytesLength) {
                    if (typeof globalThis.CoreClrWasmDebugSubmitStepIntoRequest !== "function") {
                        return -1;
                    }
                    return globalThis.CoreClrWasmDebugSubmitStepIntoRequest(requestBytesAddress >>> 0, requestBytesLength >>> 0);
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
    const testDirectory = path.join(repoRoot, "artifacts", "wasm-dbi-dac-smoke", "hello-step-over");
    const assemblyName = "HelloStepOver";
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
        HelloBreakpointTarget.BreakHere();
        Console.WriteLine("after");
    }
}

public static class HelloBreakpointTarget
{
    [MethodImpl(MethodImplOptions.NoInlining)]
    public static void BreakHere()
    {
        SomeOtherMethod();
        Console.WriteLine("after step over");
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    public static void SomeOtherMethod() => Console.WriteLine("inside callee");
}
`);

    const result = spawnSync(
        path.join(repoRoot, "dotnet.sh"),
        ["build", projectPath, "-c", "Debug", "-v:minimal"],
        { encoding: "utf8" });
    if (result.status !== 0) {
        process.stdout.write(result.stdout);
        process.stderr.write(result.stderr);
        fail(`failed to build ${assemblyName}: ${result.status}`);
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

function pollDbiIpcEvent(debuggerInstance) {
    const stack = debuggerInstance.exports.stackSave();
    const eventAddress = debuggerInstance.exports.stackAlloc(96);
    const bytesWrittenAddress = debuggerInstance.exports.stackAlloc(4);
    const pollResult = debuggerInstance.module._coreclr_wasm_dbi_dac_dbi_poll_ipc_event(eventAddress, 96, bytesWrittenAddress);
    const bytesWritten = new DataView(debuggerInstance.module.HEAPU8.buffer, bytesWrittenAddress, 4).getUint32(0, true);
    const payload = pollResult === 0 && bytesWritten === 96
        ? decodeIpcBreakpointPayload(debuggerInstance.module.HEAPU8, eventAddress)
        : null;
    debuggerInstance.exports.stackRestore(stack);
    return { pollResult, bytesWritten, payload };
}

function pollDbiIpcStepComplete(debuggerInstance) {
    const stack = debuggerInstance.exports.stackSave();
    const eventAddress = debuggerInstance.exports.stackAlloc(IpcStepCompleteSize);
    const bytesWrittenAddress = debuggerInstance.exports.stackAlloc(4);
    const pollResult = debuggerInstance.module._coreclr_wasm_dbi_dac_dbi_poll_ipc_step_complete(
        eventAddress,
        IpcStepCompleteSize,
        bytesWrittenAddress);
    const bytesWritten = new DataView(debuggerInstance.module.HEAPU8.buffer, bytesWrittenAddress, 4).getUint32(0, true);
    const payload = pollResult === 0 && bytesWritten === IpcStepCompleteSize
        ? decodeStepCompletePayload(debuggerInstance.module.HEAPU8, eventAddress)
        : null;
    debuggerInstance.exports.stackRestore(stack);
    return { pollResult, bytesWritten, payload };
}

function enumerateBreakpoints(debuggerInstance) {
    const recordSize = 8 + (16 * 88);
    const stack = debuggerInstance.exports.stackSave();
    const slotsAddress = debuggerInstance.exports.stackAlloc(recordSize);
    const bytesWrittenAddress = debuggerInstance.exports.stackAlloc(4);
    const enumerateResult = debuggerInstance.module._coreclr_wasm_dbi_dac_dbi_enumerate_breakpoints(
        slotsAddress,
        recordSize,
        bytesWrittenAddress);
    const view = new DataView(debuggerInstance.module.HEAPU8.buffer, slotsAddress, recordSize);
    const activeCount = enumerateResult === 0 ? view.getUint32(4, true) : -1;
    debuggerInstance.exports.stackRestore(stack);
    return { enumerateResult, activeCount };
}

async function waitForStepComplete(stepCompleteEvents) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
        if (stepCompleteEvents.length > 0) {
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

    const appPath = buildHelloWorld(repoRoot);

    let runtimeExports;
    let debuggerInstance;
    let callbackEvent = "";
    let initialBreakpoint = null;
    let stepRequestResult = -1;
    let preStepBreakpointCount = -1;
    let afterStepRequestBreakpointCount = -1;
    let stepCompleteBreakpointCount = -1;
    let fireEventToPauseCount = 0;
    let fireEventToPauseLastKind = "";
    const stepCompleteEvents = [];

    const getRuntimeHeap = () => new Uint8Array(runtimeExports.memory.buffer);
    const getDebuggerHeap = () => new Uint8Array(debuggerInstance.exports.memory.buffer);

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

    try {
        await loadAndRunRuntime(runtimeJsPath, appPath, sharedFrameworkPath, instance => {
            runtimeExports = instance.exports;
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
            globalThis.CoreClrWasmDebugSubmitContinueRequest = (requestBytesAddress, requestBytesLength) => {
                const debuggerHeap = getDebuggerHeap();
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
                if ((eventLength >>> 0) === IpcModuleLoadSize) {
                    return 0;
                }
                fireEventToPauseCount++;
                const runtimeHeap = getRuntimeHeap();
                if (eventLength === IpcStepCompleteSize && eventAddress + eventLength <= runtimeHeap.length) {
                    const view = new DataView(runtimeHeap.buffer, eventAddress >>> 0, eventLength >>> 0);
                    if (view.getUint32(0, true) === IpcStepCompleteMagic) {
                        fireEventToPauseLastKind = "step-complete";
                        const stepComplete = pollDbiIpcStepComplete(debuggerInstance);
                        if (stepComplete.payload !== null) {
                            stepCompleteEvents.push(stepComplete.payload);
                        }
                        const active = enumerateBreakpoints(debuggerInstance);
                        stepCompleteBreakpointCount = active.enumerateResult === 0 ? active.activeCount : -1;
                        return 0;
                    }
                }
                fireEventToPauseLastKind = "breakpoint";
                return 0;
            };
            globalThis.CoreClrWasmDebugOnBreakpointHit = (eventAddress, eventLength) => {
                const event = readAscii(getRuntimeHeap(), eventAddress >>> 0, eventLength >>> 0);
                callbackEvent = event;
                if (event.includes(`breakpoint-hit:name=${BreakpointMethodName}`) && initialBreakpoint === null) {
                    const ipc = pollDbiIpcEvent(debuggerInstance);
                    if (ipc.payload === null) {
                        return -1;
                    }
                    initialBreakpoint = ipc.payload;
                    preStepBreakpointCount = enumerateBreakpoints(debuggerInstance).activeCount;
                    const stepToken = ipc.payload.breakpointToken;
                    stepRequestResult = debuggerInstance.module._coreclr_wasm_dbi_dac_dbi_send_ipc_step_into_request(
                        Number(stepToken & 0xffffffffn),
                        Number(stepToken >> 32n),
                        StepKind);
                    afterStepRequestBreakpointCount = enumerateBreakpoints(debuggerInstance).activeCount;
                }
                return 0;
            };

            const ackResult = debuggerInstance.module._coreclr_wasm_dbi_dac_acknowledge_protocol(
                ExpectedVersionBlobMagic,
                ExpectedAbiVersion,
                ExpectedProtocolBreakingChangeCounter);
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
            if (runtimeExports.CoreClrWasmDebugSetDebuggerConnected(1) !== 0) {
                fail("runtime debugger connection gate was already set");
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

        const stepCompleteSeen = await waitForStepComplete(stepCompleteEvents);
        const stepComplete = stepCompleteEvents[0];
        const continueCount = runtimeExports.CoreClrWasmDebugGetContinueCount();
        const disconnectResult = debuggerInstance.module._coreclr_wasm_dbi_dac_dbi_disconnect_runtime();
        const sessionDestroyResult = debuggerInstance.module._coreclr_wasm_dbi_dac_dbi_session_destroy();
        const summary = {
            stepKind: StepKindName,
            initialMethodToken: initialBreakpoint?.funcMetadataToken,
            initialOffset: initialBreakpoint?.offset,
            initialToken: initialBreakpoint?.breakpointToken !== undefined ? `0x${initialBreakpoint.breakpointToken.toString(16)}` : null,
            stepRequestResult,
            preStepBreakpointCount,
            afterStepRequestBreakpointCount,
            stepCompleteBreakpointCount,
            stepCompleteSeen,
            stepComplete: stepComplete === undefined ? null : {
                ...stepComplete,
                stepToken: `0x${stepComplete.stepToken.toString(16)}`,
                originalStepRequestToken: `0x${stepComplete.originalStepRequestToken.toString(16)}`,
                codeStartAddress: `0x${stepComplete.codeStartAddress.toString(16)}`
            },
            continueCount,
            fireEventToPauseCount,
            fireEventToPauseLastKind,
            callbackEvent,
            disconnectResult,
            sessionDestroyResult
        };
        console.log(JSON.stringify(summary, null, 2));

        if (initialBreakpoint === null ||
            initialBreakpoint.magic !== 0x42435049 ||
            initialBreakpoint.type !== 0x100 ||
            initialBreakpoint.breakpointToken === 0n ||
            stepRequestResult !== 0 ||
            preStepBreakpointCount < 1 ||
            afterStepRequestBreakpointCount !== preStepBreakpointCount + 1 ||
            stepCompleteBreakpointCount !== preStepBreakpointCount ||
            !stepCompleteSeen ||
            stepComplete?.magic !== IpcStepCompleteMagic ||
            stepComplete?.type !== IpcStepCompleteType ||
            stepComplete?.hr !== 0 ||
            stepComplete?.funcMetadataToken !== ExpectedLandingMethodToken ||
            stepComplete?.funcMetadataToken === ForbiddenLandingMethodToken ||
            stepComplete?.ilOffset <= initialBreakpoint.offset ||
            stepComplete?.isIL !== 0 ||
            stepComplete?.stepToken === 0n ||
            stepComplete?.originalStepRequestToken !== initialBreakpoint.breakpointToken ||
            continueCount !== 1 ||
            fireEventToPauseCount < 2 ||
            fireEventToPauseLastKind !== "breakpoint" ||
            disconnectResult !== 0 ||
            sessionDestroyResult !== 0) {
            fail(`HelloWorld ${StepKindName} did not land at the expected caller offset`);
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
