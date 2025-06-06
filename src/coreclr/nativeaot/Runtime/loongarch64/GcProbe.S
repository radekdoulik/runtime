// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

#include <unixasmmacros.inc>
#include "AsmOffsets.inc"

#define PROBE_FRAME_SIZE 0x90  // 4 * 8  for fixed part of PInvokeTransitionFrame (fp, ra, m_pThread, m_Flags) +
                               // 9 * 8  for callee saved registers +
                               // 1 * 8  for caller SP +
                               // 2 * 8  for int returns +
                               // 2 * 8  for FP returns

// See PUSH_COOP_PINVOKE_FRAME, this macro is very similar, but also saves return registers
// and accepts the register bitmask
// Call this macro first in the method (no further prolog instructions can be added after this).
//
//  threadReg     : register containing the Thread* (this will be preserved).
//  trashReg      : register that can be trashed by this macro
//  BITMASK       : value to initialize m_dwFlags field with (register or #constant)
.macro PUSH_PROBE_FRAME threadReg, trashReg, BITMASK

    // Define the method prolog, allocating enough stack space for the PInvokeTransitionFrame and saving
    // incoming register values into it.

    // First create PInvokeTransitionFrame
    PROLOG_SAVE_REG_PAIR_INDEXED   22, 1, PROBE_FRAME_SIZE // Push down stack pointer and store FP and RA

    // Slot at $sp+0x10 is reserved for Thread *
    // Slot at $sp+0x18 is reserved for bitmask of saved registers

    // Save callee saved registers
    PROLOG_SAVE_REG_PAIR   23, 24, 0x20
    PROLOG_SAVE_REG_PAIR   25, 26, 0x30
    PROLOG_SAVE_REG_PAIR   27, 28, 0x40
    PROLOG_SAVE_REG_PAIR   29, 30, 0x50
    PROLOG_SAVE_REG        31,     0x60

    // Slot at $sp+0x68 is reserved for caller sp

    // Save the integer return registers
    st.d  $a0, $sp, 0x70
    st.d  $a1, $sp, 0x78

    // Save the FP return registers
    fst.d  $f0, $sp, 0x80
    fst.d  $f1, $sp, 0x88

    // Perform the rest of the PInvokeTransitionFrame initialization.
    st.d  \threadReg, $sp, OFFSETOF__PInvokeTransitionFrame__m_pThread   // Thread * (unused by stackwalker)
    st.d  \BITMASK, $sp, OFFSETOF__PInvokeTransitionFrame__m_pThread + 8 // save the register bitmask passed in by caller

    addi.d  \trashReg, $sp,  PROBE_FRAME_SIZE                            // recover value of caller's SP
    st.d  \trashReg, $sp, 0x68                                           // save caller's SP

    // link the frame into the Thread
    st.d  $sp, \threadReg, OFFSETOF__Thread__m_pDeferredTransitionFrame
.endm

//
// Remove the frame from a previous call to PUSH_PROBE_FRAME from the top of the stack and restore preserved
// registers and return value to their values from before the probe was called (while also updating any
// object refs or byrefs).
//
.macro POP_PROBE_FRAME

    // Restore the integer return registers
    ld.d  $a0, $sp, 0x70
    ld.d  $a1, $sp, 0x78

    // Restore the FP return registers
    fld.d  $f0, $sp, 0x80
    fld.d  $f1, $sp, 0x88

    // Restore callee saved registers
    EPILOG_RESTORE_REG_PAIR 23, 24, 0x20
    EPILOG_RESTORE_REG_PAIR 25, 26, 0x30
    EPILOG_RESTORE_REG_PAIR 27, 28, 0x40
    EPILOG_RESTORE_REG_PAIR 29, 30, 0x50
    EPILOG_RESTORE_REG      31,     0x60

    EPILOG_RESTORE_REG_PAIR_INDEXED  22, 1, PROBE_FRAME_SIZE
.endm

