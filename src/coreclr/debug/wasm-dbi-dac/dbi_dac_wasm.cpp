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

// V3 attach entry from src/coreclr/debug/di/process.cpp:61. Declared here
// because the function is exported as DLLEXPORT from the DBI side without
// a public header declaration. The wasm sidecar can call it directly
// because cordbdi is statically linked into the same module.
struct _CLR_DEBUGGING_VERSION;
EXTERN_C HRESULT STDMETHODCALLTYPE OpenVirtualProcessImpl(
    ULONG64 clrInstanceId,
    IUnknown* pDataTarget,
    HMODULE hDacModule,
    _CLR_DEBUGGING_VERSION* pMaxDebuggerSupportedVersion,
    REFIID riid,
    IUnknown** ppInstance,
    DWORD* pFlagsOut);

// Minimal facade-side view of IDacDbiInterface, replicating just the leading
// vtable slots so we can invoke DacSetTargetConsistencyChecks without pulling
// in the full dacdbiinterface.h dependency chain (which transitively needs
// crst.h and other VM-internal headers not visible from this facade
// compilation unit). The vtable order must stay in sync with
// src/coreclr/debug/inc/dacdbiinterface.h:169 (IDacDbiInterface) — see
// CheckDbiVersion / FlushCache / DacSetTargetConsistencyChecks at lines
// 193 / 207 / 230 respectively. The earlier methods are never called through
// this declaration so their argument types are stubbed as void*; only the
// slot count and the signature of DacSetTargetConsistencyChecks need to be
// accurate.
struct WasmIDacDbiInterfaceMinimal : public IUnknown
{
    virtual HRESULT STDMETHODCALLTYPE CheckDbiVersion(const void* pVersion) = 0;
    virtual HRESULT STDMETHODCALLTYPE FlushCache() = 0;
    virtual HRESULT STDMETHODCALLTYPE DacSetTargetConsistencyChecks(BOOL fEnableAsserts) = 0;
};

namespace
{
constexpr uint32_t WasmDbiDacAbiVersion = 1;
constexpr uint64_t ContractDescriptorMagic = 0x0043414443434e44;
constexpr uint32_t TestDataMagic = 0x43445744;
constexpr uint32_t MaxTransportMessageBytes = 256;
constexpr uint32_t WasmDebugCommandRecordMagic = 0x434d4457;
constexpr uint32_t WasmDebugBreakpointSlotCapacity = 16;
constexpr uint32_t WasmDebugBreakpointEnumerationHeaderSize = 8;
constexpr uint32_t WasmDebugMaxLocalsPerFrame = 32;
constexpr uint32_t WasmDebugLocalsRecordMagic = 0x524C4457; // 'WDLR' little-endian

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
//   2 - add dbi_enumerate_breakpoints sidecar export + slot-table payload.
//   3 - add structured DB_IPCE_CONTINUE request import/export path.
//   4 - add dbi_enumerate_locals sidecar export + locals-record payload.
//   5 - add structured DB_IPCE_STEP_INTO request import/export path.
constexpr uint32_t WasmDbiDacProtocolBreakingChangeCounter = 5;

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
    InvalidReadRange = -8,
    InvalidSymbolName = -9,
};

// Maximum byte count accepted by a single ReadVirtual / copy_from_target
// call. Caps a single read at 256 MiB so a confused or malicious host
// cannot trigger a runaway host-side memcpy, a wasm memory-growth
// avalanche, or an out-of-bounds JS host-callback that pushes past the
// 4 GiB wasm32 linear-memory ceiling. DAC's largest legitimate single
// read in practice is a small data structure (a few KiB), so the cap
// is comfortably above any real workload while still bounding worst-
// case behaviour.
constexpr uint32_t MaxReadVirtualBytes = 256u * 1024u * 1024u;

// Maximum byte count accepted for a symbol name in any symbol-lookup
// callback. Caps the value at 256 bytes, which is well above any real
// CoreCLR symbol name (the longest in the runtime today is ~70 chars)
// but small enough to bound JS-side TextDecoder work and prevent a
// confused or malicious host from forwarding a multi-megabyte buffer
// for "symbol resolution". Also defends against unbounded strlen()
// scans on non-NUL-terminated input by anchoring strnlen at this limit.
constexpr uint32_t MaxSymbolNameBytes = 256;

// Validate a wasm32 target read of [address, address + byteCount) and
// matching debugger-side write at [debuggerAddress, debuggerAddress +
// byteCount). Returns true when both ranges fit inside 32-bit linear
// memory and byteCount is within MaxReadVirtualBytes. A zero-byte read
// is always considered valid; callers should special-case it before
// invoking the host callback.
inline bool IsValidWasmReadRange(uint64_t address, uint64_t debuggerAddress, uint32_t byteCount)
{
    if (byteCount == 0)
    {
        return true;
    }
    if (byteCount > MaxReadVirtualBytes)
    {
        return false;
    }
    // address + byteCount - 1 must fit in 32 bits.
    if (address > UINT32_MAX || address > static_cast<uint64_t>(UINT32_MAX) - (byteCount - 1))
    {
        return false;
    }
    if (debuggerAddress > UINT32_MAX || debuggerAddress > static_cast<uint64_t>(UINT32_MAX) - (byteCount - 1))
    {
        return false;
    }
    return true;
}

// Validate a wasm32 symbol-name buffer at [symbolNameAddress,
// symbolNameAddress + symbolNameLength). Rejects empty names, names
// longer than MaxSymbolNameBytes, a null buffer pointer with non-zero
// length, and ranges that wrap past the 4 GiB wasm32 linear-memory
// ceiling. The complementary debugger-side bounds check (the buffer
// actually fits inside the sidecar's heap) is the JS host's
// responsibility because it depends on the live heap size.
inline bool IsValidSymbolNameRange(uint32_t symbolNameAddress, uint32_t symbolNameLength)
{
    if (symbolNameLength == 0 || symbolNameLength > MaxSymbolNameBytes)
    {
        return false;
    }
    if (symbolNameAddress == 0)
    {
        return false;
    }
    // symbolNameAddress + symbolNameLength - 1 must fit in 32 bits.
    if (symbolNameAddress > UINT32_MAX - (symbolNameLength - 1))
    {
        return false;
    }
    return true;
}

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

