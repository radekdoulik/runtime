// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

export const BreakpointMethodName = 'BreakHereWithLocals';
export const CommandRecordMagic = 0x434d4457;
export const CommandRecordSize = 80;
export const ExpectedLocalTypeTags = [0x08, 0x0a, 0x0d];
export const ExpectedVersionBlobMagic = 0x42564457;
export const ExpectedAbiVersion = 1;
export const ExpectedProtocolBreakingChangeCounter = 14;
export const IpcModuleLoadSize = 312;
export const ValueRecordSize = 104;
export const ValueRecordFlagReadFailed = 1;
export const SourceLocationFileCapacity = 256;

export function assert(condition, message) {
    if (!condition) {
        throw new Error(message);
    }
}

export function writeBytes(memory, address, bytes) {
    memory.set(bytes, address);
}

export function writeUint64(memory, address, value) {
    new DataView(memory.buffer).setBigUint64(address, BigInt(value), true);
}

export function writeUint32(memory, address, value) {
    new DataView(memory.buffer).setUint32(address, value >>> 0, true);
}

export function readAscii(memory, address, byteCount) {
    let result = '';
    for (let index = 0; index < byteCount; index++) {
        result += String.fromCharCode(memory[address + index]);
    }

    return result;
}

export function readNullTerminatedAscii(memory, address, byteCount) {
    let result = '';
    for (let index = 0; index < byteCount && memory[address + index] !== 0; index++) {
        result += String.fromCharCode(memory[address + index]);
    }

    return result;
}

function dirname(virtualPath) {
    const index = virtualPath.lastIndexOf('/');
    return index <= 0 ? '/' : virtualPath.slice(0, index);
}

function basename(virtualPath) {
    const index = virtualPath.lastIndexOf('/');
    return index < 0 ? virtualPath : virtualPath.slice(index + 1);
}


function makeNodePathPolyfill() {
    const normalize = input => {
        let path = String(input || '.').replace(/\\+/g, '/');
        const absolute = path.startsWith('/');
        const trailing = path.endsWith('/');
        const parts = [];
        for (const part of path.split('/')) {
            if (part.length === 0 || part === '.') {
                continue;
            }
            if (part === '..') {
                if (parts.length > 0 && parts[parts.length - 1] !== '..') {
                    parts.pop();
                } else if (!absolute) {
                    parts.push('..');
                }
            } else {
                parts.push(part);
            }
        }

        let result = `${absolute ? '/' : ''}${parts.join('/')}`;
        if (result.length === 0) {
            result = absolute ? '/' : '.';
        }
        if (trailing && result !== '/') {
            result += '/';
        }

        return result;
    };
    const resolve = (...paths) => {
        let combined = '';
        for (let index = paths.length - 1; index >= 0; index--) {
            const part = String(paths[index] || '');
            if (part.length === 0) {
                continue;
            }
            combined = combined.length === 0 ? part : `${part}/${combined}`;
            if (part.startsWith('/')) {
                break;
            }
        }

        if (!combined.startsWith('/')) {
            combined = `/${combined}`;
        }

        return normalize(combined);
    };
    const dirname = input => {
        const path = normalize(input);
        if (path === '/') {
            return '/';
        }
        const trimmed = path.endsWith('/') ? path.slice(0, -1) : path;
        const index = trimmed.lastIndexOf('/');
        if (index < 0) {
            return '.';
        }
        if (index === 0) {
            return '/';
        }

        return trimmed.slice(0, index);
    };
    const basename = input => {
        const path = normalize(input);
        if (path === '/') {
            return '/';
        }
        const trimmed = path.endsWith('/') ? path.slice(0, -1) : path;
        const index = trimmed.lastIndexOf('/');
        return index < 0 ? trimmed : trimmed.slice(index + 1);
    };
    const relative = (from, to) => {
        const fromParts = resolve(from).split('/').filter(Boolean);
        const toParts = resolve(to).split('/').filter(Boolean);
        let common = 0;
        while (common < fromParts.length && common < toParts.length && fromParts[common] === toParts[common]) {
            common++;
        }

        const up = new Array(fromParts.length - common).fill('..');
        const down = toParts.slice(common);
        return [...up, ...down].join('/') || '';
    };
    const polyfill = {
        isAbsolute: value => String(value).startsWith('/'),
        normalize,
        dirname,
        basename,
        join: (...parts) => normalize(parts.filter(part => part !== undefined && part !== '').join('/')),
        resolve,
        relative
    };
    polyfill.posix = polyfill;
    return polyfill;
}

