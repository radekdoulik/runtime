// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

import {
    IpcAsyncBreakMagic,
    IpcAsyncBreakSize,
    IpcAsyncBreakType,
    acknowledgeProtocol,
    assert,
    loadRuntime,
    loadSidecar,
    pollDbiIpcAsyncBreakComplete,
    readAscii,
    writeUint64
} from './host.mjs';

const AsyncBreakRequestDelayMs = 800;
const AsyncBreakTimeoutMs = 30000;
const CompletionTimeoutMs = 90000;
const ExpectedKeepAliveIterations = 120;

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

function readHex(memory, address, byteCount) {
    return Array.from(memory.subarray(address, address + byteCount), value => value.toString(16).padStart(2, '0')).join('');
}

function isMethodDefToken(token) {
    return ((token >>> 24) === 0x06) && (token & 0x00ffffff) !== 0;
}

function sendContinue(sidecar, token) {
    return sidecar.module._coreclr_wasm_dbi_dac_dbi_send_ipc_continue_request(
        Number(token & 0xffffffffn),
        Number(token >> 32n)) | 0;
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
    let debuggerConnected = false;
    let asyncBreakTimer = 0;
    let asyncBreakRequestResult = undefined;
    let asyncBreakRequestTickCount = -1;
    let asyncBreakRequestElapsedMs = 0;
    let begin = false;
    let end = false;
    let final = false;
    let finalSink = 0;
    let tickCount = 0;
    let lastTick = -1;
    let tickCountAtAsyncBreak = -1;
    let keepAliveMethodToken = 0;
    let keepAliveMoveNextToken = 0;
    let keepAliveMoveNextILBytes = 0;
    let fireEventToPauseCount = 0;
    let asyncBreakFireEventToPauseCount = 0;
    let continueDuringCallbackResult = -1;
    let asyncBreakEvent = { pollResult: -1, bytesWritten: 0, payload: null };
    let fireEventToPauseLastEvent = { address: 0, length: 0, headerHex: '' };
    const startedAt = performance.now();
    let completedAt = 0;
    let resolveComplete;
    const completed = new Promise(resolve => {
        resolveComplete = resolve;
    });
    let resolveAsyncBreakEvent;
    let rejectAsyncBreakEvent;
    const asyncBreakEventPromise = new Promise((resolve, reject) => {
        resolveAsyncBreakEvent = resolve;
        rejectAsyncBreakEvent = reject;
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
        if (!final) {
            completedAt = performance.now();
            final = true;
            resolveComplete();
        }
    }

    function recordRuntimeLine(text) {
        const methodTokenMatch = /^keepalive-method-token 0x([0-9a-fA-F]+)$/.exec(text);
        if (methodTokenMatch !== null) {
            keepAliveMethodToken = Number.parseInt(methodTokenMatch[1], 16) >>> 0;
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

        if (text === 'keepalive-begin') {
            begin = true;
            setStatus('running busy loop');
            // Schedule the async-break request NOW that the loop has
            // actually started. Scheduling it earlier (during onInstance)
            // doesn't work: the wasm runtime's startup blocks the JS
            // event loop for ~1.5-2s, so a setTimeout queued before
            // loadRuntime fires only AFTER the loop has already begun
            // — and the very first sequence point thereafter triggers
            // the break at tick 0/1, not mid-loop. Anchoring the delay
            // to keepalive-begin ensures we break around tick (delay /
            // 10ms-per-tick) ≈ tick 60, which is mid-loop for the
            // 120-iteration managed program.
            if (asyncBreakTimer === 0) {
                asyncBreakTimer = setTimeout(requestAsyncBreak, AsyncBreakRequestDelayMs);
            }
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
            markComplete();
        }
    }

    function requestAsyncBreak() {
        asyncBreakRequestTickCount = tickCount;
        asyncBreakRequestElapsedMs = Math.round(performance.now() - startedAt);
        setStatus('requesting cooperative async-break');
        asyncBreakRequestResult = sidecar.module._coreclr_wasm_dbi_dac_dbi_async_break_request() | 0;
        if (asyncBreakRequestResult !== 0) {
            rejectAsyncBreakEvent(new Error(`async-break request facade failed: ${asyncBreakRequestResult}`));
        }
    }

    try {
        const manifest = await fetchJson('/hello-async-break/manifest.json');
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
        globalThis.CoreClrWasmDebugSubmitContinueRequest = (requestBytesAddress, requestBytesLength) => {
            const debuggerHeap = getDebuggerHeap();
            if (requestBytesAddress + requestBytesLength > debuggerHeap.length ||
                typeof runtimeExports.CoreClrWasmDebugSubmitContinueRequest !== 'function') {
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
            const address = eventAddress >>> 0;
            const length = eventLength >>> 0;
            fireEventToPauseLastEvent = {
                address,
                length,
                headerHex: readHex(getRuntimeHeap(), address, Math.min(length, 16))
            };
            if (length !== IpcAsyncBreakSize) {
                return 0;
            }

            asyncBreakFireEventToPauseCount++;
            tickCountAtAsyncBreak = tickCount;
            setStatus('async-break event fired');
            asyncBreakEvent = pollDbiIpcAsyncBreakComplete(sidecar);
            if (asyncBreakEvent.payload !== null) {
                continueDuringCallbackResult = sendContinue(sidecar, asyncBreakEvent.payload.asyncBreakToken);
            }
            resolveAsyncBreakEvent(asyncBreakEvent);
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
                assert(typeof runtimeExports.CoreClrWasmDebugSetDebuggerConnected === 'function', 'runtime export CoreClrWasmDebugSetDebuggerConnected is missing');
                assert(typeof runtimeExports.CoreClrWasmDebugIsDebuggerConnected === 'function', 'runtime export CoreClrWasmDebugIsDebuggerConnected is missing');
                assert(typeof runtimeExports.CoreClrWasmDebugSetAsyncBreakInProgress === 'function', 'runtime export CoreClrWasmDebugSetAsyncBreakInProgress is missing');
                assert(typeof runtimeExports.CoreClrWasmDebugIsAsyncBreakInProgress === 'function', 'runtime export CoreClrWasmDebugIsAsyncBreakInProgress is missing');
                acknowledgeProtocol(sidecar);
                const sessionCreateResult = sidecar.module._coreclr_wasm_dbi_dac_dbi_session_create();
                assert(sessionCreateResult === 0, `failed to create DBI session: ${sessionCreateResult}`);
                sessionCreated = true;
                const connectResult = sidecar.module._coreclr_wasm_dbi_dac_dbi_connect_runtime(1);
                assert(connectResult === 0, `failed to connect DBI session to runtime: ${connectResult}`);
                connected = true;
                const previousConnected = runtimeExports.CoreClrWasmDebugSetDebuggerConnected(1) | 0;
                assert(previousConnected === 0, `expected CoreClrWasmDebugSetDebuggerConnected to return 0, got ${previousConnected}`);
                assert(runtimeExports.CoreClrWasmDebugIsDebuggerConnected() === 1, 'debugger connected flag was not set');
                debuggerConnected = true;
                // NOTE: the async-break timer is now scheduled when the
                // 'keepalive-begin' line is observed (see recordRuntimeLine
                // above), not here, because wasm init blocks JS for ~1.5-2s
                // and a setTimeout queued here would fire effectively
                // immediately after the loop begins (tick 0/1 instead of
                // mid-loop).
            }
        });

        await withTimeout(asyncBreakEventPromise, 'cooperative async-break event', AsyncBreakTimeoutMs);
        await withTimeout(completed, 'KeepAlive loop completion', CompletionTimeoutMs);
        await sleep(0);

        const disconnectResult = connected
            ? sidecar.module._coreclr_wasm_dbi_dac_dbi_disconnect_runtime()
            : 0;
        connected = false;
        const sessionDestroyResult = sessionCreated
            ? sidecar.module._coreclr_wasm_dbi_dac_dbi_session_destroy()
            : 0;
        sessionCreated = false;
        const debuggerConnectedPrevious = debuggerConnected
            ? runtimeExports.CoreClrWasmDebugSetDebuggerConnected(0) | 0
            : 0;
        debuggerConnected = false;

        const payload = asyncBreakEvent.payload;
        assert(asyncBreakRequestResult === 0, `async-break request facade failed: ${asyncBreakRequestResult}`);
        assert(fireEventToPauseCount >= 1 && asyncBreakFireEventToPauseCount >= 1, 'async-break fireEventToPause callback did not fire');
        assert(asyncBreakEvent.pollResult === 0 && asyncBreakEvent.bytesWritten === IpcAsyncBreakSize && payload !== null, 'sidecar async-break event missing');
        assert(payload.magic === IpcAsyncBreakMagic, `async-break magic mismatch: 0x${payload.magic.toString(16)}`);
        assert(payload.type === IpcAsyncBreakType, `async-break type mismatch: 0x${payload.type.toString(16)}`);
        assert(payload.processId === 1 && payload.threadId === 1, 'async-break process/thread mismatch');
        assert(payload.hr === 0 && payload.flags === 0, 'async-break status mismatch');
        assert(payload.asyncBreakToken > 0n, 'async-break token missing');
        assert(isMethodDefToken(payload.funcMetadataToken), `async-break method token is not an mdMethodDef: 0x${payload.funcMetadataToken.toString(16)}`);
        if (payload.funcMetadataToken === keepAliveMoveNextToken && keepAliveMoveNextILBytes !== 0) {
            assert(payload.ilOffset < keepAliveMoveNextILBytes, 'async-break IL offset is outside KeepAlive.MoveNext');
        } else {
            assert(payload.ilOffset < 0x100000, `async-break IL offset is implausible: ${payload.ilOffset}`);
        }
        assert(payload.interpreterIP !== 0n, 'async-break interpreter IP missing');
        assert(continueDuringCallbackResult === 0, `structured continue failed: ${continueDuringCallbackResult}`);
        assert(begin, 'KeepAlive loop did not begin');
        assert(end, 'KeepAlive loop did not end');
        assert(final, 'KeepAlive final marker missing');
        assert(tickCount === ExpectedKeepAliveIterations && lastTick === ExpectedKeepAliveIterations - 1, `unexpected tick progress: count=${tickCount} last=${lastTick}`);
        // Cooperative async-break should land roughly mid-loop. The
        // 800ms delay anchored at keepalive-begin (each tick ~13-14ms
        // due to await Task.Delay(10) yields) puts the break in
        // [40, 90] for the 120-iteration program. Tightening here
        // catches accidental regressions (e.g., timer firing at
        // page-load like before commit 0fb5a7bdaf8 + fed1209a375 era).
        assert(tickCountAtAsyncBreak > 30 && tickCountAtAsyncBreak < ExpectedKeepAliveIterations - 30,
            `async-break should land mid-loop, got ${tickCountAtAsyncBreak} of ${tickCount}`);
        assert((runtimeExports.CoreClrWasmDebugIsAsyncBreakInProgress() | 0) === 0, 'async-break flag was not cleared');
        assert(disconnectResult === 0 && sessionDestroyResult === 0, 'disconnect/session destroy failed');
        assert(debuggerConnectedPrevious === 1, `debugger connected flag previous value mismatch: ${debuggerConnectedPrevious}`);

        const result = {
            tickCount,
            lastTick,
            tickCountAtAsyncBreak,
            finalSink,
            elapsedMs: Math.round(completedAt - startedAt),
            asyncBreakRequest: {
                delayMs: AsyncBreakRequestDelayMs,
                result: asyncBreakRequestResult,
                tickCount: asyncBreakRequestTickCount,
                elapsedMs: asyncBreakRequestElapsedMs
            },
            fireEventToPauseCount,
            asyncBreakFireEventToPauseCount,
            fireEventToPauseLastEvent,
            keepAliveMethodToken,
            keepAliveMoveNextToken,
            keepAliveMoveNextILBytes,
            asyncBreakEvent: {
                pollResult: asyncBreakEvent.pollResult,
                bytesWritten: asyncBreakEvent.bytesWritten,
                payload
            },
            continueDuringCallbackResult,
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
        clearTimeout(asyncBreakTimer);
        if (runtimeExports !== undefined &&
            typeof runtimeExports.CoreClrWasmDebugIsAsyncBreakInProgress === 'function' &&
            runtimeExports.CoreClrWasmDebugIsAsyncBreakInProgress() !== 0) {
            runtimeExports.CoreClrWasmDebugSetAsyncBreakInProgress(0);
        }
        if (debuggerConnected && runtimeExports?.CoreClrWasmDebugSetDebuggerConnected) {
            runtimeExports.CoreClrWasmDebugSetDebuggerConnected(0);
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
