// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

#ifndef DBI_DAC_WASM_EXPORTS_H
#define DBI_DAC_WASM_EXPORTS_H

//
// Source-of-truth export tagging for the WASM DBI/DAC sidecar.
//
// Both sidecar variants compile from the same translation units and
// differ only in which exports are visible to JavaScript:
//
//   coreclr-dbi-dac.wasm        product variant; ships the real DBI/DAC
//                               ABI that an IDE / browser host would call.
//   coreclr-dbi-dac-tests.wasm  test variant; product ABI plus probe and
//                               smoke-test helpers (`WASM_DBI_DAC_BUILD_TESTS`
//                               defined).
//
// Tagging an exported function with one of the macros below is the only
// place the export name appears - the CMake side does not maintain a
// parallel `EXPORTED_FUNCTIONS` list. `wasm-ld` honours the `export_name`
// attribute directly, so each tagged function is preserved from
// dead-stripping and exposed to JavaScript under the requested name.
//
//   WASM_DBI_DAC_EXPORT(name)
//     A product-tier export. Visible to JS in both variants.
//
//   WASM_DBI_DAC_EXPORT_TESTS_ONLY(name)
//     A probe / test-only entry point. Visible to JS only in the tests
//     variant. In the product variant the function is still compiled,
//     but wasm-ld dead-strips it unless something else references it.
//

#if defined(__wasm__)
#define _WASM_DBI_DAC_EXPORTED(name) \
    __attribute__((used, export_name(#name)))
#else
#define _WASM_DBI_DAC_EXPORTED(name)
#endif

#define WASM_DBI_DAC_EXPORT(name) \
    extern "C" _WASM_DBI_DAC_EXPORTED(name)

#if defined(WASM_DBI_DAC_BUILD_TESTS)
#define WASM_DBI_DAC_EXPORT_TESTS_ONLY(name) \
    extern "C" _WASM_DBI_DAC_EXPORTED(name)
#else
#define WASM_DBI_DAC_EXPORT_TESTS_ONLY(name) \
    extern "C"
#endif

#endif // DBI_DAC_WASM_EXPORTS_H
