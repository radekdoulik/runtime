// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { pathToFileURL } = require("url");
const { spawnSync } = require("child_process");

const ExpectedVersionBlobMagic = 0x42564457;
const ExpectedAbiVersion = 1;
const ExpectedProtocolBreakingChangeCounter = 14;
const IpcAsyncBreakSize = 88;
const IpcAsyncBreakMagic = 0x41435049;
const IpcAsyncBreakType = 0x0107;
const KeepAliveIterations = 120;
const KeepAliveInnerIterations = 1_000;
const AsyncBreakTimeoutMs = 15_000;
const RuntimeCompletionTimeoutMs = 45_000;

function fail(message) {
    throw new Error(message);
}

function requireFile(filePath, description) {
    if (!fs.existsSync(filePath)) {
        fail(`${description} not found: ${filePath}`);
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
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

function withTimeout(promise, timeoutMs, message) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        promise.then(
            value => {
                clearTimeout(timer);
                resolve(value);
            },
            error => {
                clearTimeout(timer);
                reject(error);
            });
    });
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
                submit_async_break_request() {
                    if (typeof globalThis.CoreClrWasmDebugSubmitAsyncBreakRequest !== "function") {
                        return -1;
                    }

                    return globalThis.CoreClrWasmDebugSubmitAsyncBreakRequest();
                },
                submit_step_into_request() {
                    return -1;
                },
                lookup_source_location() {
                    return -1;
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
    const testDirectory = path.join(repoRoot, "artifacts", "wasm-dbi-dac-smoke", "hello-cooperative-async-break");
    const assemblyName = "HelloCooperativeAsyncBreak";
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
using System.Threading.Tasks;

namespace HelloSmoke;

public static class Program
{
    private static volatile int s_sink;

    public static async Task<int> Main()
    {
        MethodInfo keepAliveMethod = typeof(Program).GetMethod(nameof(KeepAlive), BindingFlags.Public | BindingFlags.Static)!;
        AsyncStateMachineAttribute stateMachine = keepAliveMethod.GetCustomAttribute<AsyncStateMachineAttribute>()!;
        MethodInfo moveNext = stateMachine.StateMachineType.GetMethod("MoveNext", BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public)!;
        int moveNextILBytes = moveNext.GetMethodBody()?.GetILAsByteArray()?.Length ?? 1;
        Console.WriteLine($"keepalive-method-token 0x{keepAliveMethod.MetadataToken:x8}");
        Console.WriteLine($"keepalive-movenext-token 0x{moveNext.MetadataToken:x8}");
        Console.WriteLine($"keepalive-movenext-il-bytes {moveNextILBytes}");
        await KeepAlive(${KeepAliveIterations}, ${KeepAliveInnerIterations}).ConfigureAwait(false);
        Console.WriteLine($"keepalive-final {s_sink}");
        return 0;
    }

    [MethodImpl(MethodImplOptions.NoInlining | MethodImplOptions.NoOptimization)]
    public static async Task KeepAlive(int iterations, int innerIterations)
    {
        Console.WriteLine("keepalive-begin");
        int value = 17;
        for (int i = 0; i < iterations; i++)
        {
            for (int j = 0; j < innerIterations; j++)
            {
                value = unchecked((value * 1103515245 + 12345) ^ (i + j));
            }

            s_sink = value;
            Console.WriteLine($"keepalive-tick {i}");
            await Task.Delay(10).ConfigureAwait(false);
        }

        Console.WriteLine("keepalive-end");
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
        fail(`failed to build cooperative async-break test app: ${result.status}`);
    }

    const outputMatch = [...result.stdout.matchAll(/-> (.*\.dll)$/gm)]
        .map(match => match[1])
        .find(outputPath => path.basename(outputPath) === `${assemblyName}.dll`);
    if (outputMatch !== undefined) {
        return outputMatch;
    }

    return path.join(testDirectory, "bin/Debug/net11.0", `${assemblyName}.dll`);
}

async function loadAndRunRuntime(runtimeJsPath, appPath, sharedFrameworkPath, onRuntimeInstantiated, onRuntimePrint, onRuntimeDone) {
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
            let runtimeInstance;
            let runtimeDone = false;
            const completeRuntime = () => {
                if (!runtimeDone && runtimeInstance !== undefined) {
                    runtimeDone = true;
                    onRuntimeDone(runtimeInstance);
                }
            };
            const moduleConfig = {
                noExitRuntime: true,
                arguments: ["-c", sharedFrameworkPath, appPath],
                locateFile: fileName => path.join(runtimeDirectory, fileName),
                onAbort: reason => reject(new Error(String(reason))),
                print(text) {
                    const value = String(text).trimEnd();
                    process.stdout.write(`${value}\n`);
                    onRuntimePrint(value);
                    if (value.startsWith("keepalive-final ")) {
                        completeRuntime();
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
                        runtimeInstance = instance;
                        onRuntimeInstantiated(instance);
                        receiveInstance(instance, module);
                        resolve();
                    }).catch(reject);

                    return {};
                }
            };

            try {
                const runResult = moduleFactory.selfRun(moduleConfig);
                if (runResult && typeof runResult.then === "function") {
                    runResult.catch(reject);
                }
            } catch (error) {
                reject(error);
            }
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

function pollDbiAsyncBreakEvent(debuggerInstance) {
    const stack = debuggerInstance.exports.stackSave();
    const eventAddress = debuggerInstance.exports.stackAlloc(IpcAsyncBreakSize);
    const bytesWrittenAddress = debuggerInstance.exports.stackAlloc(4);
    try {
        const pollResult = debuggerInstance.module._coreclr_wasm_dbi_dac_dbi_poll_ipc_async_break_complete(
            eventAddress,
            IpcAsyncBreakSize,
            bytesWrittenAddress) | 0;
        const view = new DataView(debuggerInstance.exports.memory.buffer);
        const bytesWritten = view.getUint32(bytesWrittenAddress, true);
        if (pollResult !== 0 || bytesWritten === 0) {
            return { pollResult, bytesWritten, payload: null };
        }

        const payload = {
            magic: view.getUint32(eventAddress + 0, true),
            type: view.getUint32(eventAddress + 4, true),
            processId: view.getUint32(eventAddress + 8, true),
            threadId: view.getUint32(eventAddress + 12, true),
            hr: view.getInt32(eventAddress + 32, true),
            flags: view.getUint32(eventAddress + 36, true),
            asyncBreakToken: view.getBigUint64(eventAddress + 40, true),
            funcMetadataToken: view.getUint32(eventAddress + 48, true),
            ilOffset: view.getUint32(eventAddress + 52, true),
            interpreterIP: view.getBigUint64(eventAddress + 64, true)
        };
        return { pollResult, bytesWritten, payload };
    } finally {
        debuggerInstance.exports.stackRestore(stack);
    }
}

function sendContinue(debuggerInstance, token) {
    return debuggerInstance.module._coreclr_wasm_dbi_dac_dbi_send_ipc_continue_request(
        Number(token & 0xffffffffn),
        Number(token >> 32n)) | 0;
}

async function main() {
    const repoRoot = path.resolve(__dirname, "../../../..");
    const coreclrObjDirectory = path.resolve(process.cwd(), process.argv[2] ?? "artifacts/obj/coreclr/browser.wasm.Debug");
    const runtimeJsPath = path.join(coreclrObjDirectory, "hosts/corerun/corerun.js");
    const debuggerJsPath = path.join(coreclrObjDirectory, "debug/wasm-dbi-dac/coreclr-dbi-dac-tests.js");
    const sharedFrameworkPath = path.join(repoRoot, "artifacts/bin/testhost/net11.0-browser-Debug-wasm/shared/Microsoft.NETCore.App/11.0.0");
    const appPath = buildHelloWorld(repoRoot);

    requireFile(runtimeJsPath, "runtime JS wrapper");
    requireFile(path.join(path.dirname(runtimeJsPath), "corerun.wasm"), "runtime wasm module");
    requireFile(debuggerJsPath, "debugger JS wrapper");
    requireFile(path.join(path.dirname(debuggerJsPath), "coreclr-dbi-dac-tests.wasm"), "debugger wasm module");
    requireFile(sharedFrameworkPath, "browser-wasm testhost shared framework");
    requireFile(appPath, "HelloCooperativeAsyncBreak.dll");

    let runtimeExports;
    let debuggerInstance;
    let asyncBreakRequestResult = undefined;
    let asyncBreakRequestPending = false;
    let fireEventToPauseCount = 0;
    let continueDuringCallbackResult = undefined;
    let asyncBreakEvent;
    let keepAliveMoveNextToken = 0;
    let keepAliveMoveNextILBytes = 0;
    let keepAliveFinalSeen = false;
    let keepAliveTickCount = 0;
    let resolveAsyncBreakEvent;
    const asyncBreakEventPromise = new Promise(resolve => {
        resolveAsyncBreakEvent = resolve;
    });
    let resolveRuntimeDone;
    const runtimeDonePromise = new Promise(resolve => {
        resolveRuntimeDone = resolve;
    });
    const requestAsyncBreak = () => {
        if (asyncBreakRequestPending || asyncBreakEvent !== undefined) {
            return;
        }

        const result = debuggerInstance.module._coreclr_wasm_dbi_dac_dbi_async_break_request() | 0;
        asyncBreakRequestResult ??= result;
        asyncBreakRequestPending = result === 0;
    };
    const handleRuntimeLine = text => {
        const methodTokenMatch = /^keepalive-method-token 0x([0-9a-fA-F]+)$/.exec(text);
        if (methodTokenMatch !== null) {
            return;
        }

        const moveNextTokenMatch = /^keepalive-movenext-token 0x([0-9a-fA-F]+)$/.exec(text);
        if (moveNextTokenMatch !== null) {
            keepAliveMoveNextToken = Number.parseInt(moveNextTokenMatch[1], 16) >>> 0;
            return;
        }

        const moveNextILBytesMatch = /^keepalive-movenext-il-bytes ([0-9]+)$/.exec(text);
        if (moveNextILBytesMatch !== null) {
            keepAliveMoveNextILBytes = Number.parseInt(moveNextILBytesMatch[1], 10) >>> 0;
            return;
        }

        const tickMatch = /^keepalive-tick ([0-9]+)$/.exec(text);
        if (tickMatch !== null) {
            keepAliveTickCount = Math.max(keepAliveTickCount, Number.parseInt(tickMatch[1], 10) + 1);
            if (keepAliveTickCount >= 2) {
                setTimeout(requestAsyncBreak, 0);
            }
            return;
        }

        if (text.startsWith("keepalive-final ")) {
            keepAliveFinalSeen = true;
            resolveRuntimeDone();
        }
    };
    let stdoutRemainder = "";
    const observeRuntimeOutput = text => {
        stdoutRemainder += text;
        const lines = stdoutRemainder.split(/\r?\n/);
        stdoutRemainder = lines.pop() ?? "";
        for (const line of lines) {
            handleRuntimeLine(line.trimEnd());
        }
    };
    const originalConsoleLog = console.log.bind(console);
    console.log = (...args) => {
        handleRuntimeLine(args.map(arg => String(arg)).join(" ").trimEnd());
        originalConsoleLog(...args);
    };
    const originalStdoutWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk, encoding, callback) => {
        const text = Buffer.isBuffer(chunk) ? chunk.toString(typeof encoding === "string" ? encoding : "utf8") : String(chunk);
        observeRuntimeOutput(text);
        return originalStdoutWrite(chunk, encoding, callback);
    };
    const originalFsWriteSync = fs.writeSync.bind(fs);
    fs.writeSync = (...args) => {
        if (args[0] === 1) {
            const data = args[1];
            if (typeof data === "string") {
                observeRuntimeOutput(data);
            } else if (Buffer.isBuffer(data) || ArrayBuffer.isView(data)) {
                const offset = typeof args[2] === "number" ? args[2] : 0;
                const length = typeof args[3] === "number" ? args[3] : data.byteLength - offset;
                observeRuntimeOutput(Buffer.from(data.buffer, data.byteOffset + offset, length).toString("utf8"));
            }
        }

        return originalFsWriteSync(...args);
    };

    const getRuntimeHeap = () => new Uint8Array(runtimeExports.memory.buffer);
    const getDebuggerHeap = () => new Uint8Array(debuggerInstance.exports.memory.buffer);

    debuggerInstance = await loadDebugger(debuggerJsPath, () => -1);

    try {
        await loadAndRunRuntime(
            runtimeJsPath,
            appPath,
            sharedFrameworkPath,
            instance => {
                runtimeExports = instance.exports;
                if (typeof runtimeExports.memory === "undefined" || typeof runtimeExports.memory.buffer === "undefined") {
                    fail("runtime export 'memory' is missing or does not expose a buffer");
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
                        symbolName === "g_wasmDebugLastIpcAsyncBreak" ? runtimeExports.Getg_wasmDebugLastIpcAsyncBreak() >>> 0 :
                        symbolName === "g_wasmDebugLastIpcAsyncBreakValid" ? runtimeExports.Getg_wasmDebugLastIpcAsyncBreakValid() >>> 0 :
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
                globalThis.CoreClrWasmDebugSubmitAsyncBreakRequest = () => {
                    if (typeof runtimeExports.CoreClrWasmDebugSetAsyncBreakInProgress !== "function") {
                        return -1;
                    }

                    runtimeExports.CoreClrWasmDebugSetAsyncBreakInProgress(1);
                    return 0;
                };
                globalThis.CoreClrWasmDebugSubmitStepIntoRequest = () => -1;
                globalThis.CoreClrWasmDebugLookupSourceLocation = () => -1;
                globalThis.coreClrDebugLookupSourceLocation = () => -1;
                globalThis.coreClrDebugFireEventToPause = (eventAddress, eventLength) => {
                    if ((eventLength >>> 0) !== IpcAsyncBreakSize) {
                        return 0;
                    }

                    fireEventToPauseCount++;
                    asyncBreakEvent = pollDbiAsyncBreakEvent(debuggerInstance);
                    if (asyncBreakEvent.payload !== null) {
                        continueDuringCallbackResult = sendContinue(debuggerInstance, asyncBreakEvent.payload.asyncBreakToken);
                    }
                    asyncBreakRequestPending = false;
                    resolveAsyncBreakEvent(asyncBreakEvent);
                    return 0;
                };

                const ackResult = debuggerInstance.module._coreclr_wasm_dbi_dac_acknowledge_protocol(
                    ExpectedVersionBlobMagic, ExpectedAbiVersion, ExpectedProtocolBreakingChangeCounter) | 0;
                if (ackResult !== 0) {
                    fail(`failed to acknowledge sidecar protocol: ${ackResult}`);
                }

                const sessionCreateResult = debuggerInstance.module._coreclr_wasm_dbi_dac_dbi_session_create() | 0;
                if (sessionCreateResult !== 0) {
                    fail(`failed to create DBI session: ${sessionCreateResult}`);
                }

                const connectResult = debuggerInstance.module._coreclr_wasm_dbi_dac_dbi_connect_runtime(1) | 0;
                if (connectResult !== 0) {
                    fail(`failed to connect DBI session to runtime: ${connectResult}`);
                }

                const previousConnected = runtimeExports.CoreClrWasmDebugSetDebuggerConnected(1) | 0;
                if (previousConnected !== 0) {
                    fail(`expected debugger connected previous value 0, got ${previousConnected}`);
                }

            },
            text => {
                handleRuntimeLine(text);
            },
            () => {
                resolveRuntimeDone();
            });

        await withTimeout(asyncBreakEventPromise, AsyncBreakTimeoutMs, "timed out waiting for cooperative async-break event");
        await withTimeout(runtimeDonePromise, RuntimeCompletionTimeoutMs, "timed out waiting for managed loop completion");

        // Give the final print callback a turn to parse stdout state.
        await sleep(0);

        const payload = asyncBreakEvent?.payload;
        if (asyncBreakRequestResult !== 0 ||
            fireEventToPauseCount !== 1 ||
            asyncBreakEvent?.pollResult !== 0 ||
            asyncBreakEvent?.bytesWritten !== IpcAsyncBreakSize ||
            payload === undefined ||
            payload === null ||
            payload.magic !== IpcAsyncBreakMagic ||
            payload.type !== IpcAsyncBreakType ||
            payload.processId !== 1 ||
            payload.threadId !== 1 ||
            payload.hr !== 0 ||
            payload.flags !== 0 ||
            payload.asyncBreakToken <= 0n ||
            // The nearest interpreter sequence point after a cooperative
            // request can be in the async/task scheduler before returning to
            // the managed loop body; validate a real IL stop and the loop's
            // post-continue completion rather than requiring a user-method token.
            payload.funcMetadataToken === 0 ||
            payload.interpreterIP === 0n ||
            continueDuringCallbackResult !== 0 ||
            !keepAliveFinalSeen ||
            keepAliveTickCount < 2 ||
            (runtimeExports.CoreClrWasmDebugIsAsyncBreakInProgress() | 0) !== 0) {
            console.error(JSON.stringify({
                asyncBreakRequestResult,
                fireEventToPauseCount,
                continueDuringCallbackResult,
                keepAliveMoveNextToken: `0x${keepAliveMoveNextToken.toString(16)}`,
                keepAliveMoveNextILBytes,
                keepAliveFinalSeen,
                keepAliveTickCount,
                asyncBreakEvent
            }, (_, value) => typeof value === "bigint" ? value.toString() : value, 2));
            fail("cooperative async-break smoke validation failed");
        }

        console.log(JSON.stringify({
            status: "PASS",
            asyncBreakToken: payload.asyncBreakToken.toString(),
            funcMetadataToken: `0x${payload.funcMetadataToken.toString(16)}`,
            ilOffset: payload.ilOffset,
            ticks: keepAliveTickCount
        }));
    } finally {
        console.log = originalConsoleLog;
        process.stdout.write = originalStdoutWrite;
        fs.writeSync = originalFsWriteSync;
        try {
            if (runtimeExports?.CoreClrWasmDebugSetDebuggerConnected) {
                runtimeExports.CoreClrWasmDebugSetDebuggerConnected(0);
            }
        } catch {
        }
        try {
            debuggerInstance?.module?._coreclr_wasm_dbi_dac_dbi_disconnect_runtime?.();
            debuggerInstance?.module?._coreclr_wasm_dbi_dac_dbi_session_destroy?.();
        } catch {
        }
        delete globalThis.coreClrDebugFireEventToPause;
        delete globalThis.coreClrDebugLookupSourceLocation;
        delete globalThis.CoreClrWasmDebugLookupSourceLocation;
        delete globalThis.CoreClrWasmDebugSubmitStepIntoRequest;
        delete globalThis.CoreClrWasmDebugSubmitAsyncBreakRequest;
        delete globalThis.CoreClrWasmDebugSubmitContinueRequest;
        delete globalThis.CoreClrWasmDebugGetTargetModuleBase;
        delete globalThis.CoreClrWasmDebugGetSymbolAddress;
        delete globalThis.CoreClrWasmDebugReadTargetMemory;
    }
}

main().catch(error => {
    console.error(error && error.stack ? error.stack : String(error));
    process.exitCode = 1;
});
