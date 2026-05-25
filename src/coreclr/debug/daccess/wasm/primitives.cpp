// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

#include "stdafx.h"

void CORDbgCopyThreadContext(DT_CONTEXT* pDst, const DT_CONTEXT* pSrc)
{
    LIMITED_METHOD_DAC_CONTRACT;
}

void CORDbgSetDebuggerREGDISPLAYFromContext(DebuggerREGDISPLAY* pDRD, DT_CONTEXT* pContext)
{
    LIMITED_METHOD_DAC_CONTRACT;

    pDRD->PC = 0;
    pDRD->FP = 0;
    pDRD->SP = 0;
    pDRD->pFP = nullptr;
}

#if defined(ALLOW_VMPTR_ACCESS) || !defined(RIGHT_SIDE_COMPILE)
void SetDebuggerREGDISPLAYFromREGDISPLAY(DebuggerREGDISPLAY* pDRD, REGDISPLAY* pRD)
{
    SUPPORTS_DAC_HOST_ONLY;

    pDRD->PC = pRD->ControlPC;
    pDRD->FP = 0;
    pDRD->SP = pRD->SP;
    pDRD->pFP = nullptr;
}
#endif // ALLOW_VMPTR_ACCESS || !RIGHT_SIDE_COMPILE
