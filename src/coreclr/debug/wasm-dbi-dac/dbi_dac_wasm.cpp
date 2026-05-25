// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

#include <new>
#include <stdio.h>
#include <stdint.h>
#include <string.h>

#include "cor.h"
#include "clrdata.h"
#include "cordebug.h"
#include "xclrdata.h"

EXTERN_C const IID IID_IDacDbiAllocator;
EXTERN_C const IID IID_IDacDbiMetaDataLookup;
EXTERN_C bool TryGetSymbol(ICorDebugDataTarget* dataTarget, uint64_t baseAddress, const char* symbolName, uint64_t* symbolAddress);

namespace
{
constexpr uint32_t WasmDbiDacAbiVersion = 1;
constexpr uint64_t ContractDescriptorMagic = 0x0043414443434e44;
constexpr uint32_t TestDataMagic = 0x43445744;
constexpr uint32_t MaxTransportMessageBytes = 256;

enum ComponentMask : uint32_t
{
    ComponentScaffold = 0x1,
    ComponentCeeDac = 0x2,
    ComponentDaccess = 0x4,
    ComponentCordbdi = 0x8,
};

enum Result : int32_t
{
    Success = 0,
    InvalidArgument = -1,
    HostReadFailed = -2,
    HostSymbolLookupFailed = -3,
    InvalidContractDescriptor = -4,
    InvalidPointerDataIndex = -5,
    InvalidTestData = -6,
    BufferTooSmall = -7,
};

struct ContractDescriptorLayout
{
    uint64_t Magic;
    uint32_t Flags;
    uint32_t DescriptorSize;
    uint32_t DescriptorAddress;
    uint32_t PointerDataCount;
    uint32_t Pad0;
    uint32_t PointerDataAddress;
};

struct ContractPointerDataProbe
{
    uint32_t PointerDataValue;
    uint32_t DereferencedValue;
};

struct TestDataProbe
{
    uint32_t Magic;
    int32_t Int32Value;
    double DoubleValue;
    uint32_t VectorLanes[4];
    char Message[16];
};

struct DbiControlProbe
{
    int32_t CreateCordbResult;
    int32_t InitializeResult;
    int32_t CreateProcessResult;
    int32_t BreakpointResult;
};

static_assert(sizeof(ContractDescriptorLayout) == 32);
static_assert(sizeof(ContractPointerDataProbe) == 8);
static_assert(sizeof(TestDataProbe) == 48);
static_assert(sizeof(DbiControlProbe) == 16);
static_assert(sizeof(void*) == sizeof(uint32_t));

ICorDebug* g_cordb = nullptr;
bool g_connectedToRuntime = false;
uint8_t g_lastRuntimeEvent[MaxTransportMessageBytes];
uint32_t g_lastRuntimeEventLength = 0;

class WasmDacDataTarget;

int32_t ReadRuntimeContractDescriptor(
    WasmDacDataTarget& dataTarget,
    uint32_t runtimeBase,
    ContractDescriptorLayout* descriptor);

int32_t SendRuntimeCommand(const char* command, uint32_t commandLength);

class WasmDacDataTarget final :
    public ICLRDataTarget,
    public ICLRRuntimeLocator,
    public ICorDebugDataTarget
{
public:
    explicit WasmDacDataTarget(CORDB_ADDRESS runtimeBase)
        : m_ref(1),
          m_runtimeBase(runtimeBase)
    {
    }

    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** ppInterface) override
    {
        if (ppInterface == nullptr)
        {
            return E_POINTER;
        }

        *ppInterface = nullptr;

        if (riid == IID_IUnknown || riid == __uuidof(ICLRDataTarget))
        {
            *ppInterface = static_cast<ICLRDataTarget*>(this);
        }
        else if (riid == __uuidof(ICLRRuntimeLocator))
        {
            *ppInterface = static_cast<ICLRRuntimeLocator*>(this);
        }
        else if (riid == __uuidof(ICorDebugDataTarget))
        {
            *ppInterface = static_cast<ICorDebugDataTarget*>(this);
        }
        else
        {
            return E_NOINTERFACE;
        }

        AddRef();
        return S_OK;
    }