struct WasmDebugBreakpointSlotMirror
{
    uint8_t Armed;
    uint8_t IsOneShot;
    char MethodName[64];
    uint8_t Pad0[2];
    uint32_t MethodToken;
    uint32_t PatchAddress;
    int32_t OriginalOpcode;
    uint8_t PatchActive;
    uint8_t Pad1[3];
    uint32_t HitCount;
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

struct WasmDebugLocalRecord
{
    uint32_t ILSlot;
    uint32_t TypeTag;
    uint32_t ByteOffset;
    uint32_t ByteSize;
    char Name[32];
};

struct WasmDebugLocalsRecord
{
    uint32_t Magic;
    uint32_t Version;
    uint32_t MethodToken;
    uint32_t LocalCount;
    WasmDebugLocalRecord Locals[WasmDebugMaxLocalsPerFrame];
};

// Phase 4 first slice: a simplified wire-format mirror of
// DebuggerIPCEvent::BreakpointData + the DebuggerIPCEvent header
// (src/coreclr/debug/inc/dbgipcevents.h:1696-1761). The real
// DebuggerIPCEvent is a heavy union with VMPTR/LSPTR internal types
// that pulls the full VM internal header graph; the wasm sidecar
// transports the same logical fields through this simpler, fixed-layout
// struct that uses only plain integer types. Phase 4 expansion will
// either replace this with the real DebuggerIPCEvent layout (and pull
// in the headers) or keep a translation layer; today this is the wire
// format the wasm sidecar emits and accepts for DB_IPCE_BREAKPOINT.
//
// Fields mirror DebuggerIPCEvent::BreakpointData and the event header:
//   Magic              - 'IPCB' (0x42435049) sanity tag.
//   Type               - DB_IPCE_BREAKPOINT (0x0100) from dbgipceventtypes.h.
//   ProcessId/ThreadId - from DebuggerIPCEvent header.
//   VmAppDomain/Thread - 64-bit slots matching Portable<VMPTR_*> layout
//                         (DebuggerIPCEvent uses portable 64-bit ptrs
//                         even on 32-bit hosts so cross-architecture
//                         debugging works; we keep the same width).
//   Hr                 - from DebuggerIPCEvent::hr.
//   Flags              - bit 0: replyRequired, bit 1: asyncSend.
//   BreakpointToken    - LSPTR_BREAKPOINT (left-side opaque token).
//   FuncMetadataToken  - mdMethodDef (the patched method).
//   VmAssembly         - Portable<VMPTR_Assembly>.
//   IsIL               - 0/1.
//   Offset             - IL offset (when IsIL) or native offset.
//   EncVersion         - edit-and-continue version (0 today on wasm).
//   NativeCodeMethodDescToken - LSPTR_METHODDESC (when !IsIL).
//   CodeStartAddress   - CORDB_ADDRESS.
struct WasmDbgIpcEventBreakpoint
{
    uint32_t Magic;
    uint32_t Type;
    uint32_t ProcessId;
    uint32_t ThreadId;
    uint64_t VmAppDomain;
    uint64_t VmThread;
    int32_t Hr;
    uint32_t Flags;
    uint64_t BreakpointToken;
    uint32_t FuncMetadataToken;
    uint32_t Reserved0;             // pad for 8-byte alignment of next field
    uint64_t VmAssembly;
    uint32_t IsIL;
    uint32_t Offset;
    uint32_t EncVersion;
    uint32_t Reserved1;             // pad for 8-byte alignment of next field
    uint64_t NativeCodeMethodDescToken;
    uint64_t CodeStartAddress;
};

struct WasmDbgIpcEventContinueRequest
{
    uint32_t Magic;
    uint32_t Type;
    uint32_t ProcessId;
    uint32_t ThreadId;
    uint64_t BreakpointToken;
    uint32_t Flags;
    uint32_t Reserved0;             // pad for 8-byte alignment of future fields
};

struct WasmDbgIpcEventStepIntoRequest
{
    uint32_t Magic;
    uint32_t Type;
    uint32_t ProcessId;
    uint32_t ThreadId;
    uint64_t BreakpointToken;
    uint32_t Flags;
    uint32_t Reserved0;             // pad for 8-byte alignment of future fields
};

constexpr uint32_t WasmDbgIpcEventBreakpointMagic = 0x42435049;  // 'IPCB' little-endian
constexpr uint32_t WasmDbgIpcEventTypeBreakpoint = 0x0100;       // DB_IPCE_BREAKPOINT
constexpr uint32_t WasmDbgIpcEventContinueRequestMagic = 0x43435049; // 'IPCC' little-endian
constexpr uint32_t WasmDbgIpcEventTypeContinueRequest = 0x0201;      // DB_IPCE_CONTINUE
constexpr uint32_t WasmDbgIpcEventStepIntoRequestMagic = 0x53435049; // 'IPCS' little-endian
constexpr uint32_t WasmDbgIpcEventTypeStepIntoRequest = 0x0102;      // wasm-private StepInto request
constexpr uint32_t WasmDbgIpcEventFlagReplyRequired = 0x1;
constexpr uint32_t WasmDbgIpcEventFlagAsyncSend = 0x2;

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

constexpr uint32_t WasmDebugBreakpointSlotMirrorSize = static_cast<uint32_t>(sizeof(WasmDebugBreakpointSlotMirror));
constexpr uint32_t WasmDebugBreakpointEnumerationSize =
    WasmDebugBreakpointEnumerationHeaderSize +
    (WasmDebugBreakpointSlotCapacity * WasmDebugBreakpointSlotMirrorSize);

static_assert(sizeof(ContractDescriptorLayout) == 32);
static_assert(sizeof(ContractPointerDataProbe) == 8);
static_assert(sizeof(TestDataProbe) == 48);
static_assert(sizeof(DbiControlProbe) == 16);
static_assert(sizeof(WasmDbiDacVersionBlob) == 32);
static_assert(sizeof(WasmDebugCommandRecord) == 80);
static_assert(sizeof(WasmDebugBreakpointSlotMirror) == 88);
static_assert(sizeof(WasmDebugEventRecord) == 340);
static_assert(sizeof(WasmDebugFrameRecord) == 88);
static_assert(sizeof(WasmDebugLocalRecord) == 48);
static_assert(sizeof(WasmDebugLocalsRecord) == 16 + 32 * 48);
static_assert(sizeof(WasmDbgIpcEventBreakpoint) == 96);
static_assert(sizeof(WasmDbgIpcEventContinueRequest) == 32);
static_assert(sizeof(WasmDbgIpcEventStepIntoRequest) == 32);
static_assert(sizeof(WasmDbiProcessState) == 40);
static_assert(sizeof(void*) == sizeof(uint32_t));

// Page cache for ReadTargetMemory results. Most DAC reads are small
// (a few bytes) and clustered around the same runtime data structures
// (e.g., a contract pointer-data slot, then five adjacent words of the
// pointed-to record). Without a cache, every read crosses the JS host
// bridge, which dominates wall-clock cost in real DAC workloads.
//
// Design:
//  - Single-page fully-associative cache (linear scan of N small slots).
//  - 4 KiB pages, 32 slots = 128 KiB of cache memory (negligible vs.
//    the 5+ MiB sidecar wasm binary).
//  - LRU eviction via a monotonically-increasing tick counter.
//  - O(1) invalidation: bump the epoch; entries from a prior epoch are
//    treated as invalid on the next lookup. No need to scan + clear.
//  - Cross-page reads (rare in DAC) bypass the cache entirely.
//
// Invalidation triggers (callers responsible):
//  - DBI session connects to a new runtime instance.
//  - DBI session disconnects.
//  - DBI continues a stopped target (memory may advance).
//  - Explicit host call to coreclr_wasm_dbi_dac_invalidate_page_cache.
//
// This is correct under wasm32's single-threaded execution model. If
// the sidecar is ever rebuilt against threads-enabled emsdk, the stats
// fields and the cache itself need synchronization.
constexpr uint32_t PageCachePageSize = 4096;
constexpr uint32_t PageCacheEntries = 32;
constexpr uint32_t PageCachePageMask = PageCachePageSize - 1;
static_assert((PageCachePageSize & (PageCachePageSize - 1)) == 0,
              "PageCachePageSize must be a power of 2 so that PageCachePageMask is a valid offset mask.");

struct PageCacheEntry
{
    uint32_t PageAddress;   // page-aligned target address; valid only when Epoch == g_currentEpoch
    uint32_t Epoch;         // epoch at insertion; mismatched = invalid
    uint32_t LastUseTick;   // for LRU eviction
    uint8_t Data[PageCachePageSize];
};

struct PageCacheStatsBlob
{
    uint32_t Epoch;
    uint32_t Hits;
    uint32_t Misses;
    uint32_t Bypasses;
    uint32_t Invalidations;
    uint32_t Pad0;
};

static_assert(sizeof(PageCacheStatsBlob) == 24);

PageCacheEntry g_pageCache[PageCacheEntries] = {};
uint32_t g_pageCacheEpoch = 1;
uint32_t g_pageCacheTick = 0;
uint32_t g_pageCacheHits = 0;
uint32_t g_pageCacheMisses = 0;
uint32_t g_pageCacheBypasses = 0;
uint32_t g_pageCacheInvalidations = 0;

void InvalidatePageCache()
{
    g_pageCacheEpoch++;
    g_pageCacheInvalidations++;
    if (g_pageCacheEpoch == 0)
    {
        // Wrap-around guard. An epoch of 0 is the "never written" sentinel
        // produced by zero-init on g_pageCache, so wrapping back to 1 would
        // accidentally "validate" every cold slot. After 2^32 invalidations
        // (extraordinarily unlikely in practice) start at 2 and physically
        // zero every entry to be safe.
        g_pageCacheEpoch = 2;
        for (auto& entry : g_pageCache)
        {
            entry.Epoch = 0;
            entry.PageAddress = 0;
        }
    }
}

const PageCacheEntry* LookupPageCache(uint32_t pageAddress)
{
    for (auto& entry : g_pageCache)
    {
        if (entry.Epoch == g_pageCacheEpoch && entry.PageAddress == pageAddress)
        {
            entry.LastUseTick = ++g_pageCacheTick;
            return &entry;
        }
    }
    return nullptr;
}

PageCacheEntry* AcquirePageCacheSlot(uint32_t pageAddress)
{
    PageCacheEntry* victim = &g_pageCache[0];
    for (auto& entry : g_pageCache)
    {
        if (entry.Epoch != g_pageCacheEpoch)
        {
            victim = &entry;
            break;
        }
        if (entry.LastUseTick < victim->LastUseTick)
        {
            victim = &entry;
        }
    }

    victim->PageAddress = pageAddress;
    victim->Epoch = g_pageCacheEpoch;
    victim->LastUseTick = ++g_pageCacheTick;
    return victim;
}

ICorDebug* g_cordb = nullptr;
bool g_connectedToRuntime = false;
uint32_t g_connectedRuntimeBase = 0;
uint32_t g_syntheticProcessId = 1;
// Real V3 ICorDebugProcess obtained from OpenVirtualProcessImpl during
// dbi_connect_runtime. Held as IUnknown* to avoid pulling the entire
// ICorDebugProcess vtable header into this façade compilation unit; the
// only operation we perform on it from the façade is Release(). The
// sidecar instantiates this in addition to (not in place of) the
// existing synthetic g_connectedToRuntime / g_syntheticProcessId facade
// during the Phase 3 transition; once the synthetic facade is fully
// retired the IUnknown* will become the sole process representation.
IUnknown* g_realCordbProcess = nullptr;
uint8_t g_lastRuntimeEvent[MaxTransportMessageBytes];
uint32_t g_lastRuntimeEventLength = 0;
WasmDebugEventRecord g_lastRuntimeEventRecord{};
WasmDebugFrameRecord g_lastRuntimeFrameRecord{};
// Phase 4 slice 3 per-connection cache of the runtime-side structured-
// event symbol addresses. Resolved on first poll, retained across
// subsequent polls. MUST be cleared on disconnect_runtime so a later
// reconnect to a runtime at a different base re-resolves; the
// addresses are not validated against the new base. Co-located with
// the other per-connection globals so the disconnect handler sees
// them.
uint64_t g_cachedIpcEventValidAddress = 0;
uint64_t g_cachedIpcEventAddress = 0;
uint64_t g_cachedBreakpointSlotsAddress = 0;
uint64_t g_cachedLocalsRecordAddress = 0;

void ClearRuntimeConnectionState()
{
    if (g_realCordbProcess != nullptr)
    {
        g_realCordbProcess->Release();
        g_realCordbProcess = nullptr;
    }

    g_connectedToRuntime = false;
    g_connectedRuntimeBase = 0;
    g_lastRuntimeEventLength = 0;
    memset(&g_lastRuntimeEventRecord, 0, sizeof(g_lastRuntimeEventRecord));
    memset(&g_lastRuntimeFrameRecord, 0, sizeof(g_lastRuntimeFrameRecord));
    // Phase 4 slice 3 and Phase 7 slice 2: drop per-connection runtime
    // symbol caches so a later reconnect to a runtime at a different base
    // re-resolves via TryGetSymbol. Without this clear, cached absolute
    // addresses survive teardown and ReadVirtual would hit garbage.
    g_cachedIpcEventValidAddress = 0;
    g_cachedIpcEventAddress = 0;
    g_cachedBreakpointSlotsAddress = 0;
    g_cachedLocalsRecordAddress = 0;
    InvalidatePageCache();
}

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

