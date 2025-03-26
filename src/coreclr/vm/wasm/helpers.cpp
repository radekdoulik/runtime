extern "C" void STDCALL CallCountingStubCode()
{
    _ASSERTE("CallCountingStubCode is not implemented on wasm");
}

extern "C" void CallCountingStubCode_End()
{
    _ASSERTE("CallCountingStubCode_End is not implemented on wasm");
}

extern "C" void STDCALL OnCallCountThresholdReachedStub()
{
    _ASSERTE("OnCallCountThresholdReachedStub is not implemented on wasm");
}

extern "C" void STDCALL ThePreStub()
{
    _ASSERTE("ThePreStub is not implemented on wasm");
}

extern "C" UINT_PTR STDCALL GetCurrentIP(void)
{
    _ASSERTE("GetCurrentIP is not implemented on wasm");
    return 0;
}

extern "C" void STDMETHODCALLTYPE JIT_ProfilerEnterLeaveTailcallStub(UINT_PTR ProfilerHandle)
{
    _ASSERTE("JIT_ProfilerEnterLeaveTailcallStub is not implemented on wasm");
}

extern "C" void STDCALL DelayLoad_MethodCall()
{
    _ASSERTE("DelayLoad_MethodCall is not implemented on wasm");
}

extern "C" void STDCALL DelayLoad_Helper()
{
    _ASSERTE("DelayLoad_Helper is not implemented on wasm");
}

extern "C" void STDCALL DelayLoad_Helper_Obj()
{
    _ASSERTE("DelayLoad_Helper_Obj is not implemented on wasm");
}

extern "C" void STDCALL DelayLoad_Helper_ObjObj()
{
    _ASSERTE("DelayLoad_Helper_ObjObj is not implemented on wasm");
}

extern "C" void STDCALL NDirectImportThunk()
{
    _ASSERTE("NDirectImportThunk is not implemented on wasm");
}

extern "C" void STDCALL StubPrecodeCode()
{
    _ASSERTE("StubPrecodeCode is not implemented on wasm");
}

extern "C" void STDCALL StubPrecodeCode_End()
{
    _ASSERTE("StubPrecodeCode_End is not implemented on wasm");
}

extern "C" void STDCALL FixupPrecodeCode()
{
    _ASSERTE("FixupPrecodeCode is not implemented on wasm");
}

extern "C" void STDCALL FixupPrecodeCode_End()
{
    _ASSERTE("FixupPrecodeCode_End is not implemented on wasm");
}

extern "C" void STDCALL JIT_PatchedCodeLast()
{
    _ASSERTE("JIT_PatchedCodeLast is not implemented on wasm");
}

extern "C" void STDCALL JIT_PatchedCodeStart()
{
    _ASSERTE("JIT_PatchedCodeStart is not implemented on wasm");
}

extern "C" void RhpInitialInterfaceDispatch()
{
    _ASSERTE("RhpInitialInterfaceDispatch is not implemented on wasm");
}

extern "C" void STDCALL CallDescrWorkerInternal(CallDescrData * pCallDescrData)
{
    _ASSERTE("CallDescrWorkerInternal is not implemented on wasm");
}

unsigned FuncEvalFrame::GetFrameAttribs_Impl(void)
{
    _ASSERTE("FuncEvalFrame::GetFrameAttribs_Impl is not implemented on wasm");
    return 0;
}

TADDR FuncEvalFrame::GetReturnAddressPtr_Impl()
{
    _ASSERTE("FuncEvalFrame::GetReturnAddressPtr_Impl is not implemented on wasm");
    return 0;
}

void FuncEvalFrame::UpdateRegDisplay_Impl(const PREGDISPLAY pRD, bool updateFloats)
{
    _ASSERTE("FuncEvalFrame::UpdateRegDisplay_Impl is not implemented on wasm");
}

void InlinedCallFrame::UpdateRegDisplay_Impl(const PREGDISPLAY pRD, bool updateFloats)
{
    _ASSERTE("InlinedCallFrame::UpdateRegDisplay_Impl is not implemented on wasm");
}

void FaultingExceptionFrame::UpdateRegDisplay_Impl(const PREGDISPLAY pRD, bool updateFloats)
{
    _ASSERTE("FaultingExceptionFrame::UpdateRegDisplay_Impl is not implemented on wasm");
}

void HelperMethodFrame::UpdateRegDisplay_Impl(const PREGDISPLAY pRD, bool updateFloats)
{
    _ASSERTE("HelperMethodFrame::UpdateRegDisplay_Impl is not implemented on wasm");
}

