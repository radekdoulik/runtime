// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

#include "common.h"

void InlinedCallFrame::UpdateRegDisplay_Impl(const PREGDISPLAY pRD, bool updateFloats)
{
    CONTRACTL
    {
        NOTHROW;
        GC_NOTRIGGER;
#ifdef PROFILING_SUPPORTED
        PRECONDITION(CORProfilerStackSnapshotEnabled() || InlinedCallFrame::FrameHasActiveCall(this));
#endif
        MODE_ANY;
        SUPPORTS_DAC;
    }
    CONTRACTL_END;

    if (!InlinedCallFrame::FrameHasActiveCall(this))
    {
        LOG((LF_CORDB, LL_ERROR, "WARNING: InlinedCallFrame::UpdateRegDisplay called on inactive frame %p\n", this));
        return;
    }

    pRD->pCurrentContext->InterpreterIP = *(DWORD *)&m_pCallerReturnAddress;

    pRD->IsCallerContextValid = FALSE;

    pRD->pCurrentContext->InterpreterSP = *(DWORD *)&m_pCallSiteSP;
    pRD->pCurrentContext->InterpreterFP = *(DWORD *)&m_pCalleeSavedFP;

    SyncRegDisplayToCurrentContext(pRD);

#ifdef FEATURE_INTERPRETER
    if ((m_Next != FRAME_TOP) && (m_Next != NULL) && (m_Next->GetFrameIdentifier() == FrameIdentifier::InterpreterFrame))
    {
        SetFirstArgReg(pRD->pCurrentContext, dac_cast<TADDR>(m_Next));
    }
#endif // FEATURE_INTERPRETER

    LOG((LF_GCROOTS, LL_INFO100000, "STACKWALK    InlinedCallFrame::UpdateRegDisplay_Impl(rip:%p, rsp:%p)\n", pRD->ControlPC, pRD->SP));
}

void FaultingExceptionFrame::UpdateRegDisplay_Impl(const PREGDISPLAY pRD, bool updateFloats)
{
    PORTABILITY_ASSERT("FaultingExceptionFrame::UpdateRegDisplay_Impl is not implemented on wasm");
}

static int32_t ReadWasmStackInt32(TADDR address)
{
    return *dac_cast<PTR_int32_t>(address);
}

static uint32_t ReadWasmStackUInt32(TADDR address)
{
    return *dac_cast<PTR_uint32_t>(address);
}

static TADDR ReadWasmStackAddress(TADDR address)
{
    return *dac_cast<PTR_TADDR>(address);
}

void TransitionFrame::UpdateRegDisplay_Impl(const PREGDISPLAY pRD, bool updateFloats)
{
    pRD->IsCallerContextValid = FALSE;

    pRD->pCurrentContext->InterpreterIP = GetReturnAddress();
    TADDR sp = GetSP();
    pRD->pCurrentContext->InterpreterSP = sp;

    // Recover the frame pointer so GC-info readers can locate frame slots, but only when
    // the stack pointer refers to a real R2R frame. When this frame represents a transition
    // out of interpreted code, GetSP() returns the address just past the TransitionBlock (the
    // outgoing argument area) rather than a frame pointer (see TransitionFrame::GetSP). Decoding
    // that would dereference arbitrary memory, so leave the frame pointer as 0 in that case.
    DPTR(TransitionBlock) pTransitionBlock =
        dac_cast<DPTR(TransitionBlock)>(GetTransitionBlock());
    bool hasR2RStackPointer = (pTransitionBlock != NULL) &&
                              (pTransitionBlock->m_ReturnAddress != 0) &&
                              (pTransitionBlock->m_StackPointer != 0);
    pRD->pCurrentContext->InterpreterFP = hasR2RStackPointer ? GetWasmFramePointerFromStackPointer(sp, (PCODE)pRD->pCurrentContext->InterpreterIP) : 0;

    SyncRegDisplayToCurrentContext(pRD);

    LOG((LF_GCROOTS, LL_INFO100000, "STACKWALK    TransitionFrame::UpdateRegDisplay_Impl(rip:%p, rsp:%p)\n", pRD->ControlPC, pRD->SP));
}

static TADDR GetWasmFramePointerFromStackPointer_Internal(TADDR sp)
{
    if (sp <= 0x1000)
    {
        // Sp has become set to the lowest page on the system. Or we're unwinding a TransitionBlock
        // which is encoded without a StackPointer. In either case, just return 0 to indicate that nothing
        // meaningful is here.
        return 0;
    }
    else
    {
        int32_t functionIndex = ReadWasmStackInt32(sp + WASM_STACKFRAME_FUNCTION_INDEX_OFFSET);
        if (functionIndex == STACK_WALK_INDIRECT_TO_FRAMEPOINTER)
        {
            sp = ReadWasmStackAddress(sp + WASM_STACKFRAME_INDIRECT_TO_FRAMEPOINTER_OFFSET);
            functionIndex = ReadWasmStackInt32(sp + WASM_STACKFRAME_FUNCTION_INDEX_OFFSET);
        }
        if (functionIndex == TERMINATE_R2R_STACK_WALK)
        {
            return 0;
        }
        else
        {
            return sp;
        }
    }
}

// Recover the establishing (method) frame pointer stored by CallFuncletWith[out]Throwable next to the
// TERMINATE_R2R_STACK_WALK marker. 'sp' must point at such a synthetic terminator frame (i.e. the SP
// reached after natively unwinding a funclet that the VM invoked via CallFunclet).
TADDR GetWasmEstablishingFramePointerFromTerminator(TADDR sp)
{
    _ASSERTE(ReadWasmStackInt32(sp + WASM_STACKFRAME_FUNCTION_INDEX_OFFSET) == TERMINATE_R2R_STACK_WALK);
    return ReadWasmStackAddress(sp + TERMINATE_R2R_STACK_WALK_FP_OFFSET);
}

