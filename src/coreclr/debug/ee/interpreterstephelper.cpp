// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

// ****************************************************************************
// File: interpreterstephelper.cpp
//
// Path A-lite slice 4 uses Approach B: extract InterpreterStepHelper from
// controller.cpp into a shared wks source so desktop and wasm-lite build the
// same implementation without duplicating interpreter stepping logic.
// ****************************************************************************

#include "stdafx.h"

#if !defined(DACCESS_COMPILE)

#ifdef FEATURE_INTERPRETER
//* -------------------------------------------------------------------------
// * InterpreterStepHelper routines
// * -------------------------------------------------------------------------
// Implements stepping through interpreter code using control flow prediction
// and breakpoint patches.

InterpreterStepHelper::InterpreterStepHelper(
    DebuggerStepper* pStepper,
    ControllerStackInfo* pInfo,
    DebuggerJitInfo* pJitInfo)
    : m_pStepper(pStepper),
      m_pInfo(pInfo),
      m_pJitInfo(pJitInfo),
      m_currentPC(0),
      m_pInterpMethod(NULL),
      m_walkType(WALK_UNKNOWN)
{
    CONTRACTL
    {
        NOTHROW;
        GC_NOTRIGGER;
    }
    CONTRACTL_END;

    m_currentPC = GetControlPC(&pInfo->m_activeFrame.registers);

    // Get InterpMethod for data items lookup (needed for resolving call targets)
    MethodDesc* pMD = pInfo->m_activeFrame.md;
    if (pMD != NULL)
    {
        PTR_InterpByteCodeStart pByteCodeStart = pMD->GetInterpreterCode();
        if (pByteCodeStart != NULL)
        {
            m_pInterpMethod = pByteCodeStart->Method;
        }
    }
}

void InterpreterStepHelper::AddInterpreterPatch(const int32_t* pIP)
{
    CONTRACTL
    {
        NOTHROW;
        GC_NOTRIGGER;
    }
    CONTRACTL_END;

    _ASSERTE(m_pJitInfo != NULL);
    _ASSERTE(pIP != NULL);
    _ASSERTE((BYTE*)pIP >= (BYTE*)m_pJitInfo->m_addrOfCode);

    SIZE_T offset = (SIZE_T)((BYTE*)pIP - (BYTE*)m_pJitInfo->m_addrOfCode);
    _ASSERTE(offset < m_pJitInfo->m_sizeOfCode);

    m_pStepper->AddBindAndActivateNativeManagedPatch(
        m_pInfo->m_activeFrame.md,
        m_pJitInfo,
        offset,
        m_pInfo->m_activeFrame.fp,
        NULL);

    LOG((LF_CORDB, LL_INFO10000, "ISH::AIP: Added interpreter patch at %p (offset 0x%zx)\n", pIP, offset));
}

