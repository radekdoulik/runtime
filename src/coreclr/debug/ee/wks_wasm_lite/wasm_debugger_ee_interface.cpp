// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

//*****************************************************************************
// File: wasm_debugger_ee_interface.cpp
//
// Wasm-lite DebugInterface implementation used to make the VM's
// g_pDebugInterface non-null without linking the full desktop debug/ee
// Debugger. This intentionally leaves the existing vm/wasm/dbi-control-plane.cpp
// WasmDebugBreakpointSlot table in charge of breakpoint patch ownership. A
// future Path A-lite slice will reconcile that table with DebuggerPatchTable
// rather than doing it as part of this wiring slice.
//*****************************************************************************

#include "stdafx.h"

#ifndef FEATURE_WASM_DEBUG_EE_LITE
#error "wasm_debugger_ee_interface.cpp must be built with FEATURE_WASM_DEBUG_EE_LITE"
#endif

#if !defined(DACCESS_COMPILE)

#include "debugger.h"

#define WASM_DEBUGGER_EE_STUB(methodName) \
    LOG((LF_CORDB, LL_INFO10000, "WasmDebuggerEEInterface: %s not implemented yet\n", methodName))

#define WASM_DEBUGGER_EE_UNEXPECTED_STUB(methodName) \
    do \
    { \
        WASM_DEBUGGER_EE_STUB(methodName); \
        _ASSERTE(!"WasmDebuggerEEInterface: " methodName " not implemented yet"); \
    } while (0)

class WasmDebuggerEEInterface final : public DebugInterface
{
public:
    static WasmDebuggerEEInterface* GetInstance()
    {
        static WasmDebuggerEEInterface s_instance;
        return &s_instance;
    }

    static uint32_t GetMethodEnterEnabledQueryCount()
    {
        return s_isMethodEnterEnabledCallCount;
    }

    HRESULT Startup() override
    {
        LIMITED_METHOD_CONTRACT;
        return S_OK;
    }

    HRESULT StartupPhase2(Thread*) override
    {
        LIMITED_METHOD_CONTRACT;
        return S_OK;
    }

    void InitializeLazyDataIfNecessary() override
    {
        LIMITED_METHOD_CONTRACT;
    }

    void SetEEInterface(EEDebugInterface* eeInterface) override
    {
        LIMITED_METHOD_CONTRACT;
        g_pEEInterface = eeInterface;
    }

    void StopDebugger() override
    {
        LIMITED_METHOD_CONTRACT;
    }

    BOOL IsStopped() override
    {
        LIMITED_METHOD_CONTRACT;
        return FALSE;
    }

    void ThreadCreated(Thread*) override
    {
        LIMITED_METHOD_CONTRACT;
    }

    void ThreadStarted(Thread*) override
    {
        LIMITED_METHOD_CONTRACT;
    }

    void DetachThread(Thread*) override
    {
        LIMITED_METHOD_CONTRACT;
    }

    void AppDomainCreated(AppDomain*) override
    {
        LIMITED_METHOD_CONTRACT;
    }

    void LoadModule(Module*, LPCWSTR, DWORD, Assembly*, BOOL) override
    {
        LIMITED_METHOD_CONTRACT;
    }

    void UnloadModule(Module*) override
    {
        LIMITED_METHOD_CONTRACT;
    }

    void DestructModule(Module*) override
    {
        LIMITED_METHOD_CONTRACT;
    }

    BOOL LoadClass(TypeHandle, mdTypeDef, Module*) override
    {
        LIMITED_METHOD_CONTRACT;
        return FALSE;
    }

    void UnloadClass(mdTypeDef, Module*) override
    {
        LIMITED_METHOD_CONTRACT;
    }

    LONG NotifyOfCHFFilter(EXCEPTION_POINTERS*, PVOID) override
    {
        LIMITED_METHOD_CONTRACT;
        WASM_DEBUGGER_EE_UNEXPECTED_STUB("NotifyOfCHFFilter");
        return EXCEPTION_CONTINUE_SEARCH;
    }

