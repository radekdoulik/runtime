// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.
//*****************************************************************************
// File: wasm_debug_ee_stubs.cpp
//
// Wasm-lite link-time stubs for debug/ee methods that desktop wks normally
// supplies to InterpreterStepHelper and its immediate debugger-controller
// surface.
//
// This slice deliberately keeps DebuggerController::g_patches null (the
// variable itself is still owned by vm/wasm/wasm-debuggee-stubs.cpp). A future
// Path A-lite slice will reconcile the current WasmDebugBreakpointSlot table
// with the desktop DebuggerPatchTable instead of activating patches here.
//*****************************************************************************

#include "stdafx.h"

#ifndef FEATURE_WASM_DEBUG_EE_LITE
#error "wasm_debug_ee_stubs.cpp must be built with FEATURE_WASM_DEBUG_EE_LITE"
#endif

#if !defined(DACCESS_COMPILE)

DebuggerController     *DebuggerController::g_controllers = NULL;
DebuggerControllerPage *DebuggerController::g_protections = NULL;
CrstStatic              DebuggerController::g_criticalSection;
int                     DebuggerController::g_cTotalMethodEnter = 0;

static bool s_controllerLockInitialized = false;

static bool InitializeControllerLock(CrstStatic *lock)
{
    LIMITED_METHOD_CONTRACT;

    if (s_controllerLockInitialized)
    {
        return true;
    }

    ZeroMemory(lock, sizeof(*lock));
    s_controllerLockInitialized = lock->InitNoThrow(
        CrstDebuggerController,
        (CrstFlags)(CRST_UNSAFE_ANYMODE | CRST_REENTRANCY | CRST_DEBUGGER_THREAD));
    _ASSERTE(s_controllerLockInitialized);
    return s_controllerLockInitialized;
}

HRESULT DebuggerController::Initialize()
{
    LIMITED_METHOD_CONTRACT;
    return InitializeControllerLock(&g_criticalSection) ? S_OK : E_OUTOFMEMORY;
}

void DebuggerController::DeleteAllControllers()
{
    LIMITED_METHOD_CONTRACT;
    InitializeControllerLock(&g_criticalSection);
}

DebuggerController::DebuggerController(Thread *pThread, AppDomain *pAppDomain)
    : m_pAppDomain(pAppDomain),
      m_thread(pThread),
      m_next(NULL),
      m_singleStep(false),
      m_exceptionHook(false),
      m_traceCall(false),
      m_traceCallFP(ROOT_MOST_FRAME),
      m_unwindFP(LEAF_MOST_FRAME),
      m_eventQueuedCount(0),
      m_deleted(false),
      m_fEnableMethodEnter(false),
      m_multicastDelegateHelper(false),
      m_externalMethodFixup(false)
{
    LIMITED_METHOD_CONTRACT;
    InitializeControllerLock(&g_criticalSection);
}

DebuggerController::~DebuggerController()
{
    LIMITED_METHOD_CONTRACT;
}

void DebuggerController::Delete()
{
    LIMITED_METHOD_CONTRACT;
    m_deleted = true;
}

bool DebuggerController::DebuggerDetachClean()
{
    LIMITED_METHOD_CONTRACT;
    return true;
}

BOOL DebuggerController::AddBindAndActivateNativeManagedPatch(
    MethodDesc *,
    DebuggerJitInfo *,
    SIZE_T,
    FramePointer,
    AppDomain *)
{
    LIMITED_METHOD_CONTRACT;
    _ASSERTE(!"wasm-lite: not yet implemented");
    return FALSE;
}

DebuggerControllerPatch *DebuggerController::AddAndActivateNativePatchForAddress(
    CORDB_ADDRESS_TYPE *,
    FramePointer,
    bool,
    TraceType)
{
    LIMITED_METHOD_CONTRACT;
    _ASSERTE(!"wasm-lite: not yet implemented");
    return NULL;
}

bool DebuggerController::PatchTrace(TraceDestination *, FramePointer, bool)
{
    LIMITED_METHOD_CONTRACT;
    _ASSERTE(!"wasm-lite: not yet implemented");
    return false;
}

void DebuggerController::DisableAll()
{
    LIMITED_METHOD_CONTRACT;
    m_singleStep = false;
    m_exceptionHook = false;
    m_traceCall = false;
    m_unwindFP = LEAF_MOST_FRAME;
    m_fEnableMethodEnter = false;
    m_multicastDelegateHelper = false;
    m_externalMethodFixup = false;
}

BOOL DebuggerController::IsSingleStepEnabled(Thread *)
{
    LIMITED_METHOD_CONTRACT;
    return FALSE;
}

bool DebuggerController::IsSingleStepEnabled()
{
    LIMITED_METHOD_CONTRACT;
    return false;
}

void DebuggerController::EnableSingleStep()
{
    LIMITED_METHOD_CONTRACT;
    _ASSERTE(!"wasm-lite: not yet implemented");
    m_singleStep = true;
}