    ULONG STDMETHODCALLTYPE AddRef() override
    {
        return static_cast<ULONG>(InterlockedIncrement(&m_ref));
    }

    ULONG STDMETHODCALLTYPE Release() override
    {
        LONG ref = InterlockedDecrement(&m_ref);
        if (ref == 0)
        {
            delete this;
        }

        return static_cast<ULONG>(ref);
    }

    HRESULT STDMETHODCALLTYPE GetMachineType(ULONG32* machineType) override
    {
        if (machineType == nullptr)
        {
            return E_POINTER;
        }

        *machineType = IMAGE_FILE_MACHINE_UNKNOWN;
        return S_OK;
    }

    HRESULT STDMETHODCALLTYPE GetPointerSize(ULONG32* pointerSize) override
    {
        if (pointerSize == nullptr)
        {
            return E_POINTER;
        }

        *pointerSize = sizeof(void*);
        return S_OK;
    }

    HRESULT STDMETHODCALLTYPE GetImageBase(LPCWSTR imagePath, CLRDATA_ADDRESS* baseAddress) override
    {
        if (baseAddress == nullptr)
        {
            return E_POINTER;
        }

        *baseAddress = m_runtimeBase;
        if (*baseAddress != 0)
        {
            return S_OK;
        }

        return GetTargetModuleBase(imagePath, baseAddress);
    }

    HRESULT STDMETHODCALLTYPE ReadVirtual(
        CLRDATA_ADDRESS address,
        BYTE* buffer,
        ULONG32 bytesRequested,
        ULONG32* bytesRead) override
    {
        return ReadTargetMemory(address, buffer, bytesRequested, bytesRead);
    }

    HRESULT STDMETHODCALLTYPE WriteVirtual(
        CLRDATA_ADDRESS address,
        BYTE* buffer,
        ULONG32 bytesRequested,
        ULONG32* bytesWritten) override
    {
        if (bytesWritten != nullptr)
        {
            *bytesWritten = 0;
        }

        return E_NOTIMPL;
    }

    HRESULT STDMETHODCALLTYPE GetTLSValue(ULONG32 threadID, ULONG32 index, CLRDATA_ADDRESS* value) override
    {
        if (value == nullptr)
        {
            return E_POINTER;
        }

        *value = 0;
        return E_NOTIMPL;
    }

    HRESULT STDMETHODCALLTYPE SetTLSValue(ULONG32 threadID, ULONG32 index, CLRDATA_ADDRESS value) override
    {
        return E_NOTIMPL;
    }

    HRESULT STDMETHODCALLTYPE GetCurrentThreadID(ULONG32* threadID) override
    {
        if (threadID == nullptr)
        {
            return E_POINTER;
        }

        *threadID = 1;
        return S_OK;
    }

    HRESULT STDMETHODCALLTYPE GetThreadContext(
        ULONG32 threadID,
        ULONG32 contextFlags,
        ULONG32 contextSize,
        BYTE* context) override
    {
        return E_NOTIMPL;
    }

    HRESULT STDMETHODCALLTYPE SetThreadContext(ULONG32 threadID, ULONG32 contextSize, BYTE* context) override
    {
        return E_NOTIMPL;
    }

    HRESULT STDMETHODCALLTYPE Request(
        ULONG32 reqCode,
        ULONG32 inBufferSize,
        BYTE* inBuffer,
        ULONG32 outBufferSize,
        BYTE* outBuffer) override
    {
        return E_NOTIMPL;
    }

    HRESULT STDMETHODCALLTYPE GetRuntimeBase(CLRDATA_ADDRESS* baseAddress) override
    {
        if (baseAddress == nullptr)
        {
            return E_POINTER;
        }

        *baseAddress = m_runtimeBase;
        return *baseAddress != 0 ? S_OK : E_FAIL;
    }

    HRESULT STDMETHODCALLTYPE GetPlatform(CorDebugPlatform* targetPlatform) override
    {
        if (targetPlatform == nullptr)
        {
            return E_POINTER;
        }

        *targetPlatform = static_cast<CorDebugPlatform>(0);
        return E_NOTIMPL;
    }

private:
    HRESULT ReadTargetMemory(
        uint64_t address,
        BYTE* buffer,
        ULONG32 bytesRequested,
        ULONG32* bytesRead);