async function importRuntimeEsm(url) {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`failed to fetch ${url}: ${response.status} ${response.statusText}`);
    }

    let source = await response.text();
    source = source.replace('} else {\n throw new Error("NODERAWFS is currently only supported on Node.js environment.");\n}\n', '} else {\n // Browser smoke uses MEMFS files preloaded below instead of NODERAWFS.\n}\n');
    const patched = source.replace('var Module = moduleArg;\n', 'var Module = moduleArg;\nvar nodePath = moduleArg.__nodePathPolyfill;\n');
    const objectUrl = URL.createObjectURL(new Blob([patched], { type: 'text/javascript' }));
    try {
        return await import(objectUrl);
    } finally {
        URL.revokeObjectURL(objectUrl);
    }
}

async function fetchBytes(url) {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`failed to fetch ${url}: ${response.status} ${response.statusText}`);
    }

    return new Uint8Array(await response.arrayBuffer());
}

async function importClassicEmscripten(url, moduleConfig) {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`failed to fetch ${url}: ${response.status} ${response.statusText}`);
    }

    const source = await response.text();
    const configName = `__wasmDbiDacModuleConfig_${Math.random().toString(36).slice(2)}`;
    globalThis[configName] = moduleConfig;
    const patched = `var Module = globalThis.${configName};\n${source}\nexport default Module;\n`;
    const objectUrl = URL.createObjectURL(new Blob([patched], { type: 'text/javascript' }));
    try {
        const imported = await import(objectUrl);
        return imported.default;
    } finally {
        URL.revokeObjectURL(objectUrl);
        delete globalThis[configName];
    }
}

function makeSidecarHostImports(getDebuggerHeap) {
    return {
        read_target_memory(targetAddress, debuggerAddress, byteCount) {
            if (typeof globalThis.CoreClrWasmDebugReadTargetMemory !== 'function') {
                return -1;
            }

            return globalThis.CoreClrWasmDebugReadTargetMemory(targetAddress >>> 0, debuggerAddress >>> 0, byteCount >>> 0) | 0;
        },
        get_symbol_address(baseAddress, symbolNameAddress, symbolNameLength, addressOutAddress) {
            if (typeof globalThis.CoreClrWasmDebugGetSymbolAddress !== 'function') {
                return -1;
            }

            return globalThis.CoreClrWasmDebugGetSymbolAddress(
                baseAddress >>> 0,
                symbolNameAddress >>> 0,
                symbolNameLength >>> 0,
                addressOutAddress >>> 0) | 0;
        },
        get_target_module_base(imageNameAddress, imageNameCharCount, addressOutAddress) {
            if (typeof globalThis.CoreClrWasmDebugGetTargetModuleBase !== 'function') {
                return -1;
            }

            return globalThis.CoreClrWasmDebugGetTargetModuleBase(
                imageNameAddress >>> 0,
                imageNameCharCount >>> 0,
                addressOutAddress >>> 0) | 0;
        },
        send_ipc_to_runtime(messageAddress, messageLength) {
            if (typeof globalThis.CoreClrWasmDebugSendIpcToRuntime !== 'function') {
                return -1;
            }

            return globalThis.CoreClrWasmDebugSendIpcToRuntime(messageAddress >>> 0, messageLength >>> 0) | 0;
        },
        submit_continue_request(requestBytesAddress, requestBytesLength) {
            if (typeof globalThis.CoreClrWasmDebugSubmitContinueRequest !== 'function') {
                return -1;
            }

            return globalThis.CoreClrWasmDebugSubmitContinueRequest(requestBytesAddress >>> 0, requestBytesLength >>> 0) | 0;
        },
        submit_async_break_request() {
            if (typeof globalThis.CoreClrWasmDebugSubmitAsyncBreakRequest !== 'function') {
                return -1;
            }

            return globalThis.CoreClrWasmDebugSubmitAsyncBreakRequest() | 0;
        },
        submit_step_into_request(requestBytesAddress, requestBytesLength) {
            if (typeof globalThis.CoreClrWasmDebugSubmitStepIntoRequest !== 'function') {
                return -1;
            }

            return globalThis.CoreClrWasmDebugSubmitStepIntoRequest(requestBytesAddress >>> 0, requestBytesLength >>> 0) | 0;
        },
        lookup_source_location(methodToken, ilOffset, outFileAddress, outFileCapacity, outLineAddress, outColumnAddress) {
            if (typeof globalThis.CoreClrWasmDebugLookupSourceLocation !== 'function') {
                return -1;
            }

            return globalThis.CoreClrWasmDebugLookupSourceLocation(
                methodToken >>> 0,
                ilOffset >>> 0,
                outFileAddress >>> 0,
                outFileCapacity >>> 0,
                outLineAddress >>> 0,
                outColumnAddress >>> 0) | 0;
        }
    };
}

