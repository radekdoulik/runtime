// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.
//*****************************************************************************
// File: dacglobals.cpp
//

//
// The DAC global pointer table
//
//*****************************************************************************

#include "stdafx.h"
#include <daccess.h>

#ifdef TARGET_WASM
// On wasm the debug EE WKS subdir is not built (see CMakeLists.txt in this
// directory).
//
// The dacvars.h entries that reference debug/ee/wks-only globals
// (g_pDebugger, DebuggerController::g_patches, etc.) are tagged with
// DEFINE_DACVAR_REQUIRES_DEBUG_EE. We do NOT override that macro on
// wasm anymore — instead, src/coreclr/vm/wasm/wasm-debuggee-stubs.cpp
// provides typed null/zero stubs for those 6 symbols so the dynamic
// DacGlobals init can wire all of them. DAC reads then correctly
// report "no debugger attached" (null/zero) instead of skipping the
// slots entirely. See docs/design/coreclr/wasm-debug-phase5-decision.md
// for the Option 5b rationale.
//
// VPTR_CLASS_REQUIRES_DEBUG_EE entries (5 classes: Debugger,
// EEDbgInterfaceImpl, DebuggerController, DebuggerMethodInfoTable,
// DebuggerPatchTable) ARE still skipped here because the dynamic-init
// path's placement-new pattern (in the non-MSVC VPTR_CLASS expansion
// below) needs each class's `(int)` constructor to link, and those
// constructors live in debug/ee/wks/ which isn't built on wasm. Adding
// stub ctors would be pure overhead because no instances of these
// classes exist on wasm (the wks-side debugger EE that creates them
// isn't running), so DAC will never encounter an object whose vtable
// needs identifying against these slots. The vptr fields in DacGlobals
// stay zero, which is correct for "no instance can possibly exist."
//
// IMPORTANT: this override block is placed AFTER `#include <daccess.h>` so
// the DacGlobals struct is laid out with its full set of fields (using the
// header's default forwarding form of the REQUIRES_DEBUG_EE macros) before
// the override activates. Putting the override earlier would make the
// struct layout in this TU silently depend on whatever PCH chain happened
// to pull in daccess.h first; if that chain ever changed, this TU would
// allocate g_dacTable at a smaller-than-expected size while every other
// TU that consumes daccess.h continued to compute the full field offsets,
// producing a silent ABI mismatch.
//
// The DacGlobals struct layout is unchanged on every platform because the
// REQUIRES_DEBUG_EE tag macros default to their unrestricted counterparts
// during struct-field generation; only the assignment phase below for
// VPTR_CLASS_REQUIRES_DEBUG_EE skips the tagged entries on wasm.
//
// The undef guards against the daccess.h #ifndef block re-defining the
// macro to its default forwarding form before we install our no-op.
#undef VPTR_CLASS_REQUIRES_DEBUG_EE
#define VPTR_CLASS_REQUIRES_DEBUG_EE(name)
#include <emscripten.h>
#endif // TARGET_WASM

#include "../../vm/virtualcallstub.h"
#include "../../vm/codeman.h"
#include "../../vm/eedbginterfaceimpl.h"
#include "../../vm/common.h"
#include "../../vm/gcenv.h"
#include "../../vm/ecall.h"
#include "../../vm/cdacplatformmetadata.hpp"

#ifdef DEBUGGING_SUPPORTED

extern PCODE g_FCDynamicallyAssignedImplementations[ECall::NUM_DYNAMICALLY_ASSIGNED_FCALL_IMPLEMENTATIONS];
extern "C" void STDCALL ThePreStubPatchLabel(void);

template<typename T, template<typename> class U>
struct is_type_template_instantiation
{
    constexpr static bool m_value = false;
};
template<typename T, template<typename> class U>
struct is_type_template_instantiation<U<T>, U>
{
    constexpr static bool m_value = true;
};

#ifdef _MSC_VER
// Based on the MSVC name mangling convention, use the /ALTERNATENAME linker switch to provide C-friendly symbol names
// for each vtable we care about.
#define DEFINE_ALTERNATENAME_3(part) _Pragma(#part)
#define DEFINE_ALTERNATENAME_2(part) DEFINE_ALTERNATENAME_3(comment(linker, part))
#define DEFINE_ALTERNATENAME_1(part) DEFINE_ALTERNATENAME_2(#part)
#define DEFINE_ALTERNATENAME(alias, func) DEFINE_ALTERNATENAME_1(/ALTERNATENAME:alias=func)
#ifdef TARGET_X86
#define VPTR_CLASS(type) DEFINE_ALTERNATENAME(_vtable_ ## type, ??_7 ## type ## @@6B@) extern "C" void* vtable_ ## type;
#else
#define VPTR_CLASS(type) DEFINE_ALTERNATENAME(vtable_ ## type, ??_7 ## type ## @@6B@) extern "C" void* vtable_ ## type;
#endif
#include "vptr_list.h"
#undef VPTR_CLASS

