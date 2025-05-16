extern "C" void STDCALL CallCountingStubCode()
{
    PORTABILITY_ASSERT("CallCountingStubCode is not implemented on wasm");
}

extern "C" void CallCountingStubCode_End()
{
    PORTABILITY_ASSERT("CallCountingStubCode_End is not implemented on wasm");
}

extern "C" void STDCALL OnCallCountThresholdReachedStub()
{
    PORTABILITY_ASSERT("OnCallCountThresholdReachedStub is not implemented on wasm");
}

extern "C" void STDCALL ThePreStub()
{
    PORTABILITY_ASSERT("ThePreStub is not implemented on wasm");
}

extern "C" void InterpreterStub()
{
    PORTABILITY_ASSERT("InterpreterStub is not implemented on wasm");
}

extern "C" UINT_PTR STDCALL GetCurrentIP(void)
{
    PORTABILITY_ASSERT("GetCurrentIP is not implemented on wasm");
    return 0;
}

extern "C" void STDMETHODCALLTYPE JIT_ProfilerEnterLeaveTailcallStub(UINT_PTR ProfilerHandle)
{
    PORTABILITY_ASSERT("JIT_ProfilerEnterLeaveTailcallStub is not implemented on wasm");
}

extern "C" void STDCALL DelayLoad_MethodCall()
{
    PORTABILITY_ASSERT("DelayLoad_MethodCall is not implemented on wasm");
}

extern "C" void STDCALL DelayLoad_Helper()
{
    PORTABILITY_ASSERT("DelayLoad_Helper is not implemented on wasm");
}

extern "C" void STDCALL DelayLoad_Helper_Obj()
{
    PORTABILITY_ASSERT("DelayLoad_Helper_Obj is not implemented on wasm");
}

extern "C" void STDCALL DelayLoad_Helper_ObjObj()
{
    PORTABILITY_ASSERT("DelayLoad_Helper_ObjObj is not implemented on wasm");
}

extern "C" void STDCALL NDirectImportThunk()
{
    PORTABILITY_ASSERT("NDirectImportThunk is not implemented on wasm");
}

extern "C" void STDCALL StubPrecodeCode()
{
    PORTABILITY_ASSERT("StubPrecodeCode is not implemented on wasm");
}

extern "C" void STDCALL StubPrecodeCode_End()
{
    PORTABILITY_ASSERT("StubPrecodeCode_End is not implemented on wasm");
}

extern "C" void STDCALL FixupPrecodeCode()
{
    PORTABILITY_ASSERT("FixupPrecodeCode is not implemented on wasm");
}

extern "C" void STDCALL FixupPrecodeCode_End()
{
    PORTABILITY_ASSERT("FixupPrecodeCode_End is not implemented on wasm");
}

extern "C" void STDCALL JIT_PatchedCodeLast()
{
    PORTABILITY_ASSERT("JIT_PatchedCodeLast is not implemented on wasm");
}

extern "C" void STDCALL JIT_PatchedCodeStart()
{
    PORTABILITY_ASSERT("JIT_PatchedCodeStart is not implemented on wasm");
}

extern "C" void RhpInitialInterfaceDispatch()
{
    PORTABILITY_ASSERT("RhpInitialInterfaceDispatch is not implemented on wasm");
}

extern "C" void STDCALL CallDescrWorkerInternal(CallDescrData * pCallDescrData)
{
    PORTABILITY_ASSERT("CallDescrWorkerInternal is not implemented on wasm");
}

unsigned FuncEvalFrame::GetFrameAttribs_Impl(void)
{
    PORTABILITY_ASSERT("FuncEvalFrame::GetFrameAttribs_Impl is not implemented on wasm");
    return 0;
}

TADDR FuncEvalFrame::GetReturnAddressPtr_Impl()
{
    PORTABILITY_ASSERT("FuncEvalFrame::GetReturnAddressPtr_Impl is not implemented on wasm");
    return 0;
}

void FuncEvalFrame::UpdateRegDisplay_Impl(const PREGDISPLAY pRD, bool updateFloats)
{
    PORTABILITY_ASSERT("FuncEvalFrame::UpdateRegDisplay_Impl is not implemented on wasm");
}

void InlinedCallFrame::UpdateRegDisplay_Impl(const PREGDISPLAY pRD, bool updateFloats)
{
    PORTABILITY_ASSERT("InlinedCallFrame::UpdateRegDisplay_Impl is not implemented on wasm");
}