export async function loadSidecar(jsUrl) {
    let instance;
    const absoluteUrl = new URL(jsUrl, globalThis.location?.href ?? import.meta.url).href;
    const wasmUrl = new URL('coreclr-dbi-dac.wasm', absoluteUrl).href;
    let resolveInstance;
    let rejectInstance;
    const instanceReady = new Promise((resolve, reject) => {
        resolveInstance = resolve;
        rejectInstance = reject;
    });
    let resolveInitialized;
    const initialized = new Promise(resolve => {
        resolveInitialized = resolve;
    });
    const moduleConfig = {
        noInitialRun: true,
        locateFile: fileName => new URL(fileName, absoluteUrl).href,
        print() {},
        printErr(text) {
            console.warn(`[sidecar] ${text}`);
        },
        onRuntimeInitialized() {
            resolveInitialized();
        },
        onAbort(reason) {
            rejectInstance(new Error(String(reason)));
            throw new Error(String(reason));
        },
        instantiateWasm(imports, receiveInstance) {
            const hostImports = makeSidecarHostImports(() => new Uint8Array(instance.exports.memory.buffer));
            Object.assign(imports.env, hostImports);
            imports.coreclr_dbi_dac = hostImports;
            WebAssembly.instantiateStreaming(fetch(wasmUrl), imports)
                .catch(async () => WebAssembly.instantiate(await fetchBytes(wasmUrl), imports))
                .then(({ instance: wasmInstance, module }) => {
                    instance = wasmInstance;
                    receiveInstance(wasmInstance, module);
                    resolveInstance(wasmInstance);
                })
                .catch(error => {
                    rejectInstance(error);
                });

            return {};
        }
    };

    const module = await importClassicEmscripten(absoluteUrl, moduleConfig);
    await instanceReady;
    await initialized;
    return { module, exports: instance.exports };
}

function createVirtualFiles(Module, files) {
    const FS = Module.FS;
    for (const file of files) {
        FS.mkdirTree(dirname(file.path));
    }

    for (const file of files) {
        const parent = dirname(file.path);
        const name = basename(file.path);
        const existing = FS.analyzePath(file.path);
        if (existing.exists) {
            FS.unlink(file.path);
        }
        FS.createDataFile(parent, name, file.bytes, true, false, true);
    }
}