void DebuggerController::EnableSingleStep(Thread *)
{
    LIMITED_METHOD_CONTRACT;
    _ASSERTE(!"wasm-lite: not yet implemented");
}

void DebuggerController::DisableSingleStep()
{
    LIMITED_METHOD_CONTRACT;
    m_singleStep = false;
}

void DebuggerController::EnableExceptionHook()
{
    LIMITED_METHOD_CONTRACT;
    _ASSERTE(!"wasm-lite: not yet implemented");
    m_exceptionHook = true;
}

void DebuggerController::DisableExceptionHook()
{
    LIMITED_METHOD_CONTRACT;
    m_exceptionHook = false;
}

void DebuggerController::EnableUnwind(FramePointer frame)
{
    LIMITED_METHOD_CONTRACT;
    _ASSERTE(!"wasm-lite: not yet implemented");
    m_unwindFP = frame;
}

void DebuggerController::DisableUnwind()
{
    LIMITED_METHOD_CONTRACT;
    m_unwindFP = LEAF_MOST_FRAME;
}

FramePointer DebuggerController::GetUnwind()
{
    LIMITED_METHOD_CONTRACT;
    return m_unwindFP;
}

void DebuggerController::EnableTraceCall(FramePointer fp)
{
    LIMITED_METHOD_CONTRACT;
    _ASSERTE(!"wasm-lite: not yet implemented");
    m_traceCall = true;
    m_traceCallFP = fp;
}

void DebuggerController::DisableTraceCall()
{
    LIMITED_METHOD_CONTRACT;
    m_traceCall = false;
    m_traceCallFP = ROOT_MOST_FRAME;
}

bool DebuggerController::IsMethodEnterEnabled()
{
    LIMITED_METHOD_CONTRACT;
    return m_fEnableMethodEnter;
}

void DebuggerController::EnableMethodEnter()
{
    LIMITED_METHOD_CONTRACT;
    _ASSERTE(!"wasm-lite: not yet implemented");
    m_fEnableMethodEnter = true;
}

void DebuggerController::DisableMethodEnter()
{
    LIMITED_METHOD_CONTRACT;
    m_fEnableMethodEnter = false;
}

void DebuggerController::EnableMultiCastDelegate()
{
    LIMITED_METHOD_CONTRACT;
    _ASSERTE(!"wasm-lite: not yet implemented");
    m_multicastDelegateHelper = true;
}

void DebuggerController::DisableMultiCastDelegate()
{
    LIMITED_METHOD_CONTRACT;
    m_multicastDelegateHelper = false;
}

void DebuggerController::EnableExternalMethodFixup()
{
    LIMITED_METHOD_CONTRACT;
    _ASSERTE(!"wasm-lite: not yet implemented");
    m_externalMethodFixup = true;
}

void DebuggerController::DisableExternalMethodFixup()
{
    LIMITED_METHOD_CONTRACT;
    m_externalMethodFixup = false;
}

void DebuggerController::TriggerFuncEvalEnter(Thread *)
{
    LIMITED_METHOD_CONTRACT;
}

void DebuggerController::TriggerFuncEvalExit(Thread *)
{
    LIMITED_METHOD_CONTRACT;
}

TP_RESULT DebuggerController::TriggerPatch(DebuggerControllerPatch *, Thread *, TRIGGER_WHY)
{
    LIMITED_METHOD_CONTRACT;
    return TPR_IGNORE;
}

bool DebuggerController::TriggerSingleStep(Thread *, const BYTE *)
{
    LIMITED_METHOD_CONTRACT;
    return false;
}

void DebuggerController::TriggerUnwind(
    Thread *,
    MethodDesc *,
    DebuggerJitInfo *,
    SIZE_T,
    FramePointer,
    CorDebugStepReason)
{
    LIMITED_METHOD_CONTRACT;
}

void DebuggerController::TriggerTraceCall(Thread *, const BYTE *)
{
    LIMITED_METHOD_CONTRACT;
}

TP_RESULT DebuggerController::TriggerExceptionHook(Thread *, CONTEXT *, EXCEPTION_RECORD *)
{
    LIMITED_METHOD_CONTRACT;
    return TPR_IGNORE;
}

void DebuggerController::TriggerMethodEnter(Thread *, DebuggerJitInfo *, const BYTE *, FramePointer)
{
    LIMITED_METHOD_CONTRACT;
}

void DebuggerController::TriggerMulticastDelegate(DELEGATEREF, INT32)
{
    LIMITED_METHOD_CONTRACT;
}

void DebuggerController::TriggerExternalMethodFixup(PCODE)
{
    LIMITED_METHOD_CONTRACT;
}

bool DebuggerController::SendEvent(Thread *, bool)
{
    LIMITED_METHOD_CONTRACT;
    return false;
}

