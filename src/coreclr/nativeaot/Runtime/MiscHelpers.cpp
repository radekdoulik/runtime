// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

//
// Miscellaneous unmanaged helpers called by managed code.
//

#include "common.h"
#include "CommonTypes.h"
#include "CommonMacros.h"
#include "daccess.h"
#include "PalLimitedContext.h"
#include "Pal.h"
#include "rhassert.h"
#include "slist.h"
#include "holder.h"
#include "Crst.h"
#include "rhbinder.h"
#include "RuntimeInstance.h"
#include "regdisplay.h"
#include "StackFrameIterator.h"
#include "thread.h"
#include "event.h"
#include "threadstore.h"
#include "threadstore.inl"
#include "thread.inl"
#include "shash.h"
#include "TypeManager.h"
#include "MethodTable.h"
#include "ObjectLayout.h"
#include "slist.inl"
#include "MethodTable.inl"
#include "CommonMacros.inl"
#include "volatile.h"
#include "yieldprocessornormalized.h"
#include "RhConfig.h"
#include <minipal/cpuid.h>
#include <minipal/debugger.h>
#include <minipal/time.h>

FCIMPL0(void, RhDebugBreak)
{
    PalDebugBreak();
}
FCIMPLEND

// Busy spin for the given number of iterations.
EXTERN_C void QCALLTYPE RhSpinWait(int32_t iterations)
{
    ASSERT(iterations > 0);

    // limit the spin count in coop mode.
    ASSERT_MSG(iterations <= 1024 || !ThreadStore::GetCurrentThread()->IsCurrentThreadInCooperativeMode(),
        "This is too long wait for coop mode. You must p/invoke with GC transition.");

    YieldProcessorNormalizationInfo normalizationInfo;
    YieldProcessorNormalized(normalizationInfo, iterations);
}

// Yield the cpu to another thread ready to process, if one is available.
EXTERN_C UInt32_BOOL QCALLTYPE RhYield()
{
    // This must be called via p/invoke -- it's a wait operation and we don't want to block thread suspension on this.
    ASSERT_MSG(!ThreadStore::GetCurrentThread()->IsCurrentThreadInCooperativeMode(),
        "You must p/invoke to RhYield");

    return PalSwitchToThread();
}

EXTERN_C void QCALLTYPE RhFlushProcessWriteBuffers()
{
    // This must be called via p/invoke -- it's a wait operation and we don't want to block thread suspension on this.
    ASSERT_MSG(!ThreadStore::GetCurrentThread()->IsCurrentThreadInCooperativeMode(),
        "You must p/invoke to RhFlushProcessWriteBuffers");

    PalFlushProcessWriteBuffers();
}

// Get the list of currently loaded NativeAOT modules (as OS HMODULE handles). The caller provides a reference
// to an array of pointer-sized elements and we return the total number of modules currently loaded (whether
// that is less than, equal to or greater than the number of elements in the array). If there are more modules
// loaded than the array will hold then the array is filled to capacity and the caller can tell further
// modules are available based on the return count. It is also possible to call this method without an array,
// in which case just the module count is returned (note that it's still possible for the module count to
// increase between calls to this method).
FCIMPL1(uint32_t, RhGetLoadedOSModules, Array * pResultArray)
{
    // Note that we depend on the fact that this is a COOP helper to make writing into an unpinned array safe.

    // If a result array is passed then it should be an array type with pointer-sized components that are not
    // GC-references.
    ASSERT(!pResultArray || pResultArray->GetMethodTable()->IsArray());
    ASSERT(!pResultArray || !pResultArray->GetMethodTable()->HasReferenceFields());
    ASSERT(!pResultArray || pResultArray->GetMethodTable()->RawGetComponentSize() == sizeof(void*));

    uint32_t cResultArrayElements = pResultArray ? pResultArray->GetArrayLength() : 0;
    HANDLE * pResultElements = pResultArray ? (HANDLE*)(pResultArray + 1) : NULL;

    uint32_t cModules = 0;

    RuntimeInstance::OsModuleList *osModules = GetRuntimeInstance()->GetOsModuleList();

    for (RuntimeInstance::OsModuleList::Iterator iter = osModules->Begin(); iter != osModules->End(); iter++)
    {
        if (pResultArray && (cModules < cResultArrayElements))
            pResultElements[cModules] = iter->m_osModule;
        cModules++;
    }

    return cModules;
}
FCIMPLEND

