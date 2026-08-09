#!/bin/sh
set -eu

root_dir=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
source_dir="$root_dir/platform/kaldifst-wasm"
build_dir="/tmp/wasmtts-kaldifst-wasm-build"
output_dir="$root_dir/platform/kaldifst-wasm/dist"
export EM_CACHE="${EM_CACHE:-/tmp/wasmtts-emscripten-cache}"

command -v emcmake >/dev/null 2>&1 || {
  echo "需要 Emscripten（emcmake）；macOS 可用 brew install emscripten。" >&2
  exit 1
}

cmake -E rm -rf "$build_dir"
source_arg=
if [ -n "${KALDIFST_SOURCE_DIR:-}" ]; then
  source_arg="-DKALDIFST_SOURCE_DIR=$KALDIFST_SOURCE_DIR"
fi
emcmake cmake -S "$source_dir" -B "$build_dir" -DCMAKE_BUILD_TYPE=MinSizeRel $source_arg
cmake --build "$build_dir" --parallel
cmake -E make_directory "$output_dir"
cmake -E copy "$build_dir/matcha-kaldifst-normalizer.js" "$output_dir/"
cmake -E copy "$build_dir/matcha-kaldifst-normalizer.wasm" "$output_dir/"
ls -lh "$output_dir/matcha-kaldifst-normalizer.js" "$output_dir/matcha-kaldifst-normalizer.wasm"
