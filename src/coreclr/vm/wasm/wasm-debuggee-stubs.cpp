// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

// Wasm-only stubs for the symbols that normally live in
// src/coreclr/debug/ee/wks/ (the "workstation" debug EE library, not
// built on wasm — see src/coreclr/debug/ee/CMakeLists.txt:73-75 and the
// Option 5b rationale in docs/design/coreclr/wasm-debug-phase5-decision.md).
//
// Phase 5b expands a wasm-native debug adapter (vm/wasm/dbi-control-plane.cpp)
// rather than porting wks. As long as the wasm runtime does NOT host
// the workstation debugger EE, these globals stay null/zero — that's
// the truthful representation of "no debugger EE running" and DAC
// reading them returns null/zero rather than trapping on unresolved
// symbols.
//
// Path A-lite slice 5 wires the VM-facing g_pDebugInterface global to a
// wasm-lite DebugInterface singleton. The desktop Debugger object and
// DebuggerController patch table are still absent here: breakpoint patch state
// remains owned by vm/wasm/dbi-control-plane.cpp's WasmDebugBreakpointSlot
// table until a future slice reconciles it with DebuggerPatchTable.
//
// VPtrHostVTable identification is NOT stubbed here because the 5
// matching VPTR_CLASS entries in src/coreclr/inc/vptr_list.h are still
// tagged with VPTR_CLASS_REQUIRES_DEBUG_EE; the wasm dactable.cpp
// prelude overrides that macro to a no-op so the placement-new pattern
// (which needs Debugger::Debugger(int), etc.) is never inlined into
// InitializeEntries. The vptr slots in DacGlobals stay zero on wasm,
// which is correct because no instances of these classes exist for
// DAC to encounter.

#include "common.h"
#include "../../debug/ee/debugger.h"
#include "../../debug/ee/controller.h"
#include "dbginterface.h"

extern "C" DebugInterface* CoreClrWasmDebugGetDebuggerEEInterface();

extern "C" void CoreClrWasmDebugEnsureDebuggerEEInterface()
{
    LIMITED_METHOD_CONTRACT;
    g_pDebugInterface = CoreClrWasmDebugGetDebuggerEEInterface();
}

static struct WasmDebuggerEEInterfaceInitializer
{
    WasmDebuggerEEInterfaceInitializer()
    {
        CoreClrWasmDebugEnsureDebuggerEEInterface();
    }
} s_wasmDebuggerEEInterfaceInitializer;

GPTR_IMPL(Debugger,         g_pDebugger);
EEDebugInterface*           g_pEEInterface = NULL;
GVAL_IMPL_INIT(ULONG,       CLRJitAttachState, 0);

SPTR_IMPL_INIT(DebuggerPatchTable, DebuggerController, g_patches, NULL);
SVAL_IMPL_INIT(BOOL, DebuggerController, g_patchTableValid, FALSE);
SVAL_IMPL_INIT(BOOL, Debugger,           s_fCanChangeNgenFlags, FALSE);
