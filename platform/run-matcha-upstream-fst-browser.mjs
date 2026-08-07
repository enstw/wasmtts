import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {launch} from './cdp/cdp-client.mjs';

const host = process.env.WASM_TTS_BENCH_HOST ?? '127.0.0.1';
const serverPort = Number(process.env.WASM_TTS_BENCH_PORT ?? 8765);
const cdpPort = Number(process.env.WASM_TTS_CDP_PORT ?? 9392);
const bundleName = 'sherpa-onnx-wasm-simd-1.12.20-matcha-icefall-zh-en';
const bundleUrl = `/platform/models/${bundleName}/index.html`;
const url = `http://${host}:${serverPort}${bundleUrl}`;
const profile = path.join(os.tmpdir(), `wasmtts-matcha-upstream-fst-cdp-${process.pid}`);
const platformRoot = path.dirname(fileURLToPath(import.meta.url));
const bundleRoot = path.join(platformRoot, 'models', bundleName);
const resultPath = path.join(
  platformRoot,
  'results',
  'results-matcha_icefall_zh_en-upstream-fst-browser-wasm.json',
);
const wavPath = path.join(
  platformRoot,
  'results',
  'matcha_icefall_zh_en-upstream-fst-browser-wasm.wav',
);

const texts = {
  novel: '清晨的阳光穿过窗帘。轻轻落在安静的房间里。远处传来清脆的鸟鸣。微风带着花草的清香。让崭新的一天显得格外明亮。',
  normalization: '第12章开始于2026年8月7日14:30。请拨打110或者18920260807。她说：“我们还有25.5%的路没走完。”巷口堆着一袋垃圾。',
};

const requiredBundleFiles = [
  'index.html',
  'app-tts.js',
  'sherpa-onnx-tts.js',
  'sherpa-onnx-wasm-main-tts.js',
  'sherpa-onnx-wasm-main-tts.wasm',
  'sherpa-onnx-wasm-main-tts.data',
];

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function metric(metrics, name) {
  return metrics.metrics.find((entry) => entry.name === name)?.value ?? 0;
}

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

function encodeWav(samples, sampleRate) {
  const pcmBytes = samples.length * 2;
  const buffer = Buffer.alloc(44 + pcmBytes);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + pcmBytes, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(pcmBytes, 40);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]));
    buffer.writeInt16LE(
      Math.round(sample < 0 ? sample * 32768 : sample * 32767),
      44 + index * 2,
    );
  }
  return buffer;
}