    bool FirstChanceNativeException(
        EXCEPTION_RECORD* exception,
        CONTEXT* context,
        DWORD code,
        Thread* thread,
        BOOL fIsVEH = TRUE) override
    {
        LIMITED_METHOD_CONTRACT;
        LOG((LF_CORDB, LL_INFO10000,
            "WasmDebuggerEEInterface::FirstChanceNativeException: exception=%p context=%p code=0x%x thread=%p fIsVEH=%d\n",
            exception,
            context,
            code,
            thread,
            fIsVEH));

        // This slice only recognizes the interpreter's synthetic breakpoint
        // callback. Returning true there lets the existing interpreter
        // ProcessAnyPendingEvals hook run; all real native exceptions keep
        // flowing through the normal wasm exception path for now.
        return code == STATUS_BREAKPOINT && !fIsVEH;
    }

    bool FirstChanceManagedException(Thread*, SIZE_T, SIZE_T) override
    {
        LIMITED_METHOD_CONTRACT;
        WASM_DEBUGGER_EE_UNEXPECTED_STUB("FirstChanceManagedException");
        return false;
    }

    void FirstChanceManagedExceptionCatcherFound(Thread*, MethodDesc*, TADDR, BYTE*, EE_ILEXCEPTION_CLAUSE*) override
    {
        LIMITED_METHOD_CONTRACT;
        WASM_DEBUGGER_EE_UNEXPECTED_STUB("FirstChanceManagedExceptionCatcherFound");
    }

    LONG LastChanceManagedException(EXCEPTION_POINTERS*, Thread*, BOOL) override
    {
        LIMITED_METHOD_CONTRACT;
        WASM_DEBUGGER_EE_UNEXPECTED_STUB("LastChanceManagedException");
        return EXCEPTION_CONTINUE_SEARCH;
    }

    void ManagedExceptionUnwindBegin(Thread*) override
    {
        LIMITED_METHOD_CONTRACT;
        WASM_DEBUGGER_EE_UNEXPECTED_STUB("ManagedExceptionUnwindBegin");
    }

    void DeleteInterceptContext(void*) override
    {
        LIMITED_METHOD_CONTRACT;
        WASM_DEBUGGER_EE_UNEXPECTED_STUB("DeleteInterceptContext");
    }

    void ExceptionFilter(MethodDesc*, TADDR, SIZE_T, BYTE*) override
    {
        LIMITED_METHOD_CONTRACT;
        WASM_DEBUGGER_EE_UNEXPECTED_STUB("ExceptionFilter");
    }

    void ExceptionHandle(MethodDesc*, TADDR, SIZE_T, BYTE*) override
    {
        LIMITED_METHOD_CONTRACT;
        WASM_DEBUGGER_EE_UNEXPECTED_STUB("ExceptionHandle");
    }

    void SendUserBreakpoint(Thread*) override
    {
        LIMITED_METHOD_CONTRACT;
        WASM_DEBUGGER_EE_UNEXPECTED_STUB("SendUserBreakpoint");
    }

    void SendUpdateModuleSymsEventAndBlock(Module*) override
    {
        LIMITED_METHOD_CONTRACT;
        WASM_DEBUGGER_EE_UNEXPECTED_STUB("SendUpdateModuleSymsEventAndBlock");
    }

    HRESULT RequestFavor(FAVORCALLBACK, void*) override
    {
        LIMITED_METHOD_CONTRACT;
        WASM_DEBUGGER_EE_UNEXPECTED_STUB("RequestFavor");
        return E_NOTIMPL;
    }

    void JITComplete(NativeCodeVersion, TADDR) override
    {
        LIMITED_METHOD_CONTRACT;
    }

#ifdef FEATURE_METADATA_UPDATER
    HRESULT UpdateFunction(MethodDesc*, SIZE_T) override
    {
        LIMITED_METHOD_CONTRACT;
        WASM_DEBUGGER_EE_UNEXPECTED_STUB("UpdateFunction");
        return E_NOTIMPL;
    }

