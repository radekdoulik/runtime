// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

import {
    BreakpointMethodName,
    CommandRecordMagic,
    CommandRecordSize,
    ExpectedLocalTypeTags,
    IpcModuleLoadSize,
    ValueRecordFlagReadFailed,
    acknowledgeProtocol,
    assert,
    loadRuntime,
    loadSidecar,
    lookupDbiSourceLocation,
    pollDbiEvent,
    pollDbiEventRecord,
    pollDbiFrameRecord,
    pollDbiIpcEvent,
    pollDbiLocals,
    pollDbiProcessState,
    readAscii,
    readDbiLocalValues,
    readDbiTestData,
    readInt32LittleEndian,
    readNullTerminatedAscii,
    writeBytes,
    writeUint32,
    writeUint64
} from './host.mjs';

const TextEncoderInstance = new TextEncoder();

async function fetchJson(url) {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`failed to fetch ${url}: ${response.status} ${response.statusText}`);
    }

    return response.json();
}

function findSourceLocation(sourceMap, methodToken, ilOffset) {
    const points = sourceMap.points ?? [];
    const token = methodToken >>> 0;
    const offset = ilOffset >>> 0;
    let best = null;
    for (const point of points) {
        if ((point.token >>> 0) !== token) {
            continue;
        }

        if (point.offset <= offset && (best === null || point.offset >= best.offset)) {
            best = point;
        }
    }

    if (best === null) {
        best = points.find(point => (point.token >>> 0) === token) ?? null;
    }

    if (best === null) {
        return null;
    }

    return {
        file: best.document || 'Program.cs',
        line: Number(best.line),
        column: Number(best.column)
    };
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
            const event = copyResult === 0 ? readAscii(runtimeMemory, eventAddress, eventLength) : '';
            runtimeExports.stackRestore(stack);

            return { hitCount, event, copyResult };
        }

        await new Promise(resolve => setTimeout(resolve, 10));
    }

    return { hitCount: 0, event: '', copyResult: -1 };
}

function toDisplayResult(result) {
    return JSON.parse(JSON.stringify(result, (_, value) => typeof value === 'bigint' ? `0x${value.toString(16)}` : value));
}

