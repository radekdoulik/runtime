project(corewasmrun)

set(CMAKE_INCLUDE_CURRENT_DIR ON)

if (DEFINED CLR_CMAKE_ICU_DIR)
  link_directories(${CLR_CMAKE_ICU_DIR}/lib)
endif(DEFINED CLR_CMAKE_ICU_DIR)

add_executable_clr(corewasmrun
  corewasmrun.cpp
)

target_link_options(corewasmrun PRIVATE "-Wl,-error-limit=0")

target_link_libraries(corewasmrun PRIVATE coreclr)
target_link_libraries(corewasmrun PRIVATE clrinterpreter)

target_link_libraries(corewasmrun PRIVATE icuuc)
target_link_libraries(corewasmrun PRIVATE icui18n)
target_link_libraries(corewasmrun PRIVATE icudata)

add_compile_options(-fwasm-exceptions)
add_link_options(-fwasm-exceptions -sEXIT_RUNTIME=1 -sUSE_OFFSET_CONVERTER=1)

install_clr(TARGETS corewasmrun DESTINATIONS . COMPONENT hosts)
