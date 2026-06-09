// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

// hello-async-break (browser) — passive runtime host.
//
// This file is a thin wrapper around the runtime + sidecar wasm. It does
// NOT initiate the async-break itself. The whole point of this smoke is
// to demonstrate the real IDE-driven flow:
//
//   ICorDebug (IDE) ──→ mscordbi/DAC (sidecar) ──CDP─→ browser
//
// In the browser harness:
//   * Playwright's CDP session plays the IDE/DBI role.
//   * The page loads the runtime + sidecar, starts a managed busy loop,
//     and exposes a few `globalThis.__dbi_*` helpers so the DBI side
//     can drive everything via `Runtime.evaluate`.
//   * The DBI orchestrates: CDP `Debugger.pause` → set the runtime's
//     async-break flag via direct memory write → CDP `Debugger.resume`
//     → wait for the runtime's libCorerun.js `debugger;` halt at the
//     next IL sequence point → poll the structured event + locals via
//     the sidecar DAC → render the panel → hold 5 s → CDP
//     `Debugger.resume` → loop completes.

import {
    IpcAsyncBreakMagic,
    IpcAsyncBreakSize,
    IpcAsyncBreakType,
    acknowledgeProtocol,
    loadRuntime,
    loadSidecar,
    pollDbiIpcAsyncBreakComplete,
    pollDbiLocals,
    readAscii,
    writeUint64
} from './host.mjs';

const ExpectedKeepAliveIterations = 120;
const CompletionTimeoutMs = 120000;

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

function describeTypeTag(typeTag) {
    // CorElementType subset relevant to the interpreter locals we exercise here.
    // See src/coreclr/inc/corhdr.h: ELEMENT_TYPE_*.
    switch (typeTag) {
        case 0x01: return 'void';
        case 0x02: return 'bool';
        case 0x03: return 'char';
        case 0x04: return 'i1';
        case 0x05: return 'u1';
        case 0x06: return 'i2';
        case 0x07: return 'u2';
        case 0x08: return 'i4';
        case 0x09: return 'u4';
        case 0x0a: return 'i8';
        case 0x0b: return 'u8';
        case 0x0c: return 'r4';
        case 0x0d: return 'r8';
        case 0x0e: return 'string';
        case 0x12: return 'class';
        case 0x14: return 'array';
        case 0x18: return 'i';
        case 0x19: return 'u';
        case 0x1c: return 'object';
        case 0x1d: return 'szarray';
        default: return `tag(0x${typeTag.toString(16)})`;
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

async function fetchJson(url) {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`failed to fetch ${url}: ${response.status} ${response.statusText}`);
    }

    return response.json();
}

