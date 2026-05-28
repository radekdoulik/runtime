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
    const runtimeMemory = runtime.module.HEAPU8;

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
    const hostImports = {};
    hostImports.read_target_memory = (targetAddressArg, debuggerAddressArg, byteCountArg) => {
        const targetAddress = targetAddressArg >>> 0;
        const debuggerAddress = debuggerAddressArg >>> 0;
        const byteCount = byteCountArg >>> 0;

        if (targetAddress + byteCount > runtimeMemory.length ||
            debuggerAddress + byteCount > debuggerModule.HEAPU8.length) {
            return -1;
        }

        debuggerModule.HEAPU8.set(runtimeMemory.subarray(targetAddress, targetAddress + byteCount), debuggerAddress);
        return 0;
    };

    hostImports.get_symbol_address = (baseAddressArg, symbolNameAddressArg, symbolNameLengthArg, addressOutAddressArg) => {
        const symbolNameAddress = symbolNameAddressArg >>> 0;
        const symbolNameLength = symbolNameLengthArg >>> 0;
        const addressOutAddress = addressOutAddressArg >>> 0;
        if (symbolNameAddress + symbolNameLength > debuggerModule.HEAPU8.length ||
            addressOutAddress + 8 > debuggerModule.HEAPU8.length) {
            return -1;
        }

        const symbolName = new TextDecoder().decode(debuggerModule.HEAPU8.subarray(symbolNameAddress, symbolNameAddress + symbolNameLength));
        const symbolAddress =
            symbolName === "DotNetRuntimeContractDescriptor" ? runtimeExports.GetDotNetRuntimeContractDescriptor() >>> 0 :
            symbolName === "g_dacTable" ? runtimeExports.Getg_dacTable() >>> 0 :
            symbolName === "WasmDbiDacTestData" ? runtimeExports.GetWasmDbiDacTestData() >>> 0 :
            0;

        if (symbolAddress === 0) {
            return -1;
        }

        writeUint64(debuggerModule.HEAPU8, addressOutAddress, symbolAddress >>> 0);
        return 0;
    };

    hostImports.get_target_module_base = (imageNameAddressArg, imageNameCharCountArg, addressOutAddressArg) => {
        const addressOutAddress = addressOutAddressArg >>> 0;
        if (addressOutAddress + 8 > debuggerModule.HEAPU8.length) {
            return -1;
        }

        writeUint64(debuggerModule.HEAPU8, addressOutAddress, 1);
        return 0;
    };
    hostImports.send_ipc_to_runtime = (messageAddressArg, messageLengthArg) => {
        const messageAddress = messageAddressArg >>> 0;
        const messageLength = messageLengthArg >>> 0;
        if (messageAddress + messageLength > debuggerModule.HEAPU8.length) {
            return -1;
        }

        const savedRuntimeStack = runtime.exports.stackSave();
        const runtimeMessageAddress = runtime.exports.stackAlloc(messageLength);
        runtimeMemory.set(debuggerModule.HEAPU8.subarray(messageAddress, messageAddress + messageLength), runtimeMessageAddress);
        const receiveResult = runtimeExports.CoreClrWasmDebugReceiveCommand(runtimeMessageAddress, messageLength);
        runtime.exports.stackRestore(savedRuntimeStack);
        if (receiveResult !== 0) {
            return receiveResult;
        }

        const runtimeCommandLength = runtimeExports.CoreClrWasmDebugGetLastCommandLength();
        const savedCopyStack = runtime.exports.stackSave();
        const runtimeCopyAddress = runtime.exports.stackAlloc(runtimeCommandLength);
        const copyResult = runtimeExports.CoreClrWasmDebugCopyLastCommand(runtimeCopyAddress, runtimeCommandLength);
        const message = copyResult === 0 ? readAscii(runtimeMemory, runtimeCopyAddress, runtimeCommandLength) : "";
        runtime.exports.stackRestore(savedCopyStack);
        if (copyResult !== 0) {
            return copyResult;
        }

        const event = new TextEncoder().encode(`runtime-event:${message}`);
        const savedStack = debuggerExports.stackSave();
        const eventAddress = debuggerExports.stackAlloc(event.length);
        writeBytes(debuggerModule.HEAPU8, eventAddress, event);
        const result = debuggerModule._coreclr_wasm_dbi_dac_receive_runtime_event(eventAddress, event.length);
        debuggerExports.stackRestore(savedStack);
        return result;
    };

    const debuggerInstance = await loadDebugger(debuggerJsPath, imports => {
        Object.assign(imports.env, hostImports);
        imports.coreclr_dbi_dac = hostImports;
    });

    debuggerModule = debuggerInstance.module;
    const debuggerExports = debuggerInstance.exports;

    if (runtimeMemory.buffer === debuggerModule.HEAPU8.buffer) {
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
    const versionBlobBytesWrittenAddress = debuggerExports.stackAlloc(4);
    const transportMessageBytes = new TextEncoder().encode(TransportMessage);
    const transportMessageAddress = debuggerExports.stackAlloc(transportMessageBytes.length);
    const symbolName = "DotNetRuntimeContractDescriptor";
    const symbolNameAddress = debuggerExports.stackAlloc(symbolName.length);
    const symbolOutAddress = debuggerExports.stackAlloc(8);

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

    const descriptorResult = debuggerModule._coreclr_wasm_dbi_dac_probe_runtime_contract_descriptor(1, descriptorAddress);
    const pointerDataResult = debuggerModule._coreclr_wasm_dbi_dac_probe_contract_pointer_data(1, 2, pointerDataAddress);
    const testDataResult = debuggerModule._coreclr_wasm_dbi_dac_probe_test_data(1, testDataAddress);
    const breakpointControlResult = debuggerModule._coreclr_wasm_dbi_dac_probe_breakpoint_control(controlProbeAddress);
    const symbolResult = debuggerModule._coreclr_wasm_dbi_dac_try_get_symbol(symbolNameAddress, symbolName.length, symbolOutAddress);

    const runtimeDescriptorAddress = runtimeExports.GetDotNetRuntimeContractDescriptor() >>> 0;
    const copyResult = debuggerModule._coreclr_wasm_dbi_dac_copy_from_target(runtimeDescriptorAddress, copyAddress, 8);
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
        copyResult,
        copiedMagic: `0x${copiedMagic.toString(16)}`,
        gDacTable: `0x${(runtimeExports.Getg_dacTable() >>> 0).toString(16)}`,
        clrDataResult,
        dacDbiResult,
        cordbSecondResult
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
        copyResult !== 0 ||
        copiedMagic !== ContractDescriptorMagic ||
        clrDataResult !== 0 ||
        dacDbiResult !== 0 ||
        cordbSecondResult !== 0) {
        fail("WASM DBI/DAC smoke test failed");
    }
}

main().catch(error => {
    console.error(error.stack || error);
    process.exitCode = 1;
});