export async function loadRuntime(jsUrl, options) {
    const absoluteUrl = new URL(jsUrl, globalThis.location?.href ?? import.meta.url).href;
    const moduleFactory = await importRuntimeEsm(absoluteUrl);
    const files = await Promise.all((options.files ?? []).map(async file => ({
        ...file,
        bytes: await fetchBytes(file.url)
    })));
    let instance;
    let resolveInstanceReady;
    let rejectInstanceReady;
    const instanceReady = new Promise((resolve, reject) => {
        resolveInstanceReady = resolve;
        rejectInstanceReady = reject;
    });
    const moduleConfig = {
        __nodePathPolyfill: makeNodePathPolyfill(),
        noExitRuntime: true,
        noInitialRun: options.noInitialRun === true,
        arguments: options.arguments ?? [],
        ENV: {
            DOTNET_InterpMode: '3',
            DOTNET_ReadyToRun: '0',
            ...(options.env ?? {})
        },
        locateFile: fileName => new URL(fileName, absoluteUrl).href,
        print(text) {
            options.onPrint?.(String(text));
        },
        printErr(text) {
            const value = String(text);
            if (!value.startsWith('program exited (with status: 0), but keepRuntimeAlive()')) {
                options.onPrintErr?.(value);
            }
        },
        preRun() {
            createVirtualFiles(moduleConfig, files);
        },
        instantiateWasm(imports, receiveInstance) {
            const wasmUrl = new URL('corerun.wasm', absoluteUrl).href;
            WebAssembly.instantiateStreaming(fetch(wasmUrl), imports)
                .catch(async () => WebAssembly.instantiate(await fetchBytes(wasmUrl), imports))
                .then(({ instance: wasmInstance, module }) => {
                    try {
                        instance = wasmInstance;
                        options.onInstance?.(wasmInstance);
                        receiveInstance(wasmInstance, module);
                        resolveInstanceReady(wasmInstance);
                    } catch (error) {
                        rejectInstanceReady(error);
                    }
                })
                .catch(error => {
                    rejectInstanceReady(error);
                });

            return {};
        }
    };

    moduleFactory.selfRun(moduleConfig);
    await Promise.all([moduleConfig.ready, instanceReady]);
    return { module: moduleConfig, exports: instance.exports };
}

export function acknowledgeProtocol(sidecar) {
    const ackResult = sidecar.module._coreclr_wasm_dbi_dac_acknowledge_protocol(
        ExpectedVersionBlobMagic,
        ExpectedAbiVersion,
        ExpectedProtocolBreakingChangeCounter);
    assert(ackResult === 0, `failed to acknowledge sidecar protocol: ${ackResult}`);
    return ackResult;
}

export function pollDbiEvent(sidecar) {
    const stack = sidecar.exports.stackSave();
    const eventAddress = sidecar.exports.stackAlloc(256);
    const bytesWrittenAddress = sidecar.exports.stackAlloc(4);
    const pollResult = sidecar.module._coreclr_wasm_dbi_dac_dbi_poll_event(eventAddress, 256, bytesWrittenAddress);
    const bytesWritten = new DataView(sidecar.module.HEAPU8.buffer, bytesWrittenAddress, 4).getUint32(0, true);
    const event = pollResult === 0 ? readAscii(sidecar.module.HEAPU8, eventAddress, bytesWritten) : '';
    sidecar.exports.stackRestore(stack);

    return { pollResult, event, bytesWritten };
}

export function readEventRecord(memory, address) {
    const view = new DataView(memory.buffer, address, 340);
    return {
        kind: view.getUint32(0, true),
        methodToken: view.getUint32(4, true),
        ilOffset: view.getUint32(8, true),
        hitCount: view.getUint32(12, true),
        continueCount: view.getUint32(16, true),
        methodName: readNullTerminatedAscii(memory, address + 20, 64),
        message: readNullTerminatedAscii(memory, address + 84, 256)
    };
}

export function pollDbiEventRecord(sidecar) {
    const stack = sidecar.exports.stackSave();
    const recordAddress = sidecar.exports.stackAlloc(340);
    const bytesWrittenAddress = sidecar.exports.stackAlloc(4);
    const pollResult = sidecar.module._coreclr_wasm_dbi_dac_dbi_poll_event_record(recordAddress, 340, bytesWrittenAddress);
    const bytesWritten = new DataView(sidecar.module.HEAPU8.buffer, bytesWrittenAddress, 4).getUint32(0, true);
    const record = pollResult === 0 ? readEventRecord(sidecar.module.HEAPU8, recordAddress) : null;
    sidecar.exports.stackRestore(stack);

    return { pollResult, bytesWritten, record };
}

