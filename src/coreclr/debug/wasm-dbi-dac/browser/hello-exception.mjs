// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

// hello-exception smoke (browser). Exercises the structured first-chance
// exception DBI event path: the runtime fires coreClrDebugFireEventToPause
// when a managed exception is thrown, and the sidecar DAC drains the
// structured WasmDbgIpcEventException payload via
// coreclr_wasm_dbi_dac_dbi_poll_ipc_exception.

import {
    IpcExceptionMagic,
    IpcExceptionSize,
    IpcExceptionType,
    acknowledgeProtocol,
    assert,
    installDebuggerImports,
    loadRuntime,
    loadSidecar,
    pollDbiIpcException,
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
    let before = false;
    let caught = false;
    let after = false;
    const exceptionEvents = [];
    let resolveComplete;
    const completed = new Promise(resolve => { resolveComplete = resolve; });

    function recordRuntimeLine(text) {
        if (text === 'before throw') {
            before = true;
        } else if (text.startsWith('caught ')) {
            caught = true;
        } else if (text === 'after throw') {
            after = true;
            resolveComplete();
        }
    }

    try {
        const manifest = await fetchJson('/hello-exception/manifest.json');
        sidecar = await loadSidecar(manifest.sidecarJsUrl);

        installDebuggerImports({
            runtime: () => runtimeExports,
            sidecar: () => sidecar
        });
        globalThis.coreClrDebugFireEventToPause = (eventAddress, eventLength) => {
            fireEventToPauseCount++;
            if ((eventLength >>> 0) !== IpcExceptionSize) {
                return 0;
            }

            const exception = pollDbiIpcException(sidecar);
            if (exception.payload !== null) {
                exceptionEvents.push(exception);
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

        await withTimeout(completed, 'exception app completion', CompletionTimeoutMs);

        const matchingEvent = exceptionEvents.find(event =>
            event.payload?.magic === IpcExceptionMagic &&
            event.payload?.type === IpcExceptionType &&
            event.payload?.exceptionTypeName.includes('InvalidOperationException'));

        const disconnectResult = connected ? sidecar.module._coreclr_wasm_dbi_dac_dbi_disconnect_runtime() : 0;
        connected = false;
        const sessionDestroyResult = sessionCreated ? sidecar.module._coreclr_wasm_dbi_dac_dbi_session_destroy() : 0;
        sessionCreated = false;

        assert(before, 'runtime did not print "before throw"');
        assert(caught, 'runtime did not print "caught ..."');
        assert(after, 'runtime did not print "after throw"');
        assert(exceptionEvents.length >= 1, 'no exception events observed');
        assert(matchingEvent !== undefined, 'no exception event matching InvalidOperationException');
        assert(matchingEvent.bytesWritten === IpcExceptionSize, `exception event wrong size: ${matchingEvent.bytesWritten}`);
        assert(matchingEvent.payload.processId === 1 && matchingEvent.payload.threadId === 1, 'exception process/thread mismatch');
        assert(matchingEvent.payload.exceptionToken !== 0n, 'exception token missing');
        assert(matchingEvent.payload.funcMetadataToken !== 0, 'exception method token missing');
        assert(matchingEvent.payload.exceptionAddress !== 0n, 'exception address missing');
        assert(disconnectResult === 0 && sessionDestroyResult === 0, 'disconnect/session destroy failed');

        const result = {
            fireEventToPauseCount,
            eventCount: exceptionEvents.length,
            matchingEvent: {
                magic: matchingEvent.payload.magic,
                type: matchingEvent.payload.type,
                exceptionToken: matchingEvent.payload.exceptionToken,
                funcMetadataToken: matchingEvent.payload.funcMetadataToken,
                ilOffset: matchingEvent.payload.ilOffset,
                exceptionTypeName: matchingEvent.payload.exceptionTypeName
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
