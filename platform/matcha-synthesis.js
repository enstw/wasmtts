(function initMatchaSynthesis(globalScope) {
  'use strict';

  const SAMPLE_RATE = 16000;
  const N_FFT = 1024;
  const HOP_LENGTH = 256;
  const NUM_BINS = N_FFT / 2 + 1;
  const DEFAULT_SILENCE_SCALE = 0.2;
  const WINDOW = Float64Array.from(
    {length: N_FFT},
    (_, index) => 0.5 - 0.5 * Math.cos(2 * Math.PI * index / N_FFT),
  );

  function inverseFft(real, imaginary) {
    const length = real.length;
    for (let index = 1, reversed = 0; index < length; index += 1) {
      let bit = length >> 1;
      for (; reversed & bit; bit >>= 1) reversed ^= bit;
      reversed ^= bit;
      if (index < reversed) {
        [real[index], real[reversed]] = [real[reversed], real[index]];
        [imaginary[index], imaginary[reversed]] = [imaginary[reversed], imaginary[index]];
      }
    }

    for (let size = 2; size <= length; size <<= 1) {
      const angle = 2 * Math.PI / size;
      const stepReal = Math.cos(angle);
      const stepImaginary = Math.sin(angle);
      const half = size >> 1;
      for (let offset = 0; offset < length; offset += size) {
        let weightReal = 1;
        let weightImaginary = 0;
        for (let index = 0; index < half; index += 1) {
          const even = offset + index;
          const odd = even + half;
          const oddReal = real[odd] * weightReal - imaginary[odd] * weightImaginary;
          const oddImaginary = real[odd] * weightImaginary + imaginary[odd] * weightReal;
          const evenReal = real[even];
          const evenImaginary = imaginary[even];
          real[even] = evenReal + oddReal;
          imaginary[even] = evenImaginary + oddImaginary;
          real[odd] = evenReal - oddReal;
          imaginary[odd] = evenImaginary - oddImaginary;
          const nextWeightReal = weightReal * stepReal - weightImaginary * stepImaginary;
          weightImaginary = weightReal * stepImaginary + weightImaginary * stepReal;
          weightReal = nextWeightReal;
        }
      }
    }

    for (let index = 0; index < length; index += 1) {
      real[index] /= length;
      imaginary[index] /= length;
    }
  }

  function istft(magnitude, x, y) {
    const [, bins, frames] = magnitude.dims;
    if (bins !== NUM_BINS || x.dims[2] !== frames || y.dims[2] !== frames) {
      throw new Error(`Vocos 輸出 shape 不符：mag=${magnitude.dims}、x=${x.dims}、y=${y.dims}`);
    }

    const outputLength = N_FFT + (frames - 1) * HOP_LENGTH;
    const output = new Float64Array(outputLength);
    const denominator = new Float64Array(outputLength);
    const real = new Float64Array(N_FFT);
    const imaginary = new Float64Array(N_FFT);

    for (let frame = 0; frame < frames; frame += 1) {
      for (let bin = 0; bin < NUM_BINS; bin += 1) {
        const sourceIndex = bin * frames + frame;
        real[bin] = magnitude.data[sourceIndex] * x.data[sourceIndex];
        imaginary[bin] = magnitude.data[sourceIndex] * y.data[sourceIndex];
      }
      imaginary[0] = 0;
      imaginary[N_FFT / 2] = 0;
      for (let bin = 1; bin < N_FFT / 2; bin += 1) {
        real[N_FFT - bin] = real[bin];
        imaginary[N_FFT - bin] = -imaginary[bin];
      }

      inverseFft(real, imaginary);
      const start = frame * HOP_LENGTH;
      for (let index = 0; index < N_FFT; index += 1) {
        const sampleIndex = start + index;
        const window = WINDOW[index];
        output[sampleIndex] += real[index] * window;
        denominator[sampleIndex] += window * window;
      }
    }

    const centeredLength = outputLength - N_FFT;
    const centered = new Float32Array(centeredLength);
    const crop = N_FFT / 2;
    for (let index = 0; index < centeredLength; index += 1) {
      const sourceIndex = index + crop;
      centered[index] = denominator[sourceIndex]
        ? output[sourceIndex] / denominator[sourceIndex]
        : output[sourceIndex];
    }
    return centered;
  }

  // 對齊 sherpa-onnx 的 GeneratedAudio::ScaleSilence()。
  function scaleSilence(samples, scale = DEFAULT_SILENCE_SCALE) {
    if (scale === 1) return samples;
    const threshold = Math.trunc(SAMPLE_RATE * 0.2);
    const intervals = [];
    let last = -1;

    for (let index = 0; index < samples.length; index += 1) {
      if (Math.abs(samples[index]) <= 0.01) {
        if (last === -1) last = index;
        continue;
      }
      if (last !== -1 && index - last < threshold) {
        last = -1;
        continue;
      }
      if (last !== -1) {
        intervals.push([last, index]);
        last = -1;
      }
    }
    if (last !== -1 && samples.length - last > threshold) {
      intervals.push([last, samples.length]);
    }
    if (!intervals.length) return samples;

    let outputLength = samples.length;
    for (const [start, end] of intervals) {
      outputLength += Math.trunc((end - start) * scale) - (end - start);
    }
    const output = new Float32Array(outputLength);
    let sourceOffset = 0;
    let targetOffset = 0;
    for (const [start, end] of intervals) {
      output.set(samples.subarray(sourceOffset, start), targetOffset);
      targetOffset += start - sourceOffset;
      const scaledLength = Math.trunc((end - start) * scale);
      output.set(samples.subarray(start, start + scaledLength), targetOffset);
      targetOffset += scaledLength;
      sourceOffset = end;
    }
    output.set(samples.subarray(sourceOffset), targetOffset);
    return output;
  }

  function waveformStats(samples) {
    let peak = 0;
    let squares = 0;
    let finiteSamples = 0;
    for (const sample of samples) {
      if (Number.isFinite(sample)) finiteSamples += 1;
      peak = Math.max(peak, Math.abs(sample));
      squares += sample * sample;
    }
    return {
      samples: samples.length,
      finiteSamples,
      peak,
      rms: Math.sqrt(squares / samples.length),
    };
  }

  function createEngine({
    ORT,
    noiseScale = 1,
    lengthScale = 1,
    silenceScale = DEFAULT_SILENCE_SCALE,
  }) {
    if (!ORT?.InferenceSession || !ORT?.Tensor) throw new TypeError('需要 ONNX Runtime Web');
    let acoustic = null;
    let vocoder = null;

    const int64 = (values, dims) =>
      new ORT.Tensor('int64', BigInt64Array.from(values, BigInt), dims);
    const float32 = (value) =>
      new ORT.Tensor('float32', new Float32Array([value]), [1]);

    async function init({acousticModel, vocoderModel}) {
      const started = performance.now();
      acoustic = await ORT.InferenceSession.create(acousticModel, {executionProviders: ['wasm']});
      const acousticInitMs = performance.now() - started;
      const vocoderStarted = performance.now();
      vocoder = await ORT.InferenceSession.create(vocoderModel, {executionProviders: ['wasm']});
      return {
        wallMs: performance.now() - started,
        acousticInitMs,
        vocoderInitMs: performance.now() - vocoderStarted,
        acousticInputs: acoustic.inputNames,
        acousticOutputs: acoustic.outputNames,
        vocoderInputs: vocoder.inputNames,
        vocoderOutputs: vocoder.outputNames,
      };
    }

    async function synthesize(ids) {
      if (!acoustic || !vocoder) throw new Error('Matcha engine 尚未初始化');
      if (!Array.isArray(ids) || !ids.length) throw new TypeError('ids 必須是非空陣列');
      const started = performance.now();

      let phaseStarted = performance.now();
      const acousticOutput = await acoustic.run({
        x: int64(ids, [1, ids.length]),
        x_length: int64([ids.length], [1]),
        noise_scale: float32(noiseScale),
        length_scale: float32(lengthScale),
      });
      const acousticMs = performance.now() - phaseStarted;

      const mel = acousticOutput[acoustic.outputNames[0]];
      phaseStarted = performance.now();
      const vocoderOutput = await vocoder.run({mels: mel});
      const vocoderMs = performance.now() - phaseStarted;

      const [magnitudeName, xName, yName] = vocoder.outputNames;
      phaseStarted = performance.now();
      const raw = istft(
        vocoderOutput[magnitudeName],
        vocoderOutput[xName],
        vocoderOutput[yName],
      );
      const istftMs = performance.now() - phaseStarted;

      phaseStarted = performance.now();
      const samples = scaleSilence(raw, silenceScale);
      const silenceMs = performance.now() - phaseStarted;
      return {
        samples,
        sampleRate: SAMPLE_RATE,
        audioSeconds: samples.length / SAMPLE_RATE,
        wallMs: performance.now() - started,
        phases: {acousticMs, vocoderMs, istftMs, silenceMs},
        waveform: waveformStats(samples),
      };
    }

    return {init, synthesize};
  }

  const api = {
    DEFAULT_SILENCE_SCALE,
    HOP_LENGTH,
    N_FFT,
    SAMPLE_RATE,
    createEngine,
    istft,
    scaleSilence,
    waveformStats,
  };
  globalScope.MatchaSynthesis = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}(typeof globalThis !== 'undefined' ? globalThis : self));