TADDR GetWasmVirtualIPFromStackPointer(TADDR sp)
{
    TADDR fp = GetWasmFramePointerFromStackPointer_Internal(sp);

    if (fp == 0)
    {
        return 0;
    }
    else
    {
        uint32_t r2rFunctionTableEntryNumber =
            ReadWasmStackUInt32(fp + WASM_STACKFRAME_FUNCTION_INDEX_OFFSET);
        uint32_t functionLocalVirtualIP =
            ReadWasmStackUInt32(fp + WASM_STACKFRAME_VIRTUALIP_OFFSET) * 2;
        TADDR baseVirtualIP = ExecutionManager::GetWasmVirtualIPFromFunctionTableIndex(r2rFunctionTableEntryNumber);
        if (baseVirtualIP == 0)
        {
            return 0;
        }
        return baseVirtualIP + functionLocalVirtualIP;
    }
}

static void WasmUnwindStackFrameCore(TADDR* pSP, TADDR* pIP, UINT_PTR ImageBase, PRUNTIME_FUNCTION FunctionEntry)
{
    TADDR sp = *pSP;
    TADDR fp = GetWasmFramePointerFromStackPointer_Internal(sp);
    if (fp == 0)
    {
        *pSP = 0;
        *pIP = 0;
    }
    else
    {
        PTR_BYTE pUnwindData = dac_cast<PTR_BYTE>(FunctionEntry->UnwindData + ImageBase);
        *pSP = fp + DecodeULEB128AsU32(&pUnwindData);
        *pIP = GetWasmVirtualIPFromStackPointer(*pSP);
    }
}

TADDR GetWasmFramePointerFromStackPointer(TADDR sp, PCODE controlPC)
{
    // Get the frame pointer of the individual WASM function from the stack pointer. However, if this is a funclet, the logical
    // frame pointer is found by unwinding to either its containing function, or to a CallFunclet location.

    TADDR internalFunctionFramePointer = GetWasmFramePointerFromStackPointer_Internal(sp);
    _ASSERTE(internalFunctionFramePointer != 0);
    uint32_t r2rFunctionTableEntryNumber =
        ReadWasmStackUInt32(internalFunctionFramePointer + WASM_STACKFRAME_FUNCTION_INDEX_OFFSET);
    _ASSERTE(GetWasmVirtualIPFromStackPointer(sp) == controlPC);

    if (ExecutionManager::IsFuncletFunctionIndex(r2rFunctionTableEntryNumber))
    {
        UINT_PTR uImageBase;
        PT_RUNTIME_FUNCTION pFunctionEntry;
        EECodeInfo codeInfo;

        codeInfo.Init(controlPC);
        pFunctionEntry = codeInfo.GetFunctionEntry();
        uImageBase = (UINT_PTR)codeInfo.GetModuleBase();

        WasmUnwindStackFrameCore(&sp, &controlPC, uImageBase, pFunctionEntry);

        if (ReadWasmStackInt32(sp + WASM_STACKFRAME_FUNCTION_INDEX_OFFSET) == TERMINATE_R2R_STACK_WALK)
        {
            // The funclet was invoked by the VM through CallFuncletWith[out]Throwable, so native
            // unwinding terminates at that synthetic frame before reaching the method's own frame.
            // Recover the establishing (method) frame pointer the helper stored next to the
            // TERMINATE_R2R_STACK_WALK marker.
            return GetWasmEstablishingFramePointerFromTerminator(sp);
        }
        else
        {
            // The funclet was called by its containing method or funclet.
            // Recurse to find out if we're dealing with another funclet, or the non-exceptional
            // finally case.
            return GetWasmFramePointerFromStackPointer(sp, controlPC);
        }
    }
    else
    {
        return internalFunctionFramePointer;
    }
}

PEXCEPTION_ROUTINE
RtlVirtualUnwind(
    _In_ DWORD HandlerType,
    _In_ DWORD ImageBase,
    _In_ DWORD ControlPc,
    _In_ PRUNTIME_FUNCTION FunctionEntry,
    __inout PT_CONTEXT ContextRecord,
    _Out_ PVOID *HandlerData,
    _Out_ PDWORD EstablisherFrame,
    __inout_opt PT_KNONVOLATILE_CONTEXT_POINTERS ContextPointers)
{
    _ASSERTE(FunctionEntry != NULL);
    _ASSERTE(HandlerType == 0);
    _ASSERTE(ExecutionManager::IsVirtualIP(ControlPc));
    _ASSERTE(ImageBase != 0);

    // CoreCLR callers currently do not use HandlerData or EstablisherFrame on WASM,
    // so we set them to 0. If future callers require them, proper unwinding support
    // can be added at that point.
    *HandlerData = 0;
    *EstablisherFrame = 0;

    WasmUnwindStackFrameCore((TADDR*)&ContextRecord->InterpreterSP, (TADDR*)&ContextRecord->InterpreterIP, ImageBase, FunctionEntry);

    if (ContextRecord->InterpreterSP != 0)
    {
        // If InterpreterSP is set, then we successfully unwound, but if InterpreterIP is 0, then the caller
        // frame is not a frame on the RyuJit frame chain, so only get the InterpreterFP for those scenarios.
        if (ContextRecord->InterpreterIP != 0)
        {
            ContextRecord->InterpreterFP = GetWasmFramePointerFromStackPointer(ContextRecord->InterpreterSP, (PCODE)ContextRecord->InterpreterIP);
        }
        else
        {
            ContextRecord->InterpreterFP = 0;
        }
    }
    else
    {
        _ASSERTE(FALSE);
        ContextRecord->InterpreterFP = 0;
    }

    return nullptr;
}
