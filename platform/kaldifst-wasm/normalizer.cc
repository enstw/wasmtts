#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <sstream>
#include <string>

#include "kaldifst/csrc/text-normalizer.h"

namespace {

struct Normalizer {
  explicit Normalizer(const uint8_t *data, size_t size) {
    std::string bytes(reinterpret_cast<const char *>(data), size);
    std::istringstream stream(bytes, std::ios::binary);
    value = std::make_unique<kaldifst::TextNormalizer>(stream);
  }

  std::unique_ptr<kaldifst::TextNormalizer> value;
};

thread_local std::string last_error;

}  // namespace

extern "C" {

const char *kaldifst_normalizer_last_error() { return last_error.c_str(); }

void *kaldifst_normalizer_create(const uint8_t *fst_data, size_t fst_size) {
  try {
    last_error.clear();
    return new Normalizer(fst_data, fst_size);
  } catch (const std::exception &error) {
    last_error = error.what();
    return nullptr;
  }
}

void kaldifst_normalizer_destroy(void *handle) {
  delete static_cast<Normalizer *>(handle);
}

char *kaldifst_normalizer_apply(void *handle, const char *input,
                                size_t input_size, size_t *output_size) {
  try {
    last_error.clear();
    if (!handle || !input || !output_size) {
      last_error = "invalid normalizer argument";
      return nullptr;
    }
    const std::string output = static_cast<Normalizer *>(handle)->value->Normalize(
        std::string(input, input_size));
    auto *result = static_cast<char *>(std::malloc(output.size() + 1));
    if (!result) {
      last_error = "unable to allocate normalization result";
      return nullptr;
    }
    std::memcpy(result, output.data(), output.size());
    result[output.size()] = '\0';
    *output_size = output.size();
    return result;
  } catch (const std::exception &error) {
    last_error = error.what();
    return nullptr;
  }
}

void kaldifst_normalizer_free(void *pointer) { std::free(pointer); }

}  // extern "C"