        *targetPlatform = CORDB_PLATFORM_WASM32;
        return S_OK;
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

extern "C" int32_t coreclr_wasm_dbi_dac_submit_continue_request(uint32_t requestBytesAddress, uint32_t requestBytesLength)
    __attribute__((import_module("coreclr_dbi_dac"), import_name("submit_continue_request")));

extern "C" int32_t coreclr_wasm_dbi_dac_submit_step_into_request(uint32_t requestBytesAddress, uint32_t requestBytesLength)
    __attribute__((import_module("coreclr_dbi_dac"), import_name("submit_step_into_request")));

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
extern "C" int32_t coreclr_wasm_dbi_dac_probe_get_platform(uint32_t runtimeBase, uint32_t platformOutAddress);

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

    // A zero-byte read is always trivially successful, even if buffer
    // is null. DAC occasionally probes a structure size by passing 0.
    if (bytesRequested == 0)
    {
        return S_OK;
    }

    if (buffer == nullptr)
    {
        return E_INVALIDARG;
    }

    // Reject reads whose target or debugger-side range falls outside
    // 32-bit linear memory or exceeds MaxReadVirtualBytes. Without this
    // check a request for 0xFFFFFFFE bytes from address 0x10 would
    // truncate to a wrap-around that the host callback would silently
    // misinterpret.
    uint64_t debuggerAddress = reinterpret_cast<uintptr_t>(buffer);
    if (!IsValidWasmReadRange(address, debuggerAddress, bytesRequested))
    {
        return E_INVALIDARG;
    }

    // Page-cache fast path. Most DAC reads are small structure-field
    // reads that fall inside a single 4 KiB page; serving them from a
    // local cache eliminates a JS-host round-trip per access. Reads
    // that straddle a page boundary bypass the cache (rare in DAC).
    uint32_t targetAddress = static_cast<uint32_t>(address);
    uint32_t pageAddress = targetAddress & ~PageCachePageMask;
    uint32_t pageOffset = targetAddress & PageCachePageMask;
    bool fitsInPage = (pageOffset + bytesRequested) <= PageCachePageSize;

    if (fitsInPage)
    {
        const PageCacheEntry* hit = LookupPageCache(pageAddress);
        if (hit != nullptr)
        {
            memcpy(buffer, hit->Data + pageOffset, bytesRequested);
            g_pageCacheHits++;
            *bytesRead = bytesRequested;
            return S_OK;
        }

        // Miss: try to fetch the entire 4 KiB page through the host
        // bridge into a fresh cache slot, then serve the requested
        // slice from that slot. Fetching whole pages amortises future
        // nearby reads. If the page fetch fails (e.g., the page
        // straddles the end of runtime linear memory), fall back to a
        // direct read of just the requested bytes so the cache layer
        // never narrows what a non-cached implementation would accept.
        PageCacheEntry* slot = AcquirePageCacheSlot(pageAddress);
        int32_t fetchResult = coreclr_wasm_dbi_dac_read_target_memory(
            pageAddress,
            static_cast<uint32_t>(reinterpret_cast<uintptr_t>(slot->Data)),
            PageCachePageSize);
        if (fetchResult == Success)
        {
            memcpy(buffer, slot->Data + pageOffset, bytesRequested);
            g_pageCacheMisses++;
            *bytesRead = bytesRequested;
            return S_OK;
        }

        // Page-fetch failed - invalidate the partially-acquired slot
        // (epoch=0 means "never written") and fall through to the
        // direct-read path below. The bypass counter (not the miss
        // counter) is bumped so smoke tests can detect this path.
        slot->Epoch = 0;
        slot->PageAddress = 0;
    }

    g_pageCacheBypasses++;