void FaultingExceptionFrame::UpdateRegDisplay_Impl(const PREGDISPLAY pRD, bool updateFloats)
{
    PORTABILITY_ASSERT("FaultingExceptionFrame::UpdateRegDisplay_Impl is not implemented on wasm");
}

void HelperMethodFrame::UpdateRegDisplay_Impl(const PREGDISPLAY pRD, bool updateFloats)
{
    PORTABILITY_ASSERT("HelperMethodFrame::UpdateRegDisplay_Impl is not implemented on wasm");
}

void TransitionFrame::UpdateRegDisplay_Impl(const PREGDISPLAY pRD, bool updateFloats)
{
    PORTABILITY_ASSERT("TransitionFrame::UpdateRegDisplay_Impl is not implemented on wasm");
}

size_t CallDescrWorkerInternalReturnAddressOffset;

VOID PALAPI RtlRestoreContext(IN PCONTEXT ContextRecord, IN PEXCEPTION_RECORD ExceptionRecord)
{
    PORTABILITY_ASSERT("RtlRestoreContext is not implemented on wasm");
}

extern "C" void TheUMEntryPrestub(void)
{
    PORTABILITY_ASSERT("TheUMEntryPrestub is not implemented on wasm");
}

extern "C" void STDCALL VarargPInvokeStub(void)
{
    PORTABILITY_ASSERT("VarargPInvokeStub is not implemented on wasm");
}

extern "C" void STDCALL VarargPInvokeStub_RetBuffArg(void)
{
    PORTABILITY_ASSERT("VarargPInvokeStub_RetBuffArg is not implemented on wasm");
}

extern "C" PCODE CID_VirtualOpenDelegateDispatch(TransitionBlock * pTransitionBlock)
{
    PORTABILITY_ASSERT("CID_VirtualOpenDelegateDispatch is not implemented on wasm");
    return 0;
}

extern "C" FCDECL2(VOID, JIT_WriteBarrier_Callable, Object **dst, Object *ref)
{
    PORTABILITY_ASSERT("JIT_WriteBarrier_Callable is not implemented on wasm");
}

EXTERN_C void JIT_WriteBarrier_End()
{
    PORTABILITY_ASSERT("JIT_WriteBarrier_End is not implemented on wasm");
}

EXTERN_C void JIT_CheckedWriteBarrier_End()
{
    PORTABILITY_ASSERT("JIT_CheckedWriteBarrier_End is not implemented on wasm");
}

EXTERN_C void JIT_ByRefWriteBarrier_End()
{
    PORTABILITY_ASSERT("JIT_ByRefWriteBarrier_End is not implemented on wasm");
}

EXTERN_C void JIT_StackProbe_End()
{
    PORTABILITY_ASSERT("JIT_StackProbe_End is not implemented on wasm");
}

EXTERN_C int __fastcall HelperMethodFrameRestoreState(
    INDEBUG_COMMA(HelperMethodFrame *pFrame)
    MachState *pState
)
{
    PORTABILITY_ASSERT("HelperMethodFrameRestoreState is not implemented on wasm");
    return 0;
}

EXTERN_C VOID STDCALL ResetCurrentContext()
{
    PORTABILITY_ASSERT("ResetCurrentContext is not implemented on wasm");
}

extern "C" void STDCALL GenericPInvokeCalliHelper(void)
{
    PORTABILITY_ASSERT("GenericPInvokeCalliHelper is not implemented on wasm");
}

EXTERN_C void JIT_PInvokeBegin(InlinedCallFrame* pFrame)
{
    PORTABILITY_ASSERT("JIT_PInvokeBegin is not implemented on wasm");
}

EXTERN_C void JIT_PInvokeEnd(InlinedCallFrame* pFrame)
{
    PORTABILITY_ASSERT("JIT_PInvokeEnd is not implemented on wasm");
}

extern "C" void STDCALL JIT_StackProbe()
{
    PORTABILITY_ASSERT("JIT_StackProbe is not implemented on wasm");
}

EXTERN_C FCDECL0(void, JIT_PollGC)
{
    PORTABILITY_ASSERT("JIT_PollGC is not implemented on wasm");
}

extern "C" FCDECL2(VOID, JIT_WriteBarrier, Object **dst, Object *ref)
{
    PORTABILITY_ASSERT("JIT_WriteBarrier is not implemented on wasm");
}

extern "C" FCDECL2(VOID, JIT_CheckedWriteBarrier, Object **dst, Object *ref)
{
    PORTABILITY_ASSERT("JIT_CheckedWriteBarrier is not implemented on wasm");
}

