// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

// Wasm-only MVP debugger control plane.
//
// This file holds the prototype command/event protocol the wasm DBI/DAC
// sidecar uses to interact with the runtime while the proper
// DebuggerIPCEvent-based wire transport (Phase 4) is being designed. It is
// intentionally minimal: a single breakpoint slot, command/event/frame
// record marshalling, and interpreter integration hooks. None of this
// belongs in the DAC table itself; it used to share src/coreclr/vm/wasm/
// dactable.cpp purely as an accident of "this was the only wasm-only VM TU
// at the time".
//
// The g_dacTable / DacGlobals::InitializeEntries / Getg_dacTable surface
// now lives in the shared src/coreclr/debug/ee/dactable.cpp under its
// TARGET_WASM branch, so this file no longer duplicates DAC-table logic.

#include "common.h"
#include "excep.h"
#include "threads.h"
#include "../interpexec.h"
#include "../../debug/ee/interpreterwalker.h"
#include "../../interpreter/intops.h"
#include "../../interpreter/inc/interpretershared.h"
#include <daccess.h>

#include <emscripten.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

extern "C" int32_t CoreClrWasmDebugOnBreakpointHit(uint32_t eventAddress, uint32_t eventLength);

// Phase 6 stop-trigger JS import. Mirrors Mono
// mono_wasm_fire_debugger_agent_message_with_data_to_pause
// (src/mono/mono/component/mini-wasm-debugger.c:455-near).
// Synchronously called from the runtime when a managed event (breakpoint,
// step, exception) needs the IDE to stop. The JS-host body in
// src/coreclr/hosts/corerun/wasm/libCorerun.js captures the event payload
// and executes `debugger;`. V8/SpiderMonkey/JavaScriptCore all halt at
// `debugger;` when an inspector is attached; Node without --inspect
// simply skips the statement, so smoke tests run cleanly. The future
// browser proxy recognizes the function name in the CDP Debugger.paused
// callFrames (the Mono parallel pattern is BrowserDebugProxy's filter
// for mono_wasm_fire_debugger_agent_message*).
extern "C" int32_t coreClrDebugFireEventToPause(uint32_t eventAddress, uint32_t eventLength);
extern "C" uint32_t CoreClrWasmDebugCallInterpreterStepHelperProbeImpl();
extern "C" uint32_t CoreClrWasmDebugGetMethodEnterEnabledQueryCountImpl();
extern "C" void CoreClrWasmDebugEnsureDebuggerEEInterface();

// Forward declaration of g_dacTable defined in src/coreclr/debug/ee/dactable.cpp.
// Used by CoreClrWasmDebugReadDacGlobalsProbe to expose well-known slot values
// to the smoke harness for coverage validation.
extern DacGlobals g_dacTable;

struct WasmDbiDacTestData
{
    uint32_t Magic;
    int32_t Int32Value;
    double DoubleValue;
    uint32_t VectorLanes[4];
    char Message[16];
};

static_assert(sizeof(WasmDbiDacTestData) == 48);

constexpr uint32_t WasmDebugMessageBufferSize = 256;
constexpr uint32_t WasmDebugCommandRecordMagic = 0x434d4457;

enum class WasmDebugCommandKind : uint32_t
{
    None = 0,
    SetBreakpointByName = 1,
    SetBreakpointByToken = 2,
    Continue = 3,
};

enum class WasmDebugEventKind : uint32_t
{
    None = 0,
    Breakpoint = 1,
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

// Phase 4 slice 2: structured DebuggerIPCEvent payload emitted on every
// breakpoint hit. Mirrors the WasmDbgIpcEventBreakpoint layout in the
// sidecar (src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:299-319) byte
// for byte; the sidecar's poll_event drains this through the existing
// copy_from_target bridge. Both sides static_assert the 96-byte size
// to catch any drift. Layout — explicit Reserved padding ensures the
// 8-byte fields are naturally aligned across Emscripten clang and
// future wasm64:
//   Magic              - 'IPCB' little-endian (0x42435049).
//   Type               - DB_IPCE_BREAKPOINT (0x0100) from dbgipceventtypes.h.
//   ProcessId/ThreadId - process + thread that hit the breakpoint.
//   VmAppDomain        - AppDomain VMPTR; today always app domain handle 0.
//   VmThread           - Thread VMPTR; today always 0 (no real Thread on wasm).
//   Hr                 - hit-time HRESULT; 0 on success, populated by future
//                        error paths (out-of-slot, etc.).
//   Flags              - WasmDbgIpcEventFlag*. 0 today; the
//                        ReplyRequired/AsyncSend bits exist for the future
//                        DBI handshake when an actual mscordbi attaches.
//   BreakpointToken    - per-fire monotonically-increasing token so DBI can
//                        correlate hit notifications with continue commands.
//   FuncMetadataToken  - the mdMethodDef of the method that hit (e.g.
//                        0x06000042 for the smoke harness's BreakHere).
//   VmAssembly         - VMPTR of the containing assembly; today 0.
//   IsIL/Offset        - IsIL=1 for managed breakpoints; Offset is the IL
//                        offset (0 today since we only patch IL[0]).
//   EncVersion         - EnC version of the patched method; today 0.
//   NativeCodeMethodDescToken / CodeStartAddress - reserved for the
//                        future jitted-code path; today both 0 since
//                        wasm-only breakpoints live in the interpreter.
struct WasmDbgIpcEventBreakpointRuntime
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
    uint32_t Reserved0;
    uint64_t VmAssembly;
    uint32_t IsIL;
    uint32_t Offset;
    uint32_t EncVersion;
    uint32_t Reserved1;
    uint64_t NativeCodeMethodDescToken;
    uint64_t CodeStartAddress;
};

struct WasmDbgIpcEventException
{
    uint32_t Magic;
    uint32_t Type;
    uint32_t ProcessId;
    uint32_t ThreadId;
    uint64_t VmAppDomain;
    uint64_t VmThread;
    int32_t Hr;
    uint32_t Flags;
    uint64_t ExceptionToken;
    uint32_t FuncMetadataToken;
    uint32_t ILOffset;
    uint64_t VmAssembly;
    uint64_t ExceptionAddress;
    char ExceptionTypeName[64];
    uint64_t Reserved0;
};

struct WasmDbgIpcEventStepComplete
{
    uint32_t Magic;
    uint32_t Type;
    uint32_t ProcessId;
    uint32_t ThreadId;
    uint64_t VmAppDomain;
    uint64_t VmThread;
    int32_t Hr;
    uint32_t Flags;
    uint64_t StepToken;
    uint64_t OriginalStepRequestToken;
    uint32_t FuncMetadataToken;
    uint32_t ILOffset;
    uint64_t VmAssembly;
    uint32_t IsIL;
    uint32_t Reserved0;
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
    uint32_t Reserved0;
};

struct WasmDbgIpcEventStepIntoRequest
{
    uint32_t Magic;
    uint32_t Type;
    uint32_t ProcessId;
    uint32_t ThreadId;
    uint64_t BreakpointToken;
    uint32_t Flags;
    uint32_t StepKind;
};