    HRESULT GetTargetModuleBase(LPCWSTR imagePath, CLRDATA_ADDRESS* baseAddress);

    LONG m_ref;
    CORDB_ADDRESS m_runtimeBase;
};

// Minimal ABI-compatible callbacks for DacDbiInterfaceInstance. The facade only
// creates and releases the interface today, so it avoids pulling the full DBI
// header graph into this standalone module boundary.
class WasmDbiAllocator final : public IUnknown
{
public:
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** ppInterface) override
    {
        if (ppInterface == nullptr)
        {
            return E_POINTER;
        }

        *ppInterface = nullptr;
        if (riid == IID_IUnknown || riid == IID_IDacDbiAllocator)
        {
            *ppInterface = this;
            AddRef();
            return S_OK;
        }

        return E_NOINTERFACE;
    }

    ULONG STDMETHODCALLTYPE AddRef() override
    {
        return 2;
    }

    ULONG STDMETHODCALLTYPE Release() override
    {
        return 1;
    }

    virtual void* Alloc(SIZE_T lenBytes)
    {
        return ::operator new(lenBytes, std::nothrow);
    }

    virtual void Free(void* p)
    {
        ::operator delete(p);
    }
};

class WasmMetaDataLookup final : public IUnknown
{
public:
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** ppInterface) override
    {
        if (ppInterface == nullptr)
        {
            return E_POINTER;
        }

        *ppInterface = nullptr;
        if (riid == IID_IUnknown || riid == IID_IDacDbiMetaDataLookup)
        {
            *ppInterface = this;
            AddRef();
            return S_OK;
        }

        return E_NOINTERFACE;
    }

    ULONG STDMETHODCALLTYPE AddRef() override
    {
        return 2;
    }

    ULONG STDMETHODCALLTYPE Release() override
    {
        return 1;
    }

    virtual void* LookupMetaData(uint64_t addressPEAssembly)
    {
        return nullptr;
    }
};
}

extern "C" int32_t coreclr_wasm_dbi_dac_read_target_memory(uint32_t targetAddress, uint32_t debuggerAddress, uint32_t byteCount)
    __attribute__((import_module("coreclr_dbi_dac"), import_name("read_target_memory")));

extern "C" int32_t coreclr_wasm_dbi_dac_get_symbol_address(uint32_t baseAddress, uint32_t symbolNameAddress, uint32_t symbolNameLength, uint32_t outAddress)
    __attribute__((import_module("coreclr_dbi_dac"), import_name("get_symbol_address")));

extern "C" int32_t coreclr_wasm_dbi_dac_get_target_module_base(uint32_t imageNameAddress, uint32_t imageNameCharCount, uint32_t outAddress)
    __attribute__((import_module("coreclr_dbi_dac"), import_name("get_target_module_base")));

extern "C" int32_t coreclr_wasm_dbi_dac_send_ipc_to_runtime(uint32_t messageAddress, uint32_t messageLength)
    __attribute__((import_module("coreclr_dbi_dac"), import_name("send_ipc_to_runtime")));

extern "C" HRESULT CLRDataCreateInstance(REFIID iid, ICLRDataTarget* legacyTarget, void** iface);

STDAPI CreateCordbObject(int iDebuggerVersion, IUnknown** ppCordb);

extern "C" HRESULT DacDbiInterfaceInstance(
    ICorDebugDataTarget* target,
    CORDB_ADDRESS baseAddress,
    IUnknown* allocator,
    IUnknown* metaDataLookup,
    void** dacDbi);

extern "C" int32_t coreclr_wasm_dbi_dac_transport_get_last_event(uint32_t bufferAddress, uint32_t bufferLength, uint32_t bytesWrittenAddress);