extern "C" void STDCALL JIT_ByRefWriteBarrier()
{
    PORTABILITY_ASSERT("JIT_ByRefWriteBarrier is not implemented on wasm");
}

void InitJITHelpers1()
{
    /* no-op TODO do we need to do anything for the interpreter? */
}

extern "C" HRESULT __cdecl CorDBGetInterface(DebugInterface** rcInterface)
{
    PORTABILITY_ASSERT("CorDBGetInterface is not implemented on wasm");
    return 0;
}

extern "C" void RhpInterfaceDispatch1()
{
    PORTABILITY_ASSERT("RhpInterfaceDispatch1 is not implemented on wasm");
}

extern "C" void RhpInterfaceDispatch2()
{
    PORTABILITY_ASSERT("RhpInterfaceDispatch2 is not implemented on wasm");
}

extern "C" void RhpInterfaceDispatch4()
{
    PORTABILITY_ASSERT("RhpInterfaceDispatch4 is not implemented on wasm");
}

extern "C" void RhpInterfaceDispatch8()
{
    PORTABILITY_ASSERT("RhpInterfaceDispatch8 is not implemented on wasm");
}

extern "C" void RhpInterfaceDispatch16()
{
    PORTABILITY_ASSERT("RhpInterfaceDispatch16 is not implemented on wasm");
}

extern "C" void RhpInterfaceDispatch32()
{
    PORTABILITY_ASSERT("RhpInterfaceDispatch32 is not implemented on wasm");
}

extern "C" void RhpInterfaceDispatch64()
{
    PORTABILITY_ASSERT("RhpInterfaceDispatch64 is not implemented on wasm");
}

extern "C" void RhpVTableOffsetDispatch()
{
    PORTABILITY_ASSERT("RhpVTableOffsetDispatch is not implemented on wasm");
}

typedef uint8_t CODE_LOCATION;
CODE_LOCATION RhpAssignRefAVLocation;
CODE_LOCATION RhpCheckedAssignRefAVLocation;
CODE_LOCATION RhpByRefAssignRefAVLocation1;
CODE_LOCATION RhpByRefAssignRefAVLocation2;

extern "C" void ThisPtrRetBufPrecodeWorker()
{
    PORTABILITY_ASSERT("ThisPtrRetBufPrecodeWorker is not implemented on wasm");
}

extern "C" FCDECL2(VOID, RhpAssignRef, Object **dst, Object *ref)
{
    PORTABILITY_ASSERT("RhpAssignRef is not implemented on wasm");
}

extern "C" FCDECL2(VOID, RhpCheckedAssignRef, Object **dst, Object *ref)
{
    PORTABILITY_ASSERT("RhpCheckedAssignRef is not implemented on wasm");
}

extern "C" FCDECL2(VOID, RhpByRefAssignRef, Object **dst, Object *ref)
{
    PORTABILITY_ASSERT("RhpByRefAssignRef is not implemented on wasm");
}

extern "C" void RhpInterfaceDispatchAVLocation1()
{
    PORTABILITY_ASSERT("RhpInterfaceDispatchAVLocation1 is not implemented on wasm");
}

extern "C" void RhpInterfaceDispatchAVLocation2()
{
    PORTABILITY_ASSERT("RhpInterfaceDispatchAVLocation2 is not implemented on wasm");
}

extern "C" void RhpInterfaceDispatchAVLocation4()
{
    PORTABILITY_ASSERT("RhpInterfaceDispatchAVLocation4 is not implemented on wasm");
}

extern "C" void RhpInterfaceDispatchAVLocation8()
{
    PORTABILITY_ASSERT("RhpInterfaceDispatchAVLocation8 is not implemented on wasm");
}

extern "C" void RhpInterfaceDispatchAVLocation16()
{
    PORTABILITY_ASSERT("RhpInterfaceDispatchAVLocation16 is not implemented on wasm");
}

extern "C" void RhpInterfaceDispatchAVLocation32()
{
    PORTABILITY_ASSERT("RhpInterfaceDispatchAVLocation32 is not implemented on wasm");
}

extern "C" void RhpInterfaceDispatchAVLocation64()
{
    PORTABILITY_ASSERT("RhpInterfaceDispatchAVLocation64 is not implemented on wasm");
}

extern "C" void RhpVTableOffsetDispatchAVLocation()
{
    PORTABILITY_ASSERT("RhpVTableOffsetDispatchAVLocation is not implemented on wasm");
}

