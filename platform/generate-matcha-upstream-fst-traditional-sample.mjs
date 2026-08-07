import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {launch} from './cdp/cdp-client.mjs';

const host = process.env.WASM_TTS_BENCH_HOST ?? '127.0.0.1';
const serverPort = Number(process.env.WASM_TTS_BENCH_PORT ?? 8765);
const cdpPort = Number(process.env.WASM_TTS_CDP_PORT ?? 9395);
const bundleName = 'sherpa-onnx-wasm-simd-1.12.20-matcha-icefall-zh-en';
const platformRoot = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.dirname(platformRoot);
const bundleRoot = path.join(platformRoot, 'models', bundleName);
const url = `http://${host}:${serverPort}/platform/models/${bundleName}/index.html`;
const profile = path.join(
  os.tmpdir(),
  `wasmtts-matcha-upstream-fst-traditional-cdp-${process.pid}`,
);
const textPath = path.join(
  repositoryRoot,
  'frameworks',
  'matcha',
  'samples',
  'matcha-no-fst-novel-traditional-direct.txt',
);
const wavPath = path.join(
  repositoryRoot,
  'frameworks',
  'matcha',
  'samples',
  'matcha-upstream-fst-recommended-traditional-direct.wav',
);
const metadataPath = path.join(
  repositoryRoot,
  'frameworks',
  'matcha',
  'samples',
  'matcha-upstream-fst-recommended-traditional-direct.json',
);
const text = fs.readFileSync(textPath, 'utf8').trim();

const requiredBundleFiles = [
  'index.html',
  'app-tts.js',
  'sherpa-onnx-tts.js',
  'sherpa-onnx-wasm-main-tts.js',
  'sherpa-onnx-wasm-main-tts.wasm',
  'sherpa-onnx-wasm-main-tts.data',
];

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

for (const filename of requiredBundleFiles) {
  if (!fs.existsSync(path.join(bundleRoot, filename))) {
    throw new Error(
      `缺少官方 WASM bundle：${path.join(bundleRoot, filename)}。`
      + '請先下載 sherpa-onnx v1.12.20 的 Matcha zh-en browser bundle。',
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
  if (!response.ok) throw new Error(`sample host returned HTTP ${response.status}`);

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

  await send('Page.navigate', {url}, sessionId);
  await waitFor(
    evalJs,
    'document.querySelector("#generateBtn")?.disabled === false',
    180000,
    '官方 bundle 下載與 TTS 初始化',
  );

  const started = performance.now();
  const generated = await evalJs(`(() => {
    globalThis.__matchaUpstreamLastBuffer = null;
    document.querySelector('#text').value = ${JSON.stringify(text)};
    document.querySelector('#speakerId').value = '0';
    document.querySelector('#speed').value = '1';
    const generationStarted = performance.now();
    document.querySelector('#generateBtn').click();
    const wallMs = performance.now() - generationStarted;
    const buffer = globalThis.__matchaUpstreamLastBuffer;
    if (!buffer) throw new Error('官方頁面沒有建立 AudioBuffer');
    return {
      wallMs,
      sampleRate: buffer.sampleRate,
      samples: Array.from(buffer.getChannelData(0)),
    };
  })()`);
  const totalWallMs = performance.now() - started;
  const waveform = waveformStats(generated.samples);
  if (
    waveform.finiteSamples !== waveform.samples
    || waveform.peak === 0
    || waveform.rms === 0
  ) {
    throw new Error(`試聽 waveform 無效：${JSON.stringify(waveform)}`);
  }

  const wav = encodeWav(generated.samples, generated.sampleRate);
  const sha256 = crypto.createHash('sha256').update(wav).digest('hex');
  const version = await send('Browser.getVersion');
  const metadata = {
    generatedAt: new Date().toISOString(),
    runtime: 'sherpa-onnx 1.12.20 browser SIMD official prebuilt bundle',
    browser: version.product,
    model: 'matcha-icefall-zh-en / model-steps-3.onnx + vocos-16khz-univ.onnx',
    frontend: {
      traditionalConversion: false,
      opencc: false,
      inputScript: 'traditional-direct',
      lexicon: 'lexicon.txt',
      tokens: 'tokens.txt',
      dataDir: 'espeak-ng-data',
      ruleFsts: ['phone-zh.fst', 'date-zh.fst', 'number-zh.fst'],
    },
    noiseScale: 0.667,
    lengthScale: 1,
    silenceScale: 0.2,
    numThreads: 1,
    maxNumSentences: 1,
    speed: 1,
    sid: 0,
    text,
    generation: {
      inPageWallMs: generated.wallMs,
      cdpRoundTripWallMs: totalWallMs,
    },
    audio: {
      format: 'WAV / PCM signed 16-bit little-endian / mono / 16000 Hz',
      sampleRate: generated.sampleRate,
      durationSeconds: generated.samples.length / generated.sampleRate,
      bytes: wav.length,
      sha256,
      waveform,
    },
    interpretation: '證明官方 FST browser build 可直接生成這段繁體；不代表所有繁體詞組讀音均與 OpenCC 路徑相同。',
  };

  fs.writeFileSync(wavPath, wav);
  fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  console.log(JSON.stringify(metadata, null, 2));
  console.log(`Wrote ${wavPath}`);
  console.log(`Wrote ${metadataPath}`);
} finally {
  try {
    await browser?.close();
  } finally {
    removeProfile();
  }
}
