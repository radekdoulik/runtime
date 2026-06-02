// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.
//*****************************************************************************
// File: wasm_lite_marker.cpp
//
// Marker source for the wasm-only debug-EE wks-lite library
// (cordbee_wks_wasm_lite). Subsequent Path A-lite slices add real
// source files alongside this one; the marker stays so CMake always
// has at least one translation unit and the FEATURE_WASM_DEBUG_EE_LITE
// compile-time tag has a single canonical home.
//
// See docs/design/coreclr/wasm-debug-phase5-decision.md for the
// architectural background that motivates a slimmed-down wks library
// on wasm instead of the full desktop debug-EE port.
//*****************************************************************************

#include "stdafx.h"

#ifndef FEATURE_WASM_DEBUG_EE_LITE
#error "wks_wasm_lite must be built with FEATURE_WASM_DEBUG_EE_LITE"
#endif

extern "C" int CoreClrWasmDebugEeLiteMarker()
{
    // Returning a fixed nonzero value makes it possible to verify (via
    // a future smoke probe) that the wasm-lite library was actually
    // linked into the final coreclr_static, separate from whether any
    // particular debug-EE feature works yet.
    return 1;
}
