// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

#include "primitives.h"

HRESULT CordbRegisterSet::GetRegistersAvailable(ULONG64* pAvailable)
{
    FAIL_IF_NEUTERED(this);
    VALIDATE_POINTER_TO_OBJECT(pAvailable, ULONG64*);

    *pAvailable = SETBITULONG64(REGISTER_INSTRUCTION_POINTER)
        | SETBITULONG64(REGISTER_STACK_POINTER)
        | SETBITULONG64(REGISTER_FRAME_POINTER);

    return S_OK;
}

HRESULT CordbRegisterSet::GetRegisters(ULONG64 mask, ULONG32 regCount, CORDB_REGISTER regBuffer[])
{
    PUBLIC_REENTRANT_API_ENTRY(this);
    FAIL_IF_NEUTERED(this);
    ATT_REQUIRE_STOPPED_MAY_FAIL(GetProcess());
    VALIDATE_POINTER_TO_OBJECT_ARRAY(regBuffer, CORDB_REGISTER, regCount, true, true);

    ULONG32 iRegister = 0;
    for (int i = REGISTER_INSTRUCTION_POINTER; i <= REGISTER_FRAME_POINTER && iRegister < regCount; i++)
    {
        if ((mask & SETBITULONG64(i)) == 0)
        {
            continue;
        }

        switch (i)
        {
        case REGISTER_INSTRUCTION_POINTER:
            regBuffer[iRegister++] = m_rd->PC;
            break;
        case REGISTER_STACK_POINTER:
            regBuffer[iRegister++] = m_rd->SP;
            break;
        case REGISTER_FRAME_POINTER:
            regBuffer[iRegister++] = m_rd->FP;
            break;
        default:
            return E_INVALIDARG;
        }
    }

    return S_OK;
}

HRESULT CordbRegisterSet::GetRegistersAvailable(ULONG32 regCount, BYTE pAvailable[])
{
    return GetRegistersAvailableAdapter(regCount, pAvailable);
}

HRESULT CordbRegisterSet::GetRegisters(ULONG32 maskCount, BYTE mask[], ULONG32 regCount, CORDB_REGISTER regBuffer[])
{
    return GetRegistersAdapter(maskCount, mask, regCount, regBuffer);
}

void CordbRegisterSet::InternalCopyRDToContext(DT_CONTEXT* pInputContext)
{
    LIMITED_METHOD_CONTRACT;

    pInputContext->InterpreterIP = static_cast<uint32_t>(m_rd->PC);
    pInputContext->InterpreterSP = static_cast<uint32_t>(m_rd->SP);
    pInputContext->InterpreterFP = static_cast<uint32_t>(m_rd->FP);
}
