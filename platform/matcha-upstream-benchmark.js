(() => {
  'use strict';

  let tts = null;
  let configuration = null;
  let resolveRuntime;
  let rejectRuntime;
  const assetRoot = '/platform/models/'
    + 'sherpa-onnx-wasm-simd-1.12.20-matcha-icefall-zh-en/';
  const runtimeReady = new Promise((resolve, reject) => {
    resolveRuntime = resolve;
    rejectRuntime = reject;
  });

  function waveformStats(samples) {
    let finiteSamples = 0;
    let peak = 0;
    let squares = 0;
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

  function buildConfig({fst = true, noiseScale = 0.667} = {}) {
    return {
      offlineTtsModelConfig: {
        offlineTtsMatchaModelConfig: {
          acousticModel: './model-steps-3.onnx',
          vocoder: './vocos-16khz-univ.onnx',
          lexicon: './lexicon.txt',
          tokens: './tokens.txt',
          dataDir: './espeak-ng-data',
          noiseScale,
          lengthScale: 1,
        },
        numThreads: 1,
        debug: 0,
        provider: 'cpu',
      },
      ruleFsts: fst ? './phone-zh.fst,./date-zh.fst,./number-zh.fst' : '',
      ruleFars: '',
      maxNumSentences: 1,
      silenceScale: 0.2,
    };
  }

  async function init({fst} = {}) {
    await runtimeReady;
    if (typeof fst === 'boolean' && fst !== configuration.fst) {
      throw new Error(`頁面已初始化 fst=${configuration.fst}，要求值為 ${fst}`);
    }
    return configuration;
  }

  function run(text, capture = false) {
    if (!tts) throw new Error('請先初始化 Matcha benchmark');
    const started = performance.now();
    const audio = tts.generate({text, sid: 0, speed: 1});
    const wallMs = performance.now() - started;
    const result = {
      wallMs,
      sampleRate: audio.sampleRate,
      audioSeconds: audio.samples.length / audio.sampleRate,
      waveform: waveformStats(audio.samples),
    };
    if (capture) result.samples = Array.from(audio.samples);
    return result;
  }

  globalThis.matchaUpstreamBench = {
    init,
    run,
    metadata: () => configuration,
  };

  const fst = new URLSearchParams(location.search).get('fst') !== '0';
  globalThis.Module = {
    locateFile(path) {
      return `${assetRoot}${path}`;
    },
    setStatus(status) {
      globalThis.matchaRuntimeStatus = status;
    },
    onAbort(reason) {
      rejectRuntime(new Error(`sherpa-onnx WASM abort：${reason}`));
    },
    onRuntimeInitialized() {
      try {
        const started = performance.now();
        const config = buildConfig({fst, noiseScale: 0.667});
        tts = fst ? createOfflineTts(Module) : createOfflineTts(Module, config);
        configuration = {
          fst,
          ruleFsts: config.ruleFsts,
          noiseScale: 0.667,
          lengthScale: 1,
          silenceScale: 0.2,
          numThreads: 1,
          maxNumSentences: 1,
          sampleRate: tts.sampleRate,
          numSpeakers: tts.numSpeakers,
          initMs: performance.now() - started,
          wasmHeapBytes: Module.HEAPU8.buffer.byteLength,
        };
        resolveRuntime();
      } catch (error) {
        rejectRuntime(error);
      }
    },
  };
})();
