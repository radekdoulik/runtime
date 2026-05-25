// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { performance } = require("perf_hooks");
const { pathToFileURL } = require("url");
const { spawnSync } = require("child_process");

const BreakpointCommand = "dbi-command:set-breakpoint:name=BreakHere";

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

function readAscii(memory, address, byteCount) {
    let result = "";
    for (let index = 0; index < byteCount; index++) {
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
                read_target_memory() { return -1; },
                get_symbol_address() { return -1; },
                get_target_module_base() { return -1; },
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
                print() {},
                printErr() {},
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

    debuggerInstance = await loadDebugger(debuggerJsPath, (messageAddress, messageLength) => {
        const message = debuggerInstance.module.HEAPU8.slice(messageAddress, messageAddress + messageLength);
        const stack = runtimeExports.stackSave();
        const runtimeMessageAddress = runtimeExports.stackAlloc(messageLength);
        runtimeMemory.set(message, runtimeMessageAddress);
        const result = runtimeExports.CoreClrWasmDebugReceiveCommand(runtimeMessageAddress, messageLength);
        runtimeExports.stackRestore(stack);
        return result;
    });

    await loadAndRunRuntime(runtimeJsPath, appPath, sharedFrameworkPath, instance => {
        runtimeExports = instance.exports;
        runtimeMemory = new Uint8Array(runtimeExports.memory.buffer);

        const message = new TextEncoder().encode(BreakpointCommand);
        const stack = debuggerInstance.exports.stackSave();
        const messageAddress = debuggerInstance.exports.stackAlloc(message.length);
        writeBytes(debuggerInstance.module.HEAPU8, messageAddress, message);
        const sendResult = debuggerInstance.module._coreclr_wasm_dbi_dac_transport_send_test_message(messageAddress, message.length);
        debuggerInstance.exports.stackRestore(stack);
        if (sendResult !== 0) {
            fail(`failed to send breakpoint command: ${sendResult}`);
        }
    });

    const result = await waitForBreakpointHit(runtimeExports);
    console.log(JSON.stringify(result, null, 2));

    if (result.hitCount !== 1 ||
        result.copyResult !== 0 ||
        !result.event.includes("breakpoint-hit:name=BreakHere")) {
        fail("HelloWorld breakpoint was not reached");
    }
}

main().catch(error => {
    console.error(error.stack || error);
    process.exitCode = 1;
});
