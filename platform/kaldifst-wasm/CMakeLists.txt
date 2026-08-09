cmake_minimum_required(VERSION 3.20)
project(matcha_kaldifst_normalizer_wasm CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_EXTENSIONS OFF)
set(KALDIFST_BUILD_PYTHON OFF CACHE BOOL "" FORCE)
set(KALDIFST_BUILD_TESTS OFF CACHE BOOL "" FORCE)

include(FetchContent)
FetchContent_Declare(
  openfst
  GIT_REPOSITORY https://github.com/csukuangfj/openfst.git
  # renovate: datasource=github-tags depName=kaldifst-openfst packageName=csukuangfj/openfst
  GIT_TAG v1.8.5-2026-04-10
  GIT_SHALLOW TRUE
)
FetchContent_GetProperties(openfst)
if(NOT openfst_POPULATED)
  FetchContent_Populate(openfst)
endif()

set(KALDIFST_SOURCE_DIR "" CACHE PATH "Optional checkout of pinned kaldifst source")
if(KALDIFST_SOURCE_DIR)
  set(kaldifst_SOURCE_DIR "${KALDIFST_SOURCE_DIR}")
  set(kaldifst_BINARY_DIR "${CMAKE_BINARY_DIR}/_deps/kaldifst-build")
else()
  FetchContent_Declare(
    kaldifst
    GIT_REPOSITORY https://github.com/k2-fsa/kaldifst.git
    # renovate: datasource=github-tags depName=kaldifst packageName=k2-fsa/kaldifst
    GIT_TAG v1.8.0
    GIT_SHALLOW TRUE
  )
  FetchContent_GetProperties(kaldifst)
  if(NOT kaldifst_POPULATED)
    FetchContent_Populate(kaldifst)
  endif()
endif()
include_directories(${kaldifst_SOURCE_DIR})
list(APPEND CMAKE_MODULE_PATH
  ${kaldifst_SOURCE_DIR}/cmake
  ${kaldifst_SOURCE_DIR}/cmake/Modules
)
add_subdirectory(${kaldifst_SOURCE_DIR} ${kaldifst_BINARY_DIR})

add_executable(matcha-kaldifst-normalizer normalizer.cc)
target_include_directories(matcha-kaldifst-normalizer PRIVATE ${kaldifst_SOURCE_DIR})
target_link_libraries(matcha-kaldifst-normalizer PRIVATE kaldifst_core)

target_link_options(matcha-kaldifst-normalizer PRIVATE
  -O3
  -flto
  -sALLOW_MEMORY_GROWTH=1
  -sINITIAL_MEMORY=16777216
  -sMAXIMUM_MEMORY=134217728
  -sFILESYSTEM=0
  -sMODULARIZE=1
  -sEXPORT_NAME=KaldifstNormalizerModule
  -sENVIRONMENT=web,worker
  -sINCOMING_MODULE_JS_API=locateFile
  -sEXPORTED_FUNCTIONS=_malloc,_free,_kaldifst_normalizer_create,_kaldifst_normalizer_destroy,_kaldifst_normalizer_apply,_kaldifst_normalizer_free,_kaldifst_normalizer_last_error
  -sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAPU32
)

set_target_properties(matcha-kaldifst-normalizer PROPERTIES
  OUTPUT_NAME "matcha-kaldifst-normalizer"
  SUFFIX ".js"
)