extern "C" void STDCALL ThePreStubPatchLabel(void)
{
    PORTABILITY_ASSERT("ThePreStubPatchLabel is not implemented on wasm");
}

LONG CLRNoCatchHandler(EXCEPTION_POINTERS* pExceptionInfo, PVOID pv)
{
    PORTABILITY_ASSERT("CLRNoCatchHandler is not implemented on wasm");
    return EXCEPTION_CONTINUE_SEARCH;
}

EXTERN_C void STDMETHODCALLTYPE ProfileEnterNaked(FunctionIDOrClientID functionIDOrClientID)
{
    PORTABILITY_ASSERT("ProfileEnterNaked is not implemented on wasm");
}

EXTERN_C void STDMETHODCALLTYPE ProfileLeaveNaked(UINT_PTR clientData)
{
    PORTABILITY_ASSERT("ProfileLeaveNaked is not implemented on wasm");
}

EXTERN_C void STDMETHODCALLTYPE ProfileTailcallNaked(UINT_PTR clientData)
{
    PORTABILITY_ASSERT("ProfileTailcallNaked is not implemented on wasm");
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
    PORTABILITY_ASSERT("FlushWriteBarrierInstructionCache is not implemented on wasm");
}

EXTERN_C Thread * JIT_InitPInvokeFrame(InlinedCallFrame *pFrame)
{
    PORTABILITY_ASSERT("JIT_InitPInvokeFrame is not implemented on wasm");
    return nullptr;
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
            PORTABILITY_ASSERT("CreateWrapperForObject is not implemented on wasm");
            return 0;
        }

        // Destroy the supplied wrapper
        void DestroyWrapperForObject(_In_ void* wrapper) noexcept
        {
            PORTABILITY_ASSERT("DestroyWrapperForObject is not implemented on wasm");
        }

        // Check if a wrapper is considered a GC root.
        HRESULT IsWrapperRooted(_In_ IUnknown* wrapper) noexcept
        {
            PORTABILITY_ASSERT("IsWrapperRooted is not implemented on wasm");
            return 0;
        }

        // Get the object for the supplied wrapper
        HRESULT GetObjectForWrapper(_In_ IUnknown* wrapper, _Outptr_result_maybenull_ OBJECTHANDLE* object) noexcept
        {
            PORTABILITY_ASSERT("GetObjectForWrapper is not implemented on wasm");
            return 0;
        }


        HRESULT MarkComActivated(_In_ IUnknown* wrapper) noexcept;
        HRESULT IsComActivated(_In_ IUnknown* wrapper) noexcept
        {
            PORTABILITY_ASSERT("IsComActivated is not implemented on wasm");
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
            PORTABILITY_ASSERT("DetermineIdentityAndInnerForExternal is not implemented on wasm");
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
            PORTABILITY_ASSERT("CreateWrapperForExternal is not implemented on wasm");
            return 0;
        }

         // Destroy the supplied wrapper.
        // Optionally notify the wrapper of collection at the same time.
        void DestroyWrapperForExternal(_In_ void* context, _In_ bool notifyIsBeingCollected = false) noexcept
        {
            PORTABILITY_ASSERT("DestroyWrapperForExternal is not implemented on wasm");
        }

        // Get internal interop IUnknown dispatch pointers.
        void GetIUnknownImpl(
            _Out_ void** fpQueryInterface,
            _Out_ void** fpAddRef,
            _Out_ void** fpRelease) noexcept
        {
            PORTABILITY_ASSERT("GetIUnknownImpl is not implemented on wasm");
        }

        // Begin the reference tracking process on external COM objects.
        // This should only be called during a runtime's GC phase.
        HRESULT BeginExternalObjectReferenceTracking(_In_ InteropLibImports::RuntimeCallContext* cxt) noexcept
        {
            PORTABILITY_ASSERT("BeginExternalObjectReferenceTracking is not implemented on wasm");
            return 0;
        }

        // End the reference tracking process.
        // This should only be called during a runtime's GC phase.
        HRESULT EndExternalObjectReferenceTracking() noexcept
        {
            PORTABILITY_ASSERT("EndExternalObjectReferenceTracking is not implemented on wasm");
            return 0;
        }

        // Inform the wrapper it is being collected.
        void NotifyWrapperForExternalIsBeingCollected(_In_ void* context) noexcept
        {
            PORTABILITY_ASSERT("NotifyWrapperForExternalIsBeingCollected is not implemented on wasm");
        }
}
}