enum class WasmDebugStepKind : uint32_t
{
    Into = 0,
    Over = 1,
    Out = 2,
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

constexpr uint32_t WasmDebugMaxLocalsPerFrame = 32;
constexpr uint32_t WasmDebugLocalsRecordMagic = 0x524C4457; // 'WDLR'

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

static_assert(sizeof(WasmDebugCommandRecord) == 80);
static_assert(sizeof(WasmDebugEventRecord) == 340);
static_assert(sizeof(WasmDebugFrameRecord) == 88);
static_assert(sizeof(WasmDebugLocalRecord) == 48);
static_assert(sizeof(WasmDebugLocalsRecord) == 16 + 32 * 48);
static_assert(sizeof(WasmDbgIpcEventBreakpointRuntime) == 96,
              "WasmDbgIpcEventBreakpointRuntime must mirror the sidecar's WasmDbgIpcEventBreakpoint byte-for-byte");
static_assert(sizeof(WasmDbgIpcEventException) == 144,
              "WasmDbgIpcEventException must mirror the sidecar's WasmDbgIpcEventException byte-for-byte");
static_assert(sizeof(WasmDbgIpcEventStepComplete) == 96,
              "WasmDbgIpcEventStepComplete must mirror the sidecar's WasmDbgIpcEventStepComplete byte-for-byte");
static_assert(sizeof(WasmDbgIpcEventContinueRequest) == 32,
              "WasmDbgIpcEventContinueRequest must mirror the sidecar's byte-for-byte");
static_assert(sizeof(WasmDbgIpcEventStepIntoRequest) == 32,
              "WasmDbgIpcEventStepIntoRequest must mirror the sidecar's byte-for-byte");

constexpr uint32_t WasmDbgIpcEventBreakpointMagic = 0x42435049;
constexpr uint32_t WasmDbgIpcEventTypeBreakpoint = 0x0100;
constexpr uint32_t WasmDbgIpcEventExceptionMagic = 0x58435049;
constexpr uint32_t WasmDbgIpcEventTypeException = 0x0103;
constexpr uint32_t WasmDbgIpcEventStepCompleteMagic = 0x54435049;
// Wasm-private event type carried under the IPCT magic. This is not the
// canonical DebuggerIPCEventType DB_IPCE_STEP_COMPLETE value.
constexpr uint32_t WasmDbgIpcEventTypeStepComplete = 0x0104;
constexpr uint32_t WasmDbgIpcEventContinueRequestMagic = 0x43435049;
constexpr uint32_t WasmDbgIpcEventTypeContinueRequest = 0x0201;
constexpr uint32_t WasmDbgIpcEventStepIntoRequestMagic = 0x53435049;
// Wasm-private request type carried under the IPCS magic; this is not a
// canonical DebuggerIPCEventType value.
constexpr uint32_t WasmDbgIpcEventTypeStepIntoRequest = 0x0102;

WasmDbiDacTestData g_wasmDbiDacTestData =
{
    0x43445744,
    123456789,
    1234.5,
    { 0x01234567, 0x89abcdef, 0xfedcba98, 0x76543210 },
    "wasm-dbi-dac"
};

uint8_t g_wasmDebugLastCommand[WasmDebugMessageBufferSize];
uint32_t g_wasmDebugLastCommandLength;
uint8_t g_wasmDebugLastEvent[WasmDebugMessageBufferSize];
uint32_t g_wasmDebugLastEventLength;
WasmDebugEventRecord g_wasmDebugLastEventRecord;
WasmDebugFrameRecord g_wasmDebugLastFrameRecord;
WasmDebugLocalsRecord g_wasmDebugLastLocalsRecord;
// Phase 4 slice 2: the structured DebuggerIPCEvent payload populated on
// every breakpoint hit. g_wasmDebugLastIpcEventValid is set to 1 by
// HandleInterpreterBreakpoint, cleared to 0 by CoreClrWasmDebugReadLastIpcEvent
// once a consumer (sidecar poll_event) drains it. BreakpointToken is the
// monotonic breakpoint counter; first-chance exception events keep their
// own counter so DBI can distinguish the event streams.
WasmDbgIpcEventBreakpointRuntime g_wasmDebugLastIpcEvent;
uint32_t g_wasmDebugLastIpcEventValid;
uint64_t g_wasmDebugBreakpointTokenCounter;
WasmDbgIpcEventException g_wasmDebugLastIpcException;
uint32_t g_wasmDebugLastIpcExceptionValid;
uint64_t g_wasmDebugExceptionTokenCounter;
WasmDbgIpcEventStepComplete g_wasmDebugLastIpcStepComplete;
uint32_t g_wasmDebugLastIpcStepCompleteValid;
uint64_t g_wasmDebugStepTokenCounter;
// Phase 7 multi-breakpoint state. The single-slot facade was replaced
// with a fixed-size array of slots so multiple managed breakpoints can
// be armed concurrently. Single-threaded wasm means at most one slot
// is "stopped" at any moment (only one interpreter thread); per-slot
// bookkeeping covers identity + patch state + hit count, session-level
// stopped/continue state stays shared.
//
// MaxBreakpoints is bounded (16 today) so the linear scans in the
// interpreter hot path (MaybePatchInterpreterMethod, ResolveActiveBreakpointSlot)
// stay cache-friendly. Mono's wasm debugger uses a similar bounded
// pattern; bump this only if real workloads need more.
constexpr uint32_t WasmDebugMaxBreakpoints = 16;

struct WasmDebugBreakpointSlot
{
    bool Armed;
    bool IsOneShot;
    char MethodName[64];
    uint32_t MethodToken;
    int32_t* PatchAddress;
    int32_t OriginalOpcode;
    bool PatchActive;
    uint32_t HitCount;
};

static_assert(sizeof(WasmDebugBreakpointSlot) == 88);

WasmDebugBreakpointSlot g_wasmDebugBreakpoints[WasmDebugMaxBreakpoints];

// Session-level breakpoint state. Single-threaded wasm means only one
// breakpoint can be "stopped" at a time; tracking which slot fired
// last is per-stop, not per-slot.
bool g_wasmDebugBreakpointStopped;
bool g_wasmDebugContinueRequested;
uint32_t g_wasmDebugContinueCount;
MethodDesc* g_wasmDebugLastStoppedMethodDesc;
const int32_t* g_wasmDebugLastStoppedIP;
uint32_t g_wasmDebugLastStoppedILOffset;
InterpMethodContextFrame* g_wasmDebugLastStoppedFrame;
// Index of the slot whose patch fired most recently (or
// WasmDebugMaxBreakpoints when no slot has fired). Used by the event-
// record builder to report the correct per-slot hit count.
uint32_t g_wasmDebugLastFiredSlot = WasmDebugMaxBreakpoints;

bool g_wasmDebugStepIntoCallPending;
uint64_t g_wasmDebugStepIntoTokenAtCall;
MethodDesc* g_wasmDebugStepIntoCallerMethod;
uint32_t g_wasmDebugStepIntoCallerILOffset;
const int32_t* g_wasmDebugStepIntoCallFallbackIP;
MethodDesc* g_wasmDebugMethodEnterContextMethodDesc;
const int32_t* g_wasmDebugMethodEnterContextIP;
InterpMethodContextFrame* g_wasmDebugMethodEnterContextFrame;
bool g_wasmDebugOneShotStepPending;
uint64_t g_wasmDebugOneShotStepRequestToken;

void ClearWasmDebugStepIntoCallState(bool clearFallbackBreakpoint);
void ClearWasmDebugOneShotStepState(bool clearBreakpoints);

// Phase 6 connection-state gate. Mirrors Mono's
// mono_wasm_set_is_debugger_attached (src/mono/mono/component/mini-wasm-debugger.c:38).
// The runtime debug adapter MUST NOT arm breakpoints or fire to-pause
// events when no debugger is connected — otherwise the runtime would
// patch interpreter opcodes or invoke `debugger;` JS imports that go
// nowhere, wasting work and (in the browser) being a no-op anyway when
// no V8 inspector is attached. Set to true via
// CoreClrWasmDebugSetDebuggerConnected once the host (browser proxy /
// debug-adapter) completes its handshake; cleared on disconnect.
bool g_wasmDebuggerConnected;

// CDP-level async-break correlation flag. The runtime does not implement
// the suspension itself for this path: an external CDP client sends
// Debugger.pause and V8's wasm-interrupt machinery halts execution at an
// instruction boundary. Hosts flip this flag around their own pause/resume
// request so future consumers can distinguish "our async-break request"
// from unrelated DevTools pauses or user-authored `debugger;` statements.
bool g_wasmDebugAsyncBreakInProgress;

void SetWasmDebugEvent(const char* event)
{
    size_t eventLength = strlen(event);
    if (eventLength >= WasmDebugMessageBufferSize)
    {
        eventLength = WasmDebugMessageBufferSize - 1;
    }

    memcpy(g_wasmDebugLastEvent, event, eventLength);
    g_wasmDebugLastEvent[eventLength] = 0;
    g_wasmDebugLastEventLength = static_cast<uint32_t>(eventLength);
}

void CopyWasmDebugString(char* destination, size_t destinationLength, const char* source)
{
    size_t sourceLength = strlen(source);
    if (sourceLength >= destinationLength)
    {
        sourceLength = destinationLength - 1;
    }

    memcpy(destination, source, sourceLength);
    destination[sourceLength] = 0;
}

void AppendWasmDebugString(char* destination, size_t destinationLength, size_t* destinationOffset, const char* source)
{
    if (destinationLength == 0 || source == nullptr)
    {
        return;
    }

    while (*source != 0 && *destinationOffset + 1 < destinationLength)
    {
        destination[*destinationOffset] = *source;
        (*destinationOffset)++;
        source++;
    }
    destination[*destinationOffset] = 0;
}

void CopyWasmDebugTypeName(char* destination, size_t destinationLength, MethodTable* methodTable)
{
    if (destinationLength == 0)
    {
        return;
    }

    destination[0] = 0;
    if (methodTable == nullptr)
    {
        return;
    }

    LPCUTF8 namespaceName = nullptr;
    LPCUTF8 className = methodTable->GetFullyQualifiedNameInfo(&namespaceName);
    size_t destinationOffset = 0;
    if (namespaceName != nullptr && namespaceName[0] != 0)
    {
        AppendWasmDebugString(destination, destinationLength, &destinationOffset, namespaceName);
        if (className != nullptr && className[0] != 0)
        {
            AppendWasmDebugString(destination, destinationLength, &destinationOffset, ".");
        }
    }
    AppendWasmDebugString(destination, destinationLength, &destinationOffset, className);
}

void SetWasmDebugBreakpointEventRecord(MethodDesc* methodDesc, uint32_t ilOffset)
{
    uint32_t hitCount = (g_wasmDebugLastFiredSlot < WasmDebugMaxBreakpoints)
        ? g_wasmDebugBreakpoints[g_wasmDebugLastFiredSlot].HitCount
        : 0;

    memset(&g_wasmDebugLastEventRecord, 0, sizeof(g_wasmDebugLastEventRecord));
    g_wasmDebugLastEventRecord.Kind = static_cast<uint32_t>(WasmDebugEventKind::Breakpoint);
    g_wasmDebugLastEventRecord.MethodToken = methodDesc->GetMemberDef();
    g_wasmDebugLastEventRecord.ILOffset = ilOffset;
    g_wasmDebugLastEventRecord.HitCount = hitCount;
    g_wasmDebugLastEventRecord.ContinueCount = g_wasmDebugContinueCount;
    CopyWasmDebugString(g_wasmDebugLastEventRecord.MethodName, sizeof(g_wasmDebugLastEventRecord.MethodName), methodDesc->GetName());
    CopyWasmDebugString(g_wasmDebugLastEventRecord.Message, sizeof(g_wasmDebugLastEventRecord.Message), reinterpret_cast<const char*>(g_wasmDebugLastEvent));
}

void SetWasmDebugBreakpointFrameRecord(MethodDesc* methodDesc, uint32_t ilOffset, const int32_t* ip, uintptr_t frameAddress, uintptr_t stackAddress)
{
    memset(&g_wasmDebugLastFrameRecord, 0, sizeof(g_wasmDebugLastFrameRecord));
    g_wasmDebugLastFrameRecord.MethodToken = methodDesc->GetMemberDef();
    g_wasmDebugLastFrameRecord.ILOffset = ilOffset;
    g_wasmDebugLastFrameRecord.InterpreterIP = static_cast<uint32_t>(reinterpret_cast<uintptr_t>(ip));
    g_wasmDebugLastFrameRecord.FrameAddress = static_cast<uint32_t>(frameAddress);
    g_wasmDebugLastFrameRecord.StackAddress = static_cast<uint32_t>(stackAddress);
    if (stackAddress != 0)
    {
        g_wasmDebugLastFrameRecord.FirstStackSlotI32 = *reinterpret_cast<int32_t*>(stackAddress);
    }
    CopyWasmDebugString(g_wasmDebugLastFrameRecord.MethodName, sizeof(g_wasmDebugLastFrameRecord.MethodName), methodDesc->GetName());
}

void SetWasmDebugBreakpointLocalsRecord(MethodDesc* methodDesc, uintptr_t stackAddress)
{
    memset(&g_wasmDebugLastLocalsRecord, 0, sizeof(g_wasmDebugLastLocalsRecord));
    g_wasmDebugLastLocalsRecord.Magic = WasmDebugLocalsRecordMagic;
    g_wasmDebugLastLocalsRecord.Version = 1;
    g_wasmDebugLastLocalsRecord.MethodToken = methodDesc->GetMemberDef();

    // Phase 8 slice 1 intentionally snapshots a conservative placeholder.
    // InterpMethod does not yet persist an IL-local descriptor table; the
    // follow-up sidecar path will expose/walk real interpreter local
    // metadata. Until then, publish the first 4-byte interpreter stack slot
    // with stable shape so DBI/IDE callers can exercise the DAC enumeration
    // path at a stopped frame.
    if (stackAddress != 0)
    {
        WasmDebugLocalRecord& local = g_wasmDebugLastLocalsRecord.Locals[0];
        local.ILSlot = 0;
        local.TypeTag = static_cast<uint32_t>(ELEMENT_TYPE_I4);
        local.ByteOffset = 0;
        local.ByteSize = sizeof(int32_t);
        CopyWasmDebugString(local.Name, sizeof(local.Name), "local0");
        g_wasmDebugLastLocalsRecord.LocalCount = 1;
    }
}

void EmitWasmDebugException(MethodDesc* methodDesc, uint32_t ilOffset, const int32_t* ip, OBJECTREF exceptionObj)
{
    if (g_wasmDebugOneShotStepPending)
    {
        ClearWasmDebugOneShotStepState(true);
    }

    if (g_wasmDebugStepIntoCallPending)
    {
        ClearWasmDebugStepIntoCallState(true);
    }

    if (!g_wasmDebuggerConnected || methodDesc == nullptr)
    {
        return;
    }

    g_wasmDebugExceptionTokenCounter++;
    memset(&g_wasmDebugLastIpcException, 0, sizeof(g_wasmDebugLastIpcException));
    g_wasmDebugLastIpcException.Magic = WasmDbgIpcEventExceptionMagic;
    g_wasmDebugLastIpcException.Type = WasmDbgIpcEventTypeException;
    g_wasmDebugLastIpcException.ProcessId = 1;
    g_wasmDebugLastIpcException.ThreadId = 1;
    g_wasmDebugLastIpcException.Hr = 0;
    g_wasmDebugLastIpcException.Flags = 0;
    g_wasmDebugLastIpcException.ExceptionToken = g_wasmDebugExceptionTokenCounter;
    g_wasmDebugLastIpcException.FuncMetadataToken = methodDesc->GetMemberDef();
    g_wasmDebugLastIpcException.ILOffset = ilOffset;
    g_wasmDebugLastIpcException.ExceptionAddress = reinterpret_cast<uintptr_t>(ip);

    if (exceptionObj != NULL)
    {
        OBJECTREF protectedException = exceptionObj;
        GCPROTECT_BEGIN(protectedException);
        MethodTable* exceptionMethodTable = protectedException->GetMethodTable();
        if (IsException(exceptionMethodTable))
        {
            g_wasmDebugLastIpcException.Hr = ((EXCEPTIONREF)protectedException)->GetHResult();
        }

        CopyWasmDebugTypeName(
            g_wasmDebugLastIpcException.ExceptionTypeName,
            sizeof(g_wasmDebugLastIpcException.ExceptionTypeName),
            exceptionMethodTable);
        GCPROTECT_END();
    }

    g_wasmDebugLastIpcExceptionValid = 1;
    coreClrDebugFireEventToPause(
        static_cast<uint32_t>(reinterpret_cast<uintptr_t>(&g_wasmDebugLastIpcException)),
        static_cast<uint32_t>(sizeof(g_wasmDebugLastIpcException)));
}

void EmitWasmDebugStepComplete(
    MethodDesc* methodDesc,
    uint32_t ilOffset,
    const int32_t* ip,
    uint64_t originalStepRequestToken,
    bool isIL,
    InterpMethodContextFrame* frame)
{
    if (!g_wasmDebuggerConnected || methodDesc == nullptr)
    {
        return;
    }

    g_wasmDebugStepTokenCounter++;
    memset(&g_wasmDebugLastIpcStepComplete, 0, sizeof(g_wasmDebugLastIpcStepComplete));
    g_wasmDebugLastIpcStepComplete.Magic = WasmDbgIpcEventStepCompleteMagic;
    g_wasmDebugLastIpcStepComplete.Type = WasmDbgIpcEventTypeStepComplete;
    g_wasmDebugLastIpcStepComplete.ProcessId = 1;
    g_wasmDebugLastIpcStepComplete.ThreadId = 1;
    g_wasmDebugLastIpcStepComplete.Hr = 0;
    g_wasmDebugLastIpcStepComplete.Flags = 0;
    g_wasmDebugLastIpcStepComplete.StepToken = g_wasmDebugStepTokenCounter;
    g_wasmDebugLastIpcStepComplete.OriginalStepRequestToken = originalStepRequestToken;
    g_wasmDebugLastIpcStepComplete.FuncMetadataToken = methodDesc->GetMemberDef();
    g_wasmDebugLastIpcStepComplete.ILOffset = ilOffset;
    g_wasmDebugLastIpcStepComplete.IsIL = isIL ? 1 : 0;
    g_wasmDebugLastIpcStepComplete.CodeStartAddress = reinterpret_cast<uintptr_t>(ip);
    g_wasmDebugLastIpcStepCompleteValid = 1;

    g_wasmDebugBreakpointStopped = true;
    g_wasmDebugContinueRequested = false;
    g_wasmDebugLastFiredSlot = WasmDebugMaxBreakpoints;
    g_wasmDebugLastStoppedMethodDesc = methodDesc;
    g_wasmDebugLastStoppedIP = ip;
    g_wasmDebugLastStoppedILOffset = ilOffset;
    g_wasmDebugLastStoppedFrame = frame;

    coreClrDebugFireEventToPause(
        static_cast<uint32_t>(reinterpret_cast<uintptr_t>(&g_wasmDebugLastIpcStepComplete)),
        static_cast<uint32_t>(sizeof(g_wasmDebugLastIpcStepComplete)));

    g_wasmDebugBreakpointStopped = false;
}

// Restore the original interpreter opcode at the patch site for a
// specific breakpoint slot, then clear its patch-state. Safe to call
// against an unarmed or unpatched slot (no-op).
void RestoreWasmDebugBreakpointPatchSlot(WasmDebugBreakpointSlot& slot)
{
    if (slot.PatchActive && slot.PatchAddress != nullptr)
    {
        *slot.PatchAddress = slot.OriginalOpcode;
    }

    slot.PatchAddress = nullptr;
    slot.OriginalOpcode = 0;
    slot.PatchActive = false;
}

bool HasOtherWasmDebugActivePatchAt(const WasmDebugBreakpointSlot& slot)
{
    if (!slot.PatchActive || slot.PatchAddress == nullptr)
    {
        return false;
    }

    for (const WasmDebugBreakpointSlot& otherSlot : g_wasmDebugBreakpoints)
    {
        if (&otherSlot != &slot &&
            otherSlot.PatchActive &&
            otherSlot.PatchAddress == slot.PatchAddress)
        {
            return true;
        }
    }

    return false;
}

void ClearWasmDebugBreakpointSlot(WasmDebugBreakpointSlot& slot)
{
    if (HasOtherWasmDebugActivePatchAt(slot))
    {
        slot.PatchAddress = nullptr;
        slot.OriginalOpcode = 0;
        slot.PatchActive = false;
    }
    else
    {
        RestoreWasmDebugBreakpointPatchSlot(slot);
    }

    slot.Armed = false;
    slot.IsOneShot = false;
    slot.MethodName[0] = 0;
    slot.MethodToken = 0;
    slot.HitCount = 0;
}

// Find a free slot to arm a new breakpoint into. Returns nullptr when
// all WasmDebugMaxBreakpoints slots are in use; callers (e.g.
// dbi_set_breakpoint_by_*) should surface that as a session-level error.
WasmDebugBreakpointSlot* FindFreeWasmDebugBreakpointSlot(uint32_t* outIndex)
{
    for (uint32_t i = 0; i < WasmDebugMaxBreakpoints; i++)
    {
        if (!g_wasmDebugBreakpoints[i].Armed)
        {
            if (outIndex != nullptr)
            {
                *outIndex = i;
            }
            return &g_wasmDebugBreakpoints[i];
        }
    }
    return nullptr;
}

uint32_t CountFreeWasmDebugBreakpointSlots()
{
    uint32_t count = 0;
    for (const auto& slot : g_wasmDebugBreakpoints)
    {
        if (!slot.Armed)
        {
            count++;
        }
    }
    return count;
}

bool TryGetWasmDebugInterpreterIPOffset(MethodDesc* methodDesc, const int32_t* ip, uint32_t* outOffset)
{
    if (outOffset != nullptr)
    {
        *outOffset = 0;
    }

    if (methodDesc == nullptr || ip == nullptr)
    {
        return false;
    }

    PTR_InterpByteCodeStart byteCodeStart = methodDesc->GetInterpreterCode();
    if (byteCodeStart == nullptr || byteCodeStart->Method == nullptr)
    {
        return false;
    }

    const int32_t* startIP = byteCodeStart->GetByteCodes();
    uintptr_t startAddress = reinterpret_cast<uintptr_t>(startIP);
    uintptr_t ipAddress = reinterpret_cast<uintptr_t>(ip);
    if (ipAddress < startAddress)
    {
        return false;
    }

    uintptr_t byteOffset = ipAddress - startAddress;
    if ((byteOffset % sizeof(int32_t)) != 0)
    {
        return false;
    }

    uintptr_t slotOffset = byteOffset / sizeof(int32_t);
    if (slotOffset > UINT32_MAX ||
        slotOffset >= static_cast<uintptr_t>(byteCodeStart->Method->codeSize))
    {
        return false;
    }

    if (outOffset != nullptr)
    {
        *outOffset = static_cast<uint32_t>(slotOffset);
    }
    return true;
}

bool IsWasmDebugInterpreterIPInMethod(MethodDesc* methodDesc, const int32_t* ip)
{
    return TryGetWasmDebugInterpreterIPOffset(methodDesc, ip, nullptr);
}

bool TryGetOriginalOpcodeForActivePatch(const int32_t* ip, int32_t* originalOpcode)
{
    if (ip == nullptr || originalOpcode == nullptr)
    {
        return false;
    }

    for (const auto& slot : g_wasmDebugBreakpoints)
    {
        if (slot.PatchActive && slot.PatchAddress == ip)
        {
            *originalOpcode = slot.OriginalOpcode;
            return true;
        }
    }
    return false;
}

bool ArmWasmDebugBreakpointSlot(
    WasmDebugBreakpointSlot& slot,
    uint32_t methodToken,
    const char* methodName,
    bool isOneShot)
{
    RestoreWasmDebugBreakpointPatchSlot(slot);

    const char* name = methodName != nullptr ? methodName : "";
    size_t nameLength = strlen(name);
    if (nameLength >= sizeof(slot.MethodName))
    {
        nameLength = sizeof(slot.MethodName) - 1;
    }
    memcpy(slot.MethodName, name, nameLength);
    slot.MethodName[nameLength] = 0;
    slot.MethodToken = (nameLength != 0) ? 0 : methodToken;
    slot.HitCount = 0;
    slot.IsOneShot = isOneShot;
    slot.Armed = true;

    // Session-level state reset on first armed breakpoint of a session.
    // Subsequent arms don't reset Stopped/ContinueRequested because the
    // user might be arming additional breakpoints while one is already
    // stopped (legal — they apply on the next continue).
    if (g_wasmDebugLastFiredSlot >= WasmDebugMaxBreakpoints)
    {
        g_wasmDebugLastEventLength = 0;
        memset(&g_wasmDebugLastEventRecord, 0, sizeof(g_wasmDebugLastEventRecord));
        memset(&g_wasmDebugLastFrameRecord, 0, sizeof(g_wasmDebugLastFrameRecord));
        g_wasmDebugBreakpointStopped = false;
        g_wasmDebugContinueRequested = false;
    }
    return true;
}

bool ArmWasmDebugBreakpoint(uint32_t methodToken, const char* methodName)
{
    uint32_t slotIndex = WasmDebugMaxBreakpoints;
    WasmDebugBreakpointSlot* slot = FindFreeWasmDebugBreakpointSlot(&slotIndex);
    if (slot == nullptr)
    {
        return false;
    }

    return ArmWasmDebugBreakpointSlot(*slot, methodToken, methodName, false);
}

bool ArmWasmDebugOneShotBreakpoint(MethodDesc* methodDesc, const int32_t* targetIP)
{
    if (!IsWasmDebugInterpreterIPInMethod(methodDesc, targetIP))
    {
        return false;
    }

    uint32_t slotIndex = WasmDebugMaxBreakpoints;
    WasmDebugBreakpointSlot* slot = FindFreeWasmDebugBreakpointSlot(&slotIndex);
    if (slot == nullptr)
    {
        return false;
    }

    int32_t* patchAddress = const_cast<int32_t*>(targetIP);
    int32_t originalOpcode = 0;
    bool alreadyPatched = TryGetOriginalOpcodeForActivePatch(targetIP, &originalOpcode);
    if (!alreadyPatched)
    {
        originalOpcode = *patchAddress;
        if (originalOpcode == INTOP_BREAKPOINT)
        {
            return false;
        }
    }

    if (!ArmWasmDebugBreakpointSlot(*slot, methodDesc->GetMemberDef(), "", true))
    {
        return false;
    }

    if (!alreadyPatched)
    {
        *patchAddress = INTOP_BREAKPOINT;
    }

    slot->PatchAddress = patchAddress;
    slot->OriginalOpcode = originalOpcode;
    slot->PatchActive = true;
    return true;
}

// Clear a previously-armed breakpoint by name (substring match) or by
// token. Returns the number of slots that were cleared (0 if no match,
// 1+ if multiple slots had the same identity which the Arm protocol
// today doesn't prevent). Restores any active patch as a side effect.
uint32_t ClearWasmDebugBreakpointByName(const char* methodName)
{
    if (methodName == nullptr || methodName[0] == 0)
    {
        return 0;
    }

    uint32_t cleared = 0;
    for (auto& slot : g_wasmDebugBreakpoints)
    {
        if (slot.Armed &&
            slot.MethodToken == 0 &&
            strcmp(slot.MethodName, methodName) == 0)
        {
            ClearWasmDebugBreakpointSlot(slot);
            cleared++;
        }
    }
    return cleared;
}

uint32_t ClearWasmDebugBreakpointByToken(uint32_t methodToken)
{
    if (methodToken == 0)
    {
        return 0;
    }

    uint32_t cleared = 0;
    for (auto& slot : g_wasmDebugBreakpoints)
    {
        if (slot.Armed && slot.MethodToken == methodToken)
        {
            ClearWasmDebugBreakpointSlot(slot);
            cleared++;
        }
    }
    return cleared;
}

void ClearWasmDebugOneShotBreakpointAt(MethodDesc* methodDesc, const int32_t* targetIP)
{
    if (methodDesc == nullptr || targetIP == nullptr)
    {
        return;
    }

    mdMethodDef methodToken = methodDesc->GetMemberDef();
    for (auto& slot : g_wasmDebugBreakpoints)
    {
        if (slot.Armed &&
            slot.IsOneShot &&
            slot.MethodToken == methodToken &&
            slot.PatchAddress == targetIP)
        {
            ClearWasmDebugBreakpointSlot(slot);
        }
    }
}

void ClearWasmDebugAllOneShotBreakpoints()
{
    for (auto& slot : g_wasmDebugBreakpoints)
    {
        if (slot.Armed && slot.IsOneShot)
        {
            ClearWasmDebugBreakpointSlot(slot);
        }
    }
}

void SetWasmDebugOneShotStepState(uint64_t originalStepRequestToken)
{
    g_wasmDebugOneShotStepPending = true;
    g_wasmDebugOneShotStepRequestToken = originalStepRequestToken;
}

void ClearWasmDebugOneShotStepState(bool clearBreakpoints)
{
    if (clearBreakpoints)
    {
        ClearWasmDebugAllOneShotBreakpoints();
    }

    g_wasmDebugOneShotStepPending = false;
    g_wasmDebugOneShotStepRequestToken = 0;
}

void ClearWasmDebugStepIntoCallState(bool clearFallbackBreakpoint)
{
    if (clearFallbackBreakpoint)
    {
        ClearWasmDebugOneShotBreakpointAt(g_wasmDebugStepIntoCallerMethod, g_wasmDebugStepIntoCallFallbackIP);
    }

    g_wasmDebugStepIntoCallPending = false;
    g_wasmDebugStepIntoTokenAtCall = 0;
    g_wasmDebugStepIntoCallerMethod = nullptr;
    g_wasmDebugStepIntoCallerILOffset = 0;
    g_wasmDebugStepIntoCallFallbackIP = nullptr;
}

uint32_t CountActiveWasmDebugBreakpoints()
{
    uint32_t count = 0;
    for (const auto& slot : g_wasmDebugBreakpoints)
    {
        if (slot.Armed)
        {
            count++;
        }
    }
    return count;
}

bool ArmWasmDebugBreakpointFromCommand(const char* command)
{
    static constexpr char Prefix[] = "dbi-command:set-breakpoint";
    static constexpr char NamePrefix[] = ":name=";
    static constexpr char TokenPrefix[] = ":token=0x";

    if (strncmp(command, Prefix, sizeof(Prefix) - 1) != 0)
    {
        // Not a set-breakpoint command — treat as "did not arm, but
        // not an error" so the text transport reports success for
        // unrelated commands (continue, future commands, etc.).
        return true;
    }

    const char* name = command + sizeof(Prefix) - 1;
    uint32_t methodToken = 0;
    if (strncmp(name, NamePrefix, sizeof(NamePrefix) - 1) == 0)
    {
        name += sizeof(NamePrefix) - 1;
    }
    else if (strncmp(name, TokenPrefix, sizeof(TokenPrefix) - 1) == 0)
    {
        name += sizeof(TokenPrefix) - 1;
        methodToken = static_cast<uint32_t>(strtoul(name, nullptr, 16));
        name = "";
    }
    else
    {
        name = "";
    }

    return ArmWasmDebugBreakpoint(methodToken, name);
}

bool WasmDebugBreakpointSlotMatches(const WasmDebugBreakpointSlot& slot, MethodDesc* methodDesc, uint32_t ilOffset)
{
    if (methodDesc == nullptr || !slot.Armed)
    {
        return false;
    }

    if (!slot.IsOneShot && ilOffset != 0)
    {
        return false;
    }

    // A slot with neither a token nor a name is a degenerate "wildcard"
    // that would match every interpreted method's first IL instruction;
    // refuse to fire it. Such slots are still legal in the table (they
    // can be allocated by the legacy text-command transport when the
    // command lacks both qualifiers) but the interpreter hot path treats
    // them as inert. The slot still counts toward
    // CountActiveWasmDebugBreakpoints so the user sees it and can clear
    // it via ClearWasmDebugBreakpointByName("") or by clearing every slot.
    if (slot.MethodToken == 0 && slot.MethodName[0] == 0)
    {
        return false;
    }

    LPCUTF8 methodName = methodDesc->GetName();
    mdMethodDef methodToken = methodDesc->GetMemberDef();
    if (slot.MethodToken != 0 && slot.MethodToken != methodToken)
    {
        return false;
    }

    if (slot.MethodToken == 0 && strstr(methodName, slot.MethodName) == nullptr)
    {
        return false;
    }

    return true;
}

void RequestWasmDebugContinue()
{
    if (g_wasmDebugBreakpointStopped)
    {
        g_wasmDebugContinueRequested = true;
        g_wasmDebugContinueCount++;
    }
}

void ContinueWasmDebugBreakpointFromCommand(const char* command)
{
    static constexpr char ContinueCommand[] = "dbi-command:continue";
    if (strcmp(command, ContinueCommand) != 0)
    {
        return;
    }

    RequestWasmDebugContinue();
}

extern "C" EMSCRIPTEN_KEEPALIVE void* GetWasmDbiDacTestData()
{
    return &g_wasmDbiDacTestData;
}

// Phase 4 slice 3: address-of getters so the sidecar's TryGetSymbol
// host bridge can resolve the structured-event globals and drain via
// the DAC ReadVirtual path (no JS-side runtime call needed at fire
// time). Follow the same naming convention as Getg_dacTable /
// GetWasmDbiDacTestData; the JS bridge maps the symbol-name string
// "g_wasmDebugLastIpcEvent" / "g_wasmDebugLastIpcEventValid" to a
// call into the matching getter.
extern "C" EMSCRIPTEN_KEEPALIVE void* Getg_wasmDebugLastIpcEvent()
{
    return &g_wasmDebugLastIpcEvent;
}

extern "C" EMSCRIPTEN_KEEPALIVE void* Getg_wasmDebugLastIpcEventValid()
{
    return &g_wasmDebugLastIpcEventValid;
}

extern "C" EMSCRIPTEN_KEEPALIVE void* Getg_wasmDebugLastIpcException()
{
    return &g_wasmDebugLastIpcException;
}

extern "C" EMSCRIPTEN_KEEPALIVE void* Getg_wasmDebugLastIpcExceptionValid()
{
    return &g_wasmDebugLastIpcExceptionValid;
}

extern "C" EMSCRIPTEN_KEEPALIVE void* Getg_wasmDebugLastIpcStepComplete()
{
    return &g_wasmDebugLastIpcStepComplete;
}

extern "C" EMSCRIPTEN_KEEPALIVE void* Getg_wasmDebugLastIpcStepCompleteValid()
{
    return &g_wasmDebugLastIpcStepCompleteValid;
}

extern "C" EMSCRIPTEN_KEEPALIVE void* Getg_wasmDebugBreakpoints()
{
    return &g_wasmDebugBreakpoints[0];
}

extern "C" EMSCRIPTEN_KEEPALIVE void* Getg_wasmDebugLastLocalsRecord()
{
    return &g_wasmDebugLastLocalsRecord;
}

extern "C" EMSCRIPTEN_KEEPALIVE uint32_t CoreClrWasmDebugGetBreakpointSlotSize()
{
    return static_cast<uint32_t>(sizeof(WasmDebugBreakpointSlot));
}

extern "C" EMSCRIPTEN_KEEPALIVE uint32_t CoreClrWasmDebugGetBreakpointSlotCapacity()
{
    return WasmDebugMaxBreakpoints;
}

// Smoke-only probe: write a small fixed-size block of well-known DacGlobals
// slot values into the caller-supplied buffer. Returns the number of TADDR
// slots written (currently 13). The smoke harness uses this after init to
// verify that the dynamic InitializeEntries path (debug/ee/dactable.cpp on
// wasm) actually populated the dac__g_pXxx / Class__member slots — before
// the dactable migration these slots were all zero except ThreadStore.
//
// The slot ordering must match the smoke harness's reader:
//   [0] = ThreadStore::s_pThreadStore       — single seed retained from the
//                                              old hand-rolled init; non-zero
//                                              proves ThreadStore class exists.
//   [1] = AppDomain::m_pTheAppDomain        — non-zero proves AppDomain class
//                                              symbol is now linked into the
//                                              DAC table.
//   [2] = SystemDomain::m_pSystemDomain     — same for SystemDomain.
//   [3] = g_pConfig                         — global EEConfig pointer var.
//   [4] = g_pGCHeap                         — global GC heap pointer var.
//   [5] = g_pObjectClass                    — type-system globals.
//   [6] = g_pStringClass
//   [7] = g_pDebugger                       — wasm stub (null) from
//                                              vm/wasm/wasm-debuggee-stubs.cpp;
//                                              slot value is the address of
//                                              the stub variable.
//   [8] = g_pEEInterface                    — wasm stub.
//   [9] = CLRJitAttachState                 — wasm stub.
//  [10] = DebuggerController::g_patches     — wasm stub.
//  [11] = DebuggerController::g_patchTableValid — wasm stub.
//  [12] = Debugger::s_fCanChangeNgenFlags   — wasm stub.
//
// Each TADDR is the *address of the variable*, not the variable's value.
// PTR_TO_TADDR(&var) is what InitializeEntries stores. A zero address
// means InitializeEntries skipped that slot or the var has no storage.
// The smoke asserts ALL 13 are non-zero on wasm; with the wasm-debuggee-
// stubs.cpp providing the 6 previously-skipped globals, ~145 of the ~145
// DacGlobals slots are now wired (only 5 vtable identity slots remain
// zero — see VPTR_CLASS_REQUIRES_DEBUG_EE handling in dactable.cpp).
// Public smoke export rooted in this already-live VM translation unit. The
// implementation lives beside InterpreterStepHelper, so this call pulls the
// shared helper source from coreclr_static into the runtime link graph.
extern "C" EMSCRIPTEN_KEEPALIVE uint32_t CoreClrWasmDebugCallInterpreterStepHelperProbe()
{
    return CoreClrWasmDebugCallInterpreterStepHelperProbeImpl();
}

extern "C" EMSCRIPTEN_KEEPALIVE uint32_t CoreClrWasmDebugGetMethodEnterEnabledQueryCount()
{
    return CoreClrWasmDebugGetMethodEnterEnabledQueryCountImpl();
}

extern "C" EMSCRIPTEN_KEEPALIVE int32_t CoreClrWasmDebugReadDacGlobalsProbe(uint32_t* outBuffer, uint32_t bufferLengthBytes)
{
    constexpr uint32_t SlotCount = 13;
    constexpr uint32_t RequiredBytes = SlotCount * sizeof(uint32_t);
    if (outBuffer == nullptr || bufferLengthBytes < RequiredBytes)
    {
        return -1;
    }

    outBuffer[0]  = static_cast<uint32_t>(g_dacTable.ThreadStore__s_pThreadStore);
    outBuffer[1]  = static_cast<uint32_t>(g_dacTable.AppDomain__m_pTheAppDomain);
    outBuffer[2]  = static_cast<uint32_t>(g_dacTable.SystemDomain__m_pSystemDomain);
    outBuffer[3]  = static_cast<uint32_t>(g_dacTable.dac__g_pConfig);
    outBuffer[4]  = static_cast<uint32_t>(g_dacTable.dac__g_pGCHeap);
    outBuffer[5]  = static_cast<uint32_t>(g_dacTable.dac__g_pObjectClass);
    outBuffer[6]  = static_cast<uint32_t>(g_dacTable.dac__g_pStringClass);
    outBuffer[7]  = static_cast<uint32_t>(g_dacTable.dac__g_pDebugger);
    outBuffer[8]  = static_cast<uint32_t>(g_dacTable.dac__g_pEEInterface);
    outBuffer[9]  = static_cast<uint32_t>(g_dacTable.dac__CLRJitAttachState);
    outBuffer[10] = static_cast<uint32_t>(g_dacTable.DebuggerController__g_patches);
    outBuffer[11] = static_cast<uint32_t>(g_dacTable.DebuggerController__g_patchTableValid);
    outBuffer[12] = static_cast<uint32_t>(g_dacTable.Debugger__s_fCanChangeNgenFlags);
    return static_cast<int32_t>(SlotCount);
}

extern "C" EMSCRIPTEN_KEEPALIVE int32_t CoreClrWasmDebugReceiveCommand(const uint8_t* command, uint32_t commandLength)
{
    if ((command == nullptr && commandLength != 0) || commandLength >= WasmDebugMessageBufferSize)
    {
        return -1;
    }

    g_wasmDebugLastCommandLength = commandLength;
    if (commandLength != 0)
    {
        memcpy(g_wasmDebugLastCommand, command, commandLength);
    }
    g_wasmDebugLastCommand[commandLength] = 0;

    ContinueWasmDebugBreakpointFromCommand(reinterpret_cast<const char*>(g_wasmDebugLastCommand));
    // Surface ArmWasmDebugBreakpoint's "all 16 slots full" failure to
    // the text-transport caller. The CommandRecord path already does
    // this; making both paths return -1 on slot exhaustion keeps the
    // text protocol from silently dropping set-breakpoint commands.
    if (!ArmWasmDebugBreakpointFromCommand(reinterpret_cast<const char*>(g_wasmDebugLastCommand)))
    {
        return -1;
    }

    return 0;
}

extern "C" EMSCRIPTEN_KEEPALIVE int32_t CoreClrWasmDebugReceiveCommandRecord(const uint8_t* commandRecord, uint32_t commandRecordLength)
{
    if (commandRecord == nullptr || commandRecordLength != sizeof(WasmDebugCommandRecord))
    {
        return -1;
    }

    WasmDebugCommandRecord record;
    memcpy(&record, commandRecord, sizeof(record));
    if (record.Magic != WasmDebugCommandRecordMagic)
    {
        return -1;
    }

    switch (static_cast<WasmDebugCommandKind>(record.Kind))
    {
        case WasmDebugCommandKind::SetBreakpointByName:
            record.MethodName[sizeof(record.MethodName) - 1] = 0;
            // Returns false when all WasmDebugMaxBreakpoints slots are
            // armed. Surface that as an error to the caller; the existing
            // protocol uses -1 for all command-record failures.
            return ArmWasmDebugBreakpoint(0, record.MethodName) ? 0 : -1;

        case WasmDebugCommandKind::SetBreakpointByToken:
            if (record.ILOffset != 0)
            {
                return -1;
            }

            return ArmWasmDebugBreakpoint(record.MethodToken, "") ? 0 : -1;

        case WasmDebugCommandKind::Continue:
            RequestWasmDebugContinue();
            return 0;

        default:
            return -1;
    }
}

extern "C" EMSCRIPTEN_KEEPALIVE int32_t CoreClrWasmDebugSubmitContinueRequest(const uint8_t* requestBytes, uint32_t requestBytesLength)
{
    if (requestBytes == nullptr || requestBytesLength != sizeof(WasmDbgIpcEventContinueRequest))
    {
        return -1;
    }

    WasmDbgIpcEventContinueRequest request;
    memcpy(&request, requestBytes, sizeof(request));
    if (request.Magic != WasmDbgIpcEventContinueRequestMagic ||
        request.Type != WasmDbgIpcEventTypeContinueRequest)
    {
        return -1;
    }

    RequestWasmDebugContinue();
    return 0;
}

extern "C" EMSCRIPTEN_KEEPALIVE int32_t CoreClrWasmDebugSubmitStepIntoRequest(const uint8_t* requestBytes, uint32_t requestBytesLength)
{
    if (requestBytes == nullptr || requestBytesLength != sizeof(WasmDbgIpcEventStepIntoRequest))
    {
        return -1;
    }

    WasmDbgIpcEventStepIntoRequest request;
    memcpy(&request, requestBytes, sizeof(request));
    if (request.Magic != WasmDbgIpcEventStepIntoRequestMagic ||
        request.Type != WasmDbgIpcEventTypeStepIntoRequest)
    {
        return -1;
    }

    WasmDebugStepKind stepKind = static_cast<WasmDebugStepKind>(request.StepKind);
    if (stepKind != WasmDebugStepKind::Into &&
        stepKind != WasmDebugStepKind::Over &&
        stepKind != WasmDebugStepKind::Out)
    {
        return -1;
    }

    if (!g_wasmDebugBreakpointStopped ||
        g_wasmDebugLastStoppedMethodDesc == nullptr ||
        g_wasmDebugLastStoppedIP == nullptr)
    {
        return -1;
    }

    if (request.BreakpointToken != 0 &&
        request.BreakpointToken != g_wasmDebugLastIpcEvent.BreakpointToken)
    {
        return -1;
    }

    PTR_InterpByteCodeStart byteCodeStart = g_wasmDebugLastStoppedMethodDesc->GetInterpreterCode();
    if (byteCodeStart == nullptr || byteCodeStart->Method == nullptr)
    {
        return -1;
    }

    InterpreterWalker walker;
    walker.Init(g_wasmDebugLastStoppedIP, byteCodeStart->Method);

    uint64_t originalStepRequestToken = request.BreakpointToken != 0
        ? request.BreakpointToken
        : g_wasmDebugLastIpcEvent.BreakpointToken;

    if (stepKind == WasmDebugStepKind::Out)
    {
        if (g_wasmDebugLastStoppedFrame == nullptr)
        {
            return -3;
        }

        InterpMethodContextFrame* callerFrame = g_wasmDebugLastStoppedFrame->pParent;
        if (callerFrame == nullptr ||
            callerFrame->startIp == nullptr ||
            callerFrame->startIp->Method == nullptr ||
            callerFrame->ip == nullptr)
        {
            return -3;
        }

        MethodDesc* callerMethodDesc = callerFrame->startIp->Method->methodHnd;
        const int32_t* callerResumeIP = callerFrame->ip;
        if (callerMethodDesc == nullptr ||
            !IsWasmDebugInterpreterIPInMethod(callerMethodDesc, callerResumeIP))
        {
            return -3;
        }

        if (CountFreeWasmDebugBreakpointSlots() < 1)
        {
            return -3;
        }

        if (!ArmWasmDebugOneShotBreakpoint(callerMethodDesc, callerResumeIP))
        {
            return -3;
        }

        SetWasmDebugOneShotStepState(originalStepRequestToken);
        RequestWasmDebugContinue();
        return 0;
    }

    const int32_t* targets[2] = { nullptr, nullptr };
    uint32_t targetCount = 0;
    switch (walker.GetOpcodeWalkType())
    {
        case WALK_NEXT:
        case WALK_BREAK:
            targets[targetCount++] = walker.GetSkipIP();
            break;

        case WALK_BRANCH:
            targets[targetCount++] = walker.GetNextIP();
            break;

        case WALK_COND_BRANCH:
            targets[targetCount++] = walker.GetNextIP();
            targets[targetCount++] = walker.GetSkipIP();
            break;

        case WALK_CALL:
        {
            const int32_t* skipIP = walker.GetSkipIP();
            if (skipIP == nullptr ||
                !IsWasmDebugInterpreterIPInMethod(g_wasmDebugLastStoppedMethodDesc, skipIP))
            {
                return -1;
            }

            if (stepKind == WasmDebugStepKind::Over)
            {
                if (CountFreeWasmDebugBreakpointSlots() < 1)
                {
                    return -3;
                }

                if (!ArmWasmDebugOneShotBreakpoint(g_wasmDebugLastStoppedMethodDesc, skipIP))
                {
                    return -3;
                }

                SetWasmDebugOneShotStepState(originalStepRequestToken);
                RequestWasmDebugContinue();
                return 0;
            }

            if (g_wasmDebugStepIntoCallPending)
            {
                return -1;
            }

            if (CountFreeWasmDebugBreakpointSlots() < 1)
            {
                return -3;
            }

            if (!ArmWasmDebugOneShotBreakpoint(g_wasmDebugLastStoppedMethodDesc, skipIP))
            {
                return -3;
            }

            uint32_t callerILOffset = g_wasmDebugLastStoppedILOffset;
            TryGetWasmDebugInterpreterIPOffset(
                g_wasmDebugLastStoppedMethodDesc,
                g_wasmDebugLastStoppedIP,
                &callerILOffset);

            g_wasmDebugStepIntoCallPending = true;
            g_wasmDebugStepIntoTokenAtCall = originalStepRequestToken;
            g_wasmDebugStepIntoCallerMethod = g_wasmDebugLastStoppedMethodDesc;
            g_wasmDebugStepIntoCallerILOffset = callerILOffset;
            g_wasmDebugStepIntoCallFallbackIP = skipIP;
            RequestWasmDebugContinue();
            return 0;
        }

        case WALK_RETURN:
        case WALK_THROW:
        default:
            return -2;
    }

    const int32_t* uniqueTargets[2] = { nullptr, nullptr };
    uint32_t uniqueTargetCount = 0;
    for (uint32_t i = 0; i < targetCount; i++)
    {
        const int32_t* target = targets[i];
        if (target == nullptr)
        {
            return -2;
        }

        if (!IsWasmDebugInterpreterIPInMethod(g_wasmDebugLastStoppedMethodDesc, target))
        {
            return -1;
        }

        bool duplicate = false;
        for (uint32_t j = 0; j < uniqueTargetCount; j++)
        {
            if (uniqueTargets[j] == target)
            {
                duplicate = true;
                break;
            }
        }

        if (!duplicate)
        {
            uniqueTargets[uniqueTargetCount++] = target;
        }
    }

    if (CountFreeWasmDebugBreakpointSlots() < uniqueTargetCount)
    {
        return -3;
    }

    for (uint32_t i = 0; i < uniqueTargetCount; i++)
    {
        if (!ArmWasmDebugOneShotBreakpoint(g_wasmDebugLastStoppedMethodDesc, uniqueTargets[i]))
        {
            ClearWasmDebugOneShotStepState(true);
            return -3;
        }
    }

    if (stepKind != WasmDebugStepKind::Into)
    {
        SetWasmDebugOneShotStepState(originalStepRequestToken);
    }
    RequestWasmDebugContinue();
    return 0;
}

extern "C" EMSCRIPTEN_KEEPALIVE uint32_t CoreClrWasmDebugGetLastCommandLength()
{
    return g_wasmDebugLastCommandLength;
}

extern "C" EMSCRIPTEN_KEEPALIVE int32_t CoreClrWasmDebugCopyLastCommand(uint8_t* buffer, uint32_t bufferLength)
{
    if ((buffer == nullptr && bufferLength != 0) || bufferLength < g_wasmDebugLastCommandLength)
    {
        return -1;
    }

    if (g_wasmDebugLastCommandLength != 0)
    {
        memcpy(buffer, g_wasmDebugLastCommand, g_wasmDebugLastCommandLength);
    }

    return 0;
}

extern "C" EMSCRIPTEN_KEEPALIVE uint32_t CoreClrWasmDebugGetLastEventLength()
{
    return g_wasmDebugLastEventLength;
}

extern "C" EMSCRIPTEN_KEEPALIVE int32_t CoreClrWasmDebugCopyLastEvent(uint8_t* buffer, uint32_t bufferLength)
{
    if ((buffer == nullptr && bufferLength != 0) || bufferLength < g_wasmDebugLastEventLength)
    {
        return -1;
    }

    if (g_wasmDebugLastEventLength != 0)
    {
        memcpy(buffer, g_wasmDebugLastEvent, g_wasmDebugLastEventLength);
    }

    return 0;
}

extern "C" EMSCRIPTEN_KEEPALIVE uint32_t CoreClrWasmDebugGetLastEventRecordSize()
{
    return sizeof(WasmDebugEventRecord);
}

extern "C" EMSCRIPTEN_KEEPALIVE int32_t CoreClrWasmDebugCopyLastEventRecord(uint8_t* buffer, uint32_t bufferLength)
{
    if (buffer == nullptr || bufferLength < sizeof(WasmDebugEventRecord))
    {
        return -1;
    }

    memcpy(buffer, &g_wasmDebugLastEventRecord, sizeof(g_wasmDebugLastEventRecord));
    return 0;
}

extern "C" EMSCRIPTEN_KEEPALIVE uint32_t CoreClrWasmDebugGetLastFrameRecordSize()
{
    return sizeof(WasmDebugFrameRecord);
}

extern "C" EMSCRIPTEN_KEEPALIVE uint32_t CoreClrWasmDebugGetLastLocalsRecordSize()
{
    return sizeof(WasmDebugLocalsRecord);
}

extern "C" EMSCRIPTEN_KEEPALIVE int32_t CoreClrWasmDebugCopyLastFrameRecord(uint8_t* buffer, uint32_t bufferLength)
{
    if (buffer == nullptr || bufferLength < sizeof(WasmDebugFrameRecord))
    {
        return -1;
    }

    memcpy(buffer, &g_wasmDebugLastFrameRecord, sizeof(g_wasmDebugLastFrameRecord));
    return 0;
}

// Phase 4 slice 2: drain the most recently populated structured
// DebuggerIPCEvent payload. Returns the number of bytes copied (96 on
// success), 0 when no event is pending (g_wasmDebugLastIpcEventValid
// is 0), or -1 on bad buffer arguments. The Valid flag is cleared on
// successful drain so the next call returns 0 until the next
// breakpoint fires. Single-threaded wasm makes the "set in
// HandleInterpreterBreakpoint, read in drain" exchange a plain
// load/store — no fencing needed.
extern "C" EMSCRIPTEN_KEEPALIVE uint32_t CoreClrWasmDebugGetLastIpcEventSize()
{
    return sizeof(WasmDbgIpcEventBreakpointRuntime);
}

extern "C" EMSCRIPTEN_KEEPALIVE int32_t CoreClrWasmDebugReadLastIpcEvent(uint8_t* buffer, uint32_t bufferLength)
{
    if (buffer == nullptr || bufferLength < sizeof(WasmDbgIpcEventBreakpointRuntime))
    {
        return -1;
    }

    if (g_wasmDebugLastIpcEventValid == 0)
    {
        return 0;
    }

    memcpy(buffer, &g_wasmDebugLastIpcEvent, sizeof(g_wasmDebugLastIpcEvent));
    g_wasmDebugLastIpcEventValid = 0;
    return static_cast<int32_t>(sizeof(g_wasmDebugLastIpcEvent));
}

extern "C" EMSCRIPTEN_KEEPALIVE uint32_t CoreClrWasmDebugGetLastIpcExceptionSize()
{
    return sizeof(WasmDbgIpcEventException);
}

extern "C" EMSCRIPTEN_KEEPALIVE int32_t CoreClrWasmDebugReadLastIpcException(uint8_t* buffer, uint32_t bufferLength)
{
    if (buffer == nullptr || bufferLength < sizeof(WasmDbgIpcEventException))
    {
        return -1;
    }

    if (g_wasmDebugLastIpcExceptionValid == 0)
    {
        return 0;
    }

    memcpy(buffer, &g_wasmDebugLastIpcException, sizeof(g_wasmDebugLastIpcException));
    g_wasmDebugLastIpcExceptionValid = 0;
    return static_cast<int32_t>(sizeof(g_wasmDebugLastIpcException));
}

extern "C" EMSCRIPTEN_KEEPALIVE uint32_t CoreClrWasmDebugGetLastIpcStepCompleteSize()
{
    return sizeof(WasmDbgIpcEventStepComplete);
}

extern "C" EMSCRIPTEN_KEEPALIVE int32_t CoreClrWasmDebugReadLastIpcStepComplete(uint8_t* buffer, uint32_t bufferLength)
{
    if (buffer == nullptr || bufferLength < sizeof(WasmDbgIpcEventStepComplete))
    {
        return -1;
    }

    if (g_wasmDebugLastIpcStepCompleteValid == 0)
    {
        return 0;
    }

    memcpy(buffer, &g_wasmDebugLastIpcStepComplete, sizeof(g_wasmDebugLastIpcStepComplete));
    g_wasmDebugLastIpcStepCompleteValid = 0;
    return static_cast<int32_t>(sizeof(g_wasmDebugLastIpcStepComplete));
}

extern "C" EMSCRIPTEN_KEEPALIVE uint32_t CoreClrWasmDebugGetBreakpointHitCount()
{
    // Phase 7 multi-bp: aggregate hit count across all armed slots.
    // Smoke harnesses with a single bp see exactly the slot's count;
    // multi-bp callers get the total (which is what the existing API
    // semantically meant — "how many times has any bp fired this
    // session"). Per-slot counts are exposed separately via the
    // breakpoint-slots probe and the BreakpointData event-record HitCount.
    uint32_t total = 0;
    for (const auto& slot : g_wasmDebugBreakpoints)
    {
        total += slot.HitCount;
    }
    return total;
}

extern "C" EMSCRIPTEN_KEEPALIVE uint32_t CoreClrWasmDebugGetContinueCount()
{
    return g_wasmDebugContinueCount;
}

// Phase 7 multi-bp: expose the number of currently-armed breakpoint
// slots. Used by the base-smoke multi-bp probe to verify slot-set/clear
// bookkeeping. Bounded by WasmDebugMaxBreakpoints.
extern "C" EMSCRIPTEN_KEEPALIVE uint32_t CoreClrWasmDebugGetActiveBreakpointCount()
{
    return CountActiveWasmDebugBreakpoints();
}

extern "C" EMSCRIPTEN_KEEPALIVE int32_t CoreClrWasmDebugClearBreakpointByName(const char* methodName, uint32_t methodNameLength)
{
    if (methodName == nullptr || methodNameLength == 0 || methodNameLength >= 64)
    {
        return -1;
    }
    char buf[64];
    memcpy(buf, methodName, methodNameLength);
    buf[methodNameLength] = 0;
    return static_cast<int32_t>(ClearWasmDebugBreakpointByName(buf));
}

extern "C" EMSCRIPTEN_KEEPALIVE int32_t CoreClrWasmDebugClearBreakpointByToken(uint32_t methodToken)
{
    return static_cast<int32_t>(ClearWasmDebugBreakpointByToken(methodToken));
}

// Phase 6 connection-state gate. The runtime debug adapter exposes these
// two exports so the host (browser proxy, debug-adapter, smoke harness)
// can flip the connected flag once the actual debugger handshake
// completes. Returns the previous value to make smoke assertions
// simpler. Mirrors Mono mono_wasm_set_is_debugger_attached
// (src/mono/mono/component/mini-wasm-debugger.c:38-373) and the
// gate-check pattern used by mono_wasm_send_dbg_command.
extern "C" EMSCRIPTEN_KEEPALIVE int32_t CoreClrWasmDebugSetDebuggerConnected(int32_t connected)
{
    CoreClrWasmDebugEnsureDebuggerEEInterface();

    int32_t previous = g_wasmDebuggerConnected ? 1 : 0;
    g_wasmDebuggerConnected = (connected != 0);
    return previous;
}

extern "C" bool CoreClrWasmDebugIsDebuggerConnectedForHooks()
{
    LIMITED_METHOD_CONTRACT;
    return g_wasmDebuggerConnected;
}

extern "C" bool CoreClrWasmDebugIsStepIntoCallPending()
{
    LIMITED_METHOD_CONTRACT;
    return g_wasmDebuggerConnected && g_wasmDebugStepIntoCallPending;
}

extern "C" void CoreClrWasmDebugSetMethodEnterContext(MethodDesc* methodDesc, const int32_t* ip, InterpMethodContextFrame* frame)
{
    LIMITED_METHOD_CONTRACT;
    g_wasmDebugMethodEnterContextMethodDesc = methodDesc;
    g_wasmDebugMethodEnterContextIP = ip;
    g_wasmDebugMethodEnterContextFrame = frame;
}

extern "C" void CoreClrWasmDebugClearMethodEnterContext()
{
    LIMITED_METHOD_CONTRACT;
    g_wasmDebugMethodEnterContextMethodDesc = nullptr;
    g_wasmDebugMethodEnterContextIP = nullptr;
    g_wasmDebugMethodEnterContextFrame = nullptr;
}

extern "C" void CoreClrWasmDebugHandleMethodEnter(const int32_t* ip)
{
    if (!g_wasmDebuggerConnected ||
        !g_wasmDebugStepIntoCallPending ||
        g_wasmDebugMethodEnterContextMethodDesc == nullptr)
    {
        return;
    }

    const int32_t* landedIP = ip != nullptr ? ip : g_wasmDebugMethodEnterContextIP;
    uint64_t originalStepRequestToken = g_wasmDebugStepIntoTokenAtCall;
    MethodDesc* methodDesc = g_wasmDebugMethodEnterContextMethodDesc;
    InterpMethodContextFrame* frame = g_wasmDebugMethodEnterContextFrame;
    ClearWasmDebugStepIntoCallState(true);
    EmitWasmDebugStepComplete(methodDesc, 0, landedIP, originalStepRequestToken, true, frame);
}

extern "C" EMSCRIPTEN_KEEPALIVE int32_t CoreClrWasmDebugIsDebuggerConnected()
{
    return g_wasmDebuggerConnected ? 1 : 0;
}

extern "C" EMSCRIPTEN_KEEPALIVE int32_t CoreClrWasmDebugSetAsyncBreakInProgress(int32_t flag)
{
    int32_t previous = g_wasmDebugAsyncBreakInProgress ? 1 : 0;
    g_wasmDebugAsyncBreakInProgress = (flag != 0);
    return previous;
}

extern "C" EMSCRIPTEN_KEEPALIVE int32_t CoreClrWasmDebugIsAsyncBreakInProgress()
{
    return g_wasmDebugAsyncBreakInProgress ? 1 : 0;
}

extern "C" void CoreClrWasmDebugMaybePatchInterpreterMethod(MethodDesc* methodDesc, uint32_t ilOffset, int32_t* ip)
{
    // Phase 6 gate: never patch interpreter opcodes when the debugger is
    // not connected. Arming via ArmWasmDebugBreakpoint*() can still set
    // a slot (the protocol is "set a breakpoint, connect, run"), but the
    // patch is only installed once a debugger is actually connected to
    // receive the resulting fire. Same gating point Mono uses: see
    // mini-wasm-debugger.c:88-91 (try_process_suspend returns FALSE).
    if (!g_wasmDebuggerConnected || ip == nullptr)
    {
        return;
    }

    // Phase 7 multi-bp: scan all armed slots. Patch the IP once for
    // the first matching un-patched slot; subsequent matching slots
    // "ride along" by sharing the same PatchAddress + OriginalOpcode
    // so the IP holds INTOP_BREAKPOINT exactly once. When the patch
    // fires, HandleInterpreterBreakpoint identifies every PatchActive
    // slot at this IP, bumps each one's HitCount, and clears each
    // one's PatchActive — so cleanup via Clear* never tries to write
    // a stale opcode back into the interpreter stream.
    //
    // Correctness invariant: every slot that is PatchActive at a given
    // IP holds the *same* OriginalOpcode (captured BEFORE any patch is
    // installed). The code below guarantees that by capturing *ip
    // exactly once per call, before any write.
    int32_t originalOpcode = 0;
    bool patched = false;
    for (auto& slot : g_wasmDebugBreakpoints)
    {
        if (slot.PatchActive)
        {
            continue;
        }
        if (!WasmDebugBreakpointSlotMatches(slot, methodDesc, ilOffset))
        {
            continue;
        }
        if (!patched)
        {
            originalOpcode = *ip;
            *ip = INTOP_BREAKPOINT;
            patched = true;
        }
        slot.PatchAddress = ip;
        slot.OriginalOpcode = originalOpcode;
        slot.PatchActive = true;
    }
}

extern "C" bool CoreClrWasmDebugHandleInterpreterBreakpoint(
    MethodDesc* methodDesc,
    uint32_t ilOffset,
    const int32_t* ip,
    uintptr_t frameAddress,
    uintptr_t stackAddress,
    int32_t* originalOpcode)
{
    if (ip == nullptr || originalOpcode == nullptr)
    {
        return false;
    }

    // Phase 7 multi-bp: find every slot whose patch is at this IP.
    // MaybePatchInterpreterMethod guarantees all such slots share the
    // same OriginalOpcode, so restoration is a single write. Bump
    // every co-located slot's HitCount (matches user expectation that
    // arming the same breakpoint N times causes N hit notifications
    // per fire). g_wasmDebugLastFiredSlot points at the first match —
    // event-record consumers that only want one identity per stop see
    // the lowest slot index, which is also what the smoke harness
    // asserts against.
    WasmDebugBreakpointSlot* firingSlot = nullptr;
    uint32_t firingSlotIndex = WasmDebugMaxBreakpoints;
    uint32_t effectiveILOffset = ilOffset;
    bool firedOneShot = false;
    bool firedStepIntoCallFallback = false;
    bool firedTrackedOneShotStep = false;
    uint64_t stepCompleteOriginalToken = 0;
    TryGetWasmDebugInterpreterIPOffset(methodDesc, ip, &effectiveILOffset);
    for (uint32_t i = 0; i < WasmDebugMaxBreakpoints; i++)
    {
        WasmDebugBreakpointSlot& slot = g_wasmDebugBreakpoints[i];
        if (slot.PatchActive &&
            slot.PatchAddress == ip &&
            WasmDebugBreakpointSlotMatches(slot, methodDesc, effectiveILOffset))
        {
            if (firingSlot == nullptr)
            {
                firingSlot = &slot;
                firingSlotIndex = i;
            }
            slot.HitCount++;
            if (slot.IsOneShot)
            {
                firedOneShot = true;
                if (g_wasmDebugStepIntoCallPending &&
                    g_wasmDebugStepIntoCallerMethod == methodDesc &&
                    g_wasmDebugStepIntoCallFallbackIP == ip)
                {
                    firedStepIntoCallFallback = true;
                }
                slot.Armed = false;
                slot.IsOneShot = false;
                slot.MethodName[0] = 0;
                slot.MethodToken = 0;
            }
        }
    }

    if (firingSlot == nullptr)
    {
        return false;
    }

    *originalOpcode = firingSlot->OriginalOpcode;

    // Restore the patched opcode and clear PatchActive for every slot
    // that was pointing at this IP — the INTOP_BREAKPOINT is gone, so
    // leaving any slot PatchActive would be a stale lie that would
    // cause a future Clear* call to write a wrong opcode back into the
    // interpreter stream. Each slot remains Armed; the next interpreter
    // entry into the matching method will re-patch via
    // MaybePatchInterpreterMethod. We use the firing slot for the
    // actual *ip write (via RestoreWasmDebugBreakpointPatchSlot) so the
    // helper-defined invariant "patched IP holds OriginalOpcode after
    // restore" lives in one place; the loop below only clears state on
    // the other piggy-backing slots since their PatchAddress already
    // points at the same IP we just rewrote.
    RestoreWasmDebugBreakpointPatchSlot(*firingSlot);
    for (auto& slot : g_wasmDebugBreakpoints)
    {
        if (&slot == firingSlot)
        {
            continue;
        }
        if (slot.PatchActive && slot.PatchAddress == ip)
        {
            slot.PatchAddress = nullptr;
            slot.OriginalOpcode = 0;
            slot.PatchActive = false;
        }
    }

    if (firedOneShot)
    {
        if (g_wasmDebugOneShotStepPending)
        {
            firedTrackedOneShotStep = true;
            stepCompleteOriginalToken = g_wasmDebugOneShotStepRequestToken;
        }

        for (auto& slot : g_wasmDebugBreakpoints)
        {
            if (slot.IsOneShot)
            {
                ClearWasmDebugBreakpointSlot(slot);
            }
        }
    }

    if (firedStepIntoCallFallback)
    {
        ClearWasmDebugStepIntoCallState(false);
    }
    else if (firedTrackedOneShotStep)
    {
        ClearWasmDebugOneShotStepState(false);
    }
    else if (g_wasmDebugOneShotStepPending)
    {
        ClearWasmDebugOneShotStepState(true);
    }

    g_wasmDebugBreakpointStopped = true;
    g_wasmDebugContinueRequested = false;
    g_wasmDebugLastFiredSlot = firingSlotIndex;
    g_wasmDebugLastStoppedMethodDesc = methodDesc;
    g_wasmDebugLastStoppedIP = ip;
    g_wasmDebugLastStoppedILOffset = effectiveILOffset;
    g_wasmDebugLastStoppedFrame = reinterpret_cast<InterpMethodContextFrame*>(frameAddress);

    if (firedTrackedOneShotStep)
    {
        EmitWasmDebugStepComplete(
            methodDesc,
            effectiveILOffset,
            ip,
            stepCompleteOriginalToken,
            false,
            reinterpret_cast<InterpMethodContextFrame*>(frameAddress));
        g_wasmDebugBreakpointStopped = true;
        g_wasmDebugContinueRequested = false;
    }

    LPCUTF8 methodName = methodDesc->GetName();
    mdMethodDef methodToken = methodDesc->GetMemberDef();
    char event[WasmDebugMessageBufferSize];
    snprintf(
        event,
        sizeof(event),
        "breakpoint-hit:name=%s;token=0x%08x;il=0x%x",
        methodName,
        methodToken,
        effectiveILOffset);
    SetWasmDebugEvent(event);
    SetWasmDebugBreakpointEventRecord(methodDesc, effectiveILOffset);
    SetWasmDebugBreakpointFrameRecord(methodDesc, effectiveILOffset, ip, frameAddress, stackAddress);
    SetWasmDebugBreakpointLocalsRecord(methodDesc, stackAddress);

    // Phase 4 slice 2: populate the structured DebuggerIPCEvent payload
    // the sidecar can drain via CoreClrWasmDebugReadLastIpcEvent. This
    // is the runtime-side counterpart to the round-trip probe at
    // dbi_dac_wasm.cpp:1665 — same layout, same magic, same type. Once
    // the sidecar exposes coreclr_wasm_dbi_dac_dbi_poll_event the
    // future real mscordbi can stop reading the legacy text event and
    // start consuming the structured payload. BreakpointToken is the
    // monotonic counter so DBI can correlate hit -> continue across
    // multiple in-flight breakpoints.
    g_wasmDebugBreakpointTokenCounter++;
    memset(&g_wasmDebugLastIpcEvent, 0, sizeof(g_wasmDebugLastIpcEvent));
    g_wasmDebugLastIpcEvent.Magic = WasmDbgIpcEventBreakpointMagic;
    g_wasmDebugLastIpcEvent.Type = WasmDbgIpcEventTypeBreakpoint;
    g_wasmDebugLastIpcEvent.ProcessId = 1;
    g_wasmDebugLastIpcEvent.ThreadId = 1;
    g_wasmDebugLastIpcEvent.Hr = 0;
    g_wasmDebugLastIpcEvent.Flags = 0;
    g_wasmDebugLastIpcEvent.BreakpointToken = g_wasmDebugBreakpointTokenCounter;
    g_wasmDebugLastIpcEvent.FuncMetadataToken = methodToken;
    // Regular named/token breakpoints keep the existing IsIL=1 contract.
    // Slice-6 one-shot step landings report the interpreter slot offset with
    // IsIL=0 until a future slice wires native/interpreter-to-IL mapping here.
    g_wasmDebugLastIpcEvent.IsIL = firedOneShot ? 0 : 1;
    g_wasmDebugLastIpcEvent.Offset = effectiveILOffset;
    g_wasmDebugLastIpcEventValid = 1;

    // Phase 6: route the breakpoint event through coreClrDebugFireEventToPause
    // (Mono-pattern stop trigger). The JS-host body captures the payload and
    // executes `debugger;` to halt V8 in browser context; in Node smoke
    // context the `debugger;` is a no-op when no inspector is attached.
    // The legacy CoreClrWasmDebugOnBreakpointHit import is still called for
    // compatibility with the existing smoke harness; it can be retired once
    // every consumer (smoke + future proxy) migrates to the Mono-pattern name.
    coreClrDebugFireEventToPause(
        static_cast<uint32_t>(reinterpret_cast<uintptr_t>(g_wasmDebugLastEvent)),
        g_wasmDebugLastEventLength);
    CoreClrWasmDebugOnBreakpointHit(
        static_cast<uint32_t>(reinterpret_cast<uintptr_t>(g_wasmDebugLastEvent)),
        g_wasmDebugLastEventLength);

    g_wasmDebugBreakpointStopped = false;
    return true;
}
