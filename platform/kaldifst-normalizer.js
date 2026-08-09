(function (root) {
  'use strict';

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  async function createNormalizer({moduleFactory, wasmUrl, fstBuffers}) {
    if (typeof moduleFactory !== 'function') throw new TypeError('moduleFactory is required');
    if (!Array.isArray(fstBuffers) || fstBuffers.length === 0) {
      throw new TypeError('fstBuffers must contain at least one FST');
    }
    const module = await moduleFactory({
      locateFile(path) {
        return path.endsWith('.wasm') ? wasmUrl : path;
      },
    });
    const handles = fstBuffers.map((buffer) => {
      const bytes = new Uint8Array(buffer);
      const pointer = module._malloc(bytes.byteLength);
      try {
        module.HEAPU8.set(bytes, pointer);
        const handle = module._kaldifst_normalizer_create(pointer, bytes.byteLength);
        if (!handle) throw new Error(readError(module));
        return handle;
      } finally {
        module._free(pointer);
      }
    });

    function normalizeOne(handle, text) {
      const input = encoder.encode(text);
      const inputPointer = module._malloc(input.byteLength || 1);
      const sizePointer = module._malloc(4);
      let outputPointer = 0;
      try {
        module.HEAPU8.set(input, inputPointer);
        outputPointer = module._kaldifst_normalizer_apply(
          handle, inputPointer, input.byteLength, sizePointer,
        );
        if (!outputPointer) throw new Error(readError(module));
        const outputSize = module.HEAPU32[sizePointer >>> 2];
        return decoder.decode(module.HEAPU8.slice(outputPointer, outputPointer + outputSize));
      } finally {
        if (outputPointer) module._kaldifst_normalizer_free(outputPointer);
        module._free(sizePointer);
        module._free(inputPointer);
      }
    }

    const normalize = (text) => handles.reduce(
      (value, handle) => normalizeOne(handle, value),
      String(text),
    );
    normalize.dispose = () => {
      while (handles.length) module._kaldifst_normalizer_destroy(handles.pop());
    };
    normalize.runtime = module;
    return normalize;
  }

  function readError(module) {
    const pointer = module._kaldifst_normalizer_last_error();
    if (!pointer) return 'kaldifst text normalization failed';
    let end = pointer;
    while (module.HEAPU8[end]) end += 1;
    return decoder.decode(module.HEAPU8.subarray(pointer, end));
  }

  root.MatchaKaldifst = {createNormalizer};
})(typeof self !== 'undefined' ? self : globalThis);
