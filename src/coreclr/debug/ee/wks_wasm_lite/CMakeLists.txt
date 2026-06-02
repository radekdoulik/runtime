# Path A-lite: a wasm-only sibling of debug/ee/wks. Reuses pieces of the
# desktop debug-EE wks library (controller.cpp, executioncontrol.cpp,
# interpreterwalker.cpp + supporting types) but excludes the parts that
# can't compile on single-threaded browser-wasm — DebuggerRCThread (its
# named-pipe / cross-process event loop has no wasm equivalent),
# DebuggerFunctionInfoEval (function evaluation; defer to a later phase),
# canary.cpp (signal-based fatal-error reporting), and frameinfo.cpp
# (JIT-specific stack walking; the interpreter has its own frame chain).
#
# This file is gated by an outer
#     if (CLR_CMAKE_TARGET_ARCH_WASM)
#         add_subdirectory(wks_wasm_lite)
#     endif()
# in ../CMakeLists.txt. The desktop wks/ subdirectory is mutually
# exclusive — only one library is ever linked into coreclr_static per
# build configuration.
#
# Slice 1: this library compiles a single marker source file so the
# CMake plumbing is in place. Subsequent slices append real files to
# CORDBEE_SOURCES_WKS_WASM_LITE as each is brought online with the
# necessary stubs.

set(CORDBEE_SOURCES_WKS_WASM_LITE
    wasm_lite_marker.cpp
)

# Path A-lite slice 2: bring the zero-coupled IL walker online. The
# desktop debug-EE shares interpreterwalker.cpp (~200 LOC, 0 Thread /
# 0 AppDomain / 0 GCX_COOP refs) verbatim; we reuse the same file.
# Its only link-time dependencies are DebuggerController::GetPatchTable
# and ControllerLockHolder, which are satisfied by the cordbee_wks_wasm_lite
# stubs added in subsequent slices (today: provided by
# wasm-debuggee-stubs.cpp's null g_patches global; the walker falls
# through to ResolveOpcode's "no patch table" branch and returns the
# raw opcode).
if(FEATURE_INTERPRETER)
    list(APPEND CORDBEE_SOURCES_WKS_WASM_LITE
        ${CMAKE_CURRENT_SOURCE_DIR}/../interpreterwalker.cpp
    )
endif()

add_library_clr(cordbee_wks_wasm_lite
    OBJECT
    ${CORDBEE_SOURCES_WKS_WASM_LITE}
)

target_compile_definitions(cordbee_wks_wasm_lite PRIVATE FEATURE_WASM_DEBUG_EE_LITE)
target_precompile_headers(cordbee_wks_wasm_lite PRIVATE [["stdafx.h"]])
add_dependencies(cordbee_wks_wasm_lite eventing_headers)