export async function runSmoke() {
    try {
        const manifest = await fetchJson('/hello-breakpoint/manifest.json');
        const sourceMap = await fetchJson(manifest.sourceMapUrl);
        let runtimeExports;
        let sidecar;
        let sawBreakpointBeforeContinue = false;
        let callbackEvent = '';
        let fireEventToPauseCount = 0;
        let fireEventToPauseLastEvent = '';
        let dbiEventDuringCallback = { pollResult: -1, event: '', bytesWritten: 0 };
        let dbiEventRecordDuringCallback = { pollResult: -1, bytesWritten: 0, record: null };
        let dbiFrameRecordDuringCallback = { pollResult: -1, bytesWritten: 0, record: null };
        let dbiLocalsDuringCallback = { pollResult: -1, bytesWritten: 0, record: null };
        let dbiLocalValuesDuringCallback = [];
        let sourceLocationDuringCallback = { lookupResult: -1, file: '', line: 0, column: 0 };
        let dbiProcessStateDuringCallback = { pollResult: -1, bytesWritten: 0, state: null };
        let testDataDuringCallback = { readResult: -1, testData: null };
        let dbiIpcEventDuringCallback = { pollResult: -1, bytesWritten: 0, payload: null };
        let continueDuringCallbackResult = -1;
        let ipcEventDuringCallback = {
            readBytes: -1,
            magic: 0,
            type: 0,
            funcMetadataToken: 0,
            breakpointToken: 0n,
            isIL: 0,
            offset: 0,
            size: 0
        };

        const getRuntimeHeap = () => {
            assert(runtimeExports?.memory, 'getRuntimeHeap called before runtimeExports.memory was bound');
            return new Uint8Array(runtimeExports.memory.buffer);
        };
        const getDebuggerHeap = () => {
            assert(sidecar?.exports?.memory, 'getDebuggerHeap called before sidecar memory was bound');
            return new Uint8Array(sidecar.exports.memory.buffer);
        };
        const sourceLocationCache = new Map();

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
        globalThis.CoreClrWasmDebugSendIpcToRuntime = (messageAddress, messageLength) => {
            const message = getDebuggerHeap().slice(messageAddress, messageAddress + messageLength);
            const stack = runtimeExports.stackSave();
            try {
                const runtimeMessageAddress = runtimeExports.stackAlloc(messageLength);
                getRuntimeHeap().set(message, runtimeMessageAddress);
                return messageLength === CommandRecordSize &&
                    new DataView(message.buffer, message.byteOffset, message.byteLength).getUint32(0, true) === CommandRecordMagic
                    ? runtimeExports.CoreClrWasmDebugReceiveCommandRecord(runtimeMessageAddress, messageLength)
                    : runtimeExports.CoreClrWasmDebugReceiveCommand(runtimeMessageAddress, messageLength);
            } finally {
                runtimeExports.stackRestore(stack);
            }
        };
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
        globalThis.CoreClrWasmDebugSubmitStepIntoRequest = (requestBytesAddress, requestBytesLength) => {
            const debuggerHeap = getDebuggerHeap();
            if (requestBytesAddress + requestBytesLength > debuggerHeap.length ||
                typeof runtimeExports.CoreClrWasmDebugSubmitStepIntoRequest !== 'function') {
                return -1;
            }

            const requestBytes = debuggerHeap.slice(requestBytesAddress, requestBytesAddress + requestBytesLength);
            const savedRuntimeStack = runtimeExports.stackSave();
            try {
                const runtimeRequestAddress = runtimeExports.stackAlloc(requestBytesLength);
                getRuntimeHeap().set(requestBytes, runtimeRequestAddress);
                return runtimeExports.CoreClrWasmDebugSubmitStepIntoRequest(runtimeRequestAddress, requestBytesLength) | 0;
            } finally {
                runtimeExports.stackRestore(savedRuntimeStack);
            }
        };
        globalThis.coreClrDebugLookupSourceLocation = (methodToken, moduleAddress, modulePathAddress, modulePathLength, ilOffset, outFileAddress, outFileCapacity, outLineAddress, outColumnAddress) => {
            const runtimeHeap = getRuntimeHeap();
            if (outFileCapacity === 0 || modulePathLength === 0 ||
                modulePathAddress + modulePathLength > runtimeHeap.length ||
                outFileAddress + outFileCapacity > runtimeHeap.length ||
                outLineAddress + 4 > runtimeHeap.length ||
                outColumnAddress + 4 > runtimeHeap.length) {
                return -1;
            }

            const assemblyPath = readNullTerminatedAscii(runtimeHeap, modulePathAddress, modulePathLength);
            const cacheKey = `${moduleAddress >>> 0}:${assemblyPath}:${methodToken >>> 0}:${ilOffset >>> 0}`;
            let location = sourceLocationCache.get(cacheKey);
            if (location === undefined) {
                location = findSourceLocation(sourceMap, methodToken >>> 0, ilOffset >>> 0);
                sourceLocationCache.set(cacheKey, location);
            }
            if (location === null || !Number.isFinite(location.line) || !Number.isFinite(location.column) || location.line <= 0 || location.column < 0) {
                return -1;
            }

            runtimeHeap.fill(0, outFileAddress, outFileAddress + outFileCapacity);
            const fileBytes = TextEncoderInstance.encode(location.file);
            const bytesToCopy = Math.min(fileBytes.length, outFileCapacity - 1);
            runtimeHeap.set(fileBytes.subarray(0, bytesToCopy), outFileAddress);
            writeUint32(runtimeHeap, outLineAddress, location.line);
            writeUint32(runtimeHeap, outColumnAddress, location.column);
            return 0;
        };
        globalThis.CoreClrWasmDebugLookupSourceLocation = (methodToken, ilOffset, outFileAddress, outFileCapacity, outLineAddress, outColumnAddress) => {
            const debuggerHeap = getDebuggerHeap();
            if (outFileCapacity === 0 ||
                outFileAddress + outFileCapacity > debuggerHeap.length ||
                outLineAddress + 4 > debuggerHeap.length ||
                outColumnAddress + 4 > debuggerHeap.length ||
                typeof runtimeExports.CoreClrWasmDebugLookupSourceLocation !== 'function') {
                return -1;
            }

            const savedRuntimeStack = runtimeExports.stackSave();
            try {
                const runtimeFileAddress = runtimeExports.stackAlloc(outFileCapacity);
                const runtimeLineAddress = runtimeExports.stackAlloc(4);
                const runtimeColumnAddress = runtimeExports.stackAlloc(4);
                const result = runtimeExports.CoreClrWasmDebugLookupSourceLocation(
                    methodToken >>> 0,
                    ilOffset >>> 0,
                    runtimeFileAddress,
                    outFileCapacity,
                    runtimeLineAddress,
                    runtimeColumnAddress) | 0;
                if (result !== 0) {
                    return result;
                }

                const runtimeHeap = getRuntimeHeap();
                debuggerHeap.set(runtimeHeap.subarray(runtimeFileAddress, runtimeFileAddress + outFileCapacity), outFileAddress);
                debuggerHeap.set(runtimeHeap.subarray(runtimeLineAddress, runtimeLineAddress + 4), outLineAddress);
                debuggerHeap.set(runtimeHeap.subarray(runtimeColumnAddress, runtimeColumnAddress + 4), outColumnAddress);
                return 0;
            } finally {
                runtimeExports.stackRestore(savedRuntimeStack);
            }
        };
        globalThis.coreClrDebugFireEventToPause = (eventAddress, eventLength) => {
            if ((eventLength >>> 0) === IpcModuleLoadSize) {
                return 0;
            }
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
                const recordSize = runtimeExports.CoreClrWasmDebugGetLastEventRecordSize();
                const runtimeStack = runtimeExports.stackSave();
                const runtimeRecordAddress = runtimeExports.stackAlloc(recordSize);
                const copyRecordResult = runtimeExports.CoreClrWasmDebugCopyLastEventRecord(runtimeRecordAddress, recordSize);
                const recordBytes = getRuntimeHeap().slice(runtimeRecordAddress, runtimeRecordAddress + recordSize);
                runtimeExports.stackRestore(runtimeStack);
                if (copyRecordResult !== 0) {
                    return copyRecordResult;
                }

                const debuggerStack = sidecar.exports.stackSave();
                const debuggerRecordAddress = sidecar.exports.stackAlloc(recordBytes.length);
                writeBytes(getDebuggerHeap(), debuggerRecordAddress, recordBytes);
                const receiveRecordResult = sidecar.module._coreclr_wasm_dbi_dac_receive_runtime_event_record(debuggerRecordAddress, recordBytes.length);
                sidecar.exports.stackRestore(debuggerStack);
                if (receiveRecordResult !== 0) {
                    return receiveRecordResult;
                }

                const frameRecordSize = runtimeExports.CoreClrWasmDebugGetLastFrameRecordSize();
                const runtimeFrameStack = runtimeExports.stackSave();
                const runtimeFrameRecordAddress = runtimeExports.stackAlloc(frameRecordSize);
                const copyFrameRecordResult = runtimeExports.CoreClrWasmDebugCopyLastFrameRecord(runtimeFrameRecordAddress, frameRecordSize);
                const frameRecordBytes = getRuntimeHeap().slice(runtimeFrameRecordAddress, runtimeFrameRecordAddress + frameRecordSize);
                runtimeExports.stackRestore(runtimeFrameStack);
                if (copyFrameRecordResult !== 0) {
                    return copyFrameRecordResult;
                }

                const debuggerFrameStack = sidecar.exports.stackSave();
                const debuggerFrameRecordAddress = sidecar.exports.stackAlloc(frameRecordBytes.length);
                writeBytes(getDebuggerHeap(), debuggerFrameRecordAddress, frameRecordBytes);
                const receiveFrameRecordResult = sidecar.module._coreclr_wasm_dbi_dac_receive_runtime_frame_record(debuggerFrameRecordAddress, frameRecordBytes.length);
                sidecar.exports.stackRestore(debuggerFrameStack);
                if (receiveFrameRecordResult !== 0) {
                    return receiveFrameRecordResult;
                }

                dbiEventDuringCallback = pollDbiEvent(sidecar);
                dbiEventRecordDuringCallback = pollDbiEventRecord(sidecar);
                dbiFrameRecordDuringCallback = pollDbiFrameRecord(sidecar);
                dbiProcessStateDuringCallback = pollDbiProcessState(sidecar);
                testDataDuringCallback = readDbiTestData(sidecar);
                dbiIpcEventDuringCallback = pollDbiIpcEvent(sidecar);
                dbiLocalsDuringCallback = pollDbiLocals(sidecar);
                dbiLocalValuesDuringCallback = readDbiLocalValues(
                    sidecar,
                    dbiFrameRecordDuringCallback.record,
                    dbiLocalsDuringCallback.record);
                sourceLocationDuringCallback = lookupDbiSourceLocation(
                    sidecar,
                    dbiFrameRecordDuringCallback.record?.methodToken ?? 0,
                    dbiFrameRecordDuringCallback.record?.ilOffset ?? 0);

                const ipcStack = runtimeExports.stackSave();
                const ipcSize = runtimeExports.CoreClrWasmDebugGetLastIpcEventSize() | 0;
                const ipcBuf = runtimeExports.stackAlloc(ipcSize);
                const ipcReadBytes = runtimeExports.CoreClrWasmDebugReadLastIpcEvent(ipcBuf, ipcSize) | 0;
                if (ipcReadBytes === 96) {
                    const ipcView = new DataView(runtimeExports.memory.buffer, ipcBuf, ipcSize);
                    ipcEventDuringCallback = {
                        readBytes: ipcReadBytes,
                        magic: ipcView.getUint32(0, true),
                        type: ipcView.getUint32(4, true),
                        breakpointToken: ipcView.getBigUint64(40, true),
                        funcMetadataToken: ipcView.getUint32(48, true),
                        isIL: ipcView.getUint32(64, true),
                        offset: ipcView.getUint32(68, true),
                        size: ipcSize
                    };
                } else {
                    ipcEventDuringCallback = { readBytes: ipcReadBytes, magic: 0, type: 0, funcMetadataToken: 0, breakpointToken: 0n, isIL: 0, offset: 0, size: ipcSize };
                }
                runtimeExports.stackRestore(ipcStack);
                const continueToken = dbiIpcEventDuringCallback.payload.breakpointToken;
                continueDuringCallbackResult = sidecar.module._coreclr_wasm_dbi_dac_dbi_send_ipc_continue_request(
                    Number(continueToken & 0xffffffffn),
                    Number(continueToken >> 32n));
                sawBreakpointBeforeContinue = true;
            }

            return receiveResult;
        };

        try {
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
                    const connectResult = sidecar.module._coreclr_wasm_dbi_dac_dbi_connect_runtime(1);
                    assert(connectResult === 0, `failed to connect DBI session to runtime: ${connectResult}`);
                    const prevConnected = runtimeExports.CoreClrWasmDebugSetDebuggerConnected(1);
                    assert(prevConnected === 0, `expected CoreClrWasmDebugSetDebuggerConnected to return 0, got ${prevConnected}`);
                    assert(runtimeExports.CoreClrWasmDebugIsDebuggerConnected() === 1, 'debugger connected flag was not set');
                    const methodName = TextEncoderInstance.encode(BreakpointMethodName);
                    const stack = sidecar.exports.stackSave();
                    const methodNameAddress = sidecar.exports.stackAlloc(methodName.length);
                    writeBytes(getDebuggerHeap(), methodNameAddress, methodName);
                    const breakpointResult = sidecar.module._coreclr_wasm_dbi_dac_dbi_set_breakpoint_by_name(methodNameAddress, methodName.length);
                    sidecar.exports.stackRestore(stack);
                    assert(breakpointResult === 0, `failed to set breakpoint: ${breakpointResult}`);
                }
            });

            const result = await waitForBreakpointHit(runtimeExports);
            const continueCount = runtimeExports.CoreClrWasmDebugGetContinueCount();
            const methodEnterQueryCount = runtimeExports.CoreClrWasmDebugGetMethodEnterEnabledQueryCount() >>> 0;
            const disconnectResult = sidecar.module._coreclr_wasm_dbi_dac_dbi_disconnect_runtime();
            const sessionDestroyResult = sidecar.module._coreclr_wasm_dbi_dac_dbi_session_destroy();
            result.callbackEvent = callbackEvent;
            result.fireEventToPauseCount = fireEventToPauseCount;
            result.fireEventToPauseLastEvent = fireEventToPauseLastEvent;
            result.dbiEvent = dbiEventDuringCallback;
            result.dbiEventRecord = dbiEventRecordDuringCallback;
            result.dbiFrameRecord = dbiFrameRecordDuringCallback;
            result.dbiLocalsDuringCallback = dbiLocalsDuringCallback;
            result.dbiLocalValuesDuringCallback = dbiLocalValuesDuringCallback.map(value => ({
                readResult: value.readResult,
                ilSlot: value.local.ilSlot,
                typeTag: value.record?.typeTag,
                byteSize: value.record?.byteSize,
                isRef: value.record?.isRef,
                flags: value.record?.flags,
                objectAddress: value.record?.objectAddress !== undefined ? `0x${value.record.objectAddress.toString(16)}` : null,
                methodTableAddress: value.record?.methodTableAddress !== undefined ? `0x${value.record.methodTableAddress.toString(16)}` : null,
                inlineBytes: value.record?.inlineBytes.slice(0, Math.min(value.local.byteSize, 16))
            }));
            result.sourceLocationDuringCallback = sourceLocationDuringCallback;
            result.dbiProcessState = dbiProcessStateDuringCallback;
            result.testDataAtBreakpoint = testDataDuringCallback;
            result.continueDuringCallbackResult = continueDuringCallbackResult;
            result.continueCount = continueCount;
            result.methodEnterQueryCount = methodEnterQueryCount;
            result.disconnectResult = disconnectResult;
            result.sessionDestroyResult = sessionDestroyResult;
            result.sawBreakpointBeforeContinue = sawBreakpointBeforeContinue;
            result.ipcEventDuringCallback = {
                ...ipcEventDuringCallback,
                magic: `0x${ipcEventDuringCallback.magic.toString(16)}`,
                type: `0x${ipcEventDuringCallback.type.toString(16)}`,
                funcMetadataToken: `0x${ipcEventDuringCallback.funcMetadataToken.toString(16)}`,
                breakpointToken: `0x${ipcEventDuringCallback.breakpointToken.toString(16)}`
            };
            result.dbiIpcEventDuringCallback = dbiIpcEventDuringCallback.payload
                ? {
                    pollResult: dbiIpcEventDuringCallback.pollResult,
                    bytesWritten: dbiIpcEventDuringCallback.bytesWritten,
                    magic: `0x${dbiIpcEventDuringCallback.payload.magic.toString(16)}`,
                    type: `0x${dbiIpcEventDuringCallback.payload.type.toString(16)}`,
                    processId: dbiIpcEventDuringCallback.payload.processId,
                    threadId: dbiIpcEventDuringCallback.payload.threadId,
                    hr: dbiIpcEventDuringCallback.payload.hr,
                    flags: dbiIpcEventDuringCallback.payload.flags,
                    breakpointToken: `0x${dbiIpcEventDuringCallback.payload.breakpointToken.toString(16)}`,
                    funcMetadataToken: `0x${dbiIpcEventDuringCallback.payload.funcMetadataToken.toString(16)}`,
                    isIL: dbiIpcEventDuringCallback.payload.isIL,
                    offset: dbiIpcEventDuringCallback.payload.offset,
                    encVersion: dbiIpcEventDuringCallback.payload.encVersion
                }
                : dbiIpcEventDuringCallback;

            const successfulLocalValueCount = dbiLocalValuesDuringCallback
                .filter(value => value.readResult === 0 && value.record !== null && (value.record.flags & ValueRecordFlagReadFailed) === 0)
                .length;
            const primitiveLocalValuesValid = ExpectedLocalTypeTags.every((typeTag, index) => {
                const value = dbiLocalValuesDuringCallback[index];
                const local = dbiLocalsDuringCallback.record?.locals[index];
                return value?.readResult === 0 &&
                    value.record?.typeTag === typeTag &&
                    value.record?.byteSize === local?.byteSize &&
                    value.record?.isRef === 0 &&
                    (value.record?.flags & ValueRecordFlagReadFailed) === 0 &&
                    value.record?.inlineBytes.length === 64 &&
                    Math.min(local?.byteSize ?? 0, 64) > 0;
            });
            const firstLocalRecord = dbiLocalValuesDuringCallback[0]?.record;
            const firstLocalValueI32 = firstLocalRecord !== undefined && firstLocalRecord !== null
                ? readInt32LittleEndian(firstLocalRecord.inlineBytes)
                : 0;
            const referenceLocalValuesValid = dbiLocalValuesDuringCallback
                .filter(value => value.record?.isRef === 1)
                .every(value => value.record.objectAddress !== 0n && value.record.methodTableAddress !== 0n);

            assert(result.hitCount === 1, 'unexpected breakpoint hit count');
            assert(result.copyResult === 0, 'failed to copy runtime event');
            assert(result.event.includes(`breakpoint-hit:name=${BreakpointMethodName}`), 'runtime event did not identify breakpoint');
            assert(dbiEventDuringCallback.pollResult === 0 && dbiEventDuringCallback.event.includes(`breakpoint-hit:name=${BreakpointMethodName}`), 'sidecar text event did not identify breakpoint');
            assert(dbiEventRecordDuringCallback.pollResult === 0 && dbiEventRecordDuringCallback.bytesWritten === 340, 'sidecar event record missing');
            assert(dbiEventRecordDuringCallback.record?.kind === 1 && dbiEventRecordDuringCallback.record?.methodName === BreakpointMethodName, 'sidecar event record mismatch');
            assert(dbiFrameRecordDuringCallback.pollResult === 0 && dbiFrameRecordDuringCallback.bytesWritten === 88, 'sidecar frame record missing');
            assert(dbiFrameRecordDuringCallback.record?.methodName === BreakpointMethodName, 'sidecar frame method mismatch');
            assert(dbiFrameRecordDuringCallback.record?.methodToken === dbiEventRecordDuringCallback.record?.methodToken, 'frame token mismatch');
            assert(dbiFrameRecordDuringCallback.record?.ilOffset === 0, 'frame IL offset mismatch');
            assert(dbiFrameRecordDuringCallback.record?.interpreterIP !== 0 && dbiFrameRecordDuringCallback.record?.frameAddress !== 0 && dbiFrameRecordDuringCallback.record?.stackAddress !== 0, 'frame addresses missing');
            assert(dbiLocalsDuringCallback.pollResult === 0 && dbiLocalsDuringCallback.bytesWritten === 1552, 'locals record missing');
            assert(dbiLocalsDuringCallback.record?.magic === 0x524C4457 && dbiLocalsDuringCallback.record?.version === 1, 'locals header mismatch');
            assert(dbiLocalsDuringCallback.record?.methodToken === dbiEventRecordDuringCallback.record?.methodToken, 'locals token mismatch');
            assert(dbiLocalsDuringCallback.record?.localCount === ExpectedLocalTypeTags.length, 'locals count mismatch');
            assert(ExpectedLocalTypeTags.every((typeTag, index) =>
                dbiLocalsDuringCallback.record?.locals[index]?.ilSlot === index &&
                dbiLocalsDuringCallback.record?.locals[index]?.typeTag === typeTag &&
                dbiLocalsDuringCallback.record?.locals[index]?.byteSize > 0), 'locals shape mismatch');
            assert(dbiLocalValuesDuringCallback.length === ExpectedLocalTypeTags.length && successfulLocalValueCount !== 0 && primitiveLocalValuesValid, 'local values mismatch');
            assert(firstLocalValueI32 === dbiFrameRecordDuringCallback.record?.firstStackSlotI32, 'first local value mismatch');
            assert(referenceLocalValuesValid, 'reference local value mismatch');
            assert(sourceLocationDuringCallback.lookupResult === 0, 'source lookup failed');
            assert(sourceLocationDuringCallback.file.endsWith('.cs') || sourceLocationDuringCallback.file.endsWith('.dll'), 'source lookup file mismatch');
            assert(sourceLocationDuringCallback.line > 0 && sourceLocationDuringCallback.column >= 0, 'source lookup line/column mismatch');
            assert(dbiProcessStateDuringCallback.pollResult === 0 && dbiProcessStateDuringCallback.bytesWritten === 40, 'process state missing');
            assert(dbiProcessStateDuringCallback.state?.sessionCreated === 1 && dbiProcessStateDuringCallback.state?.connected === 1, 'process state not connected');
            assert(dbiProcessStateDuringCallback.state?.runtimeBase === 1 && dbiProcessStateDuringCallback.state?.syntheticProcessId === 1 && dbiProcessStateDuringCallback.state?.hasRealCordbProcess === 1, 'process state target mismatch');
            assert(dbiProcessStateDuringCallback.state?.lastEventKind === 1 && dbiProcessStateDuringCallback.state?.lastMethodToken === dbiEventRecordDuringCallback.record?.methodToken, 'process state event mismatch');
            if (!testDataDuringCallback.skipped) {
                assert(testDataDuringCallback.readResult === 0, 'test data read failed');
                assert(testDataDuringCallback.testData?.magic === 0x43445744 && testDataDuringCallback.testData?.int32Value === 123456789, 'test data scalar mismatch');
                assert(testDataDuringCallback.testData?.doubleValue === 1234.5 && testDataDuringCallback.testData?.message === 'wasm-dbi-dac', 'test data payload mismatch');
            }
            assert(continueDuringCallbackResult === 0 && continueCount === 1, 'continue failed');
            assert(methodEnterQueryCount !== 0, 'method-enter query count missing');
            assert(disconnectResult === 0 && sessionDestroyResult === 0, 'disconnect/session destroy failed');
            assert(sawBreakpointBeforeContinue, 'breakpoint was not observed before continue');
            assert(fireEventToPauseCount === 1 && fireEventToPauseLastEvent.includes(`breakpoint-hit:name=${BreakpointMethodName}`), 'pause trigger mismatch');
            assert(ipcEventDuringCallback.readBytes === 96 && ipcEventDuringCallback.magic === 0x42435049 && ipcEventDuringCallback.type === 0x100, 'runtime IPC event mismatch');
            assert(ipcEventDuringCallback.funcMetadataToken === dbiEventRecordDuringCallback.record?.methodToken && ipcEventDuringCallback.breakpointToken !== 0n, 'runtime IPC token mismatch');
            assert(ipcEventDuringCallback.isIL === 1 && ipcEventDuringCallback.offset === 0, 'runtime IPC location mismatch');
            assert(dbiIpcEventDuringCallback.pollResult === 0 && dbiIpcEventDuringCallback.bytesWritten === 96, 'sidecar IPC event missing');
            assert(dbiIpcEventDuringCallback.payload?.magic === 0x42435049 && dbiIpcEventDuringCallback.payload?.type === 0x100, 'sidecar IPC event mismatch');
            assert(dbiIpcEventDuringCallback.payload?.funcMetadataToken === ipcEventDuringCallback.funcMetadataToken, 'sidecar IPC token mismatch');
            assert(dbiIpcEventDuringCallback.payload?.breakpointToken === ipcEventDuringCallback.breakpointToken, 'sidecar IPC breakpoint token mismatch');
            assert(dbiIpcEventDuringCallback.payload?.isIL === 1 && dbiIpcEventDuringCallback.payload?.offset === 0, 'sidecar IPC location mismatch');

            const displayResult = toDisplayResult(result);
            globalThis.__smokeResult = { passed: true, result: displayResult };
            return displayResult;
        } finally {
            delete globalThis.CoreClrWasmDebugOnBreakpointHit;
            delete globalThis.coreClrDebugFireEventToPause;
            delete globalThis.CoreClrWasmDebugGetTargetModuleBase;
            delete globalThis.CoreClrWasmDebugGetSymbolAddress;
            delete globalThis.CoreClrWasmDebugReadTargetMemory;
            delete globalThis.CoreClrWasmDebugSendIpcToRuntime;
            delete globalThis.CoreClrWasmDebugSubmitContinueRequest;
            delete globalThis.CoreClrWasmDebugSubmitStepIntoRequest;
            delete globalThis.CoreClrWasmDebugLookupSourceLocation;
            delete globalThis.coreClrDebugLookupSourceLocation;
        }
    } catch (error) {
        globalThis.__smokeResult = { passed: false, error: `${error.message}\n${error.stack}` };
        throw error;
    }
}
