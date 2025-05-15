project(corewasmrun)

set(CMAKE_INCLUDE_CURRENT_DIR ON)

if (DEFINED CLR_CMAKE_ICU_DIR)
  link_directories(${CLR_CMAKE_ICU_DIR}/lib)
endif(DEFINED CLR_CMAKE_ICU_DIR)

add_executable_clr(corewasmrun
  corewasmrun.cpp
)

target_compile_options(corewasmrun PRIVATE -fwasm-exceptions)
target_link_options(corewasmrun PRIVATE -fwasm-exceptions -sEXIT_RUNTIME=1 -sUSE_OFFSET_CONVERTER=1 -sINITIAL_MEMORY=134217728 -sFORCE_FILESYSTEM=1 --preload-file ${CMAKE_CURRENT_BINARY_DIR}/../../../../../bin/coreclr/browser.wasm.Debug/IL@/ -Wl,-error-limit=0)

target_link_libraries(corewasmrun PRIVATE coreclr)
target_link_libraries(corewasmrun PRIVATE clrinterpreter)

target_link_libraries(corewasmrun PRIVATE icuuc)
target_link_libraries(corewasmrun PRIVATE icui18n)
target_link_libraries(corewasmrun PRIVATE icudata)

message(STATUS "CMAKE_CURRENT_BINARY_DIR: ${CMAKE_CURRENT_BINARY_DIR}/../../../../../bin/coreclr/System.Private.CoreLib/browser.wasm.Debug/IL@/")

install_clr(TARGETS corewasmrun DESTINATIONS . COMPONENT hosts)