DebuggerStepper::DebuggerStepper(
    Thread *thread,
    CorDebugUnmappedStop rgfMappingStop,
    CorDebugIntercept interceptStop,
    AppDomain *appDomain)
    : DebuggerController(thread, appDomain),
      m_stepIn(false),
      m_reason(STEP_NORMAL),
      m_fpStepInto(LEAF_MOST_FRAME),
      m_rgfInterceptStop(interceptStop),
      m_rgfMappingStop(rgfMappingStop),
      m_range(NULL),
      m_rangeCount(0),
      m_eMode(cStepOver),
      m_fp(LEAF_MOST_FRAME),
      m_fpParentMethod(LEAF_MOST_FRAME),
      m_fpException(LEAF_MOST_FRAME),
      m_fdException(NULL),
      m_cFuncEvalNesting(0),
      m_bvFrozenTriggers(0)
#ifdef _DEBUG
      ,
      m_StepInStartMethod(NULL),
      m_fReadyToSend(false)
#endif
{
    LIMITED_METHOD_CONTRACT;
}

DebuggerStepper::~DebuggerStepper()
{
    LIMITED_METHOD_CONTRACT;
    m_range = NULL;
}

void DebuggerStepper::EnablePolyTraceCall()
{
    LIMITED_METHOD_CONTRACT;
    _ASSERTE(!"wasm-lite: not yet implemented");
    EnableTraceCall(LEAF_MOST_FRAME);
}

bool DebuggerStepper::ShouldContinueStep(ControllerStackInfo *, SIZE_T)
{
    LIMITED_METHOD_CONTRACT;
    return false;
}

void DebuggerStepper::EnableJMCBackStop(MethodDesc *)
{
    LIMITED_METHOD_CONTRACT;
    _ASSERTE(!"wasm-lite: not yet implemented");
    EnableMethodEnter();
}

void DebuggerStepper::TrapStepNext(ControllerStackInfo *)
{
    LIMITED_METHOD_CONTRACT;
    _ASSERTE(!"wasm-lite: not yet implemented");
}

bool DebuggerStepper::TrapStepInHelper(
    ControllerStackInfo *,
    const BYTE *,
    const BYTE *,
    bool,
    bool)
{
    LIMITED_METHOD_CONTRACT;
    _ASSERTE(!"wasm-lite: not yet implemented");
    return false;
}

bool DebuggerStepper::IsInterestingFrame(FrameInfo *)
{
    LIMITED_METHOD_CONTRACT;
    return false;
}

bool DebuggerStepper::DetectHandleNonUserCode(ControllerStackInfo *, DebuggerMethodInfo *)
{
    LIMITED_METHOD_CONTRACT;
    return false;
}

bool DebuggerStepper::DetectHandleInterceptors(ControllerStackInfo *)
{
    LIMITED_METHOD_CONTRACT;
    return false;
}

void DebuggerStepper::TriggerMethodEnter(Thread *, DebuggerJitInfo *, const BYTE *, FramePointer)
{
    LIMITED_METHOD_CONTRACT;
}

TP_RESULT DebuggerStepper::TriggerPatch(DebuggerControllerPatch *, Thread *, TRIGGER_WHY)
{
    LIMITED_METHOD_CONTRACT;
    return TPR_IGNORE;
}

bool DebuggerStepper::TriggerSingleStep(Thread *, const BYTE *)
{
    LIMITED_METHOD_CONTRACT;
    return false;
}

bool DebuggerStepper::SendEvent(Thread *, bool)
{
    LIMITED_METHOD_CONTRACT;
    return false;
}

DebuggerJitInfo::DebuggerJitInfo(DebuggerMethodInfo *minfo, NativeCodeVersion nativeCodeVersion)
    : m_nativeCodeVersion(nativeCodeVersion),
      m_pLoaderModule(NULL),
      m_jitComplete(false),
#ifdef FEATURE_METADATA_UPDATER
      m_encBreakpointsApplied(false),
#endif
      m_methodInfo(minfo),
      m_addrOfCode((CORDB_ADDRESS)NULL),
      m_sizeOfCode(0),
      m_prevJitInfo(NULL),
      m_nextJitInfo(NULL),
      m_lastIL(0),
      m_sequenceMap(NULL),
      m_sequenceMapCount(0),
      m_callsiteMap(NULL),
      m_callsiteMapCount(0),
      m_sequenceMapSorted(false),
      m_varNativeInfo(NULL),
      m_varNativeInfoCount(0),
      m_fAttemptInit(false),
      m_encVersion(CorDB_DEFAULT_ENC_FUNCTION_VERSION),
      m_rgFunclet(NULL),
      m_funcletCount(0)
{
    LIMITED_METHOD_CONTRACT;
    _ASSERTE(!"wasm-lite: not yet implemented");
}

DebuggerJitInfo::~DebuggerJitInfo()
{
    LIMITED_METHOD_CONTRACT;
}

DWORD DebuggerJitInfo::MapNativeOffsetToIL(
    SIZE_T,
    CorDebugMappingResult *map,
    DWORD *which,
    BOOL)
{
    LIMITED_METHOD_CONTRACT;
    if (map != NULL)
    {
        *map = MAPPING_UNMAPPED_ADDRESS;
    }
    if (which != NULL)
    {
        *which = 0;
    }
    return 0;
}

#endif // !DACCESS_COMPILE