namespace
{
HRESULT WasmDacDataTarget::ReadTargetMemory(
    uint64_t address,
    BYTE* buffer,
    ULONG32 bytesRequested,
    ULONG32* bytesRead)
{
    if (bytesRead == nullptr)
    {
        return E_POINTER;
    }

    *bytesRead = 0;

    if (bytesRequested == 0)
    {
        return S_OK;
    }

    if (buffer == nullptr || address > UINT32_MAX)
    {
        return E_INVALIDARG;
    }

    int32_t result = coreclr_wasm_dbi_dac_read_target_memory(
        static_cast<uint32_t>(address),
        static_cast<uint32_t>(reinterpret_cast<uintptr_t>(buffer)),
        bytesRequested);
    if (result != Success)
    {
        return CORDBG_E_READVIRTUAL_FAILURE;
    }

    *bytesRead = bytesRequested;
    return S_OK;
}

HRESULT WasmDacDataTarget::GetTargetModuleBase(LPCWSTR imagePath, CLRDATA_ADDRESS* baseAddress)
{
    uint64_t resolvedAddress = 0;
    uint32_t imageNameAddress = static_cast<uint32_t>(reinterpret_cast<uintptr_t>(imagePath));
    uint32_t imageNameCharCount = 0;

    if (imagePath != nullptr)
    {
        while (imagePath[imageNameCharCount] != 0)
        {
            imageNameCharCount++;
        }
    }

    int32_t result = coreclr_wasm_dbi_dac_get_target_module_base(
        imageNameAddress,
        imageNameCharCount,
        static_cast<uint32_t>(reinterpret_cast<uintptr_t>(&resolvedAddress)));
    if (result != Success || resolvedAddress == 0)
    {
        return E_FAIL;
    }

    *baseAddress = resolvedAddress;
    return S_OK;
}

int32_t ReadRuntimeContractDescriptor(
    WasmDacDataTarget& dataTarget,
    uint32_t runtimeBase,
    ContractDescriptorLayout* descriptor)
{
    uint64_t descriptorAddress = 0;
    if (!TryGetSymbol(
            static_cast<ICorDebugDataTarget*>(&dataTarget),
            runtimeBase,
            "DotNetRuntimeContractDescriptor",
            &descriptorAddress) ||
        descriptorAddress > UINT32_MAX)
    {
        return HostSymbolLookupFailed;
    }

    ULONG32 bytesRead = 0;
    HRESULT result = dataTarget.ReadVirtual(
        descriptorAddress,
        reinterpret_cast<BYTE*>(descriptor),
        sizeof(*descriptor),
        &bytesRead);
    if (FAILED(result) || bytesRead != sizeof(*descriptor))
    {
        return HostReadFailed;
    }

    if (descriptor->Magic != ContractDescriptorMagic ||
        descriptor->DescriptorAddress == 0 ||
        descriptor->DescriptorSize == 0 ||
        (descriptor->PointerDataCount != 0 && descriptor->PointerDataAddress == 0))
    {
        return InvalidContractDescriptor;
    }

    return Success;
}

int32_t SendRuntimeCommand(const char* command, uint32_t commandLength)
{
    if ((command == nullptr && commandLength != 0) || commandLength >= MaxTransportMessageBytes)
    {
        return InvalidArgument;
    }

    int32_t result = coreclr_wasm_dbi_dac_send_ipc_to_runtime(
        static_cast<uint32_t>(reinterpret_cast<uintptr_t>(command)),
        commandLength);
    return result == Success ? Success : result;
}
}

extern "C" bool
TryGetSymbol(ICorDebugDataTarget* dataTarget, uint64_t baseAddress, const char* symbolName, uint64_t* symbolAddress)
{
    if (symbolName == nullptr || symbolAddress == nullptr || baseAddress > UINT32_MAX)
    {
        return false;
    }

    uint64_t resolvedAddress = 0;
    size_t symbolNameLength = strlen(symbolName);
    if (symbolNameLength > UINT32_MAX)
    {
        return false;
    }

    int32_t result = coreclr_wasm_dbi_dac_get_symbol_address(
        static_cast<uint32_t>(baseAddress),
        static_cast<uint32_t>(reinterpret_cast<uintptr_t>(symbolName)),
        static_cast<uint32_t>(symbolNameLength),
        static_cast<uint32_t>(reinterpret_cast<uintptr_t>(&resolvedAddress)));
    if (result != Success || resolvedAddress == 0)
    {
        *symbolAddress = 0;
        return false;
    }

    *symbolAddress = resolvedAddress;
    return true;
}