FCIMPL1(HANDLE, RhGetOSModuleFromPointer, PTR_VOID pPointerVal)
{
    ICodeManager * pCodeManager = GetRuntimeInstance()->GetCodeManagerForAddress(pPointerVal);

    if (pCodeManager != NULL)
        return (HANDLE)pCodeManager->GetOsModuleHandle();

    return NULL;
}
FCIMPLEND

FCIMPL4(FC_BOOL_RET, RhFindBlob, TypeManagerHandle *pTypeManagerHandle, uint32_t blobId, uint8_t ** ppbBlob, uint32_t * pcbBlob)
{
    TypeManagerHandle typeManagerHandle = *pTypeManagerHandle;

    ReadyToRunSectionType section =
        (ReadyToRunSectionType)((uint32_t)ReadyToRunSectionType::ReadonlyBlobRegionStart + blobId);
    ASSERT(section <= ReadyToRunSectionType::ReadonlyBlobRegionEnd);

    TypeManager* pModule = typeManagerHandle.AsTypeManager();

    int length;
    void* pBlob;
    pBlob = pModule->GetModuleSection(section, &length);

    *ppbBlob = (uint8_t*)pBlob;
    *pcbBlob = (uint32_t)length;

    FC_RETURN_BOOL(pBlob != NULL);
}
FCIMPLEND

FCIMPL1(void *, RhGetTargetOfUnboxingAndInstantiatingStub, void * pUnboxStub)
{
    return GetRuntimeInstance()->GetTargetOfUnboxingAndInstantiatingStub(pUnboxStub);
}
FCIMPLEND

#if TARGET_ARM
//*****************************************************************************
//  Extract the 16-bit immediate from ARM Thumb2 Instruction (format T2_N)
//*****************************************************************************
static FORCEINLINE uint16_t GetThumb2Imm16(uint16_t * p)
{
    return ((p[0] << 12) & 0xf000) |
        ((p[0] << 1) & 0x0800) |
        ((p[1] >> 4) & 0x0700) |
        ((p[1] >> 0) & 0x00ff);
}

//*****************************************************************************
//  Extract the 32-bit immediate from movw/movt sequence
//*****************************************************************************
inline uint32_t GetThumb2Mov32(uint16_t * p)
{
    // Make sure we are decoding movw/movt sequence
    ASSERT((*(p + 0) & 0xFBF0) == 0xF240);
    ASSERT((*(p + 2) & 0xFBF0) == 0xF2C0);

    return (uint32_t)GetThumb2Imm16(p) + ((uint32_t)GetThumb2Imm16(p + 2) << 16);
}

//*****************************************************************************
//  Extract the 24-bit distance from a B/BL instruction
//*****************************************************************************
inline int32_t GetThumb2BlRel24(uint16_t * p)
{
    uint16_t Opcode0 = p[0];
    uint16_t Opcode1 = p[1];

    uint32_t S = Opcode0 >> 10;
    uint32_t J2 = Opcode1 >> 11;
    uint32_t J1 = Opcode1 >> 13;

    int32_t ret =
        ((S << 24) & 0x1000000) |
        (((J1 ^ S ^ 1) << 23) & 0x0800000) |
        (((J2 ^ S ^ 1) << 22) & 0x0400000) |
        ((Opcode0 << 12) & 0x03FF000) |
        ((Opcode1 << 1) & 0x0000FFE);

    // Sign-extend and return
    return (ret << 7) >> 7;
}
#endif // TARGET_ARM