export function pollDbiIpcEvent(sidecar) {
    const stack = sidecar.exports.stackSave();
    const eventAddress = sidecar.exports.stackAlloc(96);
    const bytesWrittenAddress = sidecar.exports.stackAlloc(4);
    const pollResult = sidecar.module._coreclr_wasm_dbi_dac_dbi_poll_ipc_event(eventAddress, 96, bytesWrittenAddress);
    const bytesWritten = new DataView(sidecar.module.HEAPU8.buffer, bytesWrittenAddress, 4).getUint32(0, true);
    let payload = null;
    if (pollResult === 0 && bytesWritten === 96) {
        const view = new DataView(sidecar.module.HEAPU8.buffer, eventAddress, 96);
        payload = {
            magic: view.getUint32(0, true),
            type: view.getUint32(4, true),
            processId: view.getUint32(8, true),
            threadId: view.getUint32(12, true),
            hr: view.getInt32(32, true),
            flags: view.getUint32(36, true),
            breakpointToken: view.getBigUint64(40, true),
            funcMetadataToken: view.getUint32(48, true),
            isIL: view.getUint32(64, true),
            offset: view.getUint32(68, true),
            encVersion: view.getUint32(72, true)
        };
    }
    sidecar.exports.stackRestore(stack);

    return { pollResult, bytesWritten, payload };
}

export function pollDbiIpcException(sidecar) {
    const stack = sidecar.exports.stackSave();
    const eventAddress = sidecar.exports.stackAlloc(144);
    const bytesWrittenAddress = sidecar.exports.stackAlloc(4);
    const pollResult = sidecar.module._coreclr_wasm_dbi_dac_dbi_poll_ipc_exception(eventAddress, 144, bytesWrittenAddress);
    const bytesWritten = new DataView(sidecar.module.HEAPU8.buffer, bytesWrittenAddress, 4).getUint32(0, true);
    sidecar.exports.stackRestore(stack);

    return { pollResult, bytesWritten };
}

export function pollDbiIpcStepComplete(sidecar) {
    const stack = sidecar.exports.stackSave();
    const eventAddress = sidecar.exports.stackAlloc(96);
    const bytesWrittenAddress = sidecar.exports.stackAlloc(4);
    const pollResult = sidecar.module._coreclr_wasm_dbi_dac_dbi_poll_ipc_step_complete(eventAddress, 96, bytesWrittenAddress);
    const bytesWritten = new DataView(sidecar.module.HEAPU8.buffer, bytesWrittenAddress, 4).getUint32(0, true);
    sidecar.exports.stackRestore(stack);

    return { pollResult, bytesWritten };
}

export function pollDbiIpcModuleLoad(sidecar) {
    const stack = sidecar.exports.stackSave();
    const eventAddress = sidecar.exports.stackAlloc(IpcModuleLoadSize);
    const bytesWrittenAddress = sidecar.exports.stackAlloc(4);
    const pollResult = sidecar.module._coreclr_wasm_dbi_dac_dbi_poll_ipc_module_load(eventAddress, IpcModuleLoadSize, bytesWrittenAddress);
    const bytesWritten = new DataView(sidecar.module.HEAPU8.buffer, bytesWrittenAddress, 4).getUint32(0, true);
    sidecar.exports.stackRestore(stack);

    return { pollResult, bytesWritten };
}

function readFrameRecord(memory, address) {
    const view = new DataView(memory.buffer, address, 88);
    return {
        methodToken: view.getUint32(0, true),
        ilOffset: view.getUint32(4, true),
        interpreterIP: view.getUint32(8, true),
        frameAddress: view.getUint32(12, true),
        stackAddress: view.getUint32(16, true),
        firstStackSlotI32: view.getInt32(20, true),
        methodName: readNullTerminatedAscii(memory, address + 24, 64)
    };
}