void TransitionFrame::UpdateRegDisplay_Impl(const PREGDISPLAY pRD, bool updateFloats)
{
    _ASSERTE("TransitionFrame::UpdateRegDisplay_Impl is not implemented on wasm");
}

size_t CallDescrWorkerInternalReturnAddressOffset;

VOID PALAPI RtlRestoreContext(IN PCONTEXT ContextRecord, IN PEXCEPTION_RECORD ExceptionRecord)
{
    _ASSERTE("RtlRestoreContext is not implemented on wasm");
}

extern "C" void TheUMEntryPrestub(void)
{
    _ASSERTE("TheUMEntryPrestub is not implemented on wasm");
}

extern "C" void STDCALL VarargPInvokeStub(void)
{
    _ASSERTE("VarargPInvokeStub is not implemented on wasm");
}

extern "C" void STDCALL VarargPInvokeStub_RetBuffArg(void)
{
    _ASSERTE("VarargPInvokeStub_RetBuffArg is not implemented on wasm");
}

extern "C" PCODE CID_VirtualOpenDelegateDispatch(TransitionBlock * pTransitionBlock)
{
    _ASSERTE("CID_VirtualOpenDelegateDispatch is not implemented on wasm");
    return 0;
}

extern "C" FCDECL2(VOID, JIT_WriteBarrier_Callable, Object **dst, Object *ref)
{
    _ASSERTE("JIT_WriteBarrier_Callable is not implemented on wasm");
}

EXTERN_C void JIT_WriteBarrier_End()
{
    _ASSERTE("JIT_WriteBarrier_End is not implemented on wasm");
}

EXTERN_C void JIT_CheckedWriteBarrier_End()
{
    _ASSERTE("JIT_CheckedWriteBarrier_End is not implemented on wasm");
}

EXTERN_C void JIT_ByRefWriteBarrier_End()
{
    _ASSERTE("JIT_ByRefWriteBarrier_End is not implemented on wasm");
}

EXTERN_C void JIT_StackProbe_End()
{
    _ASSERTE("JIT_StackProbe_End is not implemented on wasm");
}

EXTERN_C int __fastcall HelperMethodFrameRestoreState(
    INDEBUG_COMMA(HelperMethodFrame *pFrame)
    MachState *pState
)
{
    _ASSERTE("HelperMethodFrameRestoreState is not implemented on wasm");
    return 0;
}

EXTERN_C VOID STDCALL ResetCurrentContext()
{
    _ASSERTE("ResetCurrentContext is not implemented on wasm");
}

extern "C" void STDCALL GenericPInvokeCalliHelper(void)
{
    _ASSERTE("GenericPInvokeCalliHelper is not implemented on wasm");
}

EXTERN_C void JIT_PInvokeBegin(InlinedCallFrame* pFrame)
{
    _ASSERTE("JIT_PInvokeBegin is not implemented on wasm");
}

EXTERN_C void JIT_PInvokeEnd(InlinedCallFrame* pFrame)
{
    _ASSERTE("JIT_PInvokeEnd is not implemented on wasm");
}

extern "C" void STDCALL JIT_StackProbe()
{
    _ASSERTE("JIT_StackProbe is not implemented on wasm");
}

EXTERN_C FCDECL0(void, JIT_PollGC)
{
    _ASSERTE("JIT_PollGC is not implemented on wasm");
}

extern "C" FCDECL2(VOID, JIT_WriteBarrier, Object **dst, Object *ref)
{
    _ASSERTE("JIT_WriteBarrier is not implemented on wasm");
}

extern "C" FCDECL2(VOID, JIT_CheckedWriteBarrier, Object **dst, Object *ref)
{
    _ASSERTE("JIT_CheckedWriteBarrier is not implemented on wasm");
}

extern "C" void STDCALL JIT_ByRefWriteBarrier()
{
    _ASSERTE("JIT_ByRefWriteBarrier is not implemented on wasm");
}

void InitJITHelpers1()
{
    /* no-op TODO do we need to do anything for the interpreter? */
}

extern "C" HRESULT __cdecl CorDBGetInterface(DebugInterface** rcInterface)
{
    _ASSERTE("CorDBGetInterface is not implemented on wasm");
    return 0;
}

extern "C" void RhpInterfaceDispatch1()
{
    _ASSERTE("RhpInterfaceDispatch1 is not implemented on wasm");
}

extern "C" void RhpInterfaceDispatch2()
{
    _ASSERTE("RhpInterfaceDispatch2 is not implemented on wasm");
}