    HRESULT AddFunction(MethodDesc*, SIZE_T) override
    {
        LIMITED_METHOD_CONTRACT;
        WASM_DEBUGGER_EE_UNEXPECTED_STUB("AddFunction");
        return E_NOTIMPL;
    }

    HRESULT UpdateNotYetLoadedFunction(mdMethodDef, Module*, SIZE_T) override
    {
        LIMITED_METHOD_CONTRACT;
        WASM_DEBUGGER_EE_UNEXPECTED_STUB("UpdateNotYetLoadedFunction");
        return E_NOTIMPL;
    }

    HRESULT AddField(FieldDesc*, SIZE_T) override
    {
        LIMITED_METHOD_CONTRACT;
        WASM_DEBUGGER_EE_UNEXPECTED_STUB("AddField");
        return E_NOTIMPL;
    }

    HRESULT RemapComplete(MethodDesc*, TADDR, SIZE_T) override
    {
        LIMITED_METHOD_CONTRACT;
        WASM_DEBUGGER_EE_UNEXPECTED_STUB("RemapComplete");
        return E_NOTIMPL;
    }

    HRESULT MapILInfoToCurrentNative(MethodDesc*, SIZE_T, TADDR, SIZE_T*) override
    {
        LIMITED_METHOD_CONTRACT;
        WASM_DEBUGGER_EE_UNEXPECTED_STUB("MapILInfoToCurrentNative");
        return E_NOTIMPL;
    }

    void SendSetThreadContextNeeded(CONTEXT*, DebuggerSteppingInfo*, bool, bool) override
    {
        LIMITED_METHOD_CONTRACT;
        WASM_DEBUGGER_EE_UNEXPECTED_STUB("SendSetThreadContextNeeded");
    }

    BOOL IsOutOfProcessSetContextEnabled() override
    {
        LIMITED_METHOD_CONTRACT;
        WASM_DEBUGGER_EE_UNEXPECTED_STUB("IsOutOfProcessSetContextEnabled");
        return FALSE;
    }
#endif // FEATURE_METADATA_UPDATER

    void GetVarInfo(MethodDesc*, CORDB_ADDRESS, SIZE_T* cVars, const ICorDebugInfo::NativeVarInfo** vars) override
    {
        LIMITED_METHOD_CONTRACT;
        WASM_DEBUGGER_EE_UNEXPECTED_STUB("GetVarInfo");
        if (cVars != nullptr)
        {
            *cVars = 0;
        }
        if (vars != nullptr)
        {
            *vars = nullptr;
        }
    }

    void getBoundaries(MethodDesc*, unsigned int* cILOffsets, DWORD** pILOffsets, ICorDebugInfo::BoundaryTypes*) override
    {
        LIMITED_METHOD_CONTRACT;
        WASM_DEBUGGER_EE_STUB("getBoundaries");
        if (cILOffsets != nullptr)
        {
            *cILOffsets = 0;
        }
        if (pILOffsets != nullptr)
        {
            *pILOffsets = nullptr;
        }
    }

    void getVars(MethodDesc*, ULONG32* cVars, ICorDebugInfo::ILVarInfo** vars, bool* extendOthers) override
    {
        LIMITED_METHOD_CONTRACT;
        WASM_DEBUGGER_EE_STUB("getVars");
        if (cVars != nullptr)
        {
            *cVars = 0;
        }
        if (vars != nullptr)
        {
            *vars = nullptr;
        }
        if (extendOthers != nullptr)
        {
            *extendOthers = false;
        }
    }

    BOOL CheckGetPatchedOpcode(CORDB_ADDRESS_TYPE*, PRD_TYPE* pOpcode) override
    {
        LIMITED_METHOD_CONTRACT;
        WASM_DEBUGGER_EE_UNEXPECTED_STUB("CheckGetPatchedOpcode");
        if (pOpcode != nullptr)
        {
            *pOpcode = 0;
        }
        return FALSE;
    }