export function pollDbiFrameRecord(sidecar) {
    const stack = sidecar.exports.stackSave();
    const recordAddress = sidecar.exports.stackAlloc(88);
    const bytesWrittenAddress = sidecar.exports.stackAlloc(4);
    const pollResult = sidecar.module._coreclr_wasm_dbi_dac_dbi_poll_frame_record(recordAddress, 88, bytesWrittenAddress);
    const bytesWritten = new DataView(sidecar.module.HEAPU8.buffer, bytesWrittenAddress, 4).getUint32(0, true);
    const record = pollResult === 0 ? readFrameRecord(sidecar.module.HEAPU8, recordAddress) : null;
    sidecar.exports.stackRestore(stack);

    return { pollResult, bytesWritten, record };
}

function readLocalsRecord(memory, address) {
    const view = new DataView(memory.buffer, address, 1552);
    const localCount = view.getUint32(12, true);
    const locals = [];
    for (let index = 0; index < Math.min(localCount, 32); index++) {
        const localOffset = 16 + (index * 48);
        locals.push({
            ilSlot: view.getUint32(localOffset, true),
            typeTag: view.getUint32(localOffset + 4, true),
            byteOffset: view.getUint32(localOffset + 8, true),
            byteSize: view.getUint32(localOffset + 12, true),
            name: readNullTerminatedAscii(memory, address + localOffset + 16, 32)
        });
    }

    return {
        magic: view.getUint32(0, true),
        version: view.getUint32(4, true),
        methodToken: view.getUint32(8, true),
        localCount,
        locals
    };
}

export function pollDbiLocals(sidecar) {
    const recordSize = 1552;
    const stack = sidecar.exports.stackSave();
    const recordAddress = sidecar.exports.stackAlloc(recordSize);
    const bytesWrittenAddress = sidecar.exports.stackAlloc(4);
    const pollResult = sidecar.module._coreclr_wasm_dbi_dac_dbi_enumerate_locals(recordAddress, recordSize, bytesWrittenAddress);
    const bytesWritten = new DataView(sidecar.module.HEAPU8.buffer, bytesWrittenAddress, 4).getUint32(0, true);
    const record = pollResult === 0 ? readLocalsRecord(sidecar.module.HEAPU8, recordAddress) : null;
    sidecar.exports.stackRestore(stack);

    return { pollResult, bytesWritten, record };
}

function readValueRecord(memory, address) {
    const view = new DataView(memory.buffer, address, ValueRecordSize);
    return {
        typeTag: view.getUint32(0, true),
        byteSize: view.getUint32(4, true),
        isRef: view.getUint32(8, true),
        flags: view.getUint32(12, true),
        objectAddress: view.getBigUint64(16, true),
        methodTableAddress: view.getBigUint64(24, true),
        inlineBytes: Array.from(memory.subarray(address + 32, address + 96)),
        reserved: view.getBigUint64(96, true)
    };
}

export function readInt32LittleEndian(bytes) {
    return bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24);
}

export function readDbiLocalValue(sidecar, frameAddress, local) {
    const stack = sidecar.exports.stackSave();
    const recordAddress = sidecar.exports.stackAlloc(ValueRecordSize);
    const readResult = sidecar.module._coreclr_wasm_dbi_dac_dbi_read_local_value(
        frameAddress >>> 0,
        0,
        local.byteOffset,
        local.byteSize,
        local.typeTag,
        recordAddress,
        ValueRecordSize);
    const record = readResult === 0 ? readValueRecord(sidecar.module.HEAPU8, recordAddress) : null;
    sidecar.exports.stackRestore(stack);

    return { readResult, local, record };
}

export function readDbiLocalValues(sidecar, frameRecord, localsRecord) {
    if (frameRecord === null || localsRecord === null) {
        return [];
    }

    return localsRecord.locals.map(local => readDbiLocalValue(sidecar, frameRecord.frameAddress, local));
}

