// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

// hello-module-load smoke (browser). Exercises the structured
// module-load DBI event path: the runtime fires
// coreClrDebugFireEventToPause for each managed module that loads
// (startup framework assemblies + an explicit Assembly.Load), and the
// sidecar DAC drains the structured WasmDbgIpcEventModuleLoad payload
// via coreclr_wasm_dbi_dac_dbi_poll_ipc_module_load.

import {
    IpcModuleLoadMagic,
    IpcModuleLoadSize,
    IpcModuleLoadType,
    acknowledgeProtocol,
    assert,
    installDebuggerImports,
    loadRuntime,
    loadSidecar,
    pollDbiIpcModuleLoad,
    removeDebuggerImports
} from './host.mjs';

const CompletionTimeoutMs = 120000;

function setStatus(text) {
    const status = document.getElementById('status');
    if (status !== null) {
        status.textContent = text;
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function withTimeout(promise, description, timeoutMs) {
    return Promise.race([
        promise,
        sleep(timeoutMs).then(() => {
            throw new Error(`timed out waiting for ${description}`);
        })
    ]);
}

function toDisplayResult(result) {
    return JSON.parse(JSON.stringify(result, (_, value) => typeof value === 'bigint' ? `0x${value.toString(16)}` : value));
}

async function fetchJson(url) {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`failed to fetch ${url}: ${response.status} ${response.statusText}`);
    }

    return response.json();
}

export async function runSmoke() {
    globalThis.__smokeResult = undefined;
    setStatus('loading runtime');

    let runtimeExports;
    let sidecar;
    let sessionCreated = false;
    let connected = false;
    let debuggerConnected = false;
    let fireEventToPauseCount = 0;
    let fireEventToPauseLastLength = 0;
    let before = false;
    let after = false;
    const moduleLoadEvents = [];
    let resolveComplete;
    const completed = new Promise(resolve => { resolveComplete = resolve; });

    function recordRuntimeLine(text) {
        if (text === 'before module load') {
            before = true;
        } else if (text === 'after module load') {
            after = true;
            resolveComplete();
        }
    }

    try {
        const manifest = await fetchJson('/hello-module-load/manifest.json');
        sidecar = await loadSidecar(manifest.sidecarJsUrl);

        installDebuggerImports({
            runtime: () => runtimeExports,
            sidecar: () => sidecar
        });
        globalThis.coreClrDebugFireEventToPause = (eventAddress, eventLength) => {
            fireEventToPauseCount++;
            fireEventToPauseLastLength = eventLength >>> 0;
            const moduleLoad = pollDbiIpcModuleLoad(sidecar);
            if (moduleLoad.payload !== null) {
                moduleLoadEvents.push(moduleLoad);
            }
            return 0;
        };

        await loadRuntime(manifest.runtimeJsUrl, {
            arguments: ['-c', manifest.sharedFrameworkVirtualPath, manifest.appVirtualPath],
            files: manifest.files,
            onPrint(text) {
                const value = String(text);
                console.log(`[runtime] ${value}`);
                for (const line of value.split(/\r?\n/)) {
                    if (line.length > 0) {
                        recordRuntimeLine(line.trimEnd());
                    }
                }
            },
            onPrintErr: text => console.warn(`[runtime] ${text}`),
            onInstance(instance) {
                runtimeExports = instance.exports;
                assert(runtimeExports.memory?.buffer, "runtime export 'memory' is missing or does not expose a buffer");
                assert(typeof runtimeExports.CoreClrWasmDebugGetLastIpcModuleLoadSize === 'function', 'runtime export CoreClrWasmDebugGetLastIpcModuleLoadSize is missing');
                assert((runtimeExports.CoreClrWasmDebugGetLastIpcModuleLoadSize() | 0) === IpcModuleLoadSize, 'unexpected runtime IPC module-load size');
                acknowledgeProtocol(sidecar);
                const sessionCreateResult = sidecar.module._coreclr_wasm_dbi_dac_dbi_session_create();
                assert(sessionCreateResult === 0, `failed to create DBI session: ${sessionCreateResult}`);
                sessionCreated = true;
                const connectResult = sidecar.module._coreclr_wasm_dbi_dac_dbi_connect_runtime(1);
                assert(connectResult === 0, `failed to connect DBI session to runtime: ${connectResult}`);
                connected = true;
                const prevConnected = runtimeExports.CoreClrWasmDebugSetDebuggerConnected(1);
                assert(prevConnected === 0, `expected CoreClrWasmDebugSetDebuggerConnected to return 0, got ${prevConnected}`);
                debuggerConnected = true;
            }
        });

        await withTimeout(completed, 'module-load app completion', CompletionTimeoutMs);

        const matchingEvent = moduleLoadEvents.find(event =>
            event.payload?.magic === IpcModuleLoadMagic &&
            event.payload?.type === IpcModuleLoadType &&
            event.payload?.flags === 0 &&
            event.payload?.moduleName.length > 0);

        const disconnectResult = connected ? sidecar.module._coreclr_wasm_dbi_dac_dbi_disconnect_runtime() : 0;
        connected = false;
        const sessionDestroyResult = sessionCreated ? sidecar.module._coreclr_wasm_dbi_dac_dbi_session_destroy() : 0;
        sessionCreated = false;

        assert(before, 'runtime did not print "before module load"');
        assert(after, 'runtime did not print "after module load"');
        assert(moduleLoadEvents.length >= 1, 'no module-load events observed');
        assert(matchingEvent !== undefined, 'no module-load event with expected magic/type/name');
        assert(matchingEvent.bytesWritten === IpcModuleLoadSize, `module-load event wrong size: ${matchingEvent.bytesWritten}`);
        assert(matchingEvent.payload.processId === 1 && matchingEvent.payload.threadId === 1, 'module-load process/thread mismatch');
        assert(matchingEvent.payload.moduleToken !== 0n, 'module-load token missing');
        assert(fireEventToPauseCount >= 1, 'fireEventToPause was never called');
        assert(fireEventToPauseLastLength === IpcModuleLoadSize, `fireEventToPause last length unexpected: ${fireEventToPauseLastLength}`);
        assert(disconnectResult === 0 && sessionDestroyResult === 0, 'disconnect/session destroy failed');

        const result = {
            fireEventToPauseCount,
            fireEventToPauseLastLength,
            eventCount: moduleLoadEvents.length,
            matchingEvent: {
                magic: matchingEvent.payload.magic,
                type: matchingEvent.payload.type,
                moduleToken: matchingEvent.payload.moduleToken,
                moduleName: matchingEvent.payload.moduleName,
                assemblyPath: matchingEvent.payload.assemblyPath
            },
            disconnectResult,
            sessionDestroyResult
        };
        const displayResult = toDisplayResult(result);
        globalThis.__smokeResult = { passed: true, result: displayResult };
        return displayResult;
    } catch (error) {
        globalThis.__smokeResult = { passed: false, error: `${error.message}\n${error.stack}` };
        throw error;
    } finally {
        if (debuggerConnected && runtimeExports?.CoreClrWasmDebugSetDebuggerConnected) {
            runtimeExports.CoreClrWasmDebugSetDebuggerConnected(0);
        }
        if (connected) {
            sidecar.module._coreclr_wasm_dbi_dac_dbi_disconnect_runtime();
        }
        if (sessionCreated) {
            sidecar.module._coreclr_wasm_dbi_dac_dbi_session_destroy();
        }
        removeDebuggerImports();
    }
}
