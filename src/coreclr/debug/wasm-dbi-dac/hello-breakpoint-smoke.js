// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { performance } = require("perf_hooks");
const { pathToFileURL } = require("url");
const { spawnSync } = require("child_process");

const BreakpointMethodName = "BreakHere";
const CommandRecordMagic = 0x434d4457;
const CommandRecordSize = 80;

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
                }
            };

            Object.assign(imports.env, hostImports);
            imports.coreclr_dbi_dac = hostImports;

            const wasmPath = path.join(debuggerDirectory, "coreclr-dbi-dac.wasm");
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
    const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "wasm-dbi-dac-hello-"));
    const projectPath = path.join(testDirectory, "Hello.csproj");
    const programPath = path.join(testDirectory, "Program.cs");

    fs.writeFileSync(projectPath, `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net11.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
  </PropertyGroup>
</Project>
`);

    fs.writeFileSync(programPath, `using System;
using System.Runtime.CompilerServices;

Console.WriteLine("before");
HelloBreakpointTarget.BreakHere();
Console.WriteLine("after");

public static class HelloBreakpointTarget
{
    [MethodImpl(MethodImplOptions.NoInlining)]
    public static void BreakHere() => Console.WriteLine("break here");
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

    return path.join(testDirectory, "bin/Debug/net11.0/Hello.dll");
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
    const debuggerJsPath = path.join(coreclrObjDirectory, "debug/wasm-dbi-dac/coreclr-dbi-dac.js");
    const sharedFrameworkPath = path.join(repoRoot, "artifacts/bin/testhost/net11.0-browser-Debug-wasm/shared/Microsoft.NETCore.App/11.0.0");

    requireFile(runtimeJsPath, "runtime JS wrapper");
    requireFile(debuggerJsPath, "debugger JS wrapper");
    requireFile(sharedFrameworkPath, "browser-wasm testhost shared framework");

    const appPath = buildHelloWorld(repoRoot);

    let runtimeExports;
    let runtimeMemory;
    let debuggerInstance;
    let sawBreakpointBeforeContinue = false;
    let callbackEvent = "";
    let dbiEventDuringCallback = { pollResult: -1, event: "", bytesWritten: 0 };
    let dbiEventRecordDuringCallback = { pollResult: -1, bytesWritten: 0, record: null };
    let dbiFrameRecordDuringCallback = { pollResult: -1, bytesWritten: 0, record: null };
    let testDataDuringCallback = { readResult: -1, testData: null };
    let continueDuringCallbackResult = -1;

    debuggerInstance = await loadDebugger(debuggerJsPath, (messageAddress, messageLength) => {
        const message = debuggerInstance.module.HEAPU8.slice(messageAddress, messageAddress + messageLength);
        const stack = runtimeExports.stackSave();
        const runtimeMessageAddress = runtimeExports.stackAlloc(messageLength);
        runtimeMemory.set(message, runtimeMessageAddress);
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
            runtimeMemory = new Uint8Array(runtimeExports.memory.buffer);
            globalThis.CoreClrWasmDebugReadTargetMemory = (targetAddress, debuggerAddress, byteCount) => {
                const currentRuntimeMemory = new Uint8Array(runtimeExports.memory.buffer);
                if (targetAddress + byteCount > currentRuntimeMemory.length ||
                    debuggerAddress + byteCount > debuggerInstance.module.HEAPU8.length) {
                    return -1;
                }

                debuggerInstance.module.HEAPU8.set(currentRuntimeMemory.subarray(targetAddress, targetAddress + byteCount), debuggerAddress);
                return 0;
            };
            globalThis.CoreClrWasmDebugGetSymbolAddress = (baseAddress, symbolNameAddress, symbolNameLength, addressOutAddress) => {
                const symbolName = readAscii(debuggerInstance.module.HEAPU8, symbolNameAddress, symbolNameLength);
                const symbolAddress =
                    symbolName === "DotNetRuntimeContractDescriptor" ? runtimeExports.GetDotNetRuntimeContractDescriptor() >>> 0 :
                    symbolName === "g_dacTable" ? runtimeExports.Getg_dacTable() >>> 0 :
                    symbolName === "WasmDbiDacTestData" ? runtimeExports.GetWasmDbiDacTestData() >>> 0 :
                    0;
                if (symbolAddress === 0 || addressOutAddress + 8 > debuggerInstance.module.HEAPU8.length) {
                    return -1;
                }

                writeUint64(debuggerInstance.module.HEAPU8, addressOutAddress, symbolAddress);
                return 0;
            };
            globalThis.CoreClrWasmDebugGetTargetModuleBase = (imageNameAddress, imageNameCharCount, addressOutAddress) => {
                if (addressOutAddress + 8 > debuggerInstance.module.HEAPU8.length) {
                    return -1;
                }

                writeUint64(debuggerInstance.module.HEAPU8, addressOutAddress, 1);
                return 0;
            };
            globalThis.CoreClrWasmDebugOnBreakpointHit = (eventAddress, eventLength) => {
                const currentRuntimeMemory = new Uint8Array(runtimeExports.memory.buffer);
                const event = readAscii(currentRuntimeMemory, eventAddress >>> 0, eventLength >>> 0);
                callbackEvent = event;
                const eventBytes = new TextEncoder().encode(event);
                const stack = debuggerInstance.exports.stackSave();
                const debuggerEventAddress = debuggerInstance.exports.stackAlloc(eventBytes.length);
                writeBytes(debuggerInstance.module.HEAPU8, debuggerEventAddress, eventBytes);
                const receiveResult = debuggerInstance.module._coreclr_wasm_dbi_dac_receive_runtime_event(debuggerEventAddress, eventBytes.length);
                debuggerInstance.exports.stackRestore(stack);

                if (event.includes("breakpoint-hit:name=BreakHere")) {
                    const recordSize = runtimeExports.CoreClrWasmDebugGetLastEventRecordSize();
                    const runtimeStack = runtimeExports.stackSave();
                    const runtimeRecordAddress = runtimeExports.stackAlloc(recordSize);
                    const copyRecordResult = runtimeExports.CoreClrWasmDebugCopyLastEventRecord(runtimeRecordAddress, recordSize);
                    const recordBytes = new Uint8Array(runtimeExports.memory.buffer).slice(runtimeRecordAddress, runtimeRecordAddress + recordSize);
                    runtimeExports.stackRestore(runtimeStack);
                    if (copyRecordResult !== 0) {
                        return copyRecordResult;
                    }

                    const debuggerStack = debuggerInstance.exports.stackSave();
                    const debuggerRecordAddress = debuggerInstance.exports.stackAlloc(recordBytes.length);
                    writeBytes(debuggerInstance.module.HEAPU8, debuggerRecordAddress, recordBytes);
                    const receiveRecordResult = debuggerInstance.module._coreclr_wasm_dbi_dac_receive_runtime_event_record(debuggerRecordAddress, recordBytes.length);
                    debuggerInstance.exports.stackRestore(debuggerStack);
                    if (receiveRecordResult !== 0) {
                        return receiveRecordResult;
                    }

                    const frameRecordSize = runtimeExports.CoreClrWasmDebugGetLastFrameRecordSize();
                    const runtimeFrameStack = runtimeExports.stackSave();
                    const runtimeFrameRecordAddress = runtimeExports.stackAlloc(frameRecordSize);
                    const copyFrameRecordResult = runtimeExports.CoreClrWasmDebugCopyLastFrameRecord(runtimeFrameRecordAddress, frameRecordSize);
                    const frameRecordBytes = new Uint8Array(runtimeExports.memory.buffer).slice(runtimeFrameRecordAddress, runtimeFrameRecordAddress + frameRecordSize);
                    runtimeExports.stackRestore(runtimeFrameStack);
                    if (copyFrameRecordResult !== 0) {
                        return copyFrameRecordResult;
                    }

                    const debuggerFrameStack = debuggerInstance.exports.stackSave();
                    const debuggerFrameRecordAddress = debuggerInstance.exports.stackAlloc(frameRecordBytes.length);
                    writeBytes(debuggerInstance.module.HEAPU8, debuggerFrameRecordAddress, frameRecordBytes);
                    const receiveFrameRecordResult = debuggerInstance.module._coreclr_wasm_dbi_dac_receive_runtime_frame_record(debuggerFrameRecordAddress, frameRecordBytes.length);
                    debuggerInstance.exports.stackRestore(debuggerFrameStack);
                    if (receiveFrameRecordResult !== 0) {
                        return receiveFrameRecordResult;
                    }

                    dbiEventDuringCallback = pollDbiEvent(debuggerInstance);
                    dbiEventRecordDuringCallback = pollDbiEventRecord(debuggerInstance);
                    dbiFrameRecordDuringCallback = pollDbiFrameRecord(debuggerInstance);
                    testDataDuringCallback = readDbiTestData(debuggerInstance);
                    continueDuringCallbackResult = debuggerInstance.module._coreclr_wasm_dbi_dac_dbi_continue();
                    sawBreakpointBeforeContinue = true;
                }

                return receiveResult;
            };

            const sessionCreateResult = debuggerInstance.module._coreclr_wasm_dbi_dac_dbi_session_create();
            if (sessionCreateResult !== 0) {
                fail(`failed to create DBI session: ${sessionCreateResult}`);
            }

            const connectResult = debuggerInstance.module._coreclr_wasm_dbi_dac_dbi_connect_runtime(1);
            if (connectResult !== 0) {
                fail(`failed to connect DBI session to runtime: ${connectResult}`);
            }

            const methodName = new TextEncoder().encode(BreakpointMethodName);
            const stack = debuggerInstance.exports.stackSave();
            const methodNameAddress = debuggerInstance.exports.stackAlloc(methodName.length);
            writeBytes(debuggerInstance.module.HEAPU8, methodNameAddress, methodName);
            const breakpointResult = debuggerInstance.module._coreclr_wasm_dbi_dac_dbi_set_breakpoint_by_name(methodNameAddress, methodName.length);
            debuggerInstance.exports.stackRestore(stack);
            if (breakpointResult !== 0) {
                fail(`failed to set breakpoint: ${breakpointResult}`);
            }
        });

        const result = await waitForBreakpointHit(runtimeExports);
        const continueCount = runtimeExports.CoreClrWasmDebugGetContinueCount();
        const disconnectResult = debuggerInstance.module._coreclr_wasm_dbi_dac_dbi_disconnect_runtime();
        const sessionDestroyResult = debuggerInstance.module._coreclr_wasm_dbi_dac_dbi_session_destroy();
        result.callbackEvent = callbackEvent;
        result.dbiEvent = dbiEventDuringCallback;
        result.dbiEventRecord = dbiEventRecordDuringCallback;
        result.dbiFrameRecord = dbiFrameRecordDuringCallback;
        result.testDataAtBreakpoint = testDataDuringCallback;
        result.continueDuringCallbackResult = continueDuringCallbackResult;
        result.continueCount = continueCount;
        result.disconnectResult = disconnectResult;
        result.sessionDestroyResult = sessionDestroyResult;
        result.sawBreakpointBeforeContinue = sawBreakpointBeforeContinue;
        console.log(JSON.stringify(result, null, 2));

        if (result.hitCount !== 1 ||
            result.copyResult !== 0 ||
            !result.event.includes("breakpoint-hit:name=BreakHere") ||
            dbiEventDuringCallback.pollResult !== 0 ||
            !dbiEventDuringCallback.event.includes("breakpoint-hit:name=BreakHere") ||
            dbiEventRecordDuringCallback.pollResult !== 0 ||
            dbiEventRecordDuringCallback.bytesWritten !== 340 ||
            dbiEventRecordDuringCallback.record?.kind !== 1 ||
            dbiEventRecordDuringCallback.record?.methodName !== "BreakHere" ||
            dbiEventRecordDuringCallback.record?.message !== result.event ||
            dbiFrameRecordDuringCallback.pollResult !== 0 ||
            dbiFrameRecordDuringCallback.bytesWritten !== 88 ||
            dbiFrameRecordDuringCallback.record?.methodName !== "BreakHere" ||
            dbiFrameRecordDuringCallback.record?.methodToken !== dbiEventRecordDuringCallback.record?.methodToken ||
            dbiFrameRecordDuringCallback.record?.ilOffset !== 0 ||
            dbiFrameRecordDuringCallback.record?.interpreterIP === 0 ||
            dbiFrameRecordDuringCallback.record?.frameAddress === 0 ||
            dbiFrameRecordDuringCallback.record?.stackAddress === 0 ||
            testDataDuringCallback.readResult !== 0 ||
            testDataDuringCallback.testData?.magic !== 0x43445744 ||
            testDataDuringCallback.testData?.int32Value !== 123456789 ||
            testDataDuringCallback.testData?.doubleValue !== 1234.5 ||
            testDataDuringCallback.testData?.message !== "wasm-dbi-dac" ||
            continueDuringCallbackResult !== 0 ||
            continueCount !== 1 ||
            disconnectResult !== 0 ||
            sessionDestroyResult !== 0 ||
            !sawBreakpointBeforeContinue) {
            fail("HelloWorld breakpoint was not reached");
        }
    } finally {
        delete globalThis.CoreClrWasmDebugOnBreakpointHit;
        delete globalThis.CoreClrWasmDebugGetTargetModuleBase;
        delete globalThis.CoreClrWasmDebugGetSymbolAddress;
        delete globalThis.CoreClrWasmDebugReadTargetMemory;
    }
}

main().catch(error => {
    console.error(error.stack || error);
    process.exit(1);
});