export function lookupDbiSourceLocation(sidecar, methodToken, ilOffset) {
    const stack = sidecar.exports.stackSave();
    const fileAddress = sidecar.exports.stackAlloc(SourceLocationFileCapacity);
    const lineAddress = sidecar.exports.stackAlloc(4);
    const columnAddress = sidecar.exports.stackAlloc(4);
    sidecar.module.HEAPU8.fill(0, fileAddress, fileAddress + SourceLocationFileCapacity);
    const lookupResult = sidecar.module._coreclr_wasm_dbi_dac_dbi_lookup_source_location(
        methodToken >>> 0,
        ilOffset >>> 0,
        fileAddress,
        SourceLocationFileCapacity,
        lineAddress,
        columnAddress);
    const file = lookupResult === 0 ? readNullTerminatedAscii(sidecar.module.HEAPU8, fileAddress, SourceLocationFileCapacity) : '';
    const view = new DataView(sidecar.module.HEAPU8.buffer);
    const line = lookupResult === 0 ? view.getUint32(lineAddress, true) : 0;
    const column = lookupResult === 0 ? view.getUint32(columnAddress, true) : 0;
    sidecar.exports.stackRestore(stack);

    return { lookupResult, file, line, column };
}

export function pollDbiProcessState(sidecar) {
    const stack = sidecar.exports.stackSave();
    const stateAddress = sidecar.exports.stackAlloc(40);
    const bytesWrittenAddress = sidecar.exports.stackAlloc(4);
    const pollResult = sidecar.module._coreclr_wasm_dbi_dac_dbi_poll_process_state(stateAddress, 40, bytesWrittenAddress);
    const bytesWritten = new DataView(sidecar.module.HEAPU8.buffer, bytesWrittenAddress, 4).getUint32(0, true);
    const view = new DataView(sidecar.module.HEAPU8.buffer, stateAddress, 40);
    const state = pollResult === 0 ? {
        sessionCreated: view.getUint32(0, true),
        connected: view.getUint32(4, true),
        runtimeBase: view.getUint32(8, true),
        syntheticProcessId: view.getUint32(12, true),
        hasRealCordbProcess: view.getUint32(16, true),
        lastEventKind: view.getUint32(20, true),
        lastMethodToken: view.getUint32(24, true),
        lastILOffset: view.getUint32(28, true),
        breakpointHitCount: view.getUint32(32, true),
        continueCount: view.getUint32(36, true)
    } : null;
    sidecar.exports.stackRestore(stack);

    return { pollResult, bytesWritten, state };
}

function readTestData(memory, address) {
    const view = new DataView(memory.buffer, address, 48);
    return {
        magic: view.getUint32(0, true),
        int32Value: view.getInt32(4, true),
        doubleValue: view.getFloat64(8, true),
        vectorLanes: [
            view.getUint32(16, true),
            view.getUint32(20, true),
            view.getUint32(24, true),
            view.getUint32(28, true)
        ],
        message: readNullTerminatedAscii(memory, address + 32, 16)
    };
}

export function readDbiTestData(sidecar) {
    if (typeof sidecar.module._coreclr_wasm_dbi_dac_dbi_read_test_data !== 'function') {
        return { readResult: -1, testData: null, skipped: true };
    }

    const stack = sidecar.exports.stackSave();
    const testDataAddress = sidecar.exports.stackAlloc(48);
    const readResult = sidecar.module._coreclr_wasm_dbi_dac_dbi_read_test_data(testDataAddress);
    const testData = readResult === 0 ? readTestData(sidecar.module.HEAPU8, testDataAddress) : null;
    sidecar.exports.stackRestore(stack);

    return { readResult, testData, skipped: false };
}

export async function pollDbiEventUntil(sidecar, predicate, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const result = pollDbiEvent(sidecar);
        if (predicate(result)) {
            return result;
        }

        await new Promise(resolve => setTimeout(resolve, 10));
    }

    return { pollResult: -1, event: '', bytesWritten: 0 };
}