extern "C" void RhpInterfaceDispatch4()
{
    _ASSERTE("RhpInterfaceDispatch4 is not implemented on wasm");
}

extern "C" void RhpInterfaceDispatch8()
{
    _ASSERTE("RhpInterfaceDispatch8 is not implemented on wasm");
}

extern "C" void RhpInterfaceDispatch16()
{
    _ASSERTE("RhpInterfaceDispatch16 is not implemented on wasm");
}

extern "C" void RhpInterfaceDispatch32()
{
    _ASSERTE("RhpInterfaceDispatch32 is not implemented on wasm");
}

extern "C" void RhpInterfaceDispatch64()
{
    _ASSERTE("RhpInterfaceDispatch64 is not implemented on wasm");
}

extern "C" void RhpVTableOffsetDispatch()
{
    _ASSERTE("RhpVTableOffsetDispatch is not implemented on wasm");
}

extern "C" void RhpInterfaceDispatchAVLocation1()
{
    _ASSERTE("RhpInterfaceDispatchAVLocation1 is not implemented on wasm");
}

extern "C" void RhpInterfaceDispatchAVLocation2()
{
    _ASSERTE("RhpInterfaceDispatchAVLocation2 is not implemented on wasm");
}

extern "C" void RhpInterfaceDispatchAVLocation4()
{
    _ASSERTE("RhpInterfaceDispatchAVLocation4 is not implemented on wasm");
}

extern "C" void RhpInterfaceDispatchAVLocation8()
{
    _ASSERTE("RhpInterfaceDispatchAVLocation8 is not implemented on wasm");
}

extern "C" void RhpInterfaceDispatchAVLocation16()
{
    _ASSERTE("RhpInterfaceDispatchAVLocation16 is not implemented on wasm");
}

extern "C" void RhpInterfaceDispatchAVLocation32()
{
    _ASSERTE("RhpInterfaceDispatchAVLocation32 is not implemented on wasm");
}

extern "C" void RhpInterfaceDispatchAVLocation64()
{
    _ASSERTE("RhpInterfaceDispatchAVLocation64 is not implemented on wasm");
}

extern "C" void RhpVTableOffsetDispatchAVLocation()
{
    _ASSERTE("RhpVTableOffsetDispatchAVLocation is not implemented on wasm");
}

extern "C" void STDCALL ThePreStubPatchLabel(void)
{
    _ASSERTE("ThePreStubPatchLabel is not implemented on wasm");
}

LONG CLRNoCatchHandler(EXCEPTION_POINTERS* pExceptionInfo, PVOID pv)
{
    _ASSERTE("CLRNoCatchHandler is not implemented on wasm");
    return EXCEPTION_CONTINUE_SEARCH;
}

EXTERN_C void STDMETHODCALLTYPE ProfileEnterNaked(FunctionIDOrClientID functionIDOrClientID)
{
    _ASSERTE("ProfileEnterNaked is not implemented on wasm");
}

EXTERN_C void STDMETHODCALLTYPE ProfileLeaveNaked(UINT_PTR clientData)
{
    _ASSERTE("ProfileLeaveNaked is not implemented on wasm");
}

EXTERN_C void STDMETHODCALLTYPE ProfileTailcallNaked(UINT_PTR clientData)
{
    _ASSERTE("ProfileTailcallNaked is not implemented on wasm");
}

int StompWriteBarrierEphemeral(bool isRuntimeSuspended)
{
    _ASSERTE("StompWriteBarrierEphemeral is not implemented on wasm");
    return 0;
}

int StompWriteBarrierResize(bool isRuntimeSuspended, bool bReqUpperBoundsCheck)
{
    _ASSERTE("StompWriteBarrierResize is not implemented on wasm");
    return 0;
}

void FlushWriteBarrierInstructionCache()
{
    _ASSERTE("FlushWriteBarrierInstructionCache is not implemented on wasm");
}

void _DacGlobals::Initialize()
{
    /* no-op on wasm */
}

int g_pDebugger;

namespace InteropLibImports
{
    struct RuntimeCallContext;
}

namespace InteropLib {
    using OBJECTHANDLE = void*;
namespace Com {
        // See CreateComInterfaceFlags in ComWrappers.cs
        enum CreateComInterfaceFlags
        {
            CreateComInterfaceFlags_None = 0,
            CreateComInterfaceFlags_CallerDefinedIUnknown = 1,
            CreateComInterfaceFlags_TrackerSupport = 2,
        };

