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

# Product exports: the real DBI/DAC ABI that an IDE / browser host would
# call. This is what would be shipped in a productized sidecar build.
set(WASM_DBI_DAC_EXPORTED_FUNCTIONS_PRODUCT
  _coreclr_wasm_dbi_dac_dbi_connect_runtime
  _coreclr_wasm_dbi_dac_dbi_continue
  _coreclr_wasm_dbi_dac_dbi_disconnect_runtime
  _coreclr_wasm_dbi_dac_dbi_poll_event
  _coreclr_wasm_dbi_dac_dbi_poll_event_record
  _coreclr_wasm_dbi_dac_dbi_poll_frame_record
  _coreclr_wasm_dbi_dac_dbi_poll_process_state
  _coreclr_wasm_dbi_dac_dbi_session_create
  _coreclr_wasm_dbi_dac_dbi_session_create_process
  _coreclr_wasm_dbi_dac_dbi_session_destroy
  _coreclr_wasm_dbi_dac_dbi_set_breakpoint_by_name
  _coreclr_wasm_dbi_dac_dbi_set_breakpoint_by_token
  _coreclr_wasm_dbi_dac_get_abi_version
  _coreclr_wasm_dbi_dac_get_component_mask
  _coreclr_wasm_dbi_dac_receive_runtime_event
  _coreclr_wasm_dbi_dac_receive_runtime_event_record
  _coreclr_wasm_dbi_dac_receive_runtime_frame_record
)

# Test-only exports: probes, smoke helpers, and pre-facade transport
# helpers that are useful for the in-tree smoke harness but are not part
# of the product ABI. Kept out of the product build so the shipping
# binary does not advertise them.
set(WASM_DBI_DAC_EXPORTED_FUNCTIONS_TESTS_ONLY
  _coreclr_wasm_dbi_dac_copy_from_target
  _coreclr_wasm_dbi_dac_create_clr_data_instance
  _coreclr_wasm_dbi_dac_create_cordb_object
  _coreclr_wasm_dbi_dac_create_dac_dbi_interface
  _coreclr_wasm_dbi_dac_dbi_read_test_data
  _coreclr_wasm_dbi_dac_probe_breakpoint_control
  _coreclr_wasm_dbi_dac_probe_contract_pointer_data
  _coreclr_wasm_dbi_dac_probe_runtime_contract_descriptor
  _coreclr_wasm_dbi_dac_probe_test_data
  _coreclr_wasm_dbi_dac_transport_get_last_event
  _coreclr_wasm_dbi_dac_transport_send_test_message
  _coreclr_wasm_dbi_dac_try_get_symbol
)

set(WASM_DBI_DAC_EXPORTED_FUNCTIONS_TESTS
  ${WASM_DBI_DAC_EXPORTED_FUNCTIONS_PRODUCT}
  ${WASM_DBI_DAC_EXPORTED_FUNCTIONS_TESTS_ONLY}
)

list(JOIN WASM_DBI_DAC_EXPORTED_FUNCTIONS_PRODUCT "," WASM_DBI_DAC_EXPORTED_FUNCTIONS_PRODUCT_ARG)
list(JOIN WASM_DBI_DAC_EXPORTED_FUNCTIONS_TESTS "," WASM_DBI_DAC_EXPORTED_FUNCTIONS_TESTS_ARG)

# Define a sidecar target. Both variants share the same translation units
# and link graph; they differ only in which symbols are exported to JS.
function(_wasm_dbi_dac_define_target target output_name exported_arg)
  add_executable_clr(${target} ${WASM_DBI_DAC_SOURCES})
  set_target_properties(${target} PROPERTIES
    OUTPUT_NAME "${output_name}"
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}"
  )
  target_compile_definitions(${target} PRIVATE
    FEATURE_NO_HOST
  )
  target_link_libraries(${target} PRIVATE ${WASM_DBI_DAC_LINK_LIBS})
  target_link_options(${target} PRIVATE
    ${WASM_DBI_DAC_BASE_LINK_OPTIONS}
    "-sEXPORTED_FUNCTIONS=${exported_arg}"
  )
endfunction()

# Product sidecar: ships only the real DBI/DAC ABI.
_wasm_dbi_dac_define_target(coreclr_dbi_dac_wasm
  "coreclr-dbi-dac"
  "${WASM_DBI_DAC_EXPORTED_FUNCTIONS_PRODUCT_ARG}"
)

# Test sidecar: ships the product ABI plus probe / smoke-test helpers.
_wasm_dbi_dac_define_target(coreclr_dbi_dac_wasm_tests
  "coreclr-dbi-dac-tests"
  "${WASM_DBI_DAC_EXPORTED_FUNCTIONS_TESTS_ARG}"
)

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
endif()