extern "C" uint32_t coreclr_wasm_dbi_dac_get_abi_version()
{
    return WasmDbiDacAbiVersion;
}

extern "C" uint32_t coreclr_wasm_dbi_dac_get_component_mask()
{
    return ComponentScaffold | ComponentCeeDac | ComponentDaccess | ComponentCordbdi;
}

extern "C" int32_t coreclr_wasm_dbi_dac_copy_from_target(uint32_t targetAddress, uint32_t debuggerAddress, uint32_t byteCount)
{
    if (debuggerAddress == 0 && byteCount != 0)
    {
        return InvalidArgument;
    }

    int32_t result = coreclr_wasm_dbi_dac_read_target_memory(
        targetAddress,
        debuggerAddress,
        byteCount);

    return result == Success ? Success : HostReadFailed;
}

extern "C" int32_t coreclr_wasm_dbi_dac_try_get_symbol(uint32_t symbolNameAddress, uint32_t symbolNameLength, uint32_t addressOutAddress)
{
    if (symbolNameAddress == 0 || addressOutAddress == 0)
    {
        return InvalidArgument;
    }

    uint64_t resolvedAddress = 0;
    int32_t result = coreclr_wasm_dbi_dac_get_symbol_address(
        0,
        symbolNameAddress,
        symbolNameLength,
        static_cast<uint32_t>(reinterpret_cast<uintptr_t>(&resolvedAddress)));
    if (result != Success || resolvedAddress == 0)
    {
        return HostSymbolLookupFailed;
    }

    memcpy(reinterpret_cast<void*>(static_cast<uintptr_t>(addressOutAddress)), &resolvedAddress, sizeof(resolvedAddress));
    return Success;
}

extern "C" int32_t coreclr_wasm_dbi_dac_probe_runtime_contract_descriptor(uint32_t runtimeBase, uint32_t probeOutAddress)
{
    if (probeOutAddress == 0)
    {
        return InvalidArgument;
    }

    WasmDacDataTarget dataTarget(runtimeBase);
    ContractDescriptorLayout descriptor{};
    int32_t result = ReadRuntimeContractDescriptor(dataTarget, runtimeBase, &descriptor);
    if (result != Success)
    {
        return result;
    }

    memcpy(reinterpret_cast<void*>(static_cast<uintptr_t>(probeOutAddress)), &descriptor, sizeof(descriptor));
    return Success;
}

extern "C" int32_t coreclr_wasm_dbi_dac_probe_contract_pointer_data(uint32_t runtimeBase, uint32_t pointerDataIndex, uint32_t probeOutAddress)
{
    if (probeOutAddress == 0)
    {
        return InvalidArgument;
    }

    WasmDacDataTarget dataTarget(runtimeBase);
    ContractDescriptorLayout descriptor{};
    int32_t result = ReadRuntimeContractDescriptor(dataTarget, runtimeBase, &descriptor);
    if (result != Success)
    {
        return result;
    }

    if (pointerDataIndex >= descriptor.PointerDataCount)
    {
        return InvalidPointerDataIndex;
    }

    uint64_t pointerDataSlotAddress = descriptor.PointerDataAddress + static_cast<uint64_t>(pointerDataIndex) * sizeof(uint32_t);
    if (pointerDataSlotAddress > UINT32_MAX)
    {
        return InvalidContractDescriptor;
    }

    ContractPointerDataProbe probe{};
    ULONG32 bytesRead = 0;
    HRESULT hr = dataTarget.ReadVirtual(
        pointerDataSlotAddress,
        reinterpret_cast<BYTE*>(&probe.PointerDataValue),
        sizeof(probe.PointerDataValue),
        &bytesRead);
    if (FAILED(hr) || bytesRead != sizeof(probe.PointerDataValue))
    {
        return HostReadFailed;
    }

    if (probe.PointerDataValue != 0)
    {
        bytesRead = 0;
        hr = dataTarget.ReadVirtual(
            probe.PointerDataValue,
            reinterpret_cast<BYTE*>(&probe.DereferencedValue),
            sizeof(probe.DereferencedValue),
            &bytesRead);
        if (FAILED(hr) || bytesRead != sizeof(probe.DereferencedValue))
        {
            return HostReadFailed;
        }
    }

    memcpy(reinterpret_cast<void*>(static_cast<uintptr_t>(probeOutAddress)), &probe, sizeof(probe));
    return Success;
}