        // Create an IUnknown instance that represents the supplied managed object instance.
        HRESULT CreateWrapperForObject(
            _In_ OBJECTHANDLE instance,
            _In_ INT32 vtableCount,
            _In_ void* vtables,
            _In_ enum CreateComInterfaceFlags flags,
            _Outptr_ IUnknown** wrapper) noexcept
        {
            _ASSERTE("CreateWrapperForObject is not implemented on wasm");
            return 0;
        }

        // Destroy the supplied wrapper
        void DestroyWrapperForObject(_In_ void* wrapper) noexcept
        {
            _ASSERTE("DestroyWrapperForObject is not implemented on wasm");
        }

        // Check if a wrapper is considered a GC root.
        HRESULT IsWrapperRooted(_In_ IUnknown* wrapper) noexcept
        {
            _ASSERTE("IsWrapperRooted is not implemented on wasm");
            return 0;
        }

        // Get the object for the supplied wrapper
        HRESULT GetObjectForWrapper(_In_ IUnknown* wrapper, _Outptr_result_maybenull_ OBJECTHANDLE* object) noexcept
        {
            _ASSERTE("GetObjectForWrapper is not implemented on wasm");
            return 0;
        }


        HRESULT MarkComActivated(_In_ IUnknown* wrapper) noexcept;
        HRESULT IsComActivated(_In_ IUnknown* wrapper) noexcept
        {
            _ASSERTE("IsComActivated is not implemented on wasm");
            return 0;
        }

        // See CreateObjectFlags in ComWrappers.cs
        enum CreateObjectFlags
        {
            CreateObjectFlags_None = 0,
            CreateObjectFlags_TrackerObject = 1,
            CreateObjectFlags_UniqueInstance = 2,
            CreateObjectFlags_Aggregated = 4,
            CreateObjectFlags_Unwrap = 8,
        };

        // Get the true identity and inner for the supplied IUnknown.
        HRESULT DetermineIdentityAndInnerForExternal(
            _In_ IUnknown* external,
            _In_ enum CreateObjectFlags flags,
            _Outptr_ IUnknown** identity,
            _Inout_ IUnknown** innerMaybe) noexcept
        {
            _ASSERTE("DetermineIdentityAndInnerForExternal is not implemented on wasm");
            return 0;
        }
                    
        struct ExternalWrapperResult
        {
            // The returned context memory is guaranteed to be initialized to zero.
            void* Context;

            // See https://learn.microsoft.com/windows/win32/api/windows.ui.xaml.hosting.referencetracker/
            // for details.
            bool FromTrackerRuntime;

            // The supplied external object is wrapping a managed object.
            bool ManagedObjectWrapper;
        };

        // Allocate a wrapper context for an external object.
        // The runtime supplies the external object, flags, and a memory
        // request in order to bring the object into the runtime.
        HRESULT CreateWrapperForExternal(
            _In_ IUnknown* external,
            _In_opt_ IUnknown* inner,
            _In_ enum CreateObjectFlags flags,
            _In_ size_t contextSize,
            _Out_ ExternalWrapperResult* result) noexcept
        {
            _ASSERTE("CreateWrapperForExternal is not implemented on wasm");
            return 0;
        }

         // Destroy the supplied wrapper.
        // Optionally notify the wrapper of collection at the same time.
        void DestroyWrapperForExternal(_In_ void* context, _In_ bool notifyIsBeingCollected = false) noexcept
        {
            _ASSERTE("DestroyWrapperForExternal is not implemented on wasm");
        }

        // Get internal interop IUnknown dispatch pointers.
        void GetIUnknownImpl(
            _Out_ void** fpQueryInterface,
            _Out_ void** fpAddRef,
            _Out_ void** fpRelease) noexcept
        {
            _ASSERTE("GetIUnknownImpl is not implemented on wasm");
        }

        // Begin the reference tracking process on external COM objects.
        // This should only be called during a runtime's GC phase.
        HRESULT BeginExternalObjectReferenceTracking(_In_ InteropLibImports::RuntimeCallContext* cxt) noexcept
        {
            _ASSERTE("BeginExternalObjectReferenceTracking is not implemented on wasm");
            return 0;
        }

        // End the reference tracking process.
        // This should only be called during a runtime's GC phase.
        HRESULT EndExternalObjectReferenceTracking() noexcept
        {
            _ASSERTE("EndExternalObjectReferenceTracking is not implemented on wasm");
            return 0;
        }

        // Inform the wrapper it is being collected.
        void NotifyWrapperForExternalIsBeingCollected(_In_ void* context) noexcept
        {
            _ASSERTE("NotifyWrapperForExternalIsBeingCollected is not implemented on wasm");
        }
}
}
