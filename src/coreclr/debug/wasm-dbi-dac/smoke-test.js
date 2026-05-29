// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { performance } = require("perf_hooks");
const { pathToFileURL } = require("url");

const ExpectedAbiVersion = 1;
const ExpectedComponentMask = 0xf;
const ExpectedVersionBlobMagic = 0x42564457;
const ExpectedVersionBlobSize = 32;
const ExpectedProtocolBreakingChangeCounter = 1;
const HrIncompatibleProtocol = 0x8013134b | 0;
const ContractDescriptorMagic = 0x0043414443434e44n;
const TestDataMagic = 0x43445744;
const E_NOTIMPL = -2147467263;
const TransportMessage = "dbi-command:set-breakpoint";

// Sidecar synthetic CorDebugPlatform sentinel; must match
// WasmSidecarSyntheticPlatform in dbi_dac_wasm.cpp. The public
// CorDebugPlatform enum has no value for WebAssembly, so the sidecar
// reports this value from ICorDebugDataTarget::GetPlatform.
const WasmSidecarSyntheticPlatform = 0x77415331 | 0;

function fail(message) {
    throw new Error(message);
}

function resolvePath(filePath) {
    return path.resolve(process.cwd(), filePath);
}

function requireFile(filePath, description) {
    if (!fs.existsSync(filePath)) {
        fail(`${description} not found: ${filePath}`);
    }
}

async function loadRuntime(runtimeJsPath) {
    const runtimeDirectory = path.dirname(runtimeJsPath);
    let source = fs.readFileSync(runtimeJsPath, "utf8");

    source = source.replaceAll("import.meta.url", JSON.stringify(pathToFileURL(runtimeJsPath).href));
    source = source.replace(/if \(_isNode\) \{\s*selfRun\(\);\s*\}\s*$/m, "");

    let instance;
    const moduleFactory = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
    const moduleConfig = {
        noInitialRun: true,
        locateFile: fileName => path.join(runtimeDirectory, fileName),
        print() {},
        printErr() {},
        instantiateWasm(imports, receiveInstance) {
            const wasmPath = path.join(runtimeDirectory, `${path.basename(runtimeJsPath, ".js")}.wasm`);
            WebAssembly.instantiate(fs.readFileSync(wasmPath), imports).then(({ instance: wasmInstance, module }) => {
                instance = wasmInstance;
                receiveInstance(wasmInstance, module);
            }).catch(error => {
                throw error;
            });

            return {};
        }
    };

    moduleFactory.selfRun(moduleConfig);

    return {
        module: await moduleConfig.ready,
        exports: instance.exports
    };
}

function loadDebugger(debuggerJsPath, configureImports) {
    const debuggerDirectory = path.dirname(debuggerJsPath);
    const source = fs.readFileSync(debuggerJsPath, "utf8");
    let instance;
    let context;

    return new Promise((resolve, reject) => {
        const moduleConfig = {
            noInitialRun: true,
            locateFile: fileName => path.join(debuggerDirectory, fileName),
            print() {},
            printErr() {},
            onAbort: reason => reject(new Error(String(reason))),
            onRuntimeInitialized: () => resolve({
                module: context.Module,
                exports: instance.exports
            })
        };

        context = {
            Module: moduleConfig,
            require,
            process,
            console,
            WebAssembly,
            __dirname: debuggerDirectory,
            __filename: debuggerJsPath,
            setTimeout,
            clearTimeout,
            TextDecoder,
            TextEncoder,
            URL,
            fetch,
            performance
        };

        moduleConfig.instantiateWasm = (imports, receiveInstance) => {
            configureImports(imports);
            const wasmPath = path.join(debuggerDirectory, `${path.basename(debuggerJsPath, ".js")}.wasm`);
            WebAssembly.instantiate(fs.readFileSync(wasmPath), imports).then(({ instance: wasmInstance, module }) => {
                instance = wasmInstance;
                receiveInstance(wasmInstance, module);
            }).catch(reject);

            return {};
        };

        try {
            vm.runInNewContext(source, context, { filename: debuggerJsPath });
        } catch (error) {
            reject(error);
        }
    });
}

function writeUint64(memory, address, value) {
    new DataView(memory.buffer).setBigUint64(address, BigInt(value), true);
}

function writeAscii(memory, address, value) {
    for (let index = 0; index < value.length; index++) {
        memory[address + index] = value.charCodeAt(index);
    }
}

function writeBytes(memory, address, bytes) {
    memory.set(bytes, address);
}

function readAscii(memory, address, byteCount) {
    let result = "";
    for (let index = 0; index < byteCount; index++) {
        result += String.fromCharCode(memory[address + index]);
    }

    return result;
}

function readDescriptor(memory, address) {
    const view = new DataView(memory.buffer, address, 32);
    return {
        magic: view.getBigUint64(0, true),
        flags: view.getUint32(8, true),
        descriptorSize: view.getUint32(12, true),
        descriptorAddress: view.getUint32(16, true),
        pointerDataCount: view.getUint32(20, true),
        pointerDataAddress: view.getUint32(28, true)
    };
}

function readNullTerminatedAscii(memory, address, byteCount) {
    let result = "";
    for (let index = 0; index < byteCount && memory[address + index] !== 0; index++) {
        result += String.fromCharCode(memory[address + index]);
    }

    return result;
}