extern "C" int32_t coreclr_wasm_dbi_dac_probe_test_data(uint32_t runtimeBase, uint32_t probeOutAddress)
{
    if (probeOutAddress == 0)
    {
        return InvalidArgument;
    }

    WasmDacDataTarget dataTarget(runtimeBase);
    uint64_t testDataAddress = 0;
    if (!TryGetSymbol(
            static_cast<ICorDebugDataTarget*>(&dataTarget),
            runtimeBase,
            "WasmDbiDacTestData",
            &testDataAddress) ||
        testDataAddress > UINT32_MAX)
    {
        return HostSymbolLookupFailed;
    }

    TestDataProbe probe{};
    ULONG32 bytesRead = 0;
    HRESULT hr = dataTarget.ReadVirtual(
        testDataAddress,
        reinterpret_cast<BYTE*>(&probe),
        sizeof(probe),
        &bytesRead);
    if (FAILED(hr) || bytesRead != sizeof(probe))
    {
        return HostReadFailed;
    }

    if (probe.Magic != TestDataMagic)
    {
        return InvalidTestData;
    }

    memcpy(reinterpret_cast<void*>(static_cast<uintptr_t>(probeOutAddress)), &probe, sizeof(probe));
    return Success;
}

extern "C" int32_t coreclr_wasm_dbi_dac_create_clr_data_instance(uint32_t runtimeBase)
{
    WasmDacDataTarget* dataTarget = new (std::nothrow) WasmDacDataTarget(runtimeBase);
    if (dataTarget == nullptr)
    {
        return E_OUTOFMEMORY;
    }

    void* dataProcess = nullptr;
    HRESULT result = CLRDataCreateInstance(__uuidof(IXCLRDataProcess), dataTarget, &dataProcess);
    dataTarget->Release();

    if (SUCCEEDED(result) && dataProcess != nullptr)
    {
        static_cast<IUnknown*>(dataProcess)->Release();
    }

    return result;
}

extern "C" int32_t coreclr_wasm_dbi_dac_create_dac_dbi_interface(uint32_t runtimeBase)
{
    if (runtimeBase == 0)
    {
        return E_INVALIDARG;
    }

    WasmDacDataTarget* dataTarget = new (std::nothrow) WasmDacDataTarget(runtimeBase);
    if (dataTarget == nullptr)
    {
        return E_OUTOFMEMORY;
    }

    WasmDbiAllocator allocator;
    WasmMetaDataLookup metadataLookup;
    void* dacDbi = nullptr;
    HRESULT result = DacDbiInterfaceInstance(dataTarget, runtimeBase, &allocator, &metadataLookup, &dacDbi);
    dataTarget->Release();

    if (SUCCEEDED(result) && dacDbi != nullptr)
    {
        reinterpret_cast<IUnknown*>(dacDbi)->Release();
    }

    return result;
}

extern "C" int32_t coreclr_wasm_dbi_dac_dbi_session_create()
{
    if (g_cordb != nullptr)
    {
        return S_OK;
    }

    ICorDebug* cordb = nullptr;
    HRESULT result = CreateCordbObject(static_cast<int>(CorDebugVersion_4_0), reinterpret_cast<IUnknown**>(&cordb));
    if (FAILED(result))
    {
        return result;
    }

    result = cordb->Initialize();
    if (FAILED(result))
    {
        cordb->Release();
        return result;
    }

    g_cordb = cordb;
    return S_OK;
}

