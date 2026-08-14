import {createHash} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {launch} from './cdp/cdp-client.mjs';

const host = process.env.WASM_TTS_BENCH_HOST ?? '127.0.0.1';
const serverPort = Number(process.env.WASM_TTS_BENCH_PORT ?? 8765);
const cdpPort = Number(process.env.WASM_TTS_CDP_PORT ?? 9391);
const url = `http://${host}:${serverPort}/mobile-host/matcha-stream-test.html`;
const profile = path.join(os.tmpdir(), `wasmtts-matcha-sample-cdp-${process.pid}`);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.join(
  repositoryRoot,
  'frameworks',
  'matcha',
  'samples',
  'matcha-no-fst-novel-traditional-direct.txt',
);
const text = fs.readFileSync(sourcePath, 'utf8').trim();
const variants = [
  {
    suffix: 'noise-1',
    noiseScale: 1,
    basis: '先前 Chromium 品質／效能測試參數',
  },
  {
    suffix: 'noise-0.667',
    noiseScale: 0.667,
    basis: 'sherpa-onnx Matcha 預設參數',
  },
];

async function waitFor(evalJs, expression, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (!(await evalJs(expression))) {
    if (Date.now() > deadline) throw new Error(`等待逾時：${label}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
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
  if (!response.ok) throw new Error(`mobile host returned HTTP ${response.status}`);

  browser = await launch({port: cdpPort, profile});
  const {send, evalJs, sessionId} = browser;
  await send('Page.navigate', {url}, sessionId);
  await waitFor(evalJs, 'Boolean(globalThis.matchaStreamTest)', 30000, '測試頁載入');
  await evalJs('globalThis.matchaStreamTest.producer.download()');
  await waitFor(evalJs, 'globalThis.matchaStreamTest.producer.downloaded', 180000, '模型下載');
  await evalJs('globalThis.matchaStreamTest.producer.initialize()');
  await waitFor(
    evalJs,
    'Boolean(globalThis.matchaStreamTest?.producer?.initialization)',
    180000,
    '模型初始化與暖機',
  );

  const initialization = await evalJs('globalThis.matchaStreamTest.producer.initialization');
  const outputs = [];
  for (const variant of variants) {
    const synthesis = await evalJs(`(async () => {
      const text = ${JSON.stringify(text)};
      const producer = globalThis.matchaStreamTest.producer;
      const sentences = globalThis.matchaStreamTest.splitNovelText(text);
      const signal = new AbortController().signal;
      producer.reset({
        text,
        pronunciationProfile: 'official',
        inputNormalization: 'traditional-direct',
        noiseScale: ${variant.noiseScale},
      });
      const units = [];
      for (let index = 0; index < sentences.length; index += 1) {
        units.push(await producer.next({index, signal}));
      }
      const byteLength = units.reduce((sum, unit) => sum + unit.buffer.byteLength, 0);
      const merged = new Uint8Array(byteLength);
      let offset = 0;
      for (const unit of units) {
        merged.set(new Uint8Array(unit.buffer), offset);
        offset += unit.buffer.byteLength;
      }
      return {
        bytes: Array.from(merged),
        segments: units.map((unit) => unit.meta),
        sentenceCount: sentences.length,
      };
    })()`);

    const mp3 = Buffer.from(synthesis.bytes);
    if (!mp3.length || synthesis.sentenceCount !== synthesis.segments.length) {
      throw new Error(`${variant.suffix} 試聽檔沒有完整產生`);
    }
    for (const [index, segment] of synthesis.segments.entries()) {
      if (
        segment.waveform.finiteSamples !== segment.waveform.samples
        || segment.waveform.peak === 0
        || segment.waveform.rms === 0
        || segment.mp3Bytes === 0
        || segment.unknown.length
        || segment.noiseScale !== variant.noiseScale
      ) {
        throw new Error(`${variant.suffix} segment ${index + 1} 無效：${JSON.stringify(segment)}`);
      }
    }

    const outputStem = sourcePath.replace(/\.txt$/u, `-${variant.suffix}`);
    const mp3Path = `${outputStem}.mp3`;
    const metadataPath = `${outputStem}.json`;
    const metadata = {
      generatedAt: new Date().toISOString(),
      model: 'matcha-icefall-zh-en / model-steps-6.onnx + vocos-16khz-univ.onnx',
      frontend: initialization.frontend,
      pronunciationProfile: 'official',
      inputNormalization: 'traditional-direct',
      traditionalConversion: false,
      fst: false,
      noiseScale: variant.noiseScale,
      parameterBasis: variant.basis,
      audio: 'MP3 / mono / 16000 Hz / 96 kbps / concatenated sentence units',
      text,
      sentenceCount: synthesis.sentenceCount,
      pcmAudioSeconds: synthesis.segments.reduce((sum, segment) => sum + segment.audioSeconds, 0),
      mp3Bytes: mp3.length,
      sha256: createHash('sha256').update(mp3).digest('hex'),
      segments: synthesis.segments,
    };

    fs.writeFileSync(mp3Path, mp3);
    fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
    outputs.push({
      mp3Path,
      metadataPath,
      noiseScale: variant.noiseScale,
      pcmAudioSeconds: metadata.pcmAudioSeconds,
      mp3Bytes: metadata.mp3Bytes,
      sha256: metadata.sha256,
    });
  }
  console.log(JSON.stringify(outputs, null, 2));
} finally {
  try {
    await browser?.close();
  } finally {
    removeProfile();
  }
}