// Given a pointer to code, find out if this points to an import stub
// or unboxing stub, and if so, return the address that stub jumps to
FCIMPL1(uint8_t *, RhGetCodeTarget, uint8_t * pCodeOrg)
{
    bool unboxingStub = false;

    // First, check the unboxing stubs regions known by the runtime (if any exist)
    if (!GetRuntimeInstance()->IsUnboxingStub(pCodeOrg))
    {
        return pCodeOrg;
    }

#ifdef TARGET_AMD64
    uint8_t * pCode = pCodeOrg;

    // is this "add rcx/rdi,8"?
    if (pCode[0] == 0x48 &&
        pCode[1] == 0x83 &&
#ifdef UNIX_AMD64_ABI
        pCode[2] == 0xc7 &&
#else
        pCode[2] == 0xc1 &&
#endif
        pCode[3] == 0x08)
    {
        // unboxing sequence
        unboxingStub = true;
        pCode += 4;
    }
    // is this an indirect jump?
    if (pCode[0] == 0xff && pCode[1] == 0x25)
    {
        // normal import stub - dist to IAT cell is relative to the point *after* the instruction
        int32_t distToIatCell = *(int32_t *)&pCode[2];
        uint8_t ** pIatCell = (uint8_t **)(pCode + 6 + distToIatCell);
        return *pIatCell;
    }
    // is this an unboxing stub followed by a relative jump?
    else if (unboxingStub && pCode[0] == 0xe9)
    {
        // relative jump - dist is relative to the point *after* the instruction
        int32_t distToTarget = *(int32_t *)&pCode[1];
        uint8_t * target = pCode + 5 + distToTarget;
        return target;
    }

#elif TARGET_X86
    uint8_t * pCode = pCodeOrg;

    // is this "add ecx,4"?
    if (pCode[0] == 0x83 && pCode[1] == 0xc1 && pCode[2] == 0x04)
    {
        // unboxing sequence
        unboxingStub = true;
        pCode += 3;
    }
    // is this an indirect jump?
    if (pCode[0] == 0xff && pCode[1] == 0x25)
    {
        // normal import stub - address of IAT follows
        uint8_t **pIatCell = *(uint8_t ***)&pCode[2];
        return *pIatCell;
    }
    // is this an unboxing stub followed by a relative jump?
    else if (unboxingStub && pCode[0] == 0xe9)
    {
        // relative jump - dist is relative to the point *after* the instruction
        int32_t distToTarget = *(int32_t *)&pCode[1];
        uint8_t * pTarget = pCode + 5 + distToTarget;
        return pTarget;
    }

#elif TARGET_ARM
    uint16_t * pCode = (uint16_t *)((size_t)pCodeOrg & ~THUMB_CODE);
    // is this "adds r0,4"?
    if (pCode[0] == 0x3004)
    {
        // unboxing sequence
        unboxingStub = true;
        pCode += 1;
    }
    // is this movw r12,#imm16; movt r12,#imm16; ldr pc,[r12]
    // or movw r12,#imm16; movt r12,#imm16; bx r12
    if  ((pCode[0] & 0xfbf0) == 0xf240 && (pCode[1] & 0x0f00) == 0x0c00
        && (pCode[2] & 0xfbf0) == 0xf2c0 && (pCode[3] & 0x0f00) == 0x0c00
        && ((pCode[4] == 0xf8dc && pCode[5] == 0xf000) || pCode[4] == 0x4760))
    {
        if (pCode[4] == 0xf8dc && pCode[5] == 0xf000)
        {
            // ldr pc,[r12]
            uint8_t **pIatCell = (uint8_t **)GetThumb2Mov32(pCode);
            return *pIatCell;
        }
        else if (pCode[4] == 0x4760)
        {
            // bx r12
            return (uint8_t *)GetThumb2Mov32(pCode);
        }
    }
    // is this an unboxing stub followed by a relative jump?
    else if (unboxingStub && (pCode[0] & 0xf800) == 0xf000 && (pCode[1] & 0xd000) == 0x9000)
    {
        int32_t distToTarget = GetThumb2BlRel24(pCode);
        uint8_t * pTarget = (uint8_t *)(pCode + 2) + distToTarget + THUMB_CODE;
        return (uint8_t *)pTarget;
    }

#elif TARGET_ARM64
    uint32_t * pCode = (uint32_t *)pCodeOrg;
    // is this "add x0,x0,#8"?
    if (pCode[0] == 0x91002000)
    {
        // unboxing sequence
        unboxingStub = true;
        pCode++;
    }
    // is this an indirect jump?
    // adrp xip0,#imm21; ldr xip0,[xip0,#imm12]; br xip0
    if ((pCode[0] & 0x9f00001f) == 0x90000010 &&
        (pCode[1] & 0xffc003ff) == 0xf9400210 &&
        pCode[2] == 0xd61f0200)
    {
        // normal import stub - dist to IAT cell is relative to (PC & ~0xfff)
        // adrp: imm = SignExtend(immhi:immlo:Zeros(12), 64);
        int64_t distToIatCell = (((((int64_t)pCode[0] & ~0x1f) << 40) >> 31) | ((pCode[0] >> 17) & 0x3000));
        // ldr: offset = LSL(ZeroExtend(imm12, 64), 3);
        distToIatCell += (pCode[1] >> 7) & 0x7ff8;
        uint8_t ** pIatCell = (uint8_t **)(((int64_t)pCode & ~0xfff) + distToIatCell);
        return *pIatCell;
    }
    // is this an unboxing stub followed by a relative jump?
    else if (unboxingStub && (pCode[0] >> 26) == 0x5)
    {
        // relative jump - dist is relative to the instruction
        // offset = SignExtend(imm26:'00', 64);
        int64_t distToTarget = ((int64_t)pCode[0] << 38) >> 36;
        return (uint8_t *)pCode + distToTarget;
    }

#elif TARGET_LOONGARCH64
    uint32_t * pCode = (uint32_t *)pCodeOrg;
    // is this "addi.d $a0, $a0, 8"?
    if (pCode[0] == 0x02c02084)
    {
        // unboxing sequence
        unboxingStub = true;
        pCode++;
    }
    // is this an indirect jump?
    // pcalau12i $rd, imm20; ld.d $rd, $rj, imm12; jirl $rd, $rj, 0
    if ((pCode[0] & 0xfe000000) == 0x1a000000 &&
        (pCode[1] & 0xffc00000) == 0x28c00000 &&
        (pCode[2] & 0xfc000000) == 0x4c000000)
    {
        // normal import stub - dist to IAT cell is relative to (PC & ~0xfff)
        // pcalau12i: imm = SignExtend(imm20:Zeros(12), 64);
        int64_t distToIatCell = ((((int64_t)pCode[0] & ~0x1f) << 39) >> 32);
        // ld.d: offset = SignExtend(imm12, 64);
        distToIatCell += (((int64_t)pCode[1] << 42) >> 52);
        uint8_t ** pIatCell = (uint8_t **)(((int64_t)pCode & ~0xfff) + distToIatCell);
        return *pIatCell;
    }
    // is this an unboxing stub followed by a relative jump?
    // pcaddu18i $r21, imm20; jirl $r0, $r21, imm16
    else if (unboxingStub &&
             (pCode[0] & 0xfe00001f) == 0x1e000015 &&
             (pCode[1] & 0xfc0003ff) == 0x4c0002a0)
    {
        // relative jump - dist is relative to the instruction
        // offset = SignExtend(immhi20:immlo16:'00', 64);
        int64_t distToTarget = ((((int64_t)pCode[0] & ~0x1f) << 39) >> 26);
        distToTarget += ((((int64_t)pCode[1] & ~0x3ff) << 38) >> 46);
        return (uint8_t *)((int64_t)pCode + distToTarget);
    }

#elif TARGET_RISCV64
    uint32_t * pCode = (uint32_t *)pCodeOrg;
    if (pCode[0] == 0x00850513)  // Encoding for `addi a0, a0, 8` in 32-bit instruction format
    {
        // unboxing sequence
        unboxingStub = true;
        pCode++;
    }
    // is this an indirect jump?
    // lui t0, imm; jalr t0, t0, imm12
    if ((pCode[0] & 0x7f) == 0x17 &&                 // auipc
        (pCode[1] & 0x707f) == 0x3003 &&             // ld with funct3=011
        (pCode[2] & 0x707f) == 0x0067)               // jr (jalr with x0 as rd and funct3=000)
    {
        // Compute the distance to the IAT cell
        int64_t distToIatCell = (((int32_t)pCode[0]) >> 12) << 12;  // Extract imm20 from auipc
        distToIatCell += ((int32_t)pCode[1]) >> 20;                    // Add imm12 from ld

        uint8_t ** pIatCell = (uint8_t **)(((int64_t)pCode & ~0xfff) + distToIatCell);
        return *pIatCell;
    }

    // Is this an unboxing stub followed by a relative jump?
    // auipc t0, imm20; jalr ra, imm12(t0)
    else if (unboxingStub &&
            (pCode[0] & 0x7f) == 0x17 &&                 // auipc opcode
            (pCode[1] & 0x707f) == 0x0067)              // jalr opcode with funct3=000
    {
        // Extract imm20 from auipc
        int64_t distToTarget = (((int32_t)pCode[0]) >> 12) << 12;  // Extract imm20 (bits 31:12)

        // Extract imm12 from jalr
        distToTarget += ((int32_t)pCode[1]) >> 20;  // Extract imm12 (bits 31:20)

        // Calculate the final target address relative to PC
        return (uint8_t *)((int64_t)pCode + distToTarget);
    }

#else
    UNREFERENCED_PARAMETER(unboxingStub);
    PORTABILITY_ASSERT("RhGetCodeTarget");
#endif

    return pCodeOrg;
}
FCIMPLEND

