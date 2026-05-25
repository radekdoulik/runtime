set(CMAKE_INCLUDE_CURRENT_DIR ON)

add_executable_clr(coreclr_dbi_dac_wasm
  EXCLUDE_FROM_ALL
  dbi_dac_wasm.cpp
)

set_target_properties(coreclr_dbi_dac_wasm PROPERTIES
  OUTPUT_NAME "coreclr-dbi-dac"
  RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}"
)

target_compile_definitions(coreclr_dbi_dac_wasm PRIVATE
  FEATURE_NO_HOST
)

target_link_libraries(coreclr_dbi_dac_wasm PRIVATE
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

set(WASM_DBI_DAC_EXPORTED_FUNCTIONS
  _coreclr_wasm_dbi_dac_copy_from_target
  _coreclr_wasm_dbi_dac_create_clr_data_instance
  _coreclr_wasm_dbi_dac_create_cordb_object
  _coreclr_wasm_dbi_dac_create_dac_dbi_interface
  _coreclr_wasm_dbi_dac_dbi_connect_runtime
  _coreclr_wasm_dbi_dac_dbi_continue
  _coreclr_wasm_dbi_dac_dbi_disconnect_runtime
  _coreclr_wasm_dbi_dac_dbi_poll_event
  _coreclr_wasm_dbi_dac_dbi_poll_event_record
  _coreclr_wasm_dbi_dac_dbi_poll_frame_record
  _coreclr_wasm_dbi_dac_dbi_poll_process_state
  _coreclr_wasm_dbi_dac_dbi_read_test_data
  _coreclr_wasm_dbi_dac_dbi_session_create
  _coreclr_wasm_dbi_dac_dbi_session_create_process
  _coreclr_wasm_dbi_dac_dbi_session_destroy
  _coreclr_wasm_dbi_dac_dbi_set_breakpoint_by_name
  _coreclr_wasm_dbi_dac_dbi_set_breakpoint_by_token
  _coreclr_wasm_dbi_dac_get_abi_version
  _coreclr_wasm_dbi_dac_get_component_mask
  _coreclr_wasm_dbi_dac_probe_breakpoint_control
  _coreclr_wasm_dbi_dac_probe_contract_pointer_data
  _coreclr_wasm_dbi_dac_probe_runtime_contract_descriptor
  _coreclr_wasm_dbi_dac_probe_test_data
  _coreclr_wasm_dbi_dac_receive_runtime_event
  _coreclr_wasm_dbi_dac_receive_runtime_event_record
  _coreclr_wasm_dbi_dac_receive_runtime_frame_record
  _coreclr_wasm_dbi_dac_transport_get_last_event
  _coreclr_wasm_dbi_dac_transport_send_test_message
  _coreclr_wasm_dbi_dac_try_get_symbol
)
list(JOIN WASM_DBI_DAC_EXPORTED_FUNCTIONS "," WASM_DBI_DAC_EXPORTED_FUNCTIONS_ARG)

target_link_options(coreclr_dbi_dac_wasm PRIVATE
  --no-entry
  -sALLOW_MEMORY_GROWTH=1
  # The debugger module imports target-memory and symbol operations from the JS host.
  -sERROR_ON_UNDEFINED_SYMBOLS=0
  -sWARN_ON_UNDEFINED_SYMBOLS=0
  "-sEXPORTED_FUNCTIONS=${WASM_DBI_DAC_EXPORTED_FUNCTIONS_ARG}"
)

find_program(WASM_DBI_DAC_NODE node)
if(WASM_DBI_DAC_NODE)
  add_custom_target(coreclr_dbi_dac_wasm_smoke
    COMMAND "${WASM_DBI_DAC_NODE}" "${CMAKE_CURRENT_SOURCE_DIR}/smoke-test.js" "${CMAKE_BINARY_DIR}"
    DEPENDS coreclr_dbi_dac_wasm corerun
    COMMENT "Running WASM DBI/DAC two-module smoke test"
    VERBATIM
  )
  add_custom_target(coreclr_dbi_dac_wasm_hello_breakpoint_smoke
    COMMAND "${WASM_DBI_DAC_NODE}" "${CMAKE_CURRENT_SOURCE_DIR}/hello-breakpoint-smoke.js" "${CMAKE_BINARY_DIR}"
    DEPENDS coreclr_dbi_dac_wasm corerun
    COMMENT "Running WASM DBI/DAC HelloWorld breakpoint smoke test"
    VERBATIM
  )
endif()