extern "C" int32_t coreclr_wasm_dbi_dac_dbi_session_create_process()
{
    if (g_cordb == nullptr)
    {
        return E_FAIL;
    }

    ICorDebugProcess* process = nullptr;
    HRESULT result = g_cordb->CreateProcess(
        nullptr,
        nullptr,
        nullptr,
        nullptr,
        FALSE,
        0,
        nullptr,
        nullptr,
        nullptr,
        nullptr,
        DEBUG_NO_SPECIAL_OPTIONS,
        &process);
    if (process != nullptr)
    {
        process->Release();
    }

    return result;
}

extern "C" int32_t coreclr_wasm_dbi_dac_dbi_connect_runtime()
{
    if (g_cordb == nullptr)
    {
        return E_FAIL;
    }

    if (g_connectedToRuntime)
    {
        return S_OK;
    }

    g_connectedToRuntime = true;
    g_lastRuntimeEventLength = 0;
    return S_OK;
}

extern "C" int32_t coreclr_wasm_dbi_dac_dbi_disconnect_runtime()
{
    g_connectedToRuntime = false;
    g_lastRuntimeEventLength = 0;
    return S_OK;
}

extern "C" int32_t coreclr_wasm_dbi_dac_dbi_set_breakpoint_by_name(uint32_t nameAddress, uint32_t nameLength)
{
    if (g_cordb == nullptr || !g_connectedToRuntime || (nameAddress == 0 && nameLength != 0))
    {
        return E_FAIL;
    }

    static constexpr char Prefix[] = "dbi-command:set-breakpoint:name=";
    constexpr uint32_t PrefixLength = sizeof(Prefix) - 1;
    if (nameLength == 0 || nameLength >= MaxTransportMessageBytes - PrefixLength)
    {
        return InvalidArgument;
    }

    char command[MaxTransportMessageBytes];
    memcpy(command, Prefix, PrefixLength);
    memcpy(command + PrefixLength, reinterpret_cast<void*>(static_cast<uintptr_t>(nameAddress)), nameLength);
    return SendRuntimeCommand(command, PrefixLength + nameLength);
}

extern "C" int32_t coreclr_wasm_dbi_dac_dbi_set_breakpoint_by_token(uint32_t methodToken, uint32_t ilOffset)
{
    if (g_cordb == nullptr || !g_connectedToRuntime)
    {
        return E_FAIL;
    }

    if (methodToken == 0 || ilOffset != 0)
    {
        return E_NOTIMPL;
    }

    char command[MaxTransportMessageBytes];
    int written = snprintf(command, sizeof(command), "dbi-command:set-breakpoint:token=0x%08x", methodToken);
    if (written < 0 || static_cast<uint32_t>(written) >= MaxTransportMessageBytes)
    {
        return InvalidArgument;
    }

    return SendRuntimeCommand(command, static_cast<uint32_t>(written));
}

extern "C" int32_t coreclr_wasm_dbi_dac_dbi_continue()
{
    if (g_cordb == nullptr || !g_connectedToRuntime)
    {
        return E_FAIL;
    }

    static constexpr char ContinueCommand[] = "dbi-command:continue";
    return SendRuntimeCommand(ContinueCommand, sizeof(ContinueCommand) - 1);
}

extern "C" int32_t coreclr_wasm_dbi_dac_dbi_poll_event(uint32_t bufferAddress, uint32_t bufferLength, uint32_t bytesWrittenAddress)
{
    if (g_cordb == nullptr || !g_connectedToRuntime)
    {
        return E_FAIL;
    }

    return coreclr_wasm_dbi_dac_transport_get_last_event(bufferAddress, bufferLength, bytesWrittenAddress);
}

extern "C" int32_t coreclr_wasm_dbi_dac_dbi_session_destroy()
{
    if (g_cordb == nullptr)
    {
        return S_OK;
    }

    ICorDebug* cordb = g_cordb;
    g_cordb = nullptr;
    g_connectedToRuntime = false;
    g_lastRuntimeEventLength = 0;

    HRESULT result = cordb->Terminate();
    cordb->Release();
    return result;
}

