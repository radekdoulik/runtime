// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

// hello-step (step-into) smoke (browser). Sets a managed breakpoint at
// BreakHere; on the first hit issues a step-into request (StepKind 0).
// The step landing is reported as a second breakpoint-hit event. The
// harness forwards the runtime event + record + frame-record to the
// sidecar, drains the structured breakpoint IPC payload via the sidecar
// DAC for both events, and asserts the step advanced to a later
// interpreter offset (isIL 1 -> 0).

import {
    StepKindInto,
    acknowledgeProtocol,
    assert,
    enumerateBreakpoints,
    installDebuggerImports,
    loadRuntime,
    loadSidecar,
    pollDbiIpcEvent,
    readAscii,
    removeDebuggerImports,
    sendStepRequest,
    writeBytes
} from './host.mjs';

const BreakpointMethodName = 'BreakHere';
const BreakpointIpcMagic = 0x42435049;
const BreakpointIpcType = 0x100;
const TextEncoderInstance = new TextEncoder();
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

async function waitForBreakpointHit(runtimeExports, expectedHitCount, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const hitCount = runtimeExports.CoreClrWasmDebugGetBreakpointHitCount();
        if (hitCount >= expectedHitCount) {
            return { hitCount };
        }
        await sleep(10);
    }

    return { hitCount: runtimeExports.CoreClrWasmDebugGetBreakpointHitCount() };
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
    let fireEventToPauseLastEvent = '';
    let callbackEvent = '';
    let stepRequestResult = -1;
    let preStepBreakpointCount = -1;
    let afterStepRequestBreakpointCount = -1;
    let stepLandingBreakpointCount = -1;
    const breakpointEvents = [];

    const getRuntimeHeap = () => new Uint8Array(runtimeExports.memory.buffer);
    const getDebuggerHeap = () => new Uint8Array(sidecar.exports.memory.buffer);

    function forwardRecord(getSizeFn, copyFn, receiveExport) {
        const size = runtimeExports[getSizeFn]();
        const runtimeStack = runtimeExports.stackSave();
        const runtimeAddress = runtimeExports.stackAlloc(size);
        const copyResult = runtimeExports[copyFn](runtimeAddress, size);
        const bytes = getRuntimeHeap().slice(runtimeAddress, runtimeAddress + size);
        runtimeExports.stackRestore(runtimeStack);
        if (copyResult !== 0) {
            return copyResult;
        }

        const debuggerStack = sidecar.exports.stackSave();
        const debuggerAddress = sidecar.exports.stackAlloc(bytes.length);
        writeBytes(getDebuggerHeap(), debuggerAddress, bytes);
        const receiveResult = sidecar.module[receiveExport](debuggerAddress, bytes.length);
        sidecar.exports.stackRestore(debuggerStack);
        return receiveResult;
    }

    try {
        const manifest = await fetchJson('/hello-step/manifest.json');
        sidecar = await loadSidecar(manifest.sidecarJsUrl);

        installDebuggerImports({
            runtime: () => runtimeExports,
            sidecar: () => sidecar
        });

        globalThis.coreClrDebugFireEventToPause = (eventAddress, eventLength) => {
            fireEventToPauseCount++;
            fireEventToPauseLastEvent = readAscii(getRuntimeHeap(), eventAddress >>> 0, eventLength >>> 0);
            return 0;
        };

        globalThis.CoreClrWasmDebugOnBreakpointHit = (eventAddress, eventLength) => {
            const event = readAscii(getRuntimeHeap(), eventAddress >>> 0, eventLength >>> 0);
            callbackEvent = event;
            const eventBytes = TextEncoderInstance.encode(event);
            const stack = sidecar.exports.stackSave();
            const debuggerEventAddress = sidecar.exports.stackAlloc(eventBytes.length);
            writeBytes(getDebuggerHeap(), debuggerEventAddress, eventBytes);
            const receiveResult = sidecar.module._coreclr_wasm_dbi_dac_receive_runtime_event(debuggerEventAddress, eventBytes.length);
            sidecar.exports.stackRestore(stack);

            if (event.includes(`breakpoint-hit:name=${BreakpointMethodName}`)) {
                const recordResult = forwardRecord(
                    'CoreClrWasmDebugGetLastEventRecordSize',
                    'CoreClrWasmDebugCopyLastEventRecord',
                    '_coreclr_wasm_dbi_dac_receive_runtime_event_record');
                if (recordResult !== 0) {
                    return recordResult;
                }
                const frameResult = forwardRecord(
                    'CoreClrWasmDebugGetLastFrameRecordSize',
                    'CoreClrWasmDebugCopyLastFrameRecord',
                    '_coreclr_wasm_dbi_dac_receive_runtime_frame_record');
                if (frameResult !== 0) {
                    return frameResult;
                }

                const ipc = pollDbiIpcEvent(sidecar);
                if (ipc.payload === null) {
                    return -1;
                }
                breakpointEvents.push(ipc.payload);

                if (breakpointEvents.length === 1) {
                    preStepBreakpointCount = enumerateBreakpoints(sidecar).activeCount;
                    stepRequestResult = sendStepRequest(sidecar, ipc.payload.breakpointToken, StepKindInto);
                    afterStepRequestBreakpointCount = enumerateBreakpoints(sidecar).activeCount;
                } else if (breakpointEvents.length === 2) {
                    stepLandingBreakpointCount = enumerateBreakpoints(sidecar).activeCount;
                }
            }

            return receiveResult;
        };

        await loadRuntime(manifest.runtimeJsUrl, {
            arguments: ['-c', manifest.sharedFrameworkVirtualPath, manifest.appVirtualPath],
            files: manifest.files,
            onPrint: text => console.log(`[runtime] ${text}`),
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
                const methodName = TextEncoderInstance.encode(BreakpointMethodName);
                const stack = sidecar.exports.stackSave();
                const methodNameAddress = sidecar.exports.stackAlloc(methodName.length);
                writeBytes(getDebuggerHeap(), methodNameAddress, methodName);
                const breakpointResult = sidecar.module._coreclr_wasm_dbi_dac_dbi_set_breakpoint_by_name(methodNameAddress, methodName.length);
                sidecar.exports.stackRestore(stack);
                assert(breakpointResult === 0, `failed to set breakpoint: ${breakpointResult}`);
            }
        });

        const hit = await waitForBreakpointHit(runtimeExports, 2, CompletionTimeoutMs);
        const continueCount = runtimeExports.CoreClrWasmDebugGetContinueCount();
        const disconnectResult = connected ? sidecar.module._coreclr_wasm_dbi_dac_dbi_disconnect_runtime() : 0;
        connected = false;
        const sessionDestroyResult = sessionCreated ? sidecar.module._coreclr_wasm_dbi_dac_dbi_session_destroy() : 0;
        sessionCreated = false;

        const firstEvent = breakpointEvents[0];
        const stepEvent = breakpointEvents[1];

        assert(hit.hitCount >= 2, `expected >= 2 breakpoint hits, got ${hit.hitCount}`);
        assert(breakpointEvents.length >= 2, `expected >= 2 breakpoint events, got ${breakpointEvents.length}`);
        assert(firstEvent?.magic === BreakpointIpcMagic && stepEvent?.magic === BreakpointIpcMagic, 'breakpoint IPC magic mismatch');
        assert(firstEvent?.type === BreakpointIpcType && stepEvent?.type === BreakpointIpcType, 'breakpoint IPC type mismatch');
        assert(firstEvent?.isIL === 1, 'first event should be at an IL offset');
        assert(stepEvent?.isIL === 0, 'step landing should be at a native offset');
        assert(firstEvent?.offset === 0, `first event offset should be 0, got ${firstEvent?.offset}`);
        assert(stepEvent?.offset > firstEvent?.offset, 'step did not advance the interpreter offset');
        assert(firstEvent?.breakpointToken !== 0n, 'first breakpoint token missing');
        assert(stepEvent?.breakpointToken > firstEvent?.breakpointToken, 'step token did not advance');
        assert(stepRequestResult === 0, `step request failed: ${stepRequestResult}`);
        assert(preStepBreakpointCount >= 1, `unexpected pre-step breakpoint count: ${preStepBreakpointCount}`);
        assert(afterStepRequestBreakpointCount === preStepBreakpointCount + 1, 'step request did not add a transient breakpoint');
        assert(stepLandingBreakpointCount === preStepBreakpointCount, 'transient step breakpoint was not removed on landing');
        assert(continueCount === 1, `unexpected continue count: ${continueCount}`);
        assert(fireEventToPauseCount >= 2, `unexpected fireEventToPause count: ${fireEventToPauseCount}`);
        assert(fireEventToPauseLastEvent.includes('breakpoint-hit:name=BreakHere'), 'last fire event was not the step landing');
        assert(disconnectResult === 0 && sessionDestroyResult === 0, 'disconnect/session destroy failed');

        const result = {
            hitCount: hit.hitCount,
            breakpointEventCount: breakpointEvents.length,
            firstOffset: firstEvent.offset,
            firstIsIL: firstEvent.isIL,
            stepOffset: stepEvent.offset,
            stepIsIL: stepEvent.isIL,
            firstToken: firstEvent.breakpointToken,
            stepToken: stepEvent.breakpointToken,
            preStepBreakpointCount,
            afterStepRequestBreakpointCount,
            stepLandingBreakpointCount,
            continueCount,
            fireEventToPauseCount,
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