EXTERN_C int32_t QCALLTYPE RhpCalculateStackTraceWorker(void* pOutputBuffer, uint32_t outputBufferLength, void* pAddressInCurrentFrame);

EXTERN_C int32_t QCALLTYPE RhpGetCurrentThreadStackTrace(void* pOutputBuffer, uint32_t outputBufferLength, void* pAddressInCurrentFrame)
{
    // This must be called via p/invoke rather than RuntimeImport to make the stack crawlable.

    ThreadStore::GetCurrentThread()->DeferTransitionFrame();

    return RhpCalculateStackTraceWorker(pOutputBuffer, outputBufferLength, pAddressInCurrentFrame);
}

EXTERN_C UInt32_BOOL QCALLTYPE DebugDebugger_IsNativeDebuggerAttached()
{
    return minipal_is_native_debugger_present();
}

FCIMPL2(FC_BOOL_RET, RhCompareObjectContentsAndPadding, Object* pObj1, Object* pObj2)
{
    ASSERT(pObj1->GetMethodTable() == pObj2->GetMethodTable());
    ASSERT(pObj1->GetMethodTable()->IsValueType());

    MethodTable* pEEType = pObj1->GetMethodTable();
    size_t cbFields = pEEType->GetBaseSize() - (sizeof(ObjHeader) + sizeof(MethodTable*));

    uint8_t* pbFields1 = (uint8_t*)pObj1 + sizeof(MethodTable*);
    uint8_t* pbFields2 = (uint8_t*)pObj2 + sizeof(MethodTable*);

    // memcmp is ok in this COOP method as we are comparing structs which are typically small.
    FC_RETURN_BOOL(memcmp(pbFields1, pbFields2, cbFields) == 0);
}
FCIMPLEND