export async function runSmoke() {
    globalThis.__smokeProgress = 0;
    globalThis.__smokeResult = undefined;
    globalThis.__dbiReady = false;
    setTickCount(0);
    setStatus('loading runtime');

    let runtimeExports;
    let sidecar;
    let sessionCreated = false;
    let connected = false;
    let debuggerConnected = false;
    let asyncBreakFlagAddress = 0;
    let fireEventToPauseCount = 0;
    let asyncBreakFireEventToPauseCount = 0;
    let begin = false;
    let end = false;
    let final = false;
    let finalSink = 0;
    let tickCount = 0;
    let lastTick = -1;
    let keepAliveMethodToken = 0;
    let keepAliveMoveNextToken = 0;
    let keepAliveMoveNextILBytes = 0;
    const startedAt = performance.now();
    let completedAt = 0;
    let resolveComplete;
    const completed = new Promise(resolve => { resolveComplete = resolve; });

    const getRuntimeHeap = () => new Uint8Array(runtimeExports.memory.buffer);
    const getDebuggerHeap = () => new Uint8Array(sidecar.exports.memory.buffer);

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

        const moveNextBytesMatch = /^keepalive-movenext-il-bytes (\d+)$/.exec(text);
        if (moveNextBytesMatch !== null) {
            keepAliveMoveNextILBytes = Number.parseInt(moveNextBytesMatch[1], 10);
            return;
        }

        if (text === 'keepalive-begin') {
            begin = true;
            setStatus('running busy loop — DBI may async-break at any time');
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

    try {
        const manifest = await fetchJson('/hello-async-break/manifest.json');
        sidecar = await loadSidecar(manifest.sidecarJsUrl);

        // Standard DAC JS imports — runtime memory access for the sidecar.
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
        // The PAGE does NOT request async-breaks itself. The DBI side (CDP)
        // initiates the request by writing the flag directly into runtime
        // memory while the runtime is V8-paused. This import is wired only
        // so that the sidecar's facade reports a clean "not supported"
        // rather than crashing if anyone calls it.
        globalThis.CoreClrWasmDebugSubmitAsyncBreakRequest = () => -1;
        globalThis.CoreClrWasmDebugSubmitStepIntoRequest = () => -1;
        globalThis.CoreClrWasmDebugLookupSourceLocation = () => -1;
        globalThis.coreClrDebugLookupSourceLocation = () => -1;

        // Minimal Mono-pattern stop trigger. We do almost nothing here —
        // the heavy lifting (drain event, read locals, render DOM) is
        // done by the DBI side AFTER the libCorerun.js wrapper's
        // `debugger;` halts V8 at the cooperative break point.
        //
        // The only thing this handler does is TAG the upcoming pause so
        // the DBI's CDP filter can distinguish the async-break stop
        // from incidental libCorerun pauses (module load events fire
        // through the same wrapper).
        globalThis.coreClrDebugFireEventToPause = (eventAddress, eventLength) => {
            fireEventToPauseCount++;
            const length = eventLength >>> 0;
            if (length !== IpcAsyncBreakSize) {
                globalThis.__lastFiredEventKind = 'non-async-break';
                return 0;
            }
            asyncBreakFireEventToPauseCount++;
            globalThis.__lastFiredEventKind = 'async-break';
            // tickCount here is the value the page-side line scanner has
            // seen so far; we expose it so the DBI can correlate the
            // break point with the loop position. NOT used by the page
            // for any orchestration.
            globalThis.__tickCountAtAsyncBreak = tickCount;
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
                acknowledgeProtocol(sidecar);
                const sessionCreateResult = sidecar.module._coreclr_wasm_dbi_dac_dbi_session_create();
                if (sessionCreateResult !== 0) {
                    throw new Error(`failed to create DBI session: ${sessionCreateResult}`);
                }
                sessionCreated = true;
                const connectResult = sidecar.module._coreclr_wasm_dbi_dac_dbi_connect_runtime(1);
                if (connectResult !== 0) {
                    throw new Error(`failed to connect DBI session: ${connectResult}`);
                }
                connected = true;
                runtimeExports.CoreClrWasmDebugSetDebuggerConnected(1);
                debuggerConnected = true;
                // Cache the runtime address of g_wasmDebugAsyncBreakInProgress.
                // The DBI side will write this byte directly into runtime
                // memory while V8 holds the runtime thread paused via CDP
                // Debugger.pause — at that moment the runtime cannot run
                // its own CoreClrWasmDebugSetAsyncBreakInProgress setter,
                // so direct memory write is the only viable path.
                asyncBreakFlagAddress = runtimeExports.Getg_wasmDebugAsyncBreakInProgressAddress() >>> 0;
                if (asyncBreakFlagAddress === 0) {
                    throw new Error('Getg_wasmDebugAsyncBreakInProgressAddress returned 0');
                }
                // Publish the small surface the DBI side calls via CDP
                // Runtime.evaluate. Each helper is plain JS so it can run
                // either while wasm is running OR while wasm is paused —
                // none of these call back into runtime wasm functions.
                globalThis.__dbi = {
                    getState() {
                        return {
                            asyncBreakFlagAddress,
                            asyncBreakFlagValue: getRuntimeHeap()[asyncBreakFlagAddress] | 0,
                            tickCount,
                            ready: true
                        };
                    },
                    setAsyncBreakFlag(value) {
                        // Direct memory write into the runtime's wasm
                        // linear memory at the cached flag address. JS
                        // can do this even while V8 holds the runtime
                        // thread paused — the WebAssembly.Memory
                        // ArrayBuffer is just JS-side bytes.
                        const previous = getRuntimeHeap()[asyncBreakFlagAddress] | 0;
                        getRuntimeHeap()[asyncBreakFlagAddress] = value & 0xff;
                        return previous;
                    },
                    pollAsyncBreakEvent() {
                        const event = pollDbiIpcAsyncBreakComplete(sidecar);
                        return JSON.parse(JSON.stringify(event, (_, value) =>
                            typeof value === 'bigint' ? `0x${value.toString(16)}` : value));
                    },
                    pollLocals() {
                        const locals = pollDbiLocals(sidecar);
                        return JSON.parse(JSON.stringify(locals));
                    },
                    describeTypeTag(typeTag) {
                        return describeTypeTag(typeTag);
                    },
                    renderPausePanel(message, payload, locals) {
                        const target = document.getElementById('simulated-pause');
                        if (target === null) {
                            return;
                        }
                        const localRows = locals && locals.localCount > 0
                            ? locals.locals
                                .map(l => `  [${String(l.ilSlot).padStart(2, ' ')}] ${l.name || '(anon)'} : ${describeTypeTag(l.typeTag)}` +
                                    ` @stack+${l.byteOffset} size=${l.byteSize}`)
                                .join('\n')
                            : '  (no locals reported)';
                        target.innerHTML =
                            `<strong style="color: #b0530e;">⏸ ${message}</strong>` +
                            `\n\nasync-break payload polled via sidecar DAC:` +
                            `\n  asyncBreakToken    = ${payload.asyncBreakToken}` +
                            `\n  funcMetadataToken  = ${payload.funcMetadataToken}` +
                            `\n  ilOffset           = ${payload.ilOffset}` +
                            `\n  interpreterIP      = ${payload.interpreterIP}` +
                            `\n\nlocals schema polled via sidecar DAC enumerate_locals` +
                            ` (method token 0x${(locals?.methodToken ?? 0).toString(16)}, count ${locals?.localCount ?? 0}):` +
                            `\n${localRows}`;
                        target.style.display = 'block';
                        setStatus(message);
                    }
                };
                // Surface the keepalive method tokens to the DBI side so
                // tests can assert the break landed inside the expected
                // managed method.
                globalThis.__dbi.tokens = {
                    get keepAliveMethodToken() { return keepAliveMethodToken; },
                    get keepAliveMoveNextToken() { return keepAliveMoveNextToken; },
                    get keepAliveMoveNextILBytes() { return keepAliveMoveNextILBytes; }
                };
                globalThis.__dbiReady = true;
            }
        });

        // Now JUST run the busy loop to completion. No orchestration here.
        await withTimeout(completed, 'KeepAlive loop completion', CompletionTimeoutMs);

        // Tear the session down so the runtime can exit cleanly.
        const disconnectResult = connected
            ? sidecar.module._coreclr_wasm_dbi_dac_dbi_disconnect_runtime()
            : 0;
        connected = false;
        const sessionDestroyResult = sessionCreated
            ? sidecar.module._coreclr_wasm_dbi_dac_dbi_session_destroy()
            : 0;
        sessionCreated = false;

        const result = {
            tickCount,
            lastTick,
            finalSink,
            elapsedMs: Math.round(completedAt - startedAt),
            begin,
            end,
            final,
            fireEventToPauseCount,
            asyncBreakFireEventToPauseCount,
            keepAliveMethodToken,
            keepAliveMoveNextToken,
            keepAliveMoveNextILBytes,
            disconnectResult,
            sessionDestroyResult
        };
        globalThis.__smokeResult = { passed: true, result };
        return result;
    } catch (error) {
        globalThis.__smokeResult = { passed: false, error: `${error.message}\n${error.stack}` };
        throw error;
    } finally {
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
    }
}
