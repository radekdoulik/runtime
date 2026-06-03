set(CMAKE_INCLUDE_CURRENT_DIR ON)

set(WASM_DBI_DAC_SOURCES
  dbi_dac_wasm.cpp
)

set(WASM_DBI_DAC_LINK_LIBS
  corguids
  cordbdi
  cordbee_dac
  cee_dac
  daccess
  debug-pal
  dbgutil
  mdcompiler-dbi
  mdcompiler_dac
  mddatasource_dbi
  mdruntime-dbi
  mdruntime_dac
  mdruntimerw-dbi
  mdruntimerw_dac
  minipal
  utilcode_dac
  mscorrc
  coreclrpal
  coreclrminipal
  coreclrpal_dac
)

set(WASM_DBI_DAC_BASE_LINK_OPTIONS
  --no-entry
  -sALLOW_MEMORY_GROWTH=1
  # The debugger module imports target-memory and symbol operations from the JS host.
  -sERROR_ON_UNDEFINED_SYMBOLS=0
  -sWARN_ON_UNDEFINED_SYMBOLS=0
)

# Define a sidecar target. Both variants share the same translation units
# and link graph. Per-export visibility is tagged in `dbi_dac_wasm.cpp`
# via the macros declared in `dbi_dac_wasm_exports.h`:
#
#   WASM_DBI_DAC_EXPORT             - product-tier; exported in both variants.
#   WASM_DBI_DAC_EXPORT_TESTS_ONLY  - probe / smoke helper; exported only
#                                     when WASM_DBI_DAC_BUILD_TESTS is defined.
#
# wasm-ld honours `export_name` directly, so the linker preserves and
# exports each tagged function automatically; no parallel
# EXPORTED_FUNCTIONS list is maintained here.
function(_wasm_dbi_dac_define_target target output_name)
  add_executable_clr(${target} ${WASM_DBI_DAC_SOURCES})
  set_target_properties(${target} PROPERTIES
    OUTPUT_NAME "${output_name}"
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}"
  )
  target_compile_definitions(${target} PRIVATE
    FEATURE_NO_HOST
  )
  target_link_libraries(${target} PRIVATE ${WASM_DBI_DAC_LINK_LIBS})
  target_link_options(${target} PRIVATE ${WASM_DBI_DAC_BASE_LINK_OPTIONS})
endfunction()

# Product sidecar: ships only the real DBI/DAC ABI.
_wasm_dbi_dac_define_target(coreclr_dbi_dac_wasm "coreclr-dbi-dac")

# Test sidecar: ships the product ABI plus probe / smoke-test helpers.
_wasm_dbi_dac_define_target(coreclr_dbi_dac_wasm_tests "coreclr-dbi-dac-tests")
target_compile_definitions(coreclr_dbi_dac_wasm_tests PRIVATE WASM_DBI_DAC_BUILD_TESTS=1)

find_program(WASM_DBI_DAC_NODE node)
if(WASM_DBI_DAC_NODE)
  add_custom_target(coreclr_dbi_dac_wasm_smoke
    COMMAND "${WASM_DBI_DAC_NODE}" "${CMAKE_CURRENT_SOURCE_DIR}/smoke-test.js" "${CMAKE_BINARY_DIR}"
    DEPENDS coreclr_dbi_dac_wasm_tests corerun
    COMMENT "Running WASM DBI/DAC two-module smoke test"
    VERBATIM
  )
  add_custom_target(coreclr_dbi_dac_wasm_hello_breakpoint_smoke
    COMMAND "${WASM_DBI_DAC_NODE}" "${CMAKE_CURRENT_SOURCE_DIR}/hello-breakpoint-smoke.js" "${CMAKE_BINARY_DIR}"
    DEPENDS coreclr_dbi_dac_wasm_tests corerun
    COMMENT "Running WASM DBI/DAC HelloWorld breakpoint smoke test"
    VERBATIM
  )
  add_custom_target(coreclr_dbi_dac_wasm_hello_step_smoke
    COMMAND "${WASM_DBI_DAC_NODE}" "${CMAKE_CURRENT_SOURCE_DIR}/hello-step-smoke.js" "${CMAKE_BINARY_DIR}"
    DEPENDS coreclr_dbi_dac_wasm_tests corerun
    COMMENT "Running WASM DBI/DAC HelloWorld step-into smoke test"
    VERBATIM
  )
  add_custom_target(coreclr_dbi_dac_wasm_hello_exception_smoke
    COMMAND "${WASM_DBI_DAC_NODE}" "${CMAKE_CURRENT_SOURCE_DIR}/hello-exception-smoke.js" "${CMAKE_BINARY_DIR}"
    DEPENDS coreclr_dbi_dac_wasm_tests corerun
    COMMENT "Running WASM DBI/DAC HelloWorld exception smoke test"
    VERBATIM
  )
endif()