extern "C" int32_t coreclr_wasm_dbi_dac_transport_send_test_message(uint32_t messageAddress, uint32_t messageLength)
{
    if ((messageAddress == 0 && messageLength != 0) || messageLength >= MaxTransportMessageBytes)
    {
        return InvalidArgument;
    }

    int32_t result = coreclr_wasm_dbi_dac_send_ipc_to_runtime(messageAddress, messageLength);
    return result == Success ? Success : result;
}

extern "C" int32_t coreclr_wasm_dbi_dac_receive_runtime_event(uint32_t eventAddress, uint32_t eventLength)
{
    if (g_cordb == nullptr || !g_connectedToRuntime)
    {
        return E_FAIL;
    }

    if ((eventAddress == 0 && eventLength != 0) || eventLength > MaxTransportMessageBytes)
    {
        return InvalidArgument;
    }

    g_lastRuntimeEventLength = eventLength;
    if (eventLength != 0)
    {
        memcpy(g_lastRuntimeEvent, reinterpret_cast<void*>(static_cast<uintptr_t>(eventAddress)), eventLength);
    }

    return Success;
}

extern "C" int32_t coreclr_wasm_dbi_dac_transport_get_last_event(uint32_t bufferAddress, uint32_t bufferLength, uint32_t bytesWrittenAddress)
{
    if (bytesWrittenAddress == 0 || (bufferAddress == 0 && bufferLength != 0))
    {
        return InvalidArgument;
    }

    if (bufferLength < g_lastRuntimeEventLength)
    {
        return BufferTooSmall;
    }

    if (g_lastRuntimeEventLength != 0)
    {
        memcpy(reinterpret_cast<void*>(static_cast<uintptr_t>(bufferAddress)), g_lastRuntimeEvent, g_lastRuntimeEventLength);
    }

    memcpy(reinterpret_cast<void*>(static_cast<uintptr_t>(bytesWrittenAddress)), &g_lastRuntimeEventLength, sizeof(g_lastRuntimeEventLength));
    return Success;
}

extern "C" int32_t coreclr_wasm_dbi_dac_probe_breakpoint_control(uint32_t probeOutAddress)
{
    if (probeOutAddress == 0)
    {
        return InvalidArgument;
    }

    DbiControlProbe probe{};
    probe.CreateCordbResult = E_FAIL;
    probe.InitializeResult = E_FAIL;
    probe.CreateProcessResult = E_NOTIMPL;
    probe.BreakpointResult = E_NOTIMPL;

    ICorDebug* cordb = nullptr;
    HRESULT result = CreateCordbObject(static_cast<int>(CorDebugVersion_4_0), reinterpret_cast<IUnknown**>(&cordb));
    probe.CreateCordbResult = result;
    if (SUCCEEDED(result))
    {
        result = cordb->Initialize();
        probe.InitializeResult = result;
        if (SUCCEEDED(result))
        {
            ICorDebugProcess* process = nullptr;
            probe.CreateProcessResult = cordb->CreateProcess(
                nullptr,
                nullptr,
                nullptr,
                nullptr,
                FALSE,
                0,
                nullptr,
                nullptr,
                nullptr,
                nullptr,
                DEBUG_NO_SPECIAL_OPTIONS,
                &process);
            if (process != nullptr)
            {
                process->Release();
            }

            HRESULT terminateResult = cordb->Terminate();
            if (FAILED(terminateResult) && SUCCEEDED(probe.CreateProcessResult))
            {
                probe.CreateProcessResult = terminateResult;
            }
        }

        cordb->Release();
    }

    memcpy(reinterpret_cast<void*>(static_cast<uintptr_t>(probeOutAddress)), &probe, sizeof(probe));
    return Success;
}

extern "C" int32_t coreclr_wasm_dbi_dac_create_cordb_object()
{
    ICorDebug* cordb = nullptr;
    HRESULT result = CreateCordbObject(static_cast<int>(CorDebugVersion_4_0), reinterpret_cast<IUnknown**>(&cordb));
    if (FAILED(result))
    {
        return result;
    }

    result = cordb->Initialize();
    if (FAILED(result))
    {
        cordb->Release();
        return result;
    }

    HRESULT terminateResult = cordb->Terminate();
    cordb->Release();

    if (FAILED(terminateResult))
    {
        return terminateResult;
    }

    return result;
}