    PRD_TYPE GetPatchedOpcode(CORDB_ADDRESS_TYPE*) override
    {
        LIMITED_METHOD_CONTRACT;
        WASM_DEBUGGER_EE_UNEXPECTED_STUB("GetPatchedOpcode");
        return 0;
    }

    void TraceCall(const BYTE*) override
    {
        LIMITED_METHOD_CONTRACT;
        WASM_DEBUGGER_EE_UNEXPECTED_STUB("TraceCall");
    }

    bool ThreadsAtUnsafePlaces() override
    {
        LIMITED_METHOD_CONTRACT;
        return false;
    }

    HRESULT LaunchDebuggerForUser(Thread*, EXCEPTION_POINTERS*, BOOL, BOOL) override
    {
        LIMITED_METHOD_CONTRACT;
        WASM_DEBUGGER_EE_UNEXPECTED_STUB("LaunchDebuggerForUser");
        return E_NOTIMPL;
    }

    void JitAttach(Thread*, EXCEPTION_POINTERS*, BOOL, BOOL) override
    {
        LIMITED_METHOD_CONTRACT;
        WASM_DEBUGGER_EE_UNEXPECTED_STUB("JitAttach");
    }

    BOOL PreJitAttach(BOOL, BOOL, BOOL) override
    {
        LIMITED_METHOD_CONTRACT;
        WASM_DEBUGGER_EE_UNEXPECTED_STUB("PreJitAttach");
        return FALSE;
    }

    void WaitForDebuggerAttach() override
    {
        LIMITED_METHOD_CONTRACT;
        WASM_DEBUGGER_EE_UNEXPECTED_STUB("WaitForDebuggerAttach");
    }

    void PostJitAttach() override
    {
        LIMITED_METHOD_CONTRACT;
        WASM_DEBUGGER_EE_UNEXPECTED_STUB("PostJitAttach");
    }

    void SendUserBreakpointAndSynchronize(Thread*) override
    {
        LIMITED_METHOD_CONTRACT;
        WASM_DEBUGGER_EE_UNEXPECTED_STUB("SendUserBreakpointAndSynchronize");
    }

    void SendLogMessage(int, SString*, SString*) override
    {
        LIMITED_METHOD_CONTRACT;
        WASM_DEBUGGER_EE_UNEXPECTED_STUB("SendLogMessage");
    }

    void SendCustomDebuggerNotification(Thread*, Assembly*, mdTypeDef) override
    {
        LIMITED_METHOD_CONTRACT;
        WASM_DEBUGGER_EE_UNEXPECTED_STUB("SendCustomDebuggerNotification");
    }

    bool IsJMCMethod(Module*, mdMethodDef) override
    {
        LIMITED_METHOD_CONTRACT;
        return false;
    }

    bool IsLoggingEnabled() override
    {
        LIMITED_METHOD_CONTRACT;
        return false;
    }

    bool GetILOffsetFromNative(MethodDesc*, const BYTE*, DWORD, DWORD* ilOffset) override
    {
        LIMITED_METHOD_CONTRACT;
        WASM_DEBUGGER_EE_UNEXPECTED_STUB("GetILOffsetFromNative");
        if (ilOffset != nullptr)
        {
            *ilOffset = 0;
        }
        return false;
    }

    HRESULT GetILToNativeMapping(PCODE, ULONG32, ULONG32* pcMap, COR_DEBUG_IL_TO_NATIVE_MAP[]) override
    {
        LIMITED_METHOD_CONTRACT;
        WASM_DEBUGGER_EE_UNEXPECTED_STUB("GetILToNativeMapping");
        if (pcMap != nullptr)
        {
            *pcMap = 0;
        }
        return E_NOTIMPL;
    }

#ifdef DEBUG
    HRESULT GetILToNativeMappingIntoArrays(MethodDesc*, PCODE, USHORT, USHORT* pcMap, UINT**, UINT**) override
    {
        LIMITED_METHOD_CONTRACT;
        WASM_DEBUGGER_EE_UNEXPECTED_STUB("GetILToNativeMappingIntoArrays");
        if (pcMap != nullptr)
        {
            *pcMap = 0;
        }
        return E_NOTIMPL;
    }
#endif // DEBUG

