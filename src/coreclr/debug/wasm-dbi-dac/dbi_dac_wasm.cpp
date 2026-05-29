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

#include "dbi_dac_wasm_exports.h"

EXTERN_C const IID IID_IDacDbiAllocator;
EXTERN_C const IID IID_IDacDbiMetaDataLookup;
EXTERN_C bool TryGetSymbol(ICorDebugDataTarget* dataTarget, uint64_t baseAddress, const char* symbolName, uint64_t* symbolAddress);

namespace
{
constexpr uint32_t WasmDbiDacAbiVersion = 1;
constexpr uint64_t ContractDescriptorMagic = 0x0043414443434e44;
constexpr uint32_t TestDataMagic = 0x43445744;
constexpr uint32_t MaxTransportMessageBytes = 256;
constexpr uint32_t WasmDebugCommandRecordMagic = 0x434d4457;

// 'WDVB' (Wasm DAC/DBI Version Blob) - stored little-endian so the bytes
// 'W','D','V','B' appear in that order on every wasm host.
constexpr uint32_t WasmDbiDacVersionBlobMagic = 0x42564457;

// Monotonic counter bumped whenever the sidecar protocol breaks wire
// compatibility with previous hosts. Mirrors the desktop pattern at
// src/coreclr/debug/inc/dacdbistructures.h
// (kCurrentDacDbiProtocolBreakingChangeCounter), where a mismatch causes
// CheckDbiVersion to return CORDBG_E_INCOMPATIBLE_PROTOCOL.
//
// Bumping log:
//   1 - initial value; matches the export set captured at this commit.
constexpr uint32_t WasmDbiDacProtocolBreakingChangeCounter = 1;

// Sidecar build version - encoded VS_FIXEDFILEINFO-style as two 32-bit
// words. Reserved for future use; today's PoC sidecar reports 0/0 so
// version-aware hosts can detect "pre-versioned" builds.
constexpr uint32_t WasmDbiDacSidecarBuildVersionMS = 0;
constexpr uint32_t WasmDbiDacSidecarBuildVersionLS = 0;

// CORDBG_E_INCOMPATIBLE_PROTOCOL = MAKE_HRESULT(SEVERITY_ERROR=1,
// FACILITY_URT=0x13, 0x134b) = 0x8013134B. Defined locally so the
// exports header stays self-contained; the value is fixed by the
// public corerror.h contract.
constexpr int32_t HrIncompatibleProtocol = static_cast<int32_t>(0x8013134bu);

enum ComponentMask : uint32_t
{
    ComponentScaffold = 0x1,
    ComponentCeeDac = 0x2,
    ComponentDaccess = 0x4,
    ComponentCordbdi = 0x8,
};

enum class WasmDebugCommandKind : uint32_t
{
    None = 0,
    SetBreakpointByName = 1,
    SetBreakpointByToken = 2,
    Continue = 3,
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

// Self-describing version blob - hosts read this once to learn what
// version of the sidecar protocol this binary speaks. Layout is fixed
// once published; new fields can only be appended, and old fields can
// only be deprecated by repurposing them through the breaking-change
// counter (see WasmDbiDacProtocolBreakingChangeCounter).
struct WasmDbiDacVersionBlob
{
    uint32_t Magic;                        // WasmDbiDacVersionBlobMagic ('WDVB')
    uint32_t BlobSize;                     // sizeof(WasmDbiDacVersionBlob)
    uint32_t AbiVersion;                   // monotonic; WasmDbiDacAbiVersion
    uint32_t ProtocolBreakingChangeCounter;// WasmDbiDacProtocolBreakingChangeCounter
    uint32_t ComponentMask;                // mirror of get_component_mask()
    uint32_t SidecarBuildVersionMS;        // reserved; 0 today
    uint32_t SidecarBuildVersionLS;        // reserved; 0 today
    uint32_t Reserved;                     // must be 0
};

struct DbiControlProbe
{
    int32_t CreateCordbResult;
    int32_t InitializeResult;
    int32_t CreateProcessResult;
    int32_t BreakpointResult;
};

struct WasmDebugCommandRecord
{
    uint32_t Magic;
    uint32_t Kind;
    uint32_t MethodToken;
    uint32_t ILOffset;
    char MethodName[64];
};

struct WasmDebugEventRecord
{
    uint32_t Kind;
    uint32_t MethodToken;
    uint32_t ILOffset;
    uint32_t HitCount;
    uint32_t ContinueCount;
    char MethodName[64];
    char Message[256];
};

struct WasmDebugFrameRecord
{
    uint32_t MethodToken;
    uint32_t ILOffset;
    uint32_t InterpreterIP;
    uint32_t FrameAddress;
    uint32_t StackAddress;
    int32_t FirstStackSlotI32;
    char MethodName[64];
};

struct WasmDbiProcessState
{
    uint32_t SessionCreated;
    uint32_t Connected;
    uint32_t RuntimeBase;
    uint32_t SyntheticProcessId;
    uint32_t HasRealCordbProcess;
    uint32_t LastEventKind;
    uint32_t LastMethodToken;
    uint32_t LastILOffset;
    uint32_t BreakpointHitCount;
    uint32_t ContinueCount;
};

static_assert(sizeof(ContractDescriptorLayout) == 32);
static_assert(sizeof(ContractPointerDataProbe) == 8);
static_assert(sizeof(TestDataProbe) == 48);
static_assert(sizeof(DbiControlProbe) == 16);
static_assert(sizeof(WasmDebugCommandRecord) == 80);
static_assert(sizeof(WasmDebugEventRecord) == 340);
static_assert(sizeof(WasmDebugFrameRecord) == 88);
static_assert(sizeof(WasmDbiProcessState) == 40);
static_assert(sizeof(void*) == sizeof(uint32_t));

ICorDebug* g_cordb = nullptr;
bool g_connectedToRuntime = false;
uint32_t g_connectedRuntimeBase = 0;
uint32_t g_syntheticProcessId = 1;
uint8_t g_lastRuntimeEvent[MaxTransportMessageBytes];
uint32_t g_lastRuntimeEventLength = 0;
WasmDebugEventRecord g_lastRuntimeEventRecord{};
WasmDebugFrameRecord g_lastRuntimeFrameRecord{};

// Defense-in-depth handshake flag. The host MUST call
// coreclr_wasm_dbi_dac_acknowledge_protocol with the matching
// (magic, abi, counter) triple before invoking any product-tier
// DAC/DBI session, breakpoint, or runtime-event entry point. Even
// though get_version_blob and check_protocol let the host inspect
// the contract first, gating the work itself prevents a confused or
// out-of-date host from driving DBI into undefined states.
//
// The flag is cleared on session_destroy so each session re-validates
// against the current sidecar contract, mirroring the desktop pattern
// where every Initialize/Terminate cycle re-runs the version check.
//
// This is a plain bool, not std::atomic<bool>, because the browser-wasm
// sidecar is single-threaded today (no SharedArrayBuffer, no pthreads,
// no JSPI in the pinned emsdk). If/when the sidecar is rebuilt against
// an emsdk that enables WebAssembly threads, this should become
// std::atomic<bool> with acquire/release ordering on the gate path.
bool g_protocolAcknowledged = false;

class WasmDacDataTarget;

int32_t ReadRuntimeContractDescriptor(
    WasmDacDataTarget& dataTarget,
    uint32_t runtimeBase,
    ContractDescriptorLayout* descriptor);

int32_t SendRuntimeCommand(const char* command, uint32_t commandLength);
int32_t SendRuntimeCommandRecord(const WasmDebugCommandRecord& command);

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
extern "C" int32_t coreclr_wasm_dbi_dac_probe_test_data(uint32_t runtimeBase, uint32_t probeOutAddress);

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

int32_t SendRuntimeCommandRecord(const WasmDebugCommandRecord& command)
{
    int32_t result = coreclr_wasm_dbi_dac_send_ipc_to_runtime(
        static_cast<uint32_t>(reinterpret_cast<uintptr_t>(&command)),
        sizeof(command));
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

WASM_DBI_DAC_EXPORT(coreclr_wasm_dbi_dac_get_abi_version)
uint32_t coreclr_wasm_dbi_dac_get_abi_version()
{
    return WasmDbiDacAbiVersion;
}

WASM_DBI_DAC_EXPORT(coreclr_wasm_dbi_dac_get_component_mask)
uint32_t coreclr_wasm_dbi_dac_get_component_mask()
{
    return ComponentScaffold | ComponentCeeDac | ComponentDaccess | ComponentCordbdi;
}

// Write the self-describing version blob into target-memory at
// `blobOutAddress`. The blob is binary-stable: hosts read the first
// uint32 (Magic) to validate the format, the next uint32 (BlobSize) to
// learn how many bytes to consume, and may treat any trailing bytes as
// reserved-for-future-use. `bytesWrittenAddress` always receives the
// number of bytes needed even when `blobOutLength` is too small, so
// hosts can size-and-retry in a single round trip.
WASM_DBI_DAC_EXPORT(coreclr_wasm_dbi_dac_get_version_blob)
int32_t coreclr_wasm_dbi_dac_get_version_blob(uint32_t blobOutAddress, uint32_t blobOutLength, uint32_t bytesWrittenAddress)
{
    if (bytesWrittenAddress == 0)
    {
        return InvalidArgument;
    }

    const uint32_t needed = static_cast<uint32_t>(sizeof(WasmDbiDacVersionBlob));
    memcpy(reinterpret_cast<void*>(static_cast<uintptr_t>(bytesWrittenAddress)), &needed, sizeof(needed));

    if (blobOutAddress == 0 && needed != 0)
    {
        return InvalidArgument;
    }

    if (blobOutLength < needed)
    {
        return BufferTooSmall;
    }

    WasmDbiDacVersionBlob blob{};
    blob.Magic = WasmDbiDacVersionBlobMagic;
    blob.BlobSize = needed;
    blob.AbiVersion = WasmDbiDacAbiVersion;
    blob.ProtocolBreakingChangeCounter = WasmDbiDacProtocolBreakingChangeCounter;
    blob.ComponentMask = coreclr_wasm_dbi_dac_get_component_mask();
    blob.SidecarBuildVersionMS = WasmDbiDacSidecarBuildVersionMS;
    blob.SidecarBuildVersionLS = WasmDbiDacSidecarBuildVersionLS;
    blob.Reserved = 0;

    memcpy(reinterpret_cast<void*>(static_cast<uintptr_t>(blobOutAddress)), &blob, sizeof(blob));
    return Success;
}

// Compare a host-supplied (magic, abiVersion, protocolBreakingChangeCounter)
// triple against this sidecar's contract. Returns S_OK (0) when the host
// speaks the same protocol, and CORDBG_E_INCOMPATIBLE_PROTOCOL (0x8013134B)
// otherwise. This mirrors the desktop CheckDbiVersion contract at
// src/coreclr/debug/daccess/dacdbiimpl.cpp so the JS host can route the
// same HRESULT back to mscordbi callers when wiring up real DBI flow.
WASM_DBI_DAC_EXPORT(coreclr_wasm_dbi_dac_check_protocol)
int32_t coreclr_wasm_dbi_dac_check_protocol(uint32_t hostMagic, uint32_t hostAbiVersion, uint32_t hostProtocolBreakingChangeCounter)
{
    if (hostMagic != WasmDbiDacVersionBlobMagic)
    {
        return HrIncompatibleProtocol;
    }

    if (hostAbiVersion != WasmDbiDacAbiVersion)
    {
        return HrIncompatibleProtocol;
    }

    if (hostProtocolBreakingChangeCounter != WasmDbiDacProtocolBreakingChangeCounter)
    {
        return HrIncompatibleProtocol;
    }

    return Success;
}

// Acknowledge that the host has read get_version_blob and accepts the
// sidecar contract. Runs check_protocol on the supplied triple; on
// success, latches g_protocolAcknowledged so subsequent gated entry
// points (session_create, connect_runtime, set_breakpoint_*, continue,
// poll_event, receive_runtime_event, etc.) can proceed. On failure,
// clears the latch and returns CORDBG_E_INCOMPATIBLE_PROTOCOL so a
// previously valid handshake cannot survive a subsequent bad call.
//
// Calling this with the correct triple is idempotent. Calling with a
// bad triple is always disqualifying: the host must reissue with the
// matching values to re-enable DBI traffic.
WASM_DBI_DAC_EXPORT(coreclr_wasm_dbi_dac_acknowledge_protocol)
int32_t coreclr_wasm_dbi_dac_acknowledge_protocol(uint32_t hostMagic, uint32_t hostAbiVersion, uint32_t hostProtocolBreakingChangeCounter)
{
    int32_t check = coreclr_wasm_dbi_dac_check_protocol(hostMagic, hostAbiVersion, hostProtocolBreakingChangeCounter);
    if (check != Success)
    {
        g_protocolAcknowledged = false;
        return check;
    }

    g_protocolAcknowledged = true;
    return Success;
}

// Helper for gated entry points; inlined by every call site to keep
// the read-the-flag-and-fail pattern visible at the top of each
// export's body.
int32_t EnsureProtocolAcknowledged()
{
    return g_protocolAcknowledged ? Success : HrIncompatibleProtocol;
}

WASM_DBI_DAC_EXPORT_TESTS_ONLY(coreclr_wasm_dbi_dac_copy_from_target)
int32_t coreclr_wasm_dbi_dac_copy_from_target(uint32_t targetAddress, uint32_t debuggerAddress, uint32_t byteCount)
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

WASM_DBI_DAC_EXPORT_TESTS_ONLY(coreclr_wasm_dbi_dac_try_get_symbol)
int32_t coreclr_wasm_dbi_dac_try_get_symbol(uint32_t symbolNameAddress, uint32_t symbolNameLength, uint32_t addressOutAddress)
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

WASM_DBI_DAC_EXPORT_TESTS_ONLY(coreclr_wasm_dbi_dac_probe_runtime_contract_descriptor)
int32_t coreclr_wasm_dbi_dac_probe_runtime_contract_descriptor(uint32_t runtimeBase, uint32_t probeOutAddress)
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

WASM_DBI_DAC_EXPORT_TESTS_ONLY(coreclr_wasm_dbi_dac_probe_contract_pointer_data)
int32_t coreclr_wasm_dbi_dac_probe_contract_pointer_data(uint32_t runtimeBase, uint32_t pointerDataIndex, uint32_t probeOutAddress)
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

WASM_DBI_DAC_EXPORT_TESTS_ONLY(coreclr_wasm_dbi_dac_probe_test_data)
int32_t coreclr_wasm_dbi_dac_probe_test_data(uint32_t runtimeBase, uint32_t probeOutAddress)
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

WASM_DBI_DAC_EXPORT_TESTS_ONLY(coreclr_wasm_dbi_dac_create_clr_data_instance)
int32_t coreclr_wasm_dbi_dac_create_clr_data_instance(uint32_t runtimeBase)
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

WASM_DBI_DAC_EXPORT_TESTS_ONLY(coreclr_wasm_dbi_dac_create_dac_dbi_interface)
int32_t coreclr_wasm_dbi_dac_create_dac_dbi_interface(uint32_t runtimeBase)
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

WASM_DBI_DAC_EXPORT(coreclr_wasm_dbi_dac_dbi_session_create)
int32_t coreclr_wasm_dbi_dac_dbi_session_create()
{
    int32_t gate = EnsureProtocolAcknowledged();
    if (gate != Success)
    {
        return gate;
    }

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

WASM_DBI_DAC_EXPORT(coreclr_wasm_dbi_dac_dbi_session_create_process)
int32_t coreclr_wasm_dbi_dac_dbi_session_create_process()
{
    int32_t gate = EnsureProtocolAcknowledged();
    if (gate != Success)
    {
        return gate;
    }

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

WASM_DBI_DAC_EXPORT(coreclr_wasm_dbi_dac_dbi_connect_runtime)
int32_t coreclr_wasm_dbi_dac_dbi_connect_runtime(uint32_t runtimeBase)
{
    int32_t gate = EnsureProtocolAcknowledged();
    if (gate != Success)
    {
        return gate;
    }

    if (g_cordb == nullptr || runtimeBase == 0)
    {
        return E_FAIL;
    }

    if (g_connectedToRuntime)
    {
        return S_OK;
    }

    g_connectedToRuntime = true;
    g_connectedRuntimeBase = runtimeBase;
    g_lastRuntimeEventLength = 0;
    memset(&g_lastRuntimeEventRecord, 0, sizeof(g_lastRuntimeEventRecord));
    memset(&g_lastRuntimeFrameRecord, 0, sizeof(g_lastRuntimeFrameRecord));
    return S_OK;
}

WASM_DBI_DAC_EXPORT(coreclr_wasm_dbi_dac_dbi_disconnect_runtime)
int32_t coreclr_wasm_dbi_dac_dbi_disconnect_runtime()
{
    int32_t gate = EnsureProtocolAcknowledged();
    if (gate != Success)
    {
        return gate;
    }

    g_connectedToRuntime = false;
    g_connectedRuntimeBase = 0;
    g_lastRuntimeEventLength = 0;
    memset(&g_lastRuntimeEventRecord, 0, sizeof(g_lastRuntimeEventRecord));
    memset(&g_lastRuntimeFrameRecord, 0, sizeof(g_lastRuntimeFrameRecord));
    return S_OK;
}

WASM_DBI_DAC_EXPORT_TESTS_ONLY(coreclr_wasm_dbi_dac_dbi_read_test_data)
int32_t coreclr_wasm_dbi_dac_dbi_read_test_data(uint32_t probeOutAddress)
{
    if (g_cordb == nullptr || !g_connectedToRuntime)
    {
        return E_FAIL;
    }

    return coreclr_wasm_dbi_dac_probe_test_data(g_connectedRuntimeBase, probeOutAddress);
}

WASM_DBI_DAC_EXPORT(coreclr_wasm_dbi_dac_dbi_set_breakpoint_by_name)
int32_t coreclr_wasm_dbi_dac_dbi_set_breakpoint_by_name(uint32_t nameAddress, uint32_t nameLength)
{
    int32_t gate = EnsureProtocolAcknowledged();
    if (gate != Success)
    {
        return gate;
    }

    if (g_cordb == nullptr || !g_connectedToRuntime || (nameAddress == 0 && nameLength != 0))
    {
        return E_FAIL;
    }

    if (nameLength == 0 || nameLength >= sizeof(WasmDebugCommandRecord::MethodName))
    {
        return InvalidArgument;
    }

    WasmDebugCommandRecord command{};
    command.Magic = WasmDebugCommandRecordMagic;
    command.Kind = static_cast<uint32_t>(WasmDebugCommandKind::SetBreakpointByName);
    memcpy(command.MethodName, reinterpret_cast<void*>(static_cast<uintptr_t>(nameAddress)), nameLength);
    return SendRuntimeCommandRecord(command);
}

WASM_DBI_DAC_EXPORT(coreclr_wasm_dbi_dac_dbi_set_breakpoint_by_token)
int32_t coreclr_wasm_dbi_dac_dbi_set_breakpoint_by_token(uint32_t methodToken, uint32_t ilOffset)
{
    int32_t gate = EnsureProtocolAcknowledged();
    if (gate != Success)
    {
        return gate;
    }

    if (g_cordb == nullptr || !g_connectedToRuntime)
    {
        return E_FAIL;
    }

    if (methodToken == 0 || ilOffset != 0)
    {
        return E_NOTIMPL;
    }

    WasmDebugCommandRecord command{};
    command.Magic = WasmDebugCommandRecordMagic;
    command.Kind = static_cast<uint32_t>(WasmDebugCommandKind::SetBreakpointByToken);
    command.MethodToken = methodToken;
    command.ILOffset = ilOffset;
    return SendRuntimeCommandRecord(command);
}

WASM_DBI_DAC_EXPORT(coreclr_wasm_dbi_dac_dbi_continue)
int32_t coreclr_wasm_dbi_dac_dbi_continue()
{
    int32_t gate = EnsureProtocolAcknowledged();
    if (gate != Success)
    {
        return gate;
    }

    if (g_cordb == nullptr || !g_connectedToRuntime)
    {
        return E_FAIL;
    }

    WasmDebugCommandRecord command{};
    command.Magic = WasmDebugCommandRecordMagic;
    command.Kind = static_cast<uint32_t>(WasmDebugCommandKind::Continue);
    return SendRuntimeCommandRecord(command);
}

WASM_DBI_DAC_EXPORT(coreclr_wasm_dbi_dac_dbi_poll_event)
int32_t coreclr_wasm_dbi_dac_dbi_poll_event(uint32_t bufferAddress, uint32_t bufferLength, uint32_t bytesWrittenAddress)
{
    int32_t gate = EnsureProtocolAcknowledged();
    if (gate != Success)
    {
        return gate;
    }

    if (g_cordb == nullptr || !g_connectedToRuntime)
    {
        return E_FAIL;
    }

    return coreclr_wasm_dbi_dac_transport_get_last_event(bufferAddress, bufferLength, bytesWrittenAddress);
}

WASM_DBI_DAC_EXPORT(coreclr_wasm_dbi_dac_dbi_poll_event_record)
int32_t coreclr_wasm_dbi_dac_dbi_poll_event_record(uint32_t bufferAddress, uint32_t bufferLength, uint32_t bytesWrittenAddress)
{
    int32_t gate = EnsureProtocolAcknowledged();
    if (gate != Success)
    {
        return gate;
    }

    if (g_cordb == nullptr || !g_connectedToRuntime)
    {
        return E_FAIL;
    }

    if (bytesWrittenAddress == 0 || bufferAddress == 0)
    {
        return InvalidArgument;
    }

    uint32_t recordSize = sizeof(WasmDebugEventRecord);
    if (bufferLength < recordSize)
    {
        return BufferTooSmall;
    }

    memcpy(reinterpret_cast<void*>(static_cast<uintptr_t>(bufferAddress)), &g_lastRuntimeEventRecord, recordSize);
    memcpy(reinterpret_cast<void*>(static_cast<uintptr_t>(bytesWrittenAddress)), &recordSize, sizeof(recordSize));
    return S_OK;
}

WASM_DBI_DAC_EXPORT(coreclr_wasm_dbi_dac_dbi_poll_frame_record)
int32_t coreclr_wasm_dbi_dac_dbi_poll_frame_record(uint32_t bufferAddress, uint32_t bufferLength, uint32_t bytesWrittenAddress)
{
    int32_t gate = EnsureProtocolAcknowledged();
    if (gate != Success)
    {
        return gate;
    }

    if (g_cordb == nullptr || !g_connectedToRuntime)
    {
        return E_FAIL;
    }

    if (bytesWrittenAddress == 0 || bufferAddress == 0)
    {
        return InvalidArgument;
    }

    uint32_t recordSize = sizeof(WasmDebugFrameRecord);
    if (bufferLength < recordSize)
    {
        return BufferTooSmall;
    }

    memcpy(reinterpret_cast<void*>(static_cast<uintptr_t>(bufferAddress)), &g_lastRuntimeFrameRecord, recordSize);
    memcpy(reinterpret_cast<void*>(static_cast<uintptr_t>(bytesWrittenAddress)), &recordSize, sizeof(recordSize));
    return S_OK;
}

WASM_DBI_DAC_EXPORT(coreclr_wasm_dbi_dac_dbi_poll_process_state)
int32_t coreclr_wasm_dbi_dac_dbi_poll_process_state(uint32_t bufferAddress, uint32_t bufferLength, uint32_t bytesWrittenAddress)
{
    int32_t gate = EnsureProtocolAcknowledged();
    if (gate != Success)
    {
        return gate;
    }

    if (bytesWrittenAddress == 0 || bufferAddress == 0)
    {
        return InvalidArgument;
    }

    uint32_t recordSize = sizeof(WasmDbiProcessState);
    if (bufferLength < recordSize)
    {
        return BufferTooSmall;
    }

    WasmDbiProcessState state{};
    state.SessionCreated = g_cordb != nullptr ? 1 : 0;
    state.Connected = g_connectedToRuntime ? 1 : 0;
    state.RuntimeBase = g_connectedRuntimeBase;
    state.SyntheticProcessId = g_connectedToRuntime ? g_syntheticProcessId : 0;
    state.HasRealCordbProcess = 0;
    state.LastEventKind = g_lastRuntimeEventRecord.Kind;
    state.LastMethodToken = g_lastRuntimeEventRecord.MethodToken;
    state.LastILOffset = g_lastRuntimeEventRecord.ILOffset;
    state.BreakpointHitCount = g_lastRuntimeEventRecord.HitCount;
    state.ContinueCount = g_lastRuntimeEventRecord.ContinueCount;

    memcpy(reinterpret_cast<void*>(static_cast<uintptr_t>(bufferAddress)), &state, sizeof(state));
    memcpy(reinterpret_cast<void*>(static_cast<uintptr_t>(bytesWrittenAddress)), &recordSize, sizeof(recordSize));
    return S_OK;
}

WASM_DBI_DAC_EXPORT(coreclr_wasm_dbi_dac_dbi_session_destroy)
int32_t coreclr_wasm_dbi_dac_dbi_session_destroy()
{
    // session_destroy is intentionally NOT gated on g_protocolAcknowledged
    // so a host that lost handshake state can still tear down cleanly.
    // The ack flag is cleared at the end so any new session must
    // re-handshake before doing further DBI work.

    if (g_cordb == nullptr)
    {
        g_protocolAcknowledged = false;
        return S_OK;
    }

    ICorDebug* cordb = g_cordb;
    g_cordb = nullptr;
    g_connectedToRuntime = false;
    g_connectedRuntimeBase = 0;
    g_lastRuntimeEventLength = 0;
    memset(&g_lastRuntimeEventRecord, 0, sizeof(g_lastRuntimeEventRecord));
    memset(&g_lastRuntimeFrameRecord, 0, sizeof(g_lastRuntimeFrameRecord));

    HRESULT result = cordb->Terminate();
    cordb->Release();
    g_protocolAcknowledged = false;
    return result;
}

WASM_DBI_DAC_EXPORT_TESTS_ONLY(coreclr_wasm_dbi_dac_transport_send_test_message)
int32_t coreclr_wasm_dbi_dac_transport_send_test_message(uint32_t messageAddress, uint32_t messageLength)
{
    if ((messageAddress == 0 && messageLength != 0) || messageLength >= MaxTransportMessageBytes)
    {
        return InvalidArgument;
    }

    int32_t result = coreclr_wasm_dbi_dac_send_ipc_to_runtime(messageAddress, messageLength);
    return result == Success ? Success : result;
}

WASM_DBI_DAC_EXPORT(coreclr_wasm_dbi_dac_receive_runtime_event)
int32_t coreclr_wasm_dbi_dac_receive_runtime_event(uint32_t eventAddress, uint32_t eventLength)
{
    int32_t gate = EnsureProtocolAcknowledged();
    if (gate != Success)
    {
        return gate;
    }

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

WASM_DBI_DAC_EXPORT(coreclr_wasm_dbi_dac_receive_runtime_event_record)
int32_t coreclr_wasm_dbi_dac_receive_runtime_event_record(uint32_t eventRecordAddress, uint32_t eventRecordLength)
{
    int32_t gate = EnsureProtocolAcknowledged();
    if (gate != Success)
    {
        return gate;
    }

    if (g_cordb == nullptr || !g_connectedToRuntime)
    {
        return E_FAIL;
    }

    if (eventRecordAddress == 0 || eventRecordLength != sizeof(WasmDebugEventRecord))
    {
        return InvalidArgument;
    }

    memcpy(&g_lastRuntimeEventRecord, reinterpret_cast<void*>(static_cast<uintptr_t>(eventRecordAddress)), sizeof(g_lastRuntimeEventRecord));
    return Success;
}

WASM_DBI_DAC_EXPORT(coreclr_wasm_dbi_dac_receive_runtime_frame_record)
int32_t coreclr_wasm_dbi_dac_receive_runtime_frame_record(uint32_t frameRecordAddress, uint32_t frameRecordLength)
{
    int32_t gate = EnsureProtocolAcknowledged();
    if (gate != Success)
    {
        return gate;
    }

    if (g_cordb == nullptr || !g_connectedToRuntime)
    {
        return E_FAIL;
    }

    if (frameRecordAddress == 0 || frameRecordLength != sizeof(WasmDebugFrameRecord))
    {
        return InvalidArgument;
    }

    memcpy(&g_lastRuntimeFrameRecord, reinterpret_cast<void*>(static_cast<uintptr_t>(frameRecordAddress)), sizeof(g_lastRuntimeFrameRecord));
    return Success;
}

WASM_DBI_DAC_EXPORT_TESTS_ONLY(coreclr_wasm_dbi_dac_transport_get_last_event)
int32_t coreclr_wasm_dbi_dac_transport_get_last_event(uint32_t bufferAddress, uint32_t bufferLength, uint32_t bytesWrittenAddress)
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

WASM_DBI_DAC_EXPORT_TESTS_ONLY(coreclr_wasm_dbi_dac_probe_breakpoint_control)
int32_t coreclr_wasm_dbi_dac_probe_breakpoint_control(uint32_t probeOutAddress)
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

WASM_DBI_DAC_EXPORT_TESTS_ONLY(coreclr_wasm_dbi_dac_create_cordb_object)
int32_t coreclr_wasm_dbi_dac_create_cordb_object()
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
