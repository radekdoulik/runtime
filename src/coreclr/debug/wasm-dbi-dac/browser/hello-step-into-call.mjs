// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

// hello-step-into-call smoke (browser). Sets a managed breakpoint at
// BreakHere; on the first hit issues a step-into request (StepKind 0)
// which enters the callee StepIntoTarget. The method-enter is reported
// as a structured step-complete DBI event (isIL=1, ilOffset=0,
// funcMetadataToken=StepIntoTarget); on that event the harness issues a
// step-out request (StepKind 2) which returns to the caller BreakHere
// and produces a second step-complete plus a second breakpoint event.
// Both breakpoint events (via OnBreakpointHit) and step-complete events
// (via coreClrDebugFireEventToPause) are drained via the sidecar DAC.

import {
    IpcModuleLoadSize,
    IpcStepCompleteMagic,
    IpcStepCompleteSize,
    IpcStepCompleteType,
    StepKindInto,
    StepKindOut,
    acknowledgeProtocol,
    assert,
    enumerateBreakpoints,
    installDebuggerImports,
    loadRuntime,
    loadSidecar,
    pollDbiIpcEvent,
    pollDbiIpcStepComplete,
    readAscii,
    removeDebuggerImports,
    sendStepRequest,
    writeBytes
} from './host.mjs';

const BreakpointMethodName = 'BreakHere';
const ExpectedStepIntoCallerToken = 0x06000002; // BreakHere
const ExpectedStepIntoTargetToken = 0x06000003; // StepIntoTarget
const BreakpointIpcMagic = 0x42435049;
const BreakpointIpcType = 0x100;
const MaxStepRequests = 8;
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