// Re-export the static dac table as the global g_dacTable symbol.
// This allows us to not have to change how any of the "friend struct" relationships with the DAC table work
// while also still statically initializing the dac table.
#pragma comment(linker, "/EXPORT:g_dacTable=?s_dacGlobals@_DacGlobals@@0U1@B")
const DacGlobals _DacGlobals::s_dacGlobals =
{
#define DEFINE_DACVAR(size, id, var)                   PTR_TO_TADDR(&var),
#define DEFINE_DACVAR_VOLATILE(size, id, var)          PTR_TO_TADDR(&var.m_val),
#define DEFINE_DACVAR_NO_DUMP(size, id, var)           PTR_TO_TADDR(&var),
#include "dacvars.h"
#undef DEFINE_DACVAR
#undef DEFINE_DACVAR_VOLATILE
#undef DEFINE_DACVAR_NO_DUMP
#define DEFINE_DACGFN(func) PTR_TO_TADDR(&func),
#define DEFINE_DACGFN_STATIC(class, func) PTR_TO_TADDR(&class::func),
#include "gfunc_list.h"
#undef DEFINE_DACGFN
#undef DEFINE_DACGFN_STATIC
#define VPTR_CLASS(type) PTR_TO_TADDR(&vtable_ ## type),
#include "vptr_list.h"
};

// DacGlobals::Initialize is a no-op on MSVC builds as we statically initialize the table,
// however, it provides a nice mechanism for us to get back into the right scope to validate the usage of DEFINE_DACVAR and family
// without needing to make all of the DAC variables public or include all of the headers in daccess.h.
void DacGlobals::Initialize()
{
#define DEFINE_DACVAR(size, id, var) static_assert(!is_type_template_instantiation<decltype(var), Volatile>::m_value, "DAC variables defined with DEFINE_DACVAR must not be instantiations of Volatile<T>.");
#define DEFINE_DACVAR_NODUMP(size, id, var) static_assert(!is_type_template_instantiation<decltype(var), Volatile>::m_value, "DAC variables defined with DEFINE_DACVAR_NODUMP must not be instantiations of Volatile<T>.");
#define DEFINE_DACVAR_VOLATILE(size, id, var) static_assert(is_type_template_instantiation<decltype(var), Volatile>::m_value, "DAC variables defined with DEFINE_DACVAR_VOLATILE must be instantiations of Volatile<T>.");
#include "dacvars.h"
#undef DEFINE_DACVAR_VOLATILE
#undef DEFINE_DACVAR_NODUMP
#undef DEFINE_DACVAR
}
#else
// Only dynamically initialize on non-MSVC builds since we can't handle symbol aliasing
// the same way we do with MSVC to statically initialize the DAC table.
DLLEXPORT DacGlobals g_dacTable;

void DacGlobals::InitializeEntries()
{

#define DEFINE_DACVAR(size, id, var) static_assert(!is_type_template_instantiation<decltype(var), Volatile>::m_value, "DAC variables defined with DEFINE_DACVAR must not be instantiations of Volatile<T>.");
#define DEFINE_DACVAR_NODUMP(size, id, var) static_assert(!is_type_template_instantiation<decltype(var), Volatile>::m_value, "DAC variables defined with DEFINE_DACVAR_NODUMP must not be instantiations of Volatile<T>.");
#define DEFINE_DACVAR_VOLATILE(size, id, var) static_assert(is_type_template_instantiation<decltype(var), Volatile>::m_value, "DAC variables defined with DEFINE_DACVAR_VOLATILE must be instantiations of Volatile<T>.");
#include "dacvars.h"
#undef DEFINE_DACVAR_VOLATILE
#undef DEFINE_DACVAR_NODUMP
#undef DEFINE_DACVAR

#define DEFINE_DACVAR(size, id, var)                   id = PTR_TO_TADDR(&var);
#define DEFINE_DACVAR_VOLATILE(size, id, var)          id = PTR_TO_TADDR(&var.m_val);
#define DEFINE_DACVAR_NO_DUMP(size, id, var)           id = PTR_TO_TADDR(&var);
#include "dacvars.h"
#undef DEFINE_DACVAR_NODUMP
#undef DEFINE_DACVAR_VOLATILE
#undef DEFINE_DACVAR
#define DEFINE_DACGFN(func) fn__##func = PTR_TO_TADDR(&func);
#define DEFINE_DACGFN_STATIC(class, func) fn__##class##__##func = PTR_TO_TADDR(&class::func);
#include "gfunc_list.h"
#undef DEFINE_DACGFN
#undef DEFINE_DACGFN_STATIC
#define VPTR_CLASS(name) \
    { \
        void *pBuf = _alloca(sizeof(name)); \
        name *dummy = new (pBuf) name(0); \
        name##__vtAddr = PTR_TO_TADDR(*((PVOID*)dummy)); \
    }
#include <vptr_list.h>
#undef VPTR_CLASS
}

void DacGlobals::Initialize()
{
    g_dacTable.InitializeEntries();
}
#endif
#endif // DEBUGGING_SUPPORTED

#ifdef TARGET_WASM
// Wasm-only sidecar export. The sidecar reads g_dacTable through this entry
// point rather than touching the symbol directly because wasm modules cannot
// dereference each other's memory. EMSCRIPTEN_KEEPALIVE prevents wasm-ld from
// dropping the symbol during dead-code elimination.
extern "C" EMSCRIPTEN_KEEPALIVE void* Getg_dacTable()
{
    static bool s_initialized = false;
    if (!s_initialized)
    {
        DacGlobals::Initialize();
        s_initialized = true;
    }

    return &g_dacTable;
}
#endif // TARGET_WASM