    // All-or-nothing semantics: the host callback either copies every
    // requested byte or fails the call. Partial reads are not supported
    // because the JS host has no way to report "I copied N bytes before
    // hitting an unmapped page" without a wire-format extension.
    int32_t result = coreclr_wasm_dbi_dac_read_target_memory(
        targetAddress,
        static_cast<uint32_t>(debuggerAddress),
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

    // Anchor the strlen scan at MaxSymbolNameBytes + 1 so a caller that
    // forgot to NUL-terminate cannot trigger a runaway scan into
    // unrelated wasm memory. A length of 0 (empty name) and a length
    // greater than MaxSymbolNameBytes are both rejected here so the
    // host symbol-lookup callback is never asked to resolve an empty
    // or unreasonably large name.
    size_t symbolNameLength = strnlen(symbolName, MaxSymbolNameBytes + 1);
    if (symbolNameLength == 0 || symbolNameLength > MaxSymbolNameBytes)
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
    if (byteCount == 0)
    {
        return Success;
    }

    if (debuggerAddress == 0)
    {
        return InvalidArgument;
    }

    if (!IsValidWasmReadRange(targetAddress, debuggerAddress, byteCount))
    {
        return InvalidReadRange;
    }

    int32_t result = coreclr_wasm_dbi_dac_read_target_memory(
        targetAddress,
        debuggerAddress,
        byteCount);

    return result == Success ? Success : HostReadFailed;
}

// Drop every cached page so the next ReadVirtual is forced back through
// the host bridge. Hosts MUST call this after any out-of-band target
// memory mutation (e.g., after running their own GC of the target, or
// after applying a hot-reload). The sidecar itself bumps the cache on
// connect/disconnect/continue, so well-behaved DBI flows do not need to
// invoke this directly.
WASM_DBI_DAC_EXPORT(coreclr_wasm_dbi_dac_invalidate_page_cache)
int32_t coreclr_wasm_dbi_dac_invalidate_page_cache()
{
    int32_t gate = EnsureProtocolAcknowledged();
    if (gate != Success)
    {
        return gate;
    }

    InvalidatePageCache();
    return Success;
}

// Test-only observable for the page cache. Writes a PageCacheStatsBlob
// (24 bytes) into the caller's buffer. Used by smoke tests to verify
// that nearby reads hit the cache, that cross-page reads bypass it, and
// that invalidation bumps the epoch as expected.
WASM_DBI_DAC_EXPORT_TESTS_ONLY(coreclr_wasm_dbi_dac_get_page_cache_stats)
int32_t coreclr_wasm_dbi_dac_get_page_cache_stats(uint32_t statsOutAddress)
{
    if (statsOutAddress == 0 || statsOutAddress > UINT32_MAX - (sizeof(PageCacheStatsBlob) - 1))
    {
        return InvalidArgument;
    }

    PageCacheStatsBlob blob{};
    blob.Epoch = g_pageCacheEpoch;
    blob.Hits = g_pageCacheHits;
    blob.Misses = g_pageCacheMisses;
    blob.Bypasses = g_pageCacheBypasses;
    blob.Invalidations = g_pageCacheInvalidations;
    blob.Pad0 = 0;

    memcpy(reinterpret_cast<void*>(static_cast<uintptr_t>(statsOutAddress)), &blob, sizeof(blob));
    return Success;
}

WASM_DBI_DAC_EXPORT_TESTS_ONLY(coreclr_wasm_dbi_dac_try_get_symbol)
int32_t coreclr_wasm_dbi_dac_try_get_symbol(uint32_t symbolNameAddress, uint32_t symbolNameLength, uint32_t addressOutAddress)
{
    if (addressOutAddress == 0 || addressOutAddress > UINT32_MAX - 7)
    {
        return InvalidArgument;
    }
    if (!IsValidSymbolNameRange(symbolNameAddress, symbolNameLength))
    {
        return InvalidSymbolName;
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

WASM_DBI_DAC_EXPORT_TESTS_ONLY(coreclr_wasm_dbi_dac_probe_get_platform)
int32_t coreclr_wasm_dbi_dac_probe_get_platform(uint32_t runtimeBase, uint32_t platformOutAddress)
{
    if (platformOutAddress == 0)
    {
        return InvalidArgument;
    }

    // runtimeBase is currently unused because GetPlatform returns a
    // compile-time constant on the wasm sidecar (it does not read target
    // memory). The parameter is kept for signature symmetry with the
    // other probe_* exports (e.g. probe_test_data) and so a future
    // GetPlatform that derives the value from target state can plug in
    // without changing the probe's wire contract.
    WasmDacDataTarget dataTarget(runtimeBase);
    CorDebugPlatform platform = static_cast<CorDebugPlatform>(0);
    HRESULT hr = dataTarget.GetPlatform(&platform);
    if (FAILED(hr))
    {
        return static_cast<int32_t>(hr);
    }

    int32_t platformValue = 0;
    memcpy(&platformValue, &platform, sizeof(platformValue));
    memcpy(reinterpret_cast<void*>(static_cast<uintptr_t>(platformOutAddress)),
           &platformValue, sizeof(platformValue));
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

// Phase 3 onramp probe: verify IDacDbiInterface::DacSetTargetConsistencyChecks
// is reachable from the in-sidecar DAC build. The desktop V3 attach path
// (CordbProcess::CreateDacDbiInterface in src/coreclr/debug/di/process.cpp:700)
// calls this immediately after binding the DAC. Until OpenVirtualProcessImpl
// is wired up in our sidecar, that call site is unreachable; this probe
// proves the underlying DAC method is present and returns S_OK so a future
// real-CordbProcess slice cannot regress silently. The probe writes the
// HRESULT from DacSetTargetConsistencyChecks(FALSE) to consistencyHrAddress
// and returns the creation result (or InvalidArgument on out-pointer issues).
WASM_DBI_DAC_EXPORT_TESTS_ONLY(coreclr_wasm_dbi_dac_probe_dac_consistency_checks)
int32_t coreclr_wasm_dbi_dac_probe_dac_consistency_checks(uint32_t runtimeBase, uint32_t consistencyHrAddress)
{
    if (runtimeBase == 0 || consistencyHrAddress == 0)
    {
        return InvalidArgument;
    }

    if (consistencyHrAddress > UINT32_MAX - (sizeof(int32_t) - 1))
    {
        return InvalidReadRange;
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

    int32_t consistencyHr = E_FAIL;
    if (SUCCEEDED(result) && dacDbi != nullptr)
    {
        WasmIDacDbiInterfaceMinimal* dacDbiInterface = reinterpret_cast<WasmIDacDbiInterfaceMinimal*>(dacDbi);
        consistencyHr = static_cast<int32_t>(dacDbiInterface->DacSetTargetConsistencyChecks(FALSE));
        dacDbiInterface->Release();
    }

    memcpy(reinterpret_cast<void*>(static_cast<uintptr_t>(consistencyHrAddress)), &consistencyHr, sizeof(consistencyHr));
    return result;
}

// Phase 3 onramp probe: walk the in-sidecar static DAC binding path that
// the real CordbProcess::CreateDacDbiInterface will use on wasm. The
// desktop V3 attach (src/coreclr/debug/di/process.cpp:650-701) calls
// GetProcAddress(m_hDacModule, "DacDbiInterfaceInstance") to bind the
// DAC entry; on wasm there is no separate DAC module, so the wasm-
// specialized branch must call DacDbiInterfaceInstance directly. This
// probe runs that exact path so a future Phase 3 process.cpp change
// can rely on the helper being green.
//
// The probe writes two HRESULTs:
//   *outCreateHrAddress      - DacDbiInterfaceInstance result.
//   *outConsistencyHrAddress - DacSetTargetConsistencyChecks(FALSE)
//                              result if create succeeded, else E_FAIL.
//
// Both call shapes mirror process.cpp: pAllocator/pMetaDataLookup are
// supplied, the resulting IDacDbiInterface is released after the
// consistency call. The runtimeBase argument matches the clrInstanceId
// the real attach will use (the descriptor address probed by
// probe_clr_instance_id) so this probe and the real attach exercise
// the same input shape.
WASM_DBI_DAC_EXPORT_TESTS_ONLY(coreclr_wasm_dbi_dac_probe_static_dac_binding)
int32_t coreclr_wasm_dbi_dac_probe_static_dac_binding(uint32_t runtimeBase, uint32_t outCreateHrAddress, uint32_t outConsistencyHrAddress)
{
    if (outCreateHrAddress == 0 || outConsistencyHrAddress == 0)
    {
        return InvalidArgument;
    }

    int32_t createHr = E_FAIL;
    int32_t consistencyHr = E_FAIL;

    WasmDacDataTarget* dataTarget = new (std::nothrow) WasmDacDataTarget(runtimeBase);
    if (dataTarget == nullptr)
    {
        createHr = E_OUTOFMEMORY;
        memcpy(reinterpret_cast<void*>(static_cast<uintptr_t>(outCreateHrAddress)), &createHr, sizeof(createHr));
        memcpy(reinterpret_cast<void*>(static_cast<uintptr_t>(outConsistencyHrAddress)), &consistencyHr, sizeof(consistencyHr));
        return Success;
    }

    WasmDbiAllocator allocator;
    WasmMetaDataLookup metadataLookup;
    void* dacDbi = nullptr;
    createHr = static_cast<int32_t>(DacDbiInterfaceInstance(dataTarget, runtimeBase, &allocator, &metadataLookup, &dacDbi));
    dataTarget->Release();

    if (SUCCEEDED(createHr) && dacDbi != nullptr)
    {
        WasmIDacDbiInterfaceMinimal* dacDbiInterface = reinterpret_cast<WasmIDacDbiInterfaceMinimal*>(dacDbi);
        consistencyHr = static_cast<int32_t>(dacDbiInterface->DacSetTargetConsistencyChecks(FALSE));
        dacDbiInterface->Release();
    }

    memcpy(reinterpret_cast<void*>(static_cast<uintptr_t>(outCreateHrAddress)), &createHr, sizeof(createHr));
    memcpy(reinterpret_cast<void*>(static_cast<uintptr_t>(outConsistencyHrAddress)), &consistencyHr, sizeof(consistencyHr));
    return Success;
}

// Phase 3 acceptance probe: invoke the real V3 attach entry
// `OpenVirtualProcessImpl` (src/coreclr/debug/di/process.cpp:61) against
// our WasmDacDataTarget with the clrInstanceId resolved by
// probe_clr_instance_id. This is the FINAL gate in the connect-doc
// probe ladder; passing this proves real CordbProcess attach works on
// wasm.
//
// Today the probe is EXPECTED TO FAIL because the desktop
// CordbProcess::CreateDacDbiInterface (process.cpp:650-701) calls
// `GetProcAddress(m_hDacModule, "DacDbiInterfaceInstance")`, which
// requires a loaded DAC module — wasm has none. The probe captures the
// failure HRESULT so a future process.cpp change that adds a
// wasm-specialized branch (calling DacDbiInterfaceInstance directly via
// the same path probe_static_dac_binding exercises) flips the result
// from failure to S_OK, and the probe's smoke assertion (HR == 0, then
// hasRealCordbProcess == 1) becomes the green light.
//
// Outputs:
//   *outHrAddress                   - HRESULT from OpenVirtualProcessImpl.
//   *outHasRealCordbProcessAddress  - 1 if the call returned a non-null
//                                      ICorDebugProcess*, else 0. The
//                                      returned process is released
//                                      immediately by this probe.
WASM_DBI_DAC_EXPORT_TESTS_ONLY(coreclr_wasm_dbi_dac_probe_open_virtual_process)
int32_t coreclr_wasm_dbi_dac_probe_open_virtual_process(
    uint32_t runtimeBase,
    uint32_t outHrAddress,
    uint32_t outHasRealCordbProcessAddress)
{
    if (outHrAddress == 0 || outHasRealCordbProcessAddress == 0)
    {
        return InvalidArgument;
    }

    int32_t openHr = E_FAIL;
    uint32_t hasRealCordbProcess = 0;

    WasmDacDataTarget* dataTarget = new (std::nothrow) WasmDacDataTarget(runtimeBase);
    if (dataTarget == nullptr)
    {
        openHr = E_OUTOFMEMORY;
        memcpy(reinterpret_cast<void*>(static_cast<uintptr_t>(outHrAddress)), &openHr, sizeof(openHr));
        memcpy(reinterpret_cast<void*>(static_cast<uintptr_t>(outHasRealCordbProcessAddress)), &hasRealCordbProcess, sizeof(hasRealCordbProcess));
        return Success;
    }

    // V3 attach requires PAL_InitializeDLL for the three CreateEvent calls
    // CordbProcess::Init makes (process.cpp:1679-1695). probe_create_events
    // already validates the bootstrap works; replicating it here keeps this
    // probe self-contained.
    int palInitResult = PAL_InitializeDLL();
    if (palInitResult != 0)
    {
        dataTarget->Release();
        openHr = static_cast<int32_t>(HRESULT_FROM_WIN32(static_cast<DWORD>(palInitResult)));
        if (openHr == Success)
        {
            openHr = E_FAIL;
        }
        memcpy(reinterpret_cast<void*>(static_cast<uintptr_t>(outHrAddress)), &openHr, sizeof(openHr));
        memcpy(reinterpret_cast<void*>(static_cast<uintptr_t>(outHasRealCordbProcessAddress)), &hasRealCordbProcess, sizeof(hasRealCordbProcess));
        return Success;
    }

    // Match the version structure desktop ICorDebug hosts pass — major 4
    // is the modern shipping CLR. Zero struct version (low byte) signals
    // the legacy struct shape.
    struct
    {
        WORD wStructVersion;
        WORD wMajor;
        WORD wMinor;
        WORD wBuild;
        WORD wRevision;
    } maxDebuggerVersion = { 0, 4, 0, 0, 0 };

    IUnknown* pInstance = nullptr;
    DWORD flagsOut = 0;
    openHr = static_cast<int32_t>(OpenVirtualProcessImpl(
        static_cast<ULONG64>(runtimeBase),
        static_cast<IUnknown*>(static_cast<ICorDebugDataTarget*>(dataTarget)),
        nullptr,  // hDacModule: no separate DAC module on wasm
        reinterpret_cast<_CLR_DEBUGGING_VERSION*>(&maxDebuggerVersion),
        __uuidof(ICorDebugProcess),
        &pInstance,
        &flagsOut));

    if (SUCCEEDED(openHr) && pInstance != nullptr)
    {
        hasRealCordbProcess = 1;
        pInstance->Release();
    }
    dataTarget->Release();

    memcpy(reinterpret_cast<void*>(static_cast<uintptr_t>(outHrAddress)), &openHr, sizeof(openHr));
    memcpy(reinterpret_cast<void*>(static_cast<uintptr_t>(outHasRealCordbProcessAddress)), &hasRealCordbProcess, sizeof(hasRealCordbProcess));
    return Success;
}

// Phase 4 first slice: DebuggerIPCEvent (DB_IPCE_BREAKPOINT) wire-format
// round-trip probe.
//
// The probe constructs a synthetic WasmDbgIpcEventBreakpoint with
// deterministic field values, serializes it to a caller-supplied buffer
// via memcpy, deserializes back to a second struct, and writes both
// the round-tripped struct and a boolean indicating field-by-field
// equality. The smoke asserts the equality flag and individual fields.
//
// This validates the on-wire format (sizes, alignment, no implicit
// padding tweaks across compilers) BEFORE the Phase 4 transport layer
// starts sending real DebuggerIPCEvents. Once the runtime-side emit
// path is wired (Option 5b adapter expansion per
// docs/design/coreclr/wasm-debug-phase5-decision.md), this same probe
// becomes the regression gate for the wire contract.
//
// Outputs:
//   *outBuffer (88 bytes) - the round-tripped struct.
//   *outEqualAddress      - 1 if every field round-tripped intact,
//                            else 0.
WASM_DBI_DAC_EXPORT_TESTS_ONLY(coreclr_wasm_dbi_dac_probe_dbg_ipc_event_breakpoint_roundtrip)
int32_t coreclr_wasm_dbi_dac_probe_dbg_ipc_event_breakpoint_roundtrip(
    uint32_t outBufferAddress,
    uint32_t bufferLengthBytes,
    uint32_t outEqualAddress)
{
    if (outBufferAddress == 0 || outEqualAddress == 0)
    {
        return InvalidArgument;
    }
    if (bufferLengthBytes < sizeof(WasmDbgIpcEventBreakpoint))
    {
        return BufferTooSmall;
    }

    WasmDbgIpcEventBreakpoint original{};
    original.Magic = WasmDbgIpcEventBreakpointMagic;
    original.Type = WasmDbgIpcEventTypeBreakpoint;
    original.ProcessId = 0x12345678u;
    original.ThreadId = 0x9abcdef0u;
    original.VmAppDomain = 0x0123456789abcdefULL;
    original.VmThread = 0xfedcba9876543210ULL;
    original.Hr = static_cast<int32_t>(0x80131500);  // CORDBG_E base — arbitrary recognizable HR
    original.Flags = WasmDbgIpcEventFlagReplyRequired;
    original.BreakpointToken = 0xdeadbeefcafef00dULL;
    original.FuncMetadataToken = 0x06000042u;  // mdMethodDef token shape
    original.Reserved0 = 0;
    original.VmAssembly = 0xabcdef0123456789ULL;
    original.IsIL = 1;
    original.Offset = 0x10;
    original.EncVersion = 0;
    original.Reserved1 = 0;
    original.NativeCodeMethodDescToken = 0;
    original.CodeStartAddress = 0x0000000000600000ULL;

    // Serialize: copy struct → caller-supplied buffer.
    void* bufferPtr = reinterpret_cast<void*>(static_cast<uintptr_t>(outBufferAddress));
    memcpy(bufferPtr, &original, sizeof(original));

    // Deserialize: copy buffer → roundtripped struct.
    WasmDbgIpcEventBreakpoint roundtripped{};
    memcpy(&roundtripped, bufferPtr, sizeof(roundtripped));

    uint32_t equal = (memcmp(&original, &roundtripped, sizeof(original)) == 0) ? 1u : 0u;
    memcpy(reinterpret_cast<void*>(static_cast<uintptr_t>(outEqualAddress)), &equal, sizeof(equal));
    return Success;
}

// Phase 3 onramp probe: surface which IIDs the sidecar's data target
// already implements before any real CordbProcess work begins. The
// desktop V3 connect path (CordbProcess::CordbProcess + CordbProcess::Init
// in src/coreclr/debug/di/process.cpp) QIs the data target for at least
// ICorDebugDataTarget, ICorDebugMutableDataTarget, and
// ICorDebugMetaDataLocator; mscordbi tolerates E_NOINTERFACE on the
// metadata locator but EXPECTS the mutable data target. Today
// WasmDacDataTarget (dbi_dac_wasm.cpp:449-489) only implements
// IUnknown / ICLRDataTarget / ICLRRuntimeLocator / ICorDebugDataTarget,
// so this probe is expected to report bit-mask 0x0F until the Phase 3
// mutable-data-target gap is closed. The bit layout is:
//   bit 0 (0x01) IUnknown                       — must be set
//   bit 1 (0x02) ICLRDataTarget                 — must be set
//   bit 2 (0x04) ICLRRuntimeLocator             — must be set
//   bit 3 (0x08) ICorDebugDataTarget            — must be set
//   bit 4 (0x10) ICorDebugMutableDataTarget     — Phase 3 gap (0 today)
//   bit 5 (0x20) ICorDebugMetaDataLocator       — desktop tolerates 0
WASM_DBI_DAC_EXPORT_TESTS_ONLY(coreclr_wasm_dbi_dac_probe_data_target_qi)
int32_t coreclr_wasm_dbi_dac_probe_data_target_qi(uint32_t outFlagsAddress)
{
    if (outFlagsAddress == 0)
    {
        return InvalidArgument;
    }

    if (outFlagsAddress > UINT32_MAX - (sizeof(uint32_t) - 1))
    {
        return InvalidReadRange;
    }

    WasmDacDataTarget* dataTarget = new (std::nothrow) WasmDacDataTarget(0);
    if (dataTarget == nullptr)
    {
        return E_OUTOFMEMORY;
    }

    struct ProbeIid
    {
        REFIID Iid;
        uint32_t Bit;
    };

    const ProbeIid probes[] = {
        { IID_IUnknown,                       0x01u },
        { __uuidof(ICLRDataTarget),           0x02u },
        { __uuidof(ICLRRuntimeLocator),       0x04u },
        { __uuidof(ICorDebugDataTarget),      0x08u },
        { __uuidof(ICorDebugMutableDataTarget), 0x10u },
        { __uuidof(ICorDebugMetaDataLocator), 0x20u },
    };

    uint32_t flags = 0;
    for (const ProbeIid& probe : probes)
    {
        void* iface = nullptr;
        HRESULT hr = dataTarget->QueryInterface(probe.Iid, &iface);
        if (SUCCEEDED(hr) && iface != nullptr)
        {
            flags |= probe.Bit;
            reinterpret_cast<IUnknown*>(iface)->Release();
        }
    }

    dataTarget->Release();

    memcpy(reinterpret_cast<void*>(static_cast<uintptr_t>(outFlagsAddress)), &flags, sizeof(flags));
    return Success;
}

// Phase 3 onramp probe. Resolves the runtime's `DotNetRuntimeContractDescriptor`
// host symbol via the same `TryGetSymbol` host callback that `WasmDacDataTarget`
// uses, and writes its address as the value that V3 `OpenVirtualProcessImpl`
// will pass as `clrInstanceId`. Also writes the symbol-resolution HRESULT.
// This validates that `EnsureClrInstanceIdSet` (`src/coreclr/debug/di/process.cpp:9292`)
// will see a non-zero, stable address before Phase 3 wires the real attach path.
//
// Outputs:
//   *outClrInstanceIdAddress - resolved descriptor address (cast to uint32_t,
//                              the wasm-side runtime is 32-bit so this fits
//                              losslessly), or 0 on failure.
//   *outHrAddress           - S_OK on success, else `HostSymbolLookupFailed`
//                              (-3) or an InvalidArgument code.
// Return: Success when the probe wrote both outputs; an error code otherwise.
WASM_DBI_DAC_EXPORT_TESTS_ONLY(coreclr_wasm_dbi_dac_probe_clr_instance_id)
int32_t coreclr_wasm_dbi_dac_probe_clr_instance_id(uint32_t runtimeBase, uint32_t outClrInstanceIdAddress, uint32_t outHrAddress)
{
    if (outClrInstanceIdAddress == 0 || outHrAddress == 0)
    {
        return InvalidArgument;
    }

    uint32_t clrInstanceId = 0;
    int32_t resolutionHr = HostSymbolLookupFailed;

    WasmDacDataTarget dataTarget(runtimeBase);
    uint64_t descriptorAddress = 0;
    if (TryGetSymbol(
            static_cast<ICorDebugDataTarget*>(&dataTarget),
            runtimeBase,
            "DotNetRuntimeContractDescriptor",
            &descriptorAddress) &&
        descriptorAddress != 0 &&
        descriptorAddress <= UINT32_MAX)
    {
        clrInstanceId = static_cast<uint32_t>(descriptorAddress);
        resolutionHr = Success;
    }

    memcpy(reinterpret_cast<void*>(static_cast<uintptr_t>(outClrInstanceIdAddress)), &clrInstanceId, sizeof(clrInstanceId));
    memcpy(reinterpret_cast<void*>(static_cast<uintptr_t>(outHrAddress)), &resolutionHr, sizeof(resolutionHr));
    return Success;
}

// Phase 3 onramp probe. Replicates the three unconditional
// `CreateEvent` calls that `CordbProcess::Init`
// (`src/coreclr/debug/di/process.cpp:1679-1695`) makes on every
// supported target, validating that the browser-wasm PAL emulates the
// CreateEvent / CloseHandle API surface CordbProcess depends on.
//
// The three events are:
//   1. m_leftSideEventAvailable - CreateEvent(NULL, FALSE, FALSE, NULL)
//      auto-reset, initial state not-signaled.
//   2. m_leftSideEventRead      - CreateEvent(NULL, FALSE, FALSE, NULL)
//      auto-reset, initial state not-signaled.
//   3. m_stopWaitEvent          - CreateEvent(NULL, TRUE,  FALSE, NULL)
//      manual-reset, initial state not-signaled.
//
// (m_detachSetThreadContextNeededEvent is gated on
// OUT_OF_PROCESS_SETTHREADCONTEXT and is not relevant on wasm.)
//
// Outputs:
//   *outFlagsAddress - bitmask: 0x1 = event 1 created, 0x2 = event 2,
//                       0x4 = event 3. Expected value: 0x7 on success.
//   *outHrAddress    - S_OK if all three succeeded, else the HRESULT from
//                       the first failure (from GetLastError() wrapped via
//                       HRESULT_FROM_WIN32). Subsequent events are still
//                       attempted so the flags reflect the full surface.
// Return: Success when outputs were written; an error otherwise.
WASM_DBI_DAC_EXPORT_TESTS_ONLY(coreclr_wasm_dbi_dac_probe_create_events)
int32_t coreclr_wasm_dbi_dac_probe_create_events(uint32_t outFlagsAddress, uint32_t outHrAddress)
{
    if (outFlagsAddress == 0 || outHrAddress == 0)
    {
        return InvalidArgument;
    }

    // Ensure the PAL is initialized before invoking sync primitives. The
    // sidecar links the PAL but doesn't bootstrap g_pObjectManager (which
    // CreateEventW needs) on its own — partial PAL usage works for DAC
    // ReadVirtual etc., but the synchronization subsystem requires
    // PAL_InitializeDLL. This call is idempotent (returns 0 if already
    // initialized) and is the minimum PAL bootstrap needed to make
    // CordbProcess::Init's three CreateEvent calls succeed.
    int palInitResult = PAL_InitializeDLL();
    if (palInitResult != 0)
    {
        uint32_t zero = 0;
        int32_t initHr = static_cast<int32_t>(HRESULT_FROM_WIN32(static_cast<DWORD>(palInitResult)));
        if (initHr == Success)
        {
            initHr = E_FAIL;
        }
        memcpy(reinterpret_cast<void*>(static_cast<uintptr_t>(outFlagsAddress)), &zero, sizeof(zero));
        memcpy(reinterpret_cast<void*>(static_cast<uintptr_t>(outHrAddress)), &initHr, sizeof(initHr));
        return Success;
    }

    struct EventShape
    {
        BOOL ManualReset;
        BOOL InitialState;
        uint32_t Bit;
    };
    const EventShape shapes[] = {
        { FALSE, FALSE, 0x1u },
        { FALSE, FALSE, 0x2u },
        { TRUE,  FALSE, 0x4u },
    };

    uint32_t flags = 0;
    int32_t firstFailureHr = Success;
    for (const EventShape& shape : shapes)
    {
        HANDLE handle = CreateEventW(NULL, shape.ManualReset, shape.InitialState, NULL);
        if (handle != NULL)
        {
            flags |= shape.Bit;
            CloseHandle(handle);
        }
        else if (firstFailureHr == Success)
        {
            DWORD lastError = GetLastError();
            firstFailureHr = static_cast<int32_t>(HRESULT_FROM_WIN32(lastError));
            if (firstFailureHr == Success)
            {
                firstFailureHr = E_FAIL;
            }
        }
    }

    memcpy(reinterpret_cast<void*>(static_cast<uintptr_t>(outFlagsAddress)), &flags, sizeof(flags));
    memcpy(reinterpret_cast<void*>(static_cast<uintptr_t>(outHrAddress)), &firstFailureHr, sizeof(firstFailureHr));
    return Success;
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
    InvalidatePageCache();

    // Phase 3: instantiate a real V3 CordbProcess via OpenVirtualProcessImpl
    // alongside the existing synthetic facade. Failure is non-fatal during
    // the Phase 3 transition — the synthetic facade carries the smoke
    // contract until the next slice retires it.
    if (g_realCordbProcess == nullptr)
    {
        // PAL_InitializeDLL is required for CordbProcess::Init's three
        // CreateEventW calls (process.cpp:1679-1695). The wasm sidecar's
        // partial PAL usage does not bootstrap g_pObjectManager on its
        // own; probe_create_events documents the gap. Idempotent on
        // success (returns 0 if already initialized).
        if (PAL_InitializeDLL() == 0)
        {
            WasmDacDataTarget* dataTarget = new (std::nothrow) WasmDacDataTarget(runtimeBase);
            if (dataTarget != nullptr)
            {
                uint64_t descriptorAddress = 0;
                if (TryGetSymbol(
                        static_cast<ICorDebugDataTarget*>(dataTarget),
                        runtimeBase,
                        "DotNetRuntimeContractDescriptor",
                        &descriptorAddress) &&
                    descriptorAddress != 0 &&
                    descriptorAddress <= UINT32_MAX)
                {
                    struct
                    {
                        WORD wStructVersion;
                        WORD wMajor;
                        WORD wMinor;
                        WORD wBuild;
                        WORD wRevision;
                    } maxDebuggerVersion = { 0, 4, 0, 0, 0 };

                    IUnknown* pInstance = nullptr;
                    DWORD flagsOut = 0;
                    HRESULT openHr = OpenVirtualProcessImpl(
                        descriptorAddress,
                        static_cast<IUnknown*>(static_cast<ICorDebugDataTarget*>(dataTarget)),
                        nullptr,
                        reinterpret_cast<_CLR_DEBUGGING_VERSION*>(&maxDebuggerVersion),
                        __uuidof(ICorDebugProcess),
                        &pInstance,
                        &flagsOut);
                    if (SUCCEEDED(openHr) && pInstance != nullptr)
                    {
                        g_realCordbProcess = pInstance;
                    }
                }
                dataTarget->Release();
            }
        }
    }

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

    ClearRuntimeConnectionState();
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
    InvalidatePageCache();
    return SendRuntimeCommandRecord(command);
}

WASM_DBI_DAC_EXPORT(coreclr_wasm_dbi_dac_dbi_send_ipc_continue_request)
int32_t coreclr_wasm_dbi_dac_dbi_send_ipc_continue_request(uint64_t breakpointToken)
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

    WasmDbgIpcEventContinueRequest request{};
    request.Magic = WasmDbgIpcEventContinueRequestMagic;
    request.Type = WasmDbgIpcEventTypeContinueRequest;
    request.ProcessId = 1;
    request.ThreadId = 1;
    request.BreakpointToken = breakpointToken;
    request.Flags = 0;
    request.Reserved0 = 0;

    int32_t result = coreclr_wasm_dbi_dac_submit_continue_request(
        static_cast<uint32_t>(reinterpret_cast<uintptr_t>(&request)),
        sizeof(request));
    if (result == Success)
    {
        InvalidatePageCache();
    }
    return result == Success ? Success : result;
}

WASM_DBI_DAC_EXPORT(coreclr_wasm_dbi_dac_dbi_send_ipc_step_into_request)
int32_t coreclr_wasm_dbi_dac_dbi_send_ipc_step_into_request(uint64_t breakpointToken)
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

    WasmDbgIpcEventStepIntoRequest request{};
    request.Magic = WasmDbgIpcEventStepIntoRequestMagic;
    request.Type = WasmDbgIpcEventTypeStepIntoRequest;
    request.ProcessId = 1;
    request.ThreadId = 1;
    request.BreakpointToken = breakpointToken;
    request.Flags = 0;
    request.Reserved0 = 0;

    int32_t result = coreclr_wasm_dbi_dac_submit_step_into_request(
        static_cast<uint32_t>(reinterpret_cast<uintptr_t>(&request)),
        sizeof(request));
    if (result == Success)
    {
        InvalidatePageCache();
    }
    return result == Success ? Success : result;
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

// Phase 4 slice 3: end-to-end DebuggerIPCEvent drain from the sidecar
// without a JS-side runtime export call. Resolves the runtime symbols
// `g_wasmDebugLastIpcEventValid` and `g_wasmDebugLastIpcEvent` once
// (cached on first call), then uses the WasmDacDataTarget ReadVirtual
// path to peek the Valid flag and (when set) copy the 96-byte payload
// into the caller's sidecar-side buffer. Returns:
//   S_OK + bytesWritten = 96 when an event was drained;
//   S_OK + bytesWritten = 0  when no event is pending;
//   E_FAIL on cross-module read failure or symbol lookup failure.
// Note: this peek does NOT clear the runtime's Valid flag — clearing
// would require a write-back to runtime memory which we don't have a
// bridge for yet. Future slices will either add a JS bridge to call
// CoreClrWasmDebugReadLastIpcEvent on the runtime side, or extend
// copy_from_target with a write-side companion.
WASM_DBI_DAC_EXPORT(coreclr_wasm_dbi_dac_dbi_poll_ipc_event)
int32_t coreclr_wasm_dbi_dac_dbi_poll_ipc_event(uint32_t bufferAddress, uint32_t bufferLength, uint32_t bytesWrittenAddress)
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

    if (bufferLength < sizeof(WasmDbgIpcEventBreakpoint))
    {
        return BufferTooSmall;
    }

    // The runtime mutates g_wasmDebugLastIpcEventValid on every fire
    // (and CoreClrWasmDebugReadLastIpcEvent on every drain). The page
    // cache snapshots whatever pre-fire value it captured on the
    // previous read, so a poll after a fire would otherwise serve
    // stale 0s. Invalidate before every poll. Once the runtime has a
    // proper "memory has changed" event hook the sidecar can subscribe
    // to, this can move to that callback path.
    InvalidatePageCache();

    WasmDacDataTarget dataTarget(g_connectedRuntimeBase);

    if (g_cachedIpcEventValidAddress == 0)
    {
        uint64_t resolved = 0;
        if (!TryGetSymbol(
                static_cast<ICorDebugDataTarget*>(&dataTarget),
                g_connectedRuntimeBase,
                "g_wasmDebugLastIpcEventValid",
                &resolved) ||
            resolved == 0 ||
            resolved > UINT32_MAX)
        {
            return HostSymbolLookupFailed;
        }
        g_cachedIpcEventValidAddress = resolved;
    }
    if (g_cachedIpcEventAddress == 0)
    {
        uint64_t resolved = 0;
        if (!TryGetSymbol(
                static_cast<ICorDebugDataTarget*>(&dataTarget),
                g_connectedRuntimeBase,
                "g_wasmDebugLastIpcEvent",
                &resolved) ||
            resolved == 0 ||
            resolved > UINT32_MAX)
        {
            return HostSymbolLookupFailed;
        }
        g_cachedIpcEventAddress = resolved;
    }

    uint32_t valid = 0;
    ULONG32 bytesRead = 0;
    HRESULT hr = dataTarget.ReadVirtual(
        g_cachedIpcEventValidAddress,
        reinterpret_cast<BYTE*>(&valid),
        sizeof(valid),
        &bytesRead);
    if (FAILED(hr) || bytesRead != sizeof(valid))
    {
        return HostReadFailed;
    }

    uint32_t zeroBytes = 0;
    if (valid == 0)
    {
        memcpy(reinterpret_cast<void*>(static_cast<uintptr_t>(bytesWrittenAddress)), &zeroBytes, sizeof(zeroBytes));
        return S_OK;
    }

    WasmDbgIpcEventBreakpoint payload{};
    bytesRead = 0;
    hr = dataTarget.ReadVirtual(
        g_cachedIpcEventAddress,
        reinterpret_cast<BYTE*>(&payload),
        sizeof(payload),
        &bytesRead);
    if (FAILED(hr) || bytesRead != sizeof(payload))
    {
        return HostReadFailed;
    }

    memcpy(reinterpret_cast<void*>(static_cast<uintptr_t>(bufferAddress)), &payload, sizeof(payload));
    uint32_t written = static_cast<uint32_t>(sizeof(payload));
    memcpy(reinterpret_cast<void*>(static_cast<uintptr_t>(bytesWrittenAddress)), &written, sizeof(written));
    return S_OK;
}

WASM_DBI_DAC_EXPORT(coreclr_wasm_dbi_dac_dbi_enumerate_breakpoints)
int32_t coreclr_wasm_dbi_dac_dbi_enumerate_breakpoints(uint32_t bufferAddress, uint32_t bufferLength, uint32_t bytesWrittenAddress)
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

    if (bytesWrittenAddress == 0)
    {
        return InvalidArgument;
    }

    uint32_t written = WasmDebugBreakpointEnumerationSize;
    memcpy(reinterpret_cast<void*>(static_cast<uintptr_t>(bytesWrittenAddress)), &written, sizeof(written));

    if (bufferAddress == 0)
    {
        return InvalidArgument;
    }

    if (bufferLength < written)
    {
        return BufferTooSmall;
    }

    // The slot table mutates on every arm/clear and when interpreter patches
    // are installed/restored, so every enumeration must force fresh target
    // memory through ReadVirtual instead of reusing a cached page snapshot.
    InvalidatePageCache();

    WasmDacDataTarget dataTarget(g_connectedRuntimeBase);
    if (g_cachedBreakpointSlotsAddress == 0)
    {
        uint64_t resolved = 0;
        if (!TryGetSymbol(
                static_cast<ICorDebugDataTarget*>(&dataTarget),
                g_connectedRuntimeBase,
                "g_wasmDebugBreakpoints",
                &resolved) ||
            resolved == 0 ||
            resolved > UINT32_MAX)
        {
            return HostSymbolLookupFailed;
        }
        g_cachedBreakpointSlotsAddress = resolved;
    }

    WasmDebugBreakpointSlotMirror slots[WasmDebugBreakpointSlotCapacity]{};
    ULONG32 bytesRead = 0;
    HRESULT hr = dataTarget.ReadVirtual(
        g_cachedBreakpointSlotsAddress,
        reinterpret_cast<BYTE*>(slots),
        sizeof(slots),
        &bytesRead);
    if (FAILED(hr) || bytesRead != sizeof(slots))
    {
        return HostReadFailed;
    }

    uint32_t activeCount = 0;
    for (const WasmDebugBreakpointSlotMirror& slot : slots)
    {
        if (slot.Armed != 0)
        {
            activeCount++;
        }
    }

    uint32_t header[2] = { WasmDebugBreakpointSlotCapacity, activeCount };
    uint8_t* out = reinterpret_cast<uint8_t*>(static_cast<uintptr_t>(bufferAddress));
    memcpy(out, header, sizeof(header));
    memcpy(out + sizeof(header), slots, sizeof(slots));

    return S_OK;
}

WASM_DBI_DAC_EXPORT(coreclr_wasm_dbi_dac_dbi_enumerate_locals)
int32_t coreclr_wasm_dbi_dac_dbi_enumerate_locals(uint32_t bufferAddress, uint32_t bufferLength, uint32_t bytesWrittenAddress)
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

    if (bytesWrittenAddress == 0)
    {
        return InvalidArgument;
    }

    uint32_t recordSize = static_cast<uint32_t>(sizeof(WasmDebugLocalsRecord));
    memcpy(reinterpret_cast<void*>(static_cast<uintptr_t>(bytesWrittenAddress)), &recordSize, sizeof(recordSize));

    if (bufferAddress == 0)
    {
        return InvalidArgument;
    }

    if (bufferLength < recordSize)
    {
        return BufferTooSmall;
    }

    // The runtime overwrites g_wasmDebugLastLocalsRecord on every
    // breakpoint stop. Force a fresh DAC read so callers do not observe a
    // pre-stop page-cache snapshot.
    InvalidatePageCache();

    WasmDacDataTarget dataTarget(g_connectedRuntimeBase);
    if (g_cachedLocalsRecordAddress == 0)
    {
        uint64_t resolved = 0;
        if (!TryGetSymbol(
                static_cast<ICorDebugDataTarget*>(&dataTarget),
                g_connectedRuntimeBase,
                "g_wasmDebugLastLocalsRecord",
                &resolved) ||
            resolved == 0 ||
            resolved > UINT32_MAX)
        {
            return HostSymbolLookupFailed;
        }
        g_cachedLocalsRecordAddress = resolved;
    }

    WasmDebugLocalsRecord payload{};
    ULONG32 bytesRead = 0;
    HRESULT hr = dataTarget.ReadVirtual(
        g_cachedLocalsRecordAddress,
        reinterpret_cast<BYTE*>(&payload),
        sizeof(payload),
        &bytesRead);
    if (FAILED(hr) || bytesRead != sizeof(payload))
    {
        return HostReadFailed;
    }

    if (payload.Magic != WasmDebugLocalsRecordMagic ||
        payload.Version != 1 ||
        payload.LocalCount > WasmDebugMaxLocalsPerFrame)
    {
        return InvalidArgument;
    }

    memcpy(reinterpret_cast<void*>(static_cast<uintptr_t>(bufferAddress)), &payload, sizeof(payload));
    return S_OK;
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
    state.HasRealCordbProcess = g_realCordbProcess != nullptr ? 1 : 0;
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
        ClearRuntimeConnectionState();
        g_protocolAcknowledged = false;
        return S_OK;
    }

    ICorDebug* cordb = g_cordb;
    g_cordb = nullptr;
    ClearRuntimeConnectionState();

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