FCIMPL3(void*, RhpGetModuleSection, TypeManagerHandle *pModule, int32_t headerId, int32_t* length)
{
    return pModule->AsTypeManager()->GetModuleSection((ReadyToRunSectionType)headerId, length);
}
FCIMPLEND

FCIMPL2(void, RhGetCurrentThreadStackBounds, PTR_VOID * ppStackLow, PTR_VOID * ppStackHigh)
{
    ThreadStore::GetCurrentThread()->GetStackBounds(ppStackLow, ppStackHigh);
}
FCIMPLEND

// Function to call when a thread is detached from the runtime
ThreadExitCallback g_threadExitCallback;

FCIMPL1(void, RhSetThreadExitCallback, void * pCallback)
{
    g_threadExitCallback = (ThreadExitCallback)pCallback;
}
FCIMPLEND

FCIMPL0(int32_t, RhGetProcessCpuCount)
{
    return PalGetProcessCpuCount();
}
FCIMPLEND

FCIMPL2(uint32_t, RhGetKnobValues, char *** pResultKeys, char *** pResultValues)
{
    *pResultKeys = g_pRhConfig->GetKnobNames();
    *pResultValues = g_pRhConfig->GetKnobValues();
    return g_pRhConfig->GetKnobCount();
}
FCIMPLEND

#if defined(TARGET_X86) || defined(TARGET_AMD64)
EXTERN_C void QCALLTYPE RhCpuIdEx(int* cpuInfo, int functionId, int subFunctionId)
{
    __cpuidex(cpuInfo, functionId, subFunctionId);
}
#endif

FCIMPL3(int32_t, RhpLockCmpXchg32, int32_t * location, int32_t value, int32_t comparand)
{
    return PalInterlockedCompareExchange(location, value, comparand);
}
FCIMPLEND

FCIMPL3_ILL(int64_t, RhpLockCmpXchg64, int64_t * location, int64_t value, int64_t comparand)
{
    return PalInterlockedCompareExchange64(location, value, comparand);
}
FCIMPLEND
