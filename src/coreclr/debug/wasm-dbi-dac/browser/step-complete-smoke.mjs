// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

// Shared runner for the step-over / step-out browser smokes. Both set a
// breakpoint at BreakHereWithLocals, and on the first hit issue a
// step-over (StepKind 1) or step-out (StepKind 2) request. The runtime
// then fires a structured step-complete DBI event when the step lands;
// the sidecar DAC drains the WasmDbgIpcEventStepComplete payload via
// coreclr_wasm_dbi_dac_dbi_poll_ipc_step_complete. The harness asserts
// the landing method/offset and that the transient step breakpoint was
// added on the request and removed on landing.

import {
    IpcModuleLoadSize,
    IpcStepCompleteMagic,
    IpcStepCompleteSize,
    IpcStepCompleteType,
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

async function waitForStepComplete(stepCompleteEvents, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (stepCompleteEvents.length > 0) {
            return true;
        }
        await sleep(10);
    }

    return false;
}

// stepKind: StepKindOver | StepKindOut
// expectedLandingMethodToken: the caller method the step should land in
export async function runStepCompleteSmoke(options) {
    const {
        manifestPath,
        breakpointMethodName,
        stepKind,
        stepKindName,
        expectedLandingMethodToken,
        forbiddenLandingMethodToken
    } = options;
    globalThis.__smokeResult = undefined;
    setStatus('loading runtime');

    let runtimeExports;
    let sidecar;
    let sessionCreated = false;
    let connected = false;
    let debuggerConnected = false;
    let fireEventToPauseCount = 0;
    let fireEventToPauseLastKind = '';
    let callbackEvent = '';
    let initialBreakpoint = null;
    let stepRequestResult = -1;
    let preStepBreakpointCount = -1;
    let afterStepRequestBreakpointCount = -1;
    let stepCompleteBreakpointCount = -1;
    const stepCompleteEvents = [];

    const getRuntimeHeap = () => new Uint8Array(runtimeExports.memory.buffer);
    const getDebuggerHeap = () => new Uint8Array(sidecar.exports.memory.buffer);

    try {
        const manifest = await fetchJson(manifestPath);
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
                    fireEventToPauseLastKind = 'step-complete';
                    const stepComplete = pollDbiIpcStepComplete(sidecar);
                    if (stepComplete.payload !== null) {
                        stepCompleteEvents.push(stepComplete.payload);
                    }
                    const active = enumerateBreakpoints(sidecar);
                    stepCompleteBreakpointCount = active.enumerateResult === 0 ? active.activeCount : -1;
                    return 0;
                }
            }
            fireEventToPauseLastKind = 'breakpoint';
            return 0;
        };

        globalThis.CoreClrWasmDebugOnBreakpointHit = (eventAddress, eventLength) => {
            const event = readAscii(getRuntimeHeap(), eventAddress >>> 0, eventLength >>> 0);
            callbackEvent = event;
            if (event.includes(`breakpoint-hit:name=${breakpointMethodName}`) && initialBreakpoint === null) {
                const ipc = pollDbiIpcEvent(sidecar);
                if (ipc.payload === null) {
                    return -1;
                }
                initialBreakpoint = ipc.payload;
                preStepBreakpointCount = enumerateBreakpoints(sidecar).activeCount;
                stepRequestResult = sendStepRequest(sidecar, ipc.payload.breakpointToken, stepKind);
                afterStepRequestBreakpointCount = enumerateBreakpoints(sidecar).activeCount;
            }
            return 0;
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
                const methodName = TextEncoderInstance.encode(breakpointMethodName);
                const stack = sidecar.exports.stackSave();
                const methodNameAddress = sidecar.exports.stackAlloc(methodName.length);
                writeBytes(getDebuggerHeap(), methodNameAddress, methodName);
                const breakpointResult = sidecar.module._coreclr_wasm_dbi_dac_dbi_set_breakpoint_by_name(methodNameAddress, methodName.length);
                sidecar.exports.stackRestore(stack);
                assert(breakpointResult === 0, `failed to set breakpoint: ${breakpointResult}`);
            }
        });

        const stepCompleteSeen = await waitForStepComplete(stepCompleteEvents, CompletionTimeoutMs);
        const stepComplete = stepCompleteEvents[0];
        const continueCount = runtimeExports.CoreClrWasmDebugGetContinueCount();
        const disconnectResult = connected ? sidecar.module._coreclr_wasm_dbi_dac_dbi_disconnect_runtime() : 0;
        connected = false;
        const sessionDestroyResult = sessionCreated ? sidecar.module._coreclr_wasm_dbi_dac_dbi_session_destroy() : 0;
        sessionCreated = false;

        assert(initialBreakpoint !== null, 'initial breakpoint was not hit');
        assert(initialBreakpoint.magic === 0x42435049, `initial breakpoint magic mismatch: 0x${initialBreakpoint.magic.toString(16)}`);
        assert(initialBreakpoint.type === 0x100, `initial breakpoint type mismatch: 0x${initialBreakpoint.type.toString(16)}`);
        assert(initialBreakpoint.breakpointToken !== 0n, 'initial breakpoint token missing');
        assert(stepRequestResult === 0, `step request failed: ${stepRequestResult}`);
        assert(preStepBreakpointCount >= 1, `unexpected pre-step breakpoint count: ${preStepBreakpointCount}`);
        assert(afterStepRequestBreakpointCount === preStepBreakpointCount + 1, 'step request did not add a transient breakpoint');
        assert(stepCompleteBreakpointCount === preStepBreakpointCount, 'transient step breakpoint was not removed on landing');
        assert(stepCompleteSeen, 'step-complete event was not observed');
        assert(stepComplete?.magic === IpcStepCompleteMagic, 'step-complete magic mismatch');
        assert(stepComplete?.type === IpcStepCompleteType, 'step-complete type mismatch');
        assert(stepComplete?.hr === 0, `step-complete hr nonzero: ${stepComplete?.hr}`);
        assert(stepComplete?.funcMetadataToken === expectedLandingMethodToken, `step landed in unexpected method: 0x${stepComplete?.funcMetadataToken.toString(16)}`);
        assert(stepComplete?.funcMetadataToken !== forbiddenLandingMethodToken, 'step landed in forbidden method');
        assert(stepComplete?.ilOffset > initialBreakpoint.offset, 'step did not advance past the breakpoint offset');
        assert(stepComplete?.isIL === 0, 'step-complete isIL should be 0 (native offset)');
        assert(stepComplete?.stepToken !== 0n, 'step-complete token missing');
        assert(stepComplete?.originalStepRequestToken === initialBreakpoint.breakpointToken, 'step-complete original token mismatch');
        assert(continueCount === 1, `unexpected continue count: ${continueCount}`);
        assert(fireEventToPauseCount >= 2, `unexpected fireEventToPause count: ${fireEventToPauseCount}`);
        assert(disconnectResult === 0 && sessionDestroyResult === 0, 'disconnect/session destroy failed');

        const result = {
            stepKind: stepKindName,
            initialBreakpoint: {
                offset: initialBreakpoint.offset,
                isIL: initialBreakpoint.isIL,
                breakpointToken: initialBreakpoint.breakpointToken
            },
            stepComplete: {
                magic: stepComplete.magic,
                type: stepComplete.type,
                funcMetadataToken: stepComplete.funcMetadataToken,
                ilOffset: stepComplete.ilOffset,
                isIL: stepComplete.isIL,
                stepToken: stepComplete.stepToken,
                originalStepRequestToken: stepComplete.originalStepRequestToken
            },
            preStepBreakpointCount,
            afterStepRequestBreakpointCount,
            stepCompleteBreakpointCount,
            continueCount,
            fireEventToPauseCount,
            fireEventToPauseLastKind,
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
