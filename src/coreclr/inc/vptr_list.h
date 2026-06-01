// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

// Any class with a vtable that needs to be instantiated
// during debugging data access must be listed here.
//
// Use VPTR_CLASS_REQUIRES_DEBUG_EE for classes whose vtables live in
// src/coreclr/debug/ee/wks/ (i.e. provided by the runtime-side debugger EE:
// Debugger, DebuggerController, ...). Those translation units are not built
// for TARGET_WASM today (see src/coreclr/debug/ee/CMakeLists.txt
// `if (NOT CLR_CMAKE_TARGET_ARCH_WASM)`). Targets that DO link the debugger
// EE see this expand to a regular VPTR_CLASS; wasm overrides this macro
// before #include "vptr_list.h" to skip the assignment so the dynamic
// DacGlobals InitializeEntries path does not need to placement-new an
// instance of an unlinked class. The DacGlobals struct layout is unchanged
// on every platform because the vptr field is still declared via the
// VPTR_CLASS forwarding.

#ifndef VPTR_CLASS_REQUIRES_DEBUG_EE
#define VPTR_CLASS_REQUIRES_DEBUG_EE(name) VPTR_CLASS(name)
#endif

VPTR_CLASS(EEJitManager)

#ifdef FEATURE_READYTORUN
VPTR_CLASS(ReadyToRunJitManager)
#endif
#ifdef FEATURE_INTERPRETER
VPTR_CLASS(InterpreterJitManager)
VPTR_CLASS(InterpreterCodeManager)
#endif
VPTR_CLASS(EECodeManager)

VPTR_CLASS(RangeList)
VPTR_CLASS(LockedRangeList)
VPTR_CLASS(CodeRangeMapRangeList)

#ifdef FEATURE_METADATA_UPDATER
VPTR_CLASS(EditAndContinueModule)
#endif
VPTR_CLASS(Module)
VPTR_CLASS(ReflectionModule)

#ifndef FEATURE_PORTABLE_ENTRYPOINTS
VPTR_CLASS(PrecodeStubManager)
#endif // !FEATURE_PORTABLE_ENTRYPOINTS
VPTR_CLASS(StubLinkStubManager)
VPTR_CLASS(ThePreStubManager)
VPTR_CLASS(VirtualCallStubManager)
VPTR_CLASS(VirtualCallStubManagerManager)
VPTR_CLASS(RangeSectionStubManager)
VPTR_CLASS(ILStubManager)
VPTR_CLASS(PInvokeStubManager)
VPTR_CLASS(InteropDispatchStubManager)
#if defined(TARGET_X86) && !defined(UNIX_X86_ABI)
VPTR_CLASS(TailCallStubManager)
#endif
VPTR_CLASS(AsyncThunkStubManager)

VPTR_CLASS(PEImageLayout)
VPTR_CLASS(ConvertedImageLayout)
VPTR_CLASS(LoadedImageLayout)
VPTR_CLASS(NativeImageLayout)
VPTR_CLASS(FlatImageLayout)

#ifdef DEBUGGING_SUPPORTED
VPTR_CLASS_REQUIRES_DEBUG_EE(Debugger)
VPTR_CLASS_REQUIRES_DEBUG_EE(EEDbgInterfaceImpl)
#endif // DEBUGGING_SUPPORTED

VPTR_CLASS_REQUIRES_DEBUG_EE(DebuggerController)
VPTR_CLASS_REQUIRES_DEBUG_EE(DebuggerMethodInfoTable)
VPTR_CLASS_REQUIRES_DEBUG_EE(DebuggerPatchTable)

VPTR_CLASS(LoaderCodeHeap)
VPTR_CLASS(HostCodeHeap)

VPTR_CLASS(GlobalLoaderAllocator)
VPTR_CLASS(AssemblyLoaderAllocator)

// Note: VPTR_CLASS_REQUIRES_DEBUG_EE intentionally not undefined here.
// Callers define this macro once at the top of the TU to override
// REQUIRES_DEBUG_EE entries. vptr_list.h is included multiple times in
// dactable.cpp (e.g. once to forward-declare vtables on MSVC, once to
// emit the initializer values; or once to placement-new on non-MSVC).
// Undefining here would break the override on the subsequent include
// because the `#ifndef VPTR_CLASS_REQUIRES_DEBUG_EE` guard at the top
// would then re-define it as a forward to the unconditional VPTR_CLASS.