async function waitForCounts(predicate, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) {
            return true;
        }
        await sleep(10);
    }

    return predicate();
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
    let callbackEvent = '';
    let preStepBreakpointCount = -1;
    let afterStepRequestBreakpointCount = -1;
    let stepCompleteBreakpointCount = -1;
    let stepOutCompleteBreakpointCount = -1;
    let stepOutFromMethodEnterRequestResult = -1;
    let stepOutFromMethodEnterRequestToken = 0n;
    const breakpointEvents = [];
    const stepCompleteEvents = [];
    const stepRequestResults = [];
    const stepRequestTokens = [];

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
        const manifest = await fetchJson('/hello-step-into-call/manifest.json');
        sidecar = await loadSidecar(manifest.sidecarJsUrl);

        installDebuggerImports({
            runtime: () => runtimeExports,
            sidecar: () => sidecar
        });

        globalThis.coreClrDebugFireEventToPause = (eventAddress, eventLength) => {
            if ((eventLength >>> 0) === IpcModuleLoadSize) {
                return 0;
            }
            fireEventToPauseCount++;
            const runtimeHeap = getRuntimeHeap();
            const address = eventAddress >>> 0;
            const length = eventLength >>> 0;
            if (length === IpcStepCompleteSize && address + length <= runtimeHeap.length) {
                const view = new DataView(runtimeHeap.buffer, address, length);
                if (view.getUint32(0, true) === IpcStepCompleteMagic) {
                    const stepComplete = pollDbiIpcStepComplete(sidecar);
                    if (stepComplete.payload !== null) {
                        stepCompleteEvents.push(stepComplete.payload);
                    }
                    const active = enumerateBreakpoints(sidecar);
                    if (stepCompleteEvents.length === 1) {
                        stepCompleteBreakpointCount = active.enumerateResult === 0 ? active.activeCount : -1;
                    } else if (stepCompleteEvents.length === 2) {
                        stepOutCompleteBreakpointCount = active.enumerateResult === 0 ? active.activeCount : -1;
                    }

                    const payload = stepComplete.payload;
                    if (payload !== null &&
                        stepCompleteEvents.length === 1 &&
                        payload.funcMetadataToken === ExpectedStepIntoTargetToken &&
                        payload.isIL === 1) {
                        stepOutFromMethodEnterRequestToken = payload.originalStepRequestToken;
                        stepOutFromMethodEnterRequestResult = sendStepRequest(sidecar, payload.originalStepRequestToken, StepKindOut);
                    }
                    return 0;
                }
            }
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

                if (breakpointEvents.length <= MaxStepRequests && stepCompleteEvents.length === 0) {
                    if (breakpointEvents.length === 1) {
                        preStepBreakpointCount = enumerateBreakpoints(sidecar).activeCount;
                    }
                    const stepResult = sendStepRequest(sidecar, ipc.payload.breakpointToken, StepKindInto);
                    stepRequestResults.push(stepResult);
                    stepRequestTokens.push(ipc.payload.breakpointToken);
                    if (breakpointEvents.length === 1) {
                        afterStepRequestBreakpointCount = enumerateBreakpoints(sidecar).activeCount;
                    }
                }

                if (breakpointEvents.length === 2) {
                    // landing after step-out is reported as a breakpoint
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
                assert(typeof runtimeExports.CoreClrWasmDebugGetMethodEnterEnabledQueryCount === 'function', 'runtime export CoreClrWasmDebugGetMethodEnterEnabledQueryCount is missing');
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

        await waitForCounts(() => breakpointEvents.length >= 2 && stepCompleteEvents.length >= 2, CompletionTimeoutMs);
        const continueCount = runtimeExports.CoreClrWasmDebugGetContinueCount();
        const methodEnterQueryCount = runtimeExports.CoreClrWasmDebugGetMethodEnterEnabledQueryCount() >>> 0;
        const disconnectResult = connected ? sidecar.module._coreclr_wasm_dbi_dac_dbi_disconnect_runtime() : 0;
        connected = false;
        const sessionDestroyResult = sessionCreated ? sidecar.module._coreclr_wasm_dbi_dac_dbi_session_destroy() : 0;
        sessionCreated = false;

        const firstEvent = breakpointEvents[0];
        const stepEvent = breakpointEvents[1];
        const stepComplete = stepCompleteEvents[0];
        const stepOutComplete = stepCompleteEvents[1];

        assert(breakpointEvents.length >= 2, `expected >= 2 breakpoint events, got ${breakpointEvents.length}`);
        assert(stepCompleteEvents.length >= 2, `expected >= 2 step-complete events, got ${stepCompleteEvents.length}`);
        assert(firstEvent?.magic === BreakpointIpcMagic && stepEvent?.magic === BreakpointIpcMagic, 'breakpoint IPC magic mismatch');
        assert(firstEvent?.type === BreakpointIpcType && stepEvent?.type === BreakpointIpcType, 'breakpoint IPC type mismatch');
        assert(firstEvent?.isIL === 1 && firstEvent?.offset === 0, 'first breakpoint should be at IL offset 0');
        assert(stepEvent?.isIL === 0 && stepEvent?.offset > firstEvent?.offset, 'second breakpoint did not advance');
        assert(firstEvent?.breakpointToken !== 0n, 'first breakpoint token missing');
        assert(stepEvent?.breakpointToken > firstEvent?.breakpointToken, 'second breakpoint token did not advance');
        assert(stepRequestResults.length > 0 && stepRequestResults.every(r => r === 0), 'a step-into request failed');
        assert(preStepBreakpointCount >= 1, `unexpected pre-step breakpoint count: ${preStepBreakpointCount}`);
        assert(afterStepRequestBreakpointCount === preStepBreakpointCount + 1, 'step request did not add a transient breakpoint');
        assert(stepCompleteBreakpointCount === preStepBreakpointCount, 'transient breakpoint not removed at first step-complete');
        assert(methodEnterQueryCount !== 0, 'method-enter query count should be nonzero');
        // First step-complete: stepped INTO the callee at method-enter.
        assert(stepComplete?.magic === IpcStepCompleteMagic && stepComplete?.type === IpcStepCompleteType, 'step-complete magic/type mismatch');
        assert(stepComplete?.funcMetadataToken === ExpectedStepIntoTargetToken, `step-into did not land in StepIntoTarget: 0x${stepComplete?.funcMetadataToken.toString(16)}`);
        assert(stepComplete?.ilOffset === 0, 'step-into landing should be at IL offset 0 (method enter)');
        assert(stepComplete?.isIL === 1, 'step-into landing should be at an IL offset');
        assert(stepComplete?.stepToken !== 0n, 'step-into step token missing');
        assert(stepComplete?.originalStepRequestToken === stepRequestTokens[stepRequestTokens.length - 1], 'step-into original token mismatch');
        // Step-out from the callee back to the caller.
        assert(stepOutFromMethodEnterRequestResult === 0, `step-out request failed: ${stepOutFromMethodEnterRequestResult}`);
        assert(stepOutFromMethodEnterRequestToken === stepComplete?.originalStepRequestToken, 'step-out request token mismatch');
        assert(stepOutCompleteBreakpointCount === preStepBreakpointCount, 'transient breakpoint not removed at step-out complete');
        assert(stepOutComplete?.magic === IpcStepCompleteMagic && stepOutComplete?.type === IpcStepCompleteType, 'step-out-complete magic/type mismatch');
        assert(stepOutComplete?.funcMetadataToken === ExpectedStepIntoCallerToken, `step-out did not land in BreakHere: 0x${stepOutComplete?.funcMetadataToken.toString(16)}`);
        assert(stepOutComplete?.ilOffset > firstEvent?.offset, 'step-out did not advance past the breakpoint offset');
        assert(stepOutComplete?.isIL === 0, 'step-out landing should be at a native offset');
        assert(stepOutComplete?.stepToken > stepComplete?.stepToken, 'step-out token did not advance');
        assert(stepOutComplete?.originalStepRequestToken === stepComplete?.originalStepRequestToken, 'step-out original token mismatch');
        assert(fireEventToPauseCount >= 3, `unexpected fireEventToPause count: ${fireEventToPauseCount}`);
        assert(disconnectResult === 0 && sessionDestroyResult === 0, 'disconnect/session destroy failed');

        const result = {
            breakpointEventCount: breakpointEvents.length,
            stepCompleteEventCount: stepCompleteEvents.length,
            firstOffset: firstEvent.offset,
            stepOffset: stepEvent.offset,
            stepIntoTarget: {
                funcMetadataToken: stepComplete.funcMetadataToken,
                ilOffset: stepComplete.ilOffset,
                isIL: stepComplete.isIL,
                stepToken: stepComplete.stepToken,
                originalStepRequestToken: stepComplete.originalStepRequestToken
            },
            stepOutLanding: {
                funcMetadataToken: stepOutComplete.funcMetadataToken,
                ilOffset: stepOutComplete.ilOffset,
                isIL: stepOutComplete.isIL,
                stepToken: stepOutComplete.stepToken
            },
            preStepBreakpointCount,
            afterStepRequestBreakpointCount,
            stepCompleteBreakpointCount,
            stepOutCompleteBreakpointCount,
            continueCount,
            methodEnterQueryCount,
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