InterpreterStepHelper::StepSetupResult InterpreterStepHelper::SetupStep(
    bool stepIn)
{
    CONTRACTL
    {
        NOTHROW;
        GC_NOTRIGGER;
    }
    CONTRACTL_END;

    if (m_pJitInfo == NULL)
    {
        LOG((LF_CORDB, LL_INFO10000, "ISH::SS: No JitInfo, cannot set up step\n"));
        return SSR_Failed;
    }

    // Initialize the InterpreterWalker at the current IP
    InterpreterWalker interpWalker;
    interpWalker.Init((const int32_t*)m_currentPC, m_pInterpMethod);

    m_walkType = interpWalker.GetOpcodeWalkType();
    LOG((LF_CORDB, LL_INFO10000, "ISH::SS: Decoded opcode=0x%x, walkType=%d, stepIn=%d\n",
         interpWalker.GetOpcode(), m_walkType, stepIn));

    switch (m_walkType)
    {
        case WALK_RETURN:
        {
            LOG((LF_CORDB, LL_INFO10000, "ISH::SS: WALK_RETURN - caller should handle TrapStepOut\n"));
            return SSR_NeedStepOut;
        }

        case WALK_THROW:
        {
            LOG((LF_CORDB, LL_INFO10000, "ISH::SS: WALK_THROW - caller should handle exception\n"));
            return SSR_NeedStepOut;
        }

        case WALK_CALL:
        {
            LOG((LF_CORDB, LL_INFO10000, "ISH::SS: WALK_CALL\n"));

            const int32_t* skipIP = interpWalker.GetSkipIP();

            if (stepIn)
            {
                // For all call types (direct and indirect), use the JMC backstop.
                // The interpreter's INTOP_DEBUG_METHOD_ENTER fires for all interpreted
                // methods (not just JMC), so the backstop reliably catches entry into
                // any interpreted target. We also place a step-over patch as fallback
                // in case the call target doesn't trigger MethodEnter.
                LOG((LF_CORDB, LL_INFO10000, "ISH::SS: Step-in call, using MethodEnter backstop\n"));
                if (skipIP != NULL)
                {
                    AddInterpreterPatch(skipIP);
                }
                else
                {
                    LOG((LF_CORDB, LL_INFO10000, "ISH::SS: Call with no skip IP!\n"));
                    return SSR_Failed;
                }
                return SSR_NeedStepIn; // Caller enables JMC backstop
            }
            else
            {
                // Step-over: patch at instruction after the call
                if (skipIP != NULL)
                {
                    AddInterpreterPatch(skipIP);
                    LOG((LF_CORDB, LL_INFO10000, "ISH::SS: Step-over, patched at %p\n", skipIP));
                    return SSR_Success;
                }
                else
                {
                    LOG((LF_CORDB, LL_INFO10000, "ISH::SS: No skip IP for call instruction during step-over!\n"));
                    return SSR_Failed;
                }
            }
            break;
        }

        case WALK_BRANCH:
        {
            LOG((LF_CORDB, LL_INFO10000, "ISH::SS: WALK_BRANCH\n"));

            const int32_t* nextIP = interpWalker.GetNextIP();
            if (nextIP != NULL)
            {
                AddInterpreterPatch(nextIP);
                return SSR_Success;
            }
            else
            {
                LOG((LF_CORDB, LL_INFO10000, "ISH::SS: No next IP for branch instruction!\n"));
                return SSR_Failed;
            }
            break;
        }

        case WALK_COND_BRANCH:
        {
            LOG((LF_CORDB, LL_INFO10000, "ISH::SS: WALK_COND_BRANCH\n"));

            // Check if this is a switch instruction
            if (interpWalker.GetOpcode() == INTOP_SWITCH)
            {
                int32_t caseCount = interpWalker.GetSwitchCaseCount();
                LOG((LF_CORDB, LL_INFO10000, "ISH::SS: INTOP_SWITCH with %d cases\n", caseCount));

                for (int32_t i = 0; i <= caseCount; i++)
                {
                    const int32_t* target = interpWalker.GetSwitchTarget(i);
                    if (target != NULL)
                    {
                        AddInterpreterPatch(target);
                    }
                    else
                    {
                        LOG((LF_CORDB, LL_INFO10000, "ISH::SS: No target IP for switch case %d!\n", i));
                        return SSR_Failed;
                    }
                }
                return SSR_Success;
            }
            else
            {
                // Conditional branch - patch both target and fallthrough
                const int32_t* nextIP = interpWalker.GetNextIP();
                const int32_t* skipIP = interpWalker.GetSkipIP();

                if (nextIP != NULL)
                {
                    AddInterpreterPatch(nextIP);
                }
                else
                {
                    LOG((LF_CORDB, LL_INFO10000, "ISH::SS: No next IP for conditional branch!\n"));
                    return SSR_Failed;
                }

                if (skipIP != NULL && skipIP != nextIP)
                {
                    AddInterpreterPatch(skipIP);
                }
                else if (skipIP == nextIP)
                {
                    LOG((LF_CORDB, LL_INFO10000, "ISH::SS: skipIP == nextIP, only one patch needed\n"));
                }
                else
                {
                    LOG((LF_CORDB, LL_INFO10000, "ISH::SS: No skip IP for conditional branch!\n"));
                    return SSR_Failed;
                }

                return SSR_Success;
            }
        }

        case WALK_BREAK:
        case WALK_NEXT:
        default:
        {
            LOG((LF_CORDB, LL_INFO10000, "ISH::SS: WALK_NEXT/default\n"));

            const int32_t* skipIP = interpWalker.GetSkipIP();
            if (skipIP != NULL)
            {
                AddInterpreterPatch(skipIP);
                return SSR_Success;
            }
            else
            {
                LOG((LF_CORDB, LL_INFO10000, "ISH::SS: No skip IP for next instruction!\n"));
                return SSR_Failed;
            }
            break;
        }
    }

    LOG((LF_CORDB, LL_INFO10000, "ISH::SS: Failed to set up step\n"));
    return SSR_Failed;
}
#ifdef FEATURE_WASM_DEBUG_EE_LITE
// The exported wrapper in dbi-control-plane.cpp calls this function so this
// translation unit is pulled into the live wasm runtime link graph without
// constructing or invoking InterpreterStepHelper.
extern "C" uint32_t CoreClrWasmDebugCallInterpreterStepHelperProbeImpl()
{
    static InterpreterStepHelper* s_stepHelper;
    return static_cast<uint32_t>(sizeof(s_stepHelper));
}
#endif // FEATURE_WASM_DEBUG_EE_LITE

#endif // FEATURE_INTERPRETER

#endif // !DACCESS_COMPILE