//
// The prolog for all GC suspension hijacks (normal and stress). Fixes up the hijacked return address, and
// clears the hijack state.
//
// Register state on entry:
//  All registers correct for return to the original return address.
//
// Register state on exit:
//  a2: thread pointer
//
.macro FixupHijackedCallstack

    // a2 <- GetThread()
    INLINE_GETTHREAD  $a2

    //
    // Fix the stack by restoring the original return address
    //
    // Load m_pvHijackedReturnAddress
    ld.d  $ra, $a2, OFFSETOF__Thread__m_pvHijackedReturnAddress

    //
    // Clear hijack state
    //
    // Clear m_ppvHijackedReturnAddressLocation and m_pvHijackedReturnAddress
    st.d  $zero, $a2, OFFSETOF__Thread__m_ppvHijackedReturnAddressLocation
    st.d  $zero, $a2, OFFSETOF__Thread__m_ppvHijackedReturnAddressLocation + 8
.endm

//
// GC Probe Hijack target
//
NESTED_ENTRY RhpGcProbeHijack, _TEXT, NoHandler
    FixupHijackedCallstack

    PREPARE_EXTERNAL_VAR_INDIRECT_W RhpTrapThreads, $a3
    bstrpick.d  $t8, $a3, TrapThreadsFlags_TrapThreads_Bit, TrapThreadsFlags_TrapThreads_Bit
    bnez  $t8, LOCAL_LABEL(WaitForGC)
    jirl  $r0, $ra, 0

LOCAL_LABEL(WaitForGC):
    li.d  $t3, (DEFAULT_FRAME_SAVE_FLAGS + PTFF_SAVE_R4 + PTFF_SAVE_R5 + (PTFF_THREAD_HIJACK_HI << 32))
    b  C_FUNC(RhpWaitForGC)
NESTED_END RhpGcProbeHijack

.global C_FUNC(RhpThrowHwEx)

NESTED_ENTRY RhpWaitForGC, _TEXT, NoHandler
    PUSH_PROBE_FRAME $a2, $a3, $t3

    ld.d        $a0, $a2, OFFSETOF__Thread__m_pDeferredTransitionFrame
    bl  C_FUNC(RhpWaitForGC2)

    ld.d  $a2,$sp, OFFSETOF__PInvokeTransitionFrame__m_Flags
    bstrpick.d  $t8, $a2, PTFF_THREAD_ABORT_BIT, PTFF_THREAD_ABORT_BIT
    bnez  $t8, LOCAL_LABEL(ThrowThreadAbort)

    .cfi_remember_state
    POP_PROBE_FRAME
    EPILOG_RETURN

    .cfi_restore_state
LOCAL_LABEL(ThrowThreadAbort):
    POP_PROBE_FRAME
    addi.w  $a0, $zero, STATUS_NATIVEAOT_THREAD_ABORT
    ori  $a1, $ra, 0 // return address as exception PC
    b  RhpThrowHwEx
NESTED_END RhpWaitForGC

.global C_FUNC(RhpGcPoll2)

LEAF_ENTRY RhpGcPoll
    PREPARE_EXTERNAL_VAR_INDIRECT_W RhpTrapThreads, $a0
    bnez  $a0, C_FUNC(RhpGcPollRare)
    jirl  $r0, $ra, 0
LEAF_END RhpGcPoll

NESTED_ENTRY RhpGcPollRare, _TEXT, NoHandler
    PUSH_COOP_PINVOKE_FRAME  $a0
    bl  RhpGcPoll2
    POP_COOP_PINVOKE_FRAME
    jirl  $r0, $ra, 0
NESTED_END RhpGcPollRare


#ifdef FEATURE_GC_STRESS

//
// GC Stress Hijack targets
//
LEAF_ENTRY RhpGcStressHijack, _TEXT
    // NYI
    EMIT_BREAKPOINT
LEAF_END RhpGcStressHijack, _TEXT

#endif  // FEATURE_GC_STRESS