    DWORD GetHelperThreadID() override
    {
        LIMITED_METHOD_CONTRACT;
        return 0;
    }

    void UnloadAssembly(Assembly*) override
    {
        LIMITED_METHOD_CONTRACT;
    }

    HRESULT SetILInstrumentedCodeMap(MethodDesc*, BOOL, ULONG32, COR_IL_MAP[]) override
    {
        LIMITED_METHOD_CONTRACT;
        WASM_DEBUGGER_EE_UNEXPECTED_STUB("SetILInstrumentedCodeMap");
        return E_NOTIMPL;
    }

    void EarlyHelperThreadDeath() override
    {
        LIMITED_METHOD_CONTRACT;
    }

    void ShutdownBegun() override
    {
        LIMITED_METHOD_CONTRACT;
    }

    void LockDebuggerForShutdown() override
    {
        LIMITED_METHOD_CONTRACT;
    }

    void DisableDebugger() override
    {
        LIMITED_METHOD_CONTRACT;
    }

    HRESULT NameChangeEvent(AppDomain*, Thread*) override
    {
        LIMITED_METHOD_CONTRACT;
        return S_OK;
    }

    BOOL SendCtrlCToDebugger(DWORD) override
    {
        LIMITED_METHOD_CONTRACT;
        WASM_DEBUGGER_EE_UNEXPECTED_STUB("SendCtrlCToDebugger");
        return FALSE;
    }

    HRESULT UpdateSpecialThreadList(DWORD, DWORD*) override
    {
        LIMITED_METHOD_CONTRACT;
        return S_OK;
    }

    DWORD GetRCThreadId() override
    {
        LIMITED_METHOD_CONTRACT;
        return 0;
    }

    HRESULT GetVariablesFromOffset(
        MethodDesc*,
        UINT,
        ICorDebugInfo::NativeVarInfo*,
        SIZE_T,
        CONTEXT*,
        SIZE_T*,
        SIZE_T*,
        UINT,
        BYTE***) override
    {
        LIMITED_METHOD_CONTRACT;
        WASM_DEBUGGER_EE_UNEXPECTED_STUB("GetVariablesFromOffset");
        return E_NOTIMPL;
    }

    HRESULT SetVariablesAtOffset(
        MethodDesc*,
        UINT,
        ICorDebugInfo::NativeVarInfo*,
        SIZE_T,
        CONTEXT*,
        SIZE_T*,
        SIZE_T*,
        BYTE**) override
    {
        LIMITED_METHOD_CONTRACT;
        WASM_DEBUGGER_EE_UNEXPECTED_STUB("SetVariablesAtOffset");
        return E_NOTIMPL;
    }

    BOOL IsThreadContextInvalid(Thread*, CONTEXT*) override
    {
        LIMITED_METHOD_CONTRACT;
        return FALSE;
    }

    void OnMethodEnter(void* ip) override
    {
        LIMITED_METHOD_CONTRACT;
        LOG((LF_CORDB, LL_INFO10000,
            "WasmDebuggerEEInterface::OnMethodEnter: ip=%p\n",
            ip));

        // Future slice: convert this callback into the wasm pause event flow
        // by sending a structured event and invoking coreClrDebugFireEventToPause.
    }

    DWORD* GetJMCFlagAddr(Module*) override
    {
        LIMITED_METHOD_CONTRACT;
        WASM_DEBUGGER_EE_UNEXPECTED_STUB("GetJMCFlagAddr");
        return nullptr;
    }

    bool IsMethodEnterEnabled() override
    {
        LIMITED_METHOD_CONTRACT;
        s_isMethodEnterEnabledCallCount++;
        LOG((LF_CORDB, LL_INFO10000,
            "WasmDebuggerEEInterface::IsMethodEnterEnabled: count=%u\n",
            s_isMethodEnterEnabledCallCount));

        // Future slice: return true while a stepper has enabled the
        // method-enter backstop. It remains false here so merely wiring
        // g_pDebugInterface does not change stepping or breakpoint ownership.
        return false;
    }