function readPageCacheStats(memory, address) {
    const view = new DataView(memory.buffer, address, 24);
    return {
        epoch: view.getUint32(0, true),
        hits: view.getUint32(4, true),
        misses: view.getUint32(8, true),
        bypasses: view.getUint32(12, true),
        invalidations: view.getUint32(16, true)
    };
}

async function main() {
    const coreclrObjDirectory = resolvePath(process.argv[2] ?? "artifacts/obj/coreclr/browser.wasm.Debug");
    const runtimeJsPath = resolvePath(process.argv[3] ?? path.join(coreclrObjDirectory, "hosts/corerun/corerun.js"));
    const debuggerJsPath = resolvePath(process.argv[4] ?? path.join(coreclrObjDirectory, "debug/wasm-dbi-dac/coreclr-dbi-dac-tests.js"));

    requireFile(runtimeJsPath, "runtime JS wrapper");
    requireFile(`${runtimeJsPath.slice(0, -3)}.wasm`, "runtime WASM module");
    requireFile(debuggerJsPath, "debugger JS wrapper");
    requireFile(`${debuggerJsPath.slice(0, -3)}.wasm`, "debugger WASM module");

    const runtime = await loadRuntime(runtimeJsPath);
    const runtimeExports = runtime.exports;

    if (typeof runtimeExports.memory === "undefined" || typeof runtimeExports.memory.buffer === "undefined") {
        fail("runtime export 'memory' is missing or does not expose a buffer");
    }

    if (typeof runtimeExports.GetDotNetRuntimeContractDescriptor !== "function") {
        fail("runtime export GetDotNetRuntimeContractDescriptor is missing");
    }

    if (typeof runtimeExports.Getg_dacTable !== "function") {
        fail("runtime export Getg_dacTable is missing");
    }

    if (typeof runtimeExports.GetWasmDbiDacTestData !== "function") {
        fail("runtime export GetWasmDbiDacTestData is missing");
    }

    if (typeof runtimeExports.CoreClrWasmDebugReceiveCommand !== "function" ||
        typeof runtimeExports.CoreClrWasmDebugGetLastCommandLength !== "function" ||
        typeof runtimeExports.CoreClrWasmDebugCopyLastCommand !== "function") {
        fail("runtime debug bridge exports are missing");
    }

    let debuggerModule;
    let debuggerExports;
    const hostImports = {};

    // Re-fetch typed-array views on every host callback. WebAssembly.Memory
    // can grow at any time (stack expansion, heap allocation, etc.); after
    // growth, any cached Uint8Array becomes detached and access throws
    // "memory access out of bounds". Reading `.buffer` from a live wasm
    // `memory` export always returns the current backing ArrayBuffer.
    //
    // The helpers reference late-bound `let`s by name. If a host import
    // somehow fires before the runtime/debugger module finishes binding
    // (e.g., a future change that invokes an import from WASM init), the
    // descriptive throw is friendlier than a raw "cannot read .memory of
    // undefined". Our sidecar does not call any imports during module init
    // today, so these checks are a forward-compatibility guard.
    const getRuntimeHeap = () => {
        if (typeof runtimeExports === "undefined" || !runtimeExports.memory) {
            fail("getRuntimeHeap called before runtimeExports.memory was bound");
        }
        return new Uint8Array(runtimeExports.memory.buffer);
    };
    const getDebuggerHeap = () => {
        if (typeof debuggerExports === "undefined" || !debuggerExports.memory) {
            fail("getDebuggerHeap called before debuggerExports.memory was bound");
        }
        return new Uint8Array(debuggerExports.memory.buffer);
    };

    hostImports.read_target_memory = (targetAddressArg, debuggerAddressArg, byteCountArg) => {
        const targetAddress = targetAddressArg >>> 0;
        const debuggerAddress = debuggerAddressArg >>> 0;
        const byteCount = byteCountArg >>> 0;

        const runtimeHeap = getRuntimeHeap();
        const debuggerHeap = getDebuggerHeap();
        if (targetAddress + byteCount > runtimeHeap.length ||
            debuggerAddress + byteCount > debuggerHeap.length) {
            return -1;
        }

        debuggerHeap.set(runtimeHeap.subarray(targetAddress, targetAddress + byteCount), debuggerAddress);
        return 0;
    };

    hostImports.get_symbol_address = (baseAddressArg, symbolNameAddressArg, symbolNameLengthArg, addressOutAddressArg) => {
        const symbolNameAddress = symbolNameAddressArg >>> 0;
        const symbolNameLength = symbolNameLengthArg >>> 0;
        const addressOutAddress = addressOutAddressArg >>> 0;
        const debuggerHeap = getDebuggerHeap();
        if (symbolNameAddress + symbolNameLength > debuggerHeap.length ||
            addressOutAddress + 8 > debuggerHeap.length) {
            return -1;
        }

        const symbolName = new TextDecoder().decode(debuggerHeap.subarray(symbolNameAddress, symbolNameAddress + symbolNameLength));
        const symbolAddress =
            symbolName === "DotNetRuntimeContractDescriptor" ? runtimeExports.GetDotNetRuntimeContractDescriptor() >>> 0 :
            symbolName === "g_dacTable" ? runtimeExports.Getg_dacTable() >>> 0 :
            symbolName === "WasmDbiDacTestData" ? runtimeExports.GetWasmDbiDacTestData() >>> 0 :
            0;

        if (symbolAddress === 0) {
            return -1;
        }

        writeUint64(debuggerHeap, addressOutAddress, symbolAddress >>> 0);
        return 0;
    };

    hostImports.get_target_module_base = (imageNameAddressArg, imageNameCharCountArg, addressOutAddressArg) => {
        const addressOutAddress = addressOutAddressArg >>> 0;
        const debuggerHeap = getDebuggerHeap();
        if (addressOutAddress + 8 > debuggerHeap.length) {
            return -1;
        }

        writeUint64(debuggerHeap, addressOutAddress, 1);
        return 0;
    };
    hostImports.send_ipc_to_runtime = (messageAddressArg, messageLengthArg) => {
        const messageAddress = messageAddressArg >>> 0;
        const messageLength = messageLengthArg >>> 0;
        const debuggerHeapForRead = getDebuggerHeap();
        if (messageAddress + messageLength > debuggerHeapForRead.length) {
            return -1;
        }

        const savedRuntimeStack = runtime.exports.stackSave();
        const runtimeMessageAddress = runtime.exports.stackAlloc(messageLength);
        // Re-fetch both heaps after the stackAlloc above: it can grow the
        // runtime's linear memory and detach any prior view.
        getRuntimeHeap().set(getDebuggerHeap().subarray(messageAddress, messageAddress + messageLength), runtimeMessageAddress);
        const receiveResult = runtimeExports.CoreClrWasmDebugReceiveCommand(runtimeMessageAddress, messageLength);
        runtime.exports.stackRestore(savedRuntimeStack);
        if (receiveResult !== 0) {
            return receiveResult;
        }

        const runtimeCommandLength = runtimeExports.CoreClrWasmDebugGetLastCommandLength();
        const savedCopyStack = runtime.exports.stackSave();
        const runtimeCopyAddress = runtime.exports.stackAlloc(runtimeCommandLength);
        const copyResult = runtimeExports.CoreClrWasmDebugCopyLastCommand(runtimeCopyAddress, runtimeCommandLength);
        const message = copyResult === 0 ? readAscii(getRuntimeHeap(), runtimeCopyAddress, runtimeCommandLength) : "";
        runtime.exports.stackRestore(savedCopyStack);
        if (copyResult !== 0) {
            return copyResult;
        }

        const event = new TextEncoder().encode(`runtime-event:${message}`);
        const savedStack = debuggerExports.stackSave();
        const eventAddress = debuggerExports.stackAlloc(event.length);
        writeBytes(getDebuggerHeap(), eventAddress, event);
        const result = debuggerModule._coreclr_wasm_dbi_dac_receive_runtime_event(eventAddress, event.length);
        debuggerExports.stackRestore(savedStack);
        return result;
    };

    const debuggerInstance = await loadDebugger(debuggerJsPath, imports => {
        Object.assign(imports.env, hostImports);
        imports.coreclr_dbi_dac = hostImports;
    });

    debuggerModule = debuggerInstance.module;
    debuggerExports = debuggerInstance.exports;

    if (typeof debuggerExports.memory === "undefined" || typeof debuggerExports.memory.buffer === "undefined") {
        fail("debugger export 'memory' is missing or does not expose a buffer");
    }

    if (getRuntimeHeap().buffer === getDebuggerHeap().buffer) {
        fail("runtime and debugger modules unexpectedly share the same WebAssembly memory");
    }

    const abiVersion = debuggerModule._coreclr_wasm_dbi_dac_get_abi_version();
    const componentMask = debuggerModule._coreclr_wasm_dbi_dac_get_component_mask();
    const cordbFirstResult = debuggerModule._coreclr_wasm_dbi_dac_create_cordb_object();

    const stack = debuggerExports.stackSave();
    const descriptorAddress = debuggerExports.stackAlloc(32);
    const pointerDataAddress = debuggerExports.stackAlloc(8);
    const testDataAddress = debuggerExports.stackAlloc(48);
    const controlProbeAddress = debuggerExports.stackAlloc(16);
    const copyAddress = debuggerExports.stackAlloc(8);
    const sessionEventAddress = debuggerExports.stackAlloc(64);
    const sessionEventBytesWrittenAddress = debuggerExports.stackAlloc(4);
    const versionBlobAddress = debuggerExports.stackAlloc(ExpectedVersionBlobSize);
    const platformAddress = debuggerExports.stackAlloc(4);
    const versionBlobBytesWrittenAddress = debuggerExports.stackAlloc(4);
    const transportMessageBytes = new TextEncoder().encode(TransportMessage);
    const transportMessageAddress = debuggerExports.stackAlloc(transportMessageBytes.length);
    const symbolName = "DotNetRuntimeContractDescriptor";
    const symbolNameAddress = debuggerExports.stackAlloc(symbolName.length);
    const symbolOutAddress = debuggerExports.stackAlloc(8);
    const pageCacheStatsAddress = debuggerExports.stackAlloc(24);
    const pageCacheStatsAfterAddress = debuggerExports.stackAlloc(24);
    const pageCacheStatsPostInvalidateAddress = debuggerExports.stackAlloc(24);

    writeAscii(debuggerModule.HEAPU8, symbolNameAddress, symbolName);
    writeBytes(debuggerModule.HEAPU8, transportMessageAddress, transportMessageBytes);

    const versionBlobResult = debuggerModule._coreclr_wasm_dbi_dac_get_version_blob(versionBlobAddress, ExpectedVersionBlobSize, versionBlobBytesWrittenAddress);
    const versionBlobBytesWritten = new DataView(debuggerModule.HEAPU8.buffer, versionBlobBytesWrittenAddress, 4).getUint32(0, true);
    const versionBlobView = new DataView(debuggerModule.HEAPU8.buffer, versionBlobAddress, ExpectedVersionBlobSize);
    const versionBlob = {
        magic: versionBlobView.getUint32(0, true),
        blobSize: versionBlobView.getUint32(4, true),
        abiVersion: versionBlobView.getUint32(8, true),
        protocolBreakingChangeCounter: versionBlobView.getUint32(12, true),
        componentMask: versionBlobView.getUint32(16, true),
        sidecarBuildVersionMS: versionBlobView.getUint32(20, true),
        sidecarBuildVersionLS: versionBlobView.getUint32(24, true),
        reserved: versionBlobView.getUint32(28, true)
    };

    const checkProtocolMatchResult = debuggerModule._coreclr_wasm_dbi_dac_check_protocol(
        ExpectedVersionBlobMagic, ExpectedAbiVersion, ExpectedProtocolBreakingChangeCounter);
    const checkProtocolBadMagicResult = debuggerModule._coreclr_wasm_dbi_dac_check_protocol(
        ExpectedVersionBlobMagic ^ 1, ExpectedAbiVersion, ExpectedProtocolBreakingChangeCounter) | 0;
    const checkProtocolBadAbiResult = debuggerModule._coreclr_wasm_dbi_dac_check_protocol(
        ExpectedVersionBlobMagic, ExpectedAbiVersion + 1, ExpectedProtocolBreakingChangeCounter) | 0;
    const checkProtocolBadCounterResult = debuggerModule._coreclr_wasm_dbi_dac_check_protocol(
        ExpectedVersionBlobMagic, ExpectedAbiVersion, ExpectedProtocolBreakingChangeCounter + 1) | 0;

    // Negative-path coverage: gated entry points must refuse work
    // until acknowledge_protocol succeeds. session_destroy is intentionally
    // ungated so a host that lost handshake state can still tear down,
    // so it must succeed even before any acknowledge.
    const sessionDestroyBeforeAckResult = debuggerModule._coreclr_wasm_dbi_dac_dbi_session_destroy() | 0;
    const sessionCreateBeforeAckResult = debuggerModule._coreclr_wasm_dbi_dac_dbi_session_create() | 0;
    const ackBadMagicResult = debuggerModule._coreclr_wasm_dbi_dac_acknowledge_protocol(
        ExpectedVersionBlobMagic ^ 1, ExpectedAbiVersion, ExpectedProtocolBreakingChangeCounter) | 0;
    const sessionCreateAfterBadAckResult = debuggerModule._coreclr_wasm_dbi_dac_dbi_session_create() | 0;
    const ackBadAbiResult = debuggerModule._coreclr_wasm_dbi_dac_acknowledge_protocol(
        ExpectedVersionBlobMagic, ExpectedAbiVersion + 1, ExpectedProtocolBreakingChangeCounter) | 0;
    const ackBadCounterResult = debuggerModule._coreclr_wasm_dbi_dac_acknowledge_protocol(
        ExpectedVersionBlobMagic, ExpectedAbiVersion, ExpectedProtocolBreakingChangeCounter + 1) | 0;

    // Acknowledge the protocol so all subsequent gated entry points
    // can proceed. acknowledge_protocol is idempotent on a correct triple.
    const ackResult = debuggerModule._coreclr_wasm_dbi_dac_acknowledge_protocol(
        ExpectedVersionBlobMagic, ExpectedAbiVersion, ExpectedProtocolBreakingChangeCounter);
    const ackAgainResult = debuggerModule._coreclr_wasm_dbi_dac_acknowledge_protocol(
        ExpectedVersionBlobMagic, ExpectedAbiVersion, ExpectedProtocolBreakingChangeCounter);

    const descriptorResult = debuggerModule._coreclr_wasm_dbi_dac_probe_runtime_contract_descriptor(1, descriptorAddress);
    const pointerDataResult = debuggerModule._coreclr_wasm_dbi_dac_probe_contract_pointer_data(1, 2, pointerDataAddress);
    const testDataResult = debuggerModule._coreclr_wasm_dbi_dac_probe_test_data(1, testDataAddress);
    const platformResult = debuggerModule._coreclr_wasm_dbi_dac_probe_get_platform(1, platformAddress) | 0;
    const platformValue = new DataView(debuggerModule.HEAPU8.buffer, platformAddress, 4).getInt32(0, true);
    const platformNullOutResult = debuggerModule._coreclr_wasm_dbi_dac_probe_get_platform(1, 0) | 0;
    const breakpointControlResult = debuggerModule._coreclr_wasm_dbi_dac_probe_breakpoint_control(controlProbeAddress);
    const symbolResult = debuggerModule._coreclr_wasm_dbi_dac_try_get_symbol(symbolNameAddress, symbolName.length, symbolOutAddress);

    // Symbol-name robustness coverage: confirm coreclr_wasm_dbi_dac_try_get_symbol
    // rejects malformed symbol-name buffers before forwarding them to
    // the host callback. All five cases should fail-fast inside the
    // sidecar without ever touching JS.
    const InvalidSymbolName = -9;
    const symbolEmptyResult = debuggerModule._coreclr_wasm_dbi_dac_try_get_symbol(symbolNameAddress, 0, symbolOutAddress) | 0;
    const symbolNullAddressResult = debuggerModule._coreclr_wasm_dbi_dac_try_get_symbol(0, symbolName.length, symbolOutAddress) | 0;
    const symbolTooLongResult = debuggerModule._coreclr_wasm_dbi_dac_try_get_symbol(symbolNameAddress, 0x1000 >>> 0, symbolOutAddress) | 0;
    const symbolAddressOverflowResult = debuggerModule._coreclr_wasm_dbi_dac_try_get_symbol(0xffffff00 >>> 0, 0x200 >>> 0, symbolOutAddress) | 0;
    const symbolNullOutResult = debuggerModule._coreclr_wasm_dbi_dac_try_get_symbol(symbolNameAddress, symbolName.length, 0) | 0;

    // Page-cache coverage: the three probes above all went through
    // dataTarget.ReadVirtual, which routes through the in-sidecar 4 KiB
    // page cache. The descriptor + pointer-data + test-data flow re-
    // reads the descriptor region multiple times across overlapping
    // single-page reads, so by this point we expect at least one cache
    // hit (the second + third descriptor read) and at least one miss
    // (the cold descriptor + cold WasmDbiDacTestData fetch). Bypasses
    // should still be 0 because every probe read fits in a single page.
    const pageCacheStatsResult = debuggerModule._coreclr_wasm_dbi_dac_get_page_cache_stats(pageCacheStatsAddress) | 0;
    const pageCacheStatsBefore = readPageCacheStats(debuggerModule.HEAPU8, pageCacheStatsAddress);

    // Invalidate via the product export. The next stats read must show
    // epoch and invalidations both incremented by exactly one; hits and
    // misses are cumulative so they should be unchanged.
    const pageCacheInvalidateResult = debuggerModule._coreclr_wasm_dbi_dac_invalidate_page_cache() | 0;
    const pageCacheStatsAfterInvalidateResult = debuggerModule._coreclr_wasm_dbi_dac_get_page_cache_stats(pageCacheStatsAfterAddress) | 0;
    const pageCacheStatsAfterInvalidate = readPageCacheStats(debuggerModule.HEAPU8, pageCacheStatsAfterAddress);

    // Re-issue a probe that uses the cached path. Because we just
    // invalidated, the next descriptor fetch must be a miss (or
    // bypass), not a hit; the hit counter must remain at the
    // post-invalidate baseline. This proves epoch invalidation
    // actually drops the cached page rather than serving stale data.
    const reprobeResult = debuggerModule._coreclr_wasm_dbi_dac_probe_runtime_contract_descriptor(1, descriptorAddress) | 0;
    const pageCacheStatsAfterReprobeResult = debuggerModule._coreclr_wasm_dbi_dac_get_page_cache_stats(pageCacheStatsPostInvalidateAddress) | 0;
    const pageCacheStatsAfterReprobe = readPageCacheStats(debuggerModule.HEAPU8, pageCacheStatsPostInvalidateAddress);

    const runtimeDescriptorAddress = runtimeExports.GetDotNetRuntimeContractDescriptor() >>> 0;
    const copyResult = debuggerModule._coreclr_wasm_dbi_dac_copy_from_target(runtimeDescriptorAddress, copyAddress, 8);

    // Memory-read robustness coverage: confirm the hardened
    // copy_from_target rejects malformed reads before forwarding them
    // to the host callback. All four cases should fail-fast inside the
    // sidecar without ever touching JS.
    const InvalidArgument = -1;
    const InvalidReadRange = -8;
    const copyZeroBytesResult = debuggerModule._coreclr_wasm_dbi_dac_copy_from_target(0, 0, 0) | 0;
    const copyNullDebuggerDestResult = debuggerModule._coreclr_wasm_dbi_dac_copy_from_target(runtimeDescriptorAddress, 0, 8) | 0;
    const copyTargetOverflowResult = debuggerModule._coreclr_wasm_dbi_dac_copy_from_target(0xffffff00 >>> 0, copyAddress, 0x200) | 0;
    const copyDebuggerOverflowResult = debuggerModule._coreclr_wasm_dbi_dac_copy_from_target(runtimeDescriptorAddress, 0xffffff00 >>> 0, 0x200) | 0;
    const copyOversizedResult = debuggerModule._coreclr_wasm_dbi_dac_copy_from_target(0, copyAddress, 0x20000000 >>> 0) | 0;

    const sessionCreateResult = debuggerModule._coreclr_wasm_dbi_dac_dbi_session_create();
    const sessionCreateProcessResult = debuggerModule._coreclr_wasm_dbi_dac_dbi_session_create_process();
    const sessionConnectResult = debuggerModule._coreclr_wasm_dbi_dac_dbi_connect_runtime(1);
    const transportSendResult = debuggerModule._coreclr_wasm_dbi_dac_transport_send_test_message(transportMessageAddress, transportMessageBytes.length);
    const transportGetResult = debuggerModule._coreclr_wasm_dbi_dac_transport_get_last_event(sessionEventAddress, 64, sessionEventBytesWrittenAddress);
    const sessionDisconnectResult = debuggerModule._coreclr_wasm_dbi_dac_dbi_disconnect_runtime();
    const sessionDestroyResult = debuggerModule._coreclr_wasm_dbi_dac_dbi_session_destroy();

    const descriptor = readDescriptor(debuggerModule.HEAPU8, descriptorAddress);
    const pointerDataView = new DataView(debuggerModule.HEAPU8.buffer, pointerDataAddress, 8);
    const symbolAddress = Number(new DataView(debuggerModule.HEAPU8.buffer, symbolOutAddress, 8).getBigUint64(0, true));
    const copiedMagic = new DataView(debuggerModule.HEAPU8.buffer, copyAddress, 8).getBigUint64(0, true);
    const threadStoreGlobalSlot = pointerDataView.getUint32(0, true);
    const threadStoreValue = pointerDataView.getUint32(4, true);
    const testDataView = new DataView(debuggerModule.HEAPU8.buffer, testDataAddress, 48);
    const testData = {
        magic: testDataView.getUint32(0, true),
        int32Value: testDataView.getInt32(4, true),
        doubleValue: testDataView.getFloat64(8, true),
        vectorLanes: [
            testDataView.getUint32(16, true),
            testDataView.getUint32(20, true),
            testDataView.getUint32(24, true),
            testDataView.getUint32(28, true)
        ],
        message: readNullTerminatedAscii(debuggerModule.HEAPU8, testDataAddress + 32, 16)
    };
    const controlProbeView = new DataView(debuggerModule.HEAPU8.buffer, controlProbeAddress, 16);
    const controlProbe = {
        createCordbResult: controlProbeView.getInt32(0, true),
        initializeResult: controlProbeView.getInt32(4, true),
        createProcessResult: controlProbeView.getInt32(8, true),
        breakpointResult: controlProbeView.getInt32(12, true)
    };
    const sessionEventBytesWritten = new DataView(debuggerModule.HEAPU8.buffer, sessionEventBytesWrittenAddress, 4).getUint32(0, true);
    const sessionEvent = readAscii(debuggerModule.HEAPU8, sessionEventAddress, sessionEventBytesWritten);

    debuggerExports.stackRestore(stack);

    const clrDataResult = debuggerModule._coreclr_wasm_dbi_dac_create_clr_data_instance(1);
    const dacDbiResult = debuggerModule._coreclr_wasm_dbi_dac_create_dac_dbi_interface(1);
    const cordbSecondResult = debuggerModule._coreclr_wasm_dbi_dac_create_cordb_object();

    // Phase 3 onramp probe: confirm IDacDbiInterface::DacSetTargetConsistencyChecks
    // is reachable from the in-sidecar DAC. The desktop V3 attach
    // (CordbProcess::CreateDacDbiInterface) calls this immediately after binding
    // the DAC, so if it ever drops out of our build a future real-CordbProcess
    // slice would regress silently. Calling against runtimeBase=1 mirrors the
    // existing dacDbiResult probe: creation succeeds without touching target
    // memory, and DacSetTargetConsistencyChecks just toggles a flag on the
    // ClrDataAccess base, so both should return S_OK.
    const dacConsistencyStack = debuggerExports.stackSave();
    const dacConsistencyHrAddress = debuggerExports.stackAlloc(4);
    const dacConsistencyProbeResult = debuggerModule._coreclr_wasm_dbi_dac_probe_dac_consistency_checks(1, dacConsistencyHrAddress);
    const dacConsistencyHr = new DataView(debuggerModule.HEAPU8.buffer, dacConsistencyHrAddress, 4).getInt32(0, true);
    debuggerExports.stackRestore(dacConsistencyStack);

    // Memory-growth resilience: deliberately grow both wasm linear memories
    // and re-issue a positive copy_from_target. Growth invalidates every
    // previously-captured Uint8Array view; if the host bridge cached a
    // stale view we would either get -1 from the bounds check or throw
    // "memory access out of bounds" inside the host callback. With
    // per-call buffer refetching, the second copy must succeed and the
    // re-read descriptor magic must equal the pre-growth value.
    // Run this AFTER every other read from debugger memory, because the
    // smoke body itself caches DataView buffer references that would also
    // become detached. The host bridge's per-call refetch keeps the next
    // copy_from_target working even though the smoke body cannot.
    const postGrowthStack = debuggerExports.stackSave();
    const postGrowthCopyAddress = debuggerExports.stackAlloc(8);
    const runtimePagesBefore = runtimeExports.memory.buffer.byteLength / 0x10000;
    const debuggerPagesBefore = debuggerExports.memory.buffer.byteLength / 0x10000;
    const runtimeGrowResult = runtimeExports.memory.grow(1);
    const debuggerGrowResult = debuggerExports.memory.grow(1);
    const runtimePagesAfter = runtimeExports.memory.buffer.byteLength / 0x10000;
    const debuggerPagesAfter = debuggerExports.memory.buffer.byteLength / 0x10000;
    const postGrowthCopyResult = debuggerModule._coreclr_wasm_dbi_dac_copy_from_target(runtimeDescriptorAddress, postGrowthCopyAddress, 8) | 0;
    const postGrowthCopiedMagic = new DataView(getDebuggerHeap().buffer, postGrowthCopyAddress, 8).getBigUint64(0, true);
    debuggerExports.stackRestore(postGrowthStack);

    const result = {
        abiVersion,
        componentMask,
        separateMemories: true,
        cordbFirstResult,
        versionBlobResult,
        versionBlobBytesWritten,
        versionBlob: {
            magic: `0x${versionBlob.magic.toString(16)}`,
            blobSize: versionBlob.blobSize,
            abiVersion: versionBlob.abiVersion,
            protocolBreakingChangeCounter: versionBlob.protocolBreakingChangeCounter,
            componentMask: `0x${versionBlob.componentMask.toString(16)}`,
            sidecarBuildVersionMS: versionBlob.sidecarBuildVersionMS,
            sidecarBuildVersionLS: versionBlob.sidecarBuildVersionLS,
            reserved: versionBlob.reserved
        },
        checkProtocol: {
            match: checkProtocolMatchResult,
            badMagic: `0x${(checkProtocolBadMagicResult >>> 0).toString(16)}`,
            badAbi: `0x${(checkProtocolBadAbiResult >>> 0).toString(16)}`,
            badCounter: `0x${(checkProtocolBadCounterResult >>> 0).toString(16)}`
        },
        handshake: {
            sessionDestroyBeforeAck: `0x${(sessionDestroyBeforeAckResult >>> 0).toString(16)}`,
            sessionCreateBeforeAck: `0x${(sessionCreateBeforeAckResult >>> 0).toString(16)}`,
            ackBadMagic: `0x${(ackBadMagicResult >>> 0).toString(16)}`,
            sessionCreateAfterBadAck: `0x${(sessionCreateAfterBadAckResult >>> 0).toString(16)}`,
            ackBadAbi: `0x${(ackBadAbiResult >>> 0).toString(16)}`,
            ackBadCounter: `0x${(ackBadCounterResult >>> 0).toString(16)}`,
            ack: ackResult,
            ackAgain: ackAgainResult
        },
        descriptorResult,
        magic: `0x${descriptor.magic.toString(16)}`,
        flags: descriptor.flags,
        descriptorSize: descriptor.descriptorSize,
        descriptorAddress: `0x${descriptor.descriptorAddress.toString(16)}`,
        pointerDataCount: descriptor.pointerDataCount,
        pointerDataAddress: `0x${descriptor.pointerDataAddress.toString(16)}`,
        pointerDataResult,
        threadStoreGlobalSlot: `0x${threadStoreGlobalSlot.toString(16)}`,
        threadStoreValue: `0x${threadStoreValue.toString(16)}`,
        testDataResult,
        testData: {
            magic: `0x${testData.magic.toString(16)}`,
            int32Value: testData.int32Value,
            doubleValue: testData.doubleValue,
            vectorLanes: testData.vectorLanes.map(value => `0x${value.toString(16)}`),
            message: testData.message
        },
        breakpointControlResult,
        breakpointControl: controlProbe,
        platform: {
            result: platformResult,
            value: `0x${(platformValue >>> 0).toString(16)}`,
            matchesSyntheticSentinel: platformValue === WasmSidecarSyntheticPlatform,
            nullOutResult: platformNullOutResult
        },
        session: {
            createResult: sessionCreateResult,
            createProcessResult: sessionCreateProcessResult,
            connectResult: sessionConnectResult,
            transportSendResult,
            transportGetResult,
            event: sessionEvent,
            disconnectResult: sessionDisconnectResult,
            destroyResult: sessionDestroyResult
        },
        symbolResult,
        symbolAddress: `0x${symbolAddress.toString(16)}`,
        symbolRobustness: {
            empty: symbolEmptyResult,
            nullAddress: symbolNullAddressResult,
            tooLong: symbolTooLongResult,
            addressOverflow: symbolAddressOverflowResult,
            nullOut: symbolNullOutResult
        },
        copyResult,
        copyRobustness: {
            zeroBytes: copyZeroBytesResult,
            nullDebuggerDest: copyNullDebuggerDestResult,
            targetOverflow: copyTargetOverflowResult,
            debuggerOverflow: copyDebuggerOverflowResult,
            oversized: copyOversizedResult
        },
        pageCache: {
            getStatsResult: pageCacheStatsResult,
            invalidateResult: pageCacheInvalidateResult,
            statsAfterInvalidateResult: pageCacheStatsAfterInvalidateResult,
            statsAfterReprobeResult: pageCacheStatsAfterReprobeResult,
            reprobeResult,
            before: pageCacheStatsBefore,
            afterInvalidate: pageCacheStatsAfterInvalidate,
            afterReprobe: pageCacheStatsAfterReprobe
        },
        memoryGrowth: {
            runtimeGrowResult,
            debuggerGrowResult,
            runtimePagesBefore,
            runtimePagesAfter,
            debuggerPagesBefore,
            debuggerPagesAfter,
            postGrowthCopyResult,
            postGrowthCopiedMagic: `0x${postGrowthCopiedMagic.toString(16)}`
        },
        copiedMagic: `0x${copiedMagic.toString(16)}`,
        gDacTable: `0x${(runtimeExports.Getg_dacTable() >>> 0).toString(16)}`,
        clrDataResult,
        dacDbiResult,
        cordbSecondResult,
        dacConsistencyProbeResult,
        dacConsistencyHr: `0x${(dacConsistencyHr >>> 0).toString(16)}`
    };

    console.log(JSON.stringify(result, null, 2));

    if (abiVersion !== ExpectedAbiVersion ||
        componentMask !== ExpectedComponentMask ||
        cordbFirstResult !== 0 ||
        versionBlobResult !== 0 ||
        versionBlobBytesWritten !== ExpectedVersionBlobSize ||
        versionBlob.magic !== ExpectedVersionBlobMagic ||
        versionBlob.blobSize !== ExpectedVersionBlobSize ||
        versionBlob.abiVersion !== ExpectedAbiVersion ||
        versionBlob.protocolBreakingChangeCounter !== ExpectedProtocolBreakingChangeCounter ||
        versionBlob.componentMask !== ExpectedComponentMask ||
        versionBlob.sidecarBuildVersionMS !== 0 ||
        versionBlob.sidecarBuildVersionLS !== 0 ||
        versionBlob.reserved !== 0 ||
        checkProtocolMatchResult !== 0 ||
        checkProtocolBadMagicResult !== HrIncompatibleProtocol ||
        checkProtocolBadAbiResult !== HrIncompatibleProtocol ||
        checkProtocolBadCounterResult !== HrIncompatibleProtocol ||
        sessionCreateBeforeAckResult !== HrIncompatibleProtocol ||
        sessionDestroyBeforeAckResult !== 0 ||
        ackBadMagicResult !== HrIncompatibleProtocol ||
        sessionCreateAfterBadAckResult !== HrIncompatibleProtocol ||
        ackBadAbiResult !== HrIncompatibleProtocol ||
        ackBadCounterResult !== HrIncompatibleProtocol ||
        ackResult !== 0 ||
        ackAgainResult !== 0 ||
        descriptorResult !== 0 ||
        descriptor.magic !== ContractDescriptorMagic ||
        descriptor.descriptorSize === 0 ||
        descriptor.descriptorAddress === 0 ||
        descriptor.pointerDataCount === 0 ||
        descriptor.pointerDataAddress === 0 ||
        pointerDataResult !== 0 ||
        threadStoreGlobalSlot === 0 ||
        testDataResult !== 0 ||
        testData.magic !== TestDataMagic ||
        testData.int32Value !== 123456789 ||
        testData.doubleValue !== 1234.5 ||
        testData.vectorLanes[0] !== 0x01234567 ||
        testData.vectorLanes[1] !== 0x89abcdef ||
        testData.vectorLanes[2] !== 0xfedcba98 ||
        testData.vectorLanes[3] !== 0x76543210 ||
        testData.message !== "wasm-dbi-dac" ||
        breakpointControlResult !== 0 ||
        controlProbe.createCordbResult !== 0 ||
        controlProbe.initializeResult !== 0 ||
        controlProbe.createProcessResult !== E_NOTIMPL ||
        controlProbe.breakpointResult !== E_NOTIMPL ||
        platformResult !== 0 ||
        platformValue !== WasmSidecarSyntheticPlatform ||
        platformNullOutResult !== -1 ||
        sessionCreateResult !== 0 ||
        sessionCreateProcessResult !== E_NOTIMPL ||
        sessionConnectResult !== 0 ||
        transportSendResult !== 0 ||
        transportGetResult !== 0 ||
        sessionEvent !== `runtime-event:${TransportMessage}` ||
        sessionDisconnectResult !== 0 ||
        sessionDestroyResult !== 0 ||
        symbolResult !== 0 ||
        symbolAddress !== runtimeDescriptorAddress ||
        symbolEmptyResult !== InvalidSymbolName ||
        symbolNullAddressResult !== InvalidSymbolName ||
        symbolTooLongResult !== InvalidSymbolName ||
        symbolAddressOverflowResult !== InvalidSymbolName ||
        symbolNullOutResult !== InvalidArgument ||
        copyResult !== 0 ||
        copyZeroBytesResult !== 0 ||
        copyNullDebuggerDestResult !== InvalidArgument ||
        copyTargetOverflowResult !== InvalidReadRange ||
        copyDebuggerOverflowResult !== InvalidReadRange ||
        copyOversizedResult !== InvalidReadRange ||
        pageCacheStatsResult !== 0 ||
        pageCacheInvalidateResult !== 0 ||
        pageCacheStatsAfterInvalidateResult !== 0 ||
        pageCacheStatsAfterReprobeResult !== 0 ||
        reprobeResult !== 0 ||
        pageCacheStatsBefore.epoch < 1 ||
        pageCacheStatsBefore.hits < 1 ||
        pageCacheStatsBefore.misses < 1 ||
        pageCacheStatsBefore.bypasses !== 0 ||
        pageCacheStatsAfterInvalidate.epoch !== pageCacheStatsBefore.epoch + 1 ||
        pageCacheStatsAfterInvalidate.invalidations !== pageCacheStatsBefore.invalidations + 1 ||
        pageCacheStatsAfterInvalidate.hits !== pageCacheStatsBefore.hits ||
        pageCacheStatsAfterInvalidate.misses !== pageCacheStatsBefore.misses ||
        pageCacheStatsAfterReprobe.epoch !== pageCacheStatsAfterInvalidate.epoch ||
        pageCacheStatsAfterReprobe.invalidations !== pageCacheStatsAfterInvalidate.invalidations ||
        pageCacheStatsAfterReprobe.misses !== pageCacheStatsAfterInvalidate.misses + 1 ||
        pageCacheStatsAfterReprobe.hits !== pageCacheStatsAfterInvalidate.hits ||
        runtimeGrowResult < 0 ||
        debuggerGrowResult < 0 ||
        runtimePagesAfter !== runtimePagesBefore + 1 ||
        debuggerPagesAfter !== debuggerPagesBefore + 1 ||
        postGrowthCopyResult !== 0 ||
        postGrowthCopiedMagic !== ContractDescriptorMagic ||
        copiedMagic !== ContractDescriptorMagic ||
        clrDataResult !== 0 ||
        dacDbiResult !== 0 ||
        cordbSecondResult !== 0 ||
        dacConsistencyProbeResult !== 0 ||
        dacConsistencyHr !== 0) {
        fail("WASM DBI/DAC smoke test failed");
    }
}

main().catch(error => {
    console.error(error.stack || error);
    process.exitCode = 1;
});
