// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

import {
    acknowledgeProtocol,
    assert,
    loadRuntime,
    loadSidecar,
    readAscii,
    writeUint64
} from './host.mjs';

const CompletionTimeoutMs = 120000;

async function fetchJson(url) {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`failed to fetch ${url}: ${response.status} ${response.statusText}`);
    }

    return response.json();
}

function setStatus(text) {
    const status = document.getElementById('status');
    if (status !== null) {
        status.textContent = text;
    }
}

function setTickCount(progress) {
    const tickCount = document.getElementById('tick-count');
    if (tickCount !== null) {
        tickCount.textContent = String(progress);
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

export async function runSmoke() {
    globalThis.__smokeProgress = 0;
    globalThis.__smokeResult = undefined;
    setTickCount(0);
    setStatus('loading runtime');

    let runtimeExports;
    let sidecar;
    let sessionCreated = false;
    let connected = false;
    let asyncBreakFlagSetPrevious = -1;
    let asyncBreakFlagSetCurrent = -1;
    let asyncBreakFlagClearPrevious = -1;
    let asyncBreakFlagClearCurrent = -1;
    let begin = false;
    let end = false;
    let final = false;
    let finalSink = 0;
    let tickCount = 0;
    let lastTick = -1;
    let fireEventToPauseCount = 0;
    let fireEventToPauseLastEvent = '';
    const startedAt = performance.now();
    let completedAt = 0;
    let resolveComplete;
    const completed = new Promise(resolve => {
        resolveComplete = resolve;
    });

    const getRuntimeHeap = () => {
        assert(runtimeExports?.memory, 'getRuntimeHeap called before runtimeExports.memory was bound');
        return new Uint8Array(runtimeExports.memory.buffer);
    };
    const getDebuggerHeap = () => {
        assert(sidecar?.exports?.memory, 'getDebuggerHeap called before sidecar memory was bound');
        return new Uint8Array(sidecar.exports.memory.buffer);
    };

    function markComplete() {
        completedAt = performance.now();
        resolveComplete();
    }

    function recordRuntimeLine(text) {
        if (text === 'keepalive-begin') {
            begin = true;
            setStatus('running busy loop');
            return;
        }

        if (text.startsWith('keepalive-tick ')) {
            const tick = Number(text.substring('keepalive-tick '.length));
            if (Number.isFinite(tick)) {
                lastTick = tick;
                tickCount = Math.max(tickCount, tick + 1);
                globalThis.__smokeProgress = tickCount;
                setTickCount(tickCount);
            }
            return;
        }

        if (text === 'keepalive-end') {
            end = true;
            setStatus('loop completed');
            return;
        }

        if (text.startsWith('keepalive-final ')) {
            const value = Number(text.substring('keepalive-final '.length));
            finalSink = Number.isFinite(value) ? value : 0;
            final = true;
            markComplete();
        }
    }

    try {
        const manifest = await fetchJson('/hello-cdp-pause/manifest.json');
        sidecar = await loadSidecar(manifest.sidecarJsUrl);

        globalThis.CoreClrWasmDebugReadTargetMemory = (targetAddress, debuggerAddress, byteCount) => {
            const runtimeHeap = getRuntimeHeap();
            const debuggerHeap = getDebuggerHeap();
            if (targetAddress + byteCount > runtimeHeap.length || debuggerAddress + byteCount > debuggerHeap.length) {
                return -1;
            }

            debuggerHeap.set(runtimeHeap.subarray(targetAddress, targetAddress + byteCount), debuggerAddress);
            return 0;
        };
        globalThis.CoreClrWasmDebugGetSymbolAddress = (baseAddress, symbolNameAddress, symbolNameLength, addressOutAddress) => {
            const debuggerHeap = getDebuggerHeap();
            const symbolName = readAscii(debuggerHeap, symbolNameAddress, symbolNameLength);
            const symbolAddress =
                symbolName === 'DotNetRuntimeContractDescriptor' ? runtimeExports.GetDotNetRuntimeContractDescriptor() >>> 0 :
                symbolName === 'g_dacTable' ? runtimeExports.Getg_dacTable() >>> 0 :
                symbolName === 'WasmDbiDacTestData' ? runtimeExports.GetWasmDbiDacTestData() >>> 0 :
                symbolName === 'g_wasmDebugLastIpcEvent' ? runtimeExports.Getg_wasmDebugLastIpcEvent() >>> 0 :
                symbolName === 'g_wasmDebugLastIpcEventValid' ? runtimeExports.Getg_wasmDebugLastIpcEventValid() >>> 0 :
                symbolName === 'g_wasmDebugLastIpcException' ? runtimeExports.Getg_wasmDebugLastIpcException() >>> 0 :
                symbolName === 'g_wasmDebugLastIpcExceptionValid' ? runtimeExports.Getg_wasmDebugLastIpcExceptionValid() >>> 0 :
                symbolName === 'g_wasmDebugLastIpcAsyncBreak' ? runtimeExports.Getg_wasmDebugLastIpcAsyncBreak() >>> 0 :
                symbolName === 'g_wasmDebugLastIpcAsyncBreakValid' ? runtimeExports.Getg_wasmDebugLastIpcAsyncBreakValid() >>> 0 :
                symbolName === 'g_wasmDebugLastIpcStepComplete' ? runtimeExports.Getg_wasmDebugLastIpcStepComplete() >>> 0 :
                symbolName === 'g_wasmDebugLastIpcStepCompleteValid' ? runtimeExports.Getg_wasmDebugLastIpcStepCompleteValid() >>> 0 :
                symbolName === 'g_wasmDebugLastIpcModuleLoad' ? runtimeExports.Getg_wasmDebugLastIpcModuleLoad() >>> 0 :
                symbolName === 'g_wasmDebugLastIpcModuleLoadValid' ? runtimeExports.Getg_wasmDebugLastIpcModuleLoadValid() >>> 0 :
                symbolName === 'g_wasmDebugBreakpoints' ? runtimeExports.Getg_wasmDebugBreakpoints() >>> 0 :
                symbolName === 'g_wasmDebugLastLocalsRecord' ? runtimeExports.Getg_wasmDebugLastLocalsRecord() >>> 0 :
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
        globalThis.CoreClrWasmDebugSendIpcToRuntime = () => -1;
        globalThis.CoreClrWasmDebugSubmitContinueRequest = () => -1;
        globalThis.CoreClrWasmDebugSubmitAsyncBreakRequest = () => {
            if (typeof runtimeExports?.CoreClrWasmDebugSetAsyncBreakInProgress !== 'function') {
                return -1;
            }

            runtimeExports.CoreClrWasmDebugSetAsyncBreakInProgress(1);
            return 0;
        };
        globalThis.CoreClrWasmDebugSubmitStepIntoRequest = () => -1;
        globalThis.CoreClrWasmDebugLookupSourceLocation = () => -1;
        globalThis.coreClrDebugLookupSourceLocation = () => -1;
        globalThis.coreClrDebugFireEventToPause = (eventAddress, eventLength) => {
            fireEventToPauseCount++;
            fireEventToPauseLastEvent = readAscii(getRuntimeHeap(), eventAddress >>> 0, eventLength >>> 0);
            return 0;
        };

        await loadRuntime(manifest.runtimeJsUrl, {
            arguments: ['-c', manifest.sharedFrameworkVirtualPath, manifest.appVirtualPath],
            files: manifest.files,
            onPrint(text) {
                const value = String(text);
                console.log(`[runtime] ${value}`);
                // Emscripten's print callback may batch multiple newline-
                // terminated lines into a single call under high throughput
                // (e.g., right after Debugger.resume releases a backlog of
                // queued output). Split on newlines so every keepalive-tick
                // line is recorded individually; otherwise ticks past the
                // first in each batch parse as NaN and are silently dropped.
                for (const line of value.split('\n')) {
                    if (line.length > 0) {
                        recordRuntimeLine(line);
                    }
                }
            },
            onPrintErr: text => console.warn(`[runtime] ${text}`),
            onInstance(instance) {
                runtimeExports = instance.exports;
                assert(runtimeExports.memory?.buffer, "runtime export 'memory' is missing or does not expose a buffer");
                assert(typeof runtimeExports.CoreClrWasmDebugSetAsyncBreakInProgress === 'function', 'runtime export CoreClrWasmDebugSetAsyncBreakInProgress is missing');
                assert(typeof runtimeExports.CoreClrWasmDebugIsAsyncBreakInProgress === 'function', 'runtime export CoreClrWasmDebugIsAsyncBreakInProgress is missing');
                acknowledgeProtocol(sidecar);
                const sessionCreateResult = sidecar.module._coreclr_wasm_dbi_dac_dbi_session_create();
                assert(sessionCreateResult === 0, `failed to create DBI session: ${sessionCreateResult}`);
                sessionCreated = true;
                const connectResult = sidecar.module._coreclr_wasm_dbi_dac_dbi_connect_runtime(1);
                assert(connectResult === 0, `failed to connect DBI session to runtime: ${connectResult}`);
                connected = true;
                const asyncBreakRequestResult = sidecar.module._coreclr_wasm_dbi_dac_dbi_async_break_request();
                assert(asyncBreakRequestResult === 0, `async-break request facade failed: ${asyncBreakRequestResult}`);
                asyncBreakFlagSetPrevious = 0;
                asyncBreakFlagSetCurrent = runtimeExports.CoreClrWasmDebugIsAsyncBreakInProgress() | 0;
            }
        });

        await withTimeout(completed, 'KeepAlive loop completion', CompletionTimeoutMs);
        if (runtimeExports !== undefined) {
            asyncBreakFlagClearPrevious = runtimeExports.CoreClrWasmDebugSetAsyncBreakInProgress(0) | 0;
            asyncBreakFlagClearCurrent = runtimeExports.CoreClrWasmDebugIsAsyncBreakInProgress() | 0;
        }

        const disconnectResult = connected
            ? sidecar.module._coreclr_wasm_dbi_dac_dbi_disconnect_runtime()
            : 0;
        connected = false;
        const sessionDestroyResult = sessionCreated
            ? sidecar.module._coreclr_wasm_dbi_dac_dbi_session_destroy()
            : 0;
        sessionCreated = false;

        assert(begin, 'KeepAlive loop did not begin');
        assert(end, 'KeepAlive loop did not end');
        assert(final, 'KeepAlive final marker missing');
        assert(tickCount === 1000 && lastTick === 999, `unexpected tick progress: count=${tickCount} last=${lastTick}`);
        assert(asyncBreakFlagSetPrevious === 0 && asyncBreakFlagSetCurrent === 1, 'async-break flag was not set');
        assert(asyncBreakFlagClearPrevious === 1 && asyncBreakFlagClearCurrent === 0, 'async-break flag was not cleared');
        assert(disconnectResult === 0 && sessionDestroyResult === 0, 'disconnect/session destroy failed');

        const result = {
            tickCount,
            lastTick,
            finalSink,
            elapsedMs: Math.round(completedAt - startedAt),
            asyncBreakFlag: {
                setPrevious: asyncBreakFlagSetPrevious,
                setCurrent: asyncBreakFlagSetCurrent,
                clearPrevious: asyncBreakFlagClearPrevious,
                clearCurrent: asyncBreakFlagClearCurrent
            },
            fireEventToPauseCount,
            fireEventToPauseLastEvent,
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
        if (runtimeExports !== undefined &&
            typeof runtimeExports.CoreClrWasmDebugIsAsyncBreakInProgress === 'function' &&
            runtimeExports.CoreClrWasmDebugIsAsyncBreakInProgress() !== 0) {
            runtimeExports.CoreClrWasmDebugSetAsyncBreakInProgress(0);
        }
        if (connected) {
            sidecar.module._coreclr_wasm_dbi_dac_dbi_disconnect_runtime();
        }
        if (sessionCreated) {
            sidecar.module._coreclr_wasm_dbi_dac_dbi_session_destroy();
        }
        delete globalThis.coreClrDebugFireEventToPause;
        delete globalThis.coreClrDebugLookupSourceLocation;
        delete globalThis.CoreClrWasmDebugLookupSourceLocation;
        delete globalThis.CoreClrWasmDebugGetTargetModuleBase;
        delete globalThis.CoreClrWasmDebugGetSymbolAddress;
        delete globalThis.CoreClrWasmDebugReadTargetMemory;
        delete globalThis.CoreClrWasmDebugSendIpcToRuntime;
        delete globalThis.CoreClrWasmDebugSubmitContinueRequest;
        delete globalThis.CoreClrWasmDebugSubmitAsyncBreakRequest;
        delete globalThis.CoreClrWasmDebugSubmitStepIntoRequest;
    }
}