    bool ThisIsHelperThread() override
    {
        LIMITED_METHOD_CONTRACT;
        return false;
    }

    HRESULT ReDaclEvents(PSECURITY_DESCRIPTOR) override
    {
        LIMITED_METHOD_CONTRACT;
        return S_OK;
    }

    BOOL ShouldAutoAttach() override
    {
        LIMITED_METHOD_CONTRACT;
        return FALSE;
    }

    BOOL FallbackJITAttachPrompt() override
    {
        LIMITED_METHOD_CONTRACT;
        return FALSE;
    }

#ifdef FEATURE_INTEROP_DEBUGGING
    LONG FirstChanceSuspendHijackWorker(PCONTEXT, PEXCEPTION_RECORD, BOOL) override
    {
        LIMITED_METHOD_CONTRACT;
        WASM_DEBUGGER_EE_UNEXPECTED_STUB("FirstChanceSuspendHijackWorker");
        return EXCEPTION_CONTINUE_SEARCH;
    }
#endif // FEATURE_INTEROP_DEBUGGING

    void CleanupTransportSocket() override
    {
        LIMITED_METHOD_CONTRACT;
    }

    void SuspendForGarbageCollectionStarted() override
    {
        LIMITED_METHOD_CONTRACT;
    }

    void SuspendForGarbageCollectionCompleted() override
    {
        LIMITED_METHOD_CONTRACT;
    }

    void ResumeForGarbageCollectionStarted() override
    {
        LIMITED_METHOD_CONTRACT;
    }

    BOOL IsSynchronizing() override
    {
        LIMITED_METHOD_CONTRACT;
        return FALSE;
    }

    HRESULT DeoptimizeMethod(Module*, mdMethodDef) override
    {
        LIMITED_METHOD_CONTRACT;
        WASM_DEBUGGER_EE_UNEXPECTED_STUB("DeoptimizeMethod");
        return E_NOTIMPL;
    }

    HRESULT IsMethodDeoptimized(Module*, mdMethodDef, BOOL* result) override
    {
        LIMITED_METHOD_CONTRACT;
        WASM_DEBUGGER_EE_UNEXPECTED_STUB("IsMethodDeoptimized");
        if (result != nullptr)
        {
            *result = FALSE;
        }
        return S_OK;
    }

    void MulticastTraceNextStep(DELEGATEREF, INT32) override
    {
        LIMITED_METHOD_CONTRACT;
        WASM_DEBUGGER_EE_UNEXPECTED_STUB("MulticastTraceNextStep");
    }

    void ExternalMethodFixupNextStep(PCODE) override
    {
        LIMITED_METHOD_CONTRACT;
        WASM_DEBUGGER_EE_UNEXPECTED_STUB("ExternalMethodFixupNextStep");
    }

    void ProcessAnyPendingEvals(Thread* thread) override
    {
        LIMITED_METHOD_CONTRACT;
        LOG((LF_CORDB, LL_INFO10000,
            "WasmDebuggerEEInterface::ProcessAnyPendingEvals: thread=%p\n",
            thread));

        // Future slice: drain wasm DBI function-evaluation or step commands
        // after a debugger stop. This slice intentionally has no queued evals.
    }

private:
    static uint32_t s_isMethodEnterEnabledCallCount;
};

uint32_t WasmDebuggerEEInterface::s_isMethodEnterEnabledCallCount;

extern "C" DebugInterface* CoreClrWasmDebugGetDebuggerEEInterface()
{
    return WasmDebuggerEEInterface::GetInstance();
}

extern "C" uint32_t CoreClrWasmDebugGetMethodEnterEnabledQueryCountImpl()
{
    return WasmDebuggerEEInterface::GetMethodEnterEnabledQueryCount();
}

#undef WASM_DEBUGGER_EE_UNEXPECTED_STUB
#undef WASM_DEBUGGER_EE_STUB

#endif // !DACCESS_COMPILE