async function waitFor(evalJs, expression, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (!(await evalJs(expression))) {
    if (Date.now() > deadline) throw new Error(`等待逾時：${label}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function memorySnapshot(evalJs) {
  return evalJs(`(async () => ({
    wasmHeapBytes: globalThis.Module?.HEAPU8?.buffer?.byteLength ?? null,
    userAgentSpecificMemory: typeof performance.measureUserAgentSpecificMemory === 'function'
      ? await performance.measureUserAgentSpecificMemory().then((result) => result.bytes).catch(() => null)
      : null,
  }))()`);
}

for (const filename of requiredBundleFiles) {
  if (!fs.existsSync(path.join(bundleRoot, filename))) {
    throw new Error(
      `缺少官方 WASM bundle：${path.join(bundleRoot, filename)}。`
      + '請下載 sherpa-onnx v1.12.20 的 matcha-icefall-zh-en browser bundle。',
    );
  }
}

const removeProfile = () => fs.rmSync(profile, {
  recursive: true,
  force: true,
  maxRetries: 8,
  retryDelay: 250,
});

let browser;
removeProfile();
try {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`benchmark host returned HTTP ${response.status}`);

  browser = await launch({port: cdpPort, profile});
  const {send, evalJs, sessionId} = browser;
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      const originalCreateBuffer = AudioContext.prototype.createBuffer;
      AudioContext.prototype.createBuffer = function(...args) {
        const buffer = originalCreateBuffer.apply(this, args);
        globalThis.__matchaUpstreamLastBuffer = buffer;
        return buffer;
      };
    })();`,
  }, sessionId);

  const navigationStarted = performance.now();
  await send('Page.navigate', {url}, sessionId);
  await waitFor(
    evalJs,
    'document.querySelector("#generateBtn")?.disabled === false',
    180000,
    '官方 bundle 下載與 TTS 初始化',
  );
  const initializationWallMs = performance.now() - navigationStarted;

  await evalJs(`globalThis.__runMatchaUpstream = (text, capture = false) => {
    for (const audio of document.querySelectorAll('audio')) {
      if (audio.src?.startsWith('blob:')) URL.revokeObjectURL(audio.src);
    }
    document.querySelector('#sound-clips').replaceChildren();
    globalThis.__matchaUpstreamLastBuffer = null;
    const input = document.querySelector('#text');
    input.value = text;
    input.dispatchEvent(new Event('input', {bubbles: true}));
    document.querySelector('#speakerId').value = '0';
    document.querySelector('#speed').value = '1';
    const started = performance.now();
    document.querySelector('#generateBtn').click();
    const wallMs = performance.now() - started;
    const buffer = globalThis.__matchaUpstreamLastBuffer;
    if (!buffer) throw new Error('官方頁面沒有建立 AudioBuffer');
    const samples = buffer.getChannelData(0);
    let finiteSamples = 0;
    let peak = 0;
    let squares = 0;
    for (const sample of samples) {
      if (Number.isFinite(sample)) finiteSamples += 1;
      peak = Math.max(peak, Math.abs(sample));
      squares += sample * sample;
    }
    const result = {
      wallMs,
      sampleRate: buffer.sampleRate,
      audioSeconds: buffer.duration,
      waveform: {
        samples: samples.length,
        finiteSamples,
        peak,
        rms: Math.sqrt(squares / samples.length),
      },
    };
    if (capture) result.samples = Array.from(samples);
    return result;
  }`);

  const version = await send('Browser.getVersion');
  const userAgent = await evalJs('navigator.userAgent');
  const runtime = await evalJs(`({
    crossOriginIsolated,
    sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
    hardwareConcurrency: navigator.hardwareConcurrency,
  })`);
  const memoryAfterInitialization = await memorySnapshot(evalJs);
  await send('Performance.enable', {}, sessionId);

  const corpora = {};
  let capturedAudio = null;
  for (const [name, text] of Object.entries(texts)) {
    await evalJs(`globalThis.__runMatchaUpstream(${JSON.stringify(text)}, false)`);
    const runs = [];
    for (let index = 0; index < 3; index += 1) {
      const before = await send('Performance.getMetrics', {}, sessionId);
      const result = await evalJs(
        `globalThis.__runMatchaUpstream(${JSON.stringify(text)}, false)`,
      );
      const after = await send('Performance.getMetrics', {}, sessionId);
      const taskMs = (metric(after, 'TaskDuration') - metric(before, 'TaskDuration')) * 1000;
      const run = {
        index: index + 1,
        ...result,
        taskMs,
        taskMsPer10s: taskMs * 10 / result.audioSeconds,
        taskRtf: taskMs / 1000 / result.audioSeconds,
        wallRtf: result.wallMs / 1000 / result.audioSeconds,
      };
      if (
        run.waveform.finiteSamples !== run.waveform.samples
        || run.waveform.peak === 0
        || run.waveform.rms === 0
      ) {
        throw new Error(`${name} run ${index + 1} waveform 無效`);
      }
      runs.push(run);
      console.log(JSON.stringify({corpus: name, ...run}));
    }
    const capture = await evalJs(
      `globalThis.__runMatchaUpstream(${JSON.stringify(text)}, true)`,
    );
    const samples = capture.samples;
    delete capture.samples;
    const summary = {
      medianTaskMsPer10s: median(runs.map((run) => run.taskMsPer10s)),
      medianTaskRtf: median(runs.map((run) => run.taskRtf)),
      medianWallRtf: median(runs.map((run) => run.wallRtf)),
      medianTaskRealtimeMultiplier: 1 / median(runs.map((run) => run.taskRtf)),
      medianWallRealtimeMultiplier: 1 / median(runs.map((run) => run.wallRtf)),
      medianAudioSeconds: median(runs.map((run) => run.audioSeconds)),
      capture,
    };
    corpora[name] = {text, warmups: 1, runs, summary};
    if (name === 'normalization') capturedAudio = {samples, sampleRate: capture.sampleRate};
  }

  const memoryAfterBenchmark = await memorySnapshot(evalJs);
  const capturedWaveform = waveformStats(capturedAudio.samples);
  if (
    capturedWaveform.finiteSamples !== capturedWaveform.samples
    || capturedWaveform.peak === 0
    || capturedWaveform.rms === 0
  ) {
    throw new Error(`capture waveform 無效：${JSON.stringify(capturedWaveform)}`);
  }

  const bundleStats = Object.fromEntries(requiredBundleFiles.map((filename) => [
    filename,
    fs.statSync(path.join(bundleRoot, filename)).size,
  ]));
  const report = {
    generatedAt: new Date().toISOString(),
    baseline: 'sherpa-onnx 官方預建 browser SIMD bundle，未修改 runtime 或模型資產',
    environment: {
      browser: version.product,
      browserBinary: browser.bin,
      userAgent,
      hostPlatform: process.platform,
      hostArchitecture: process.arch,
      osRelease: os.release(),
      node: process.version,
      executionProvider: 'sherpa-onnx browser WASM / CPU',
      measurement: 'Chromium CDP Performance.TaskDuration + in-page wall time',
      ...runtime,
    },
    configuration: {
      sherpaOnnx: '1.12.20',
      bundle: bundleName,
      acousticModel: 'model-steps-3.onnx',
      vocoder: 'vocos-16khz-univ.onnx',
      lexicon: 'lexicon.txt',
      tokens: 'tokens.txt',
      dataDir: 'espeak-ng-data',
      ruleFsts: ['phone-zh.fst', 'date-zh.fst', 'number-zh.fst'],
      noiseScale: 0.667,
      lengthScale: 1,
      silenceScale: 0.2,
      numThreads: 1,
      maxNumSentences: 1,
      speed: 1,
      sid: 0,
      inputScript: '上游示例使用簡體中文；不加入 OpenCC',
    },
    protocol: {
      warmupsPerCorpus: 1,
      measuredRunsPerCorpus: 3,
      waveformValidation: 'all samples finite, peak > 0, RMS > 0',
      capture: '正規化 corpus 的最後一輪另存 16-bit PCM WAV',
    },
    initialization: {
      wallMs: initializationWallMs,
      memory: memoryAfterInitialization,
    },
    bundleBytes: bundleStats,
    corpora,
    memoryAfterBenchmark,
    captureWaveform: capturedWaveform,
  };

  fs.writeFileSync(resultPath, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(wavPath, encodeWav(capturedAudio.samples, capturedAudio.sampleRate));
  console.log(JSON.stringify(report, null, 2));
  console.log(`Wrote ${resultPath}`);
  console.log(`Wrote ${wavPath}`);
} finally {
  try {
    await browser?.close();
  } finally {
    removeProfile();
  }
}
