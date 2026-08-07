/* global lamejs, MatchaFrontend, MatchaSynthesis, OpenCC, ort */

importScripts(
  '/mobile-host/vendor/ort/ort.min.js',
  '/mobile-host/vendor/opencc-t2cn.js',
  '/mobile-host/vendor/lame.min.js',
  '/platform/matcha-frontend.js',
  '/platform/matcha-synthesis.js',
);

const ASSET_CACHE = 'wasmtts-matcha-assets-v1';
const MODEL_ROOT = '/platform/models/matcha-icefall-zh-en';
const ACOUSTIC_URL = `${MODEL_ROOT}/model-steps-3.onnx`;
const VOCODER_URL = '/platform/models/vocos-16khz-univ.onnx';
const LEXICON_URL = `${MODEL_ROOT}/lexicon.txt`;
const TOKENS_URL = `${MODEL_ROOT}/tokens.txt`;
const BIT_RATE_KBPS = 96;

ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = false;
ort.env.wasm.wasmPaths = '/mobile-host/vendor/ort/';

let engine = null;
let frontends = null;
let initPromise = null;
let initialization = null;

function postProgress(stage, detail = {}) {
  postMessage({type: 'progress', stage, detail});
}

async function cachedResponse(url) {
  const absolute = new URL(url, self.location.href).href;
  const cache = await caches.open(ASSET_CACHE);
  const cached = await cache.match(absolute);
  if (cached) return {response: cached, source: 'cache'};

  const response = await fetch(absolute, {cache: 'no-cache'});
  if (!response.ok) throw new Error(`${url} HTTP ${response.status}`);
  await cache.put(absolute, response.clone());
  return {response, source: 'network'};
}

async function cachedArrayBuffer(url) {
  const {response, source} = await cachedResponse(url);
  return {buffer: await response.arrayBuffer(), source};
}

async function cachedText(url) {
  const {response, source} = await cachedResponse(url);
  return {text: await response.text(), source};
}

function encodeMp3(samples, sampleRate) {
  const started = performance.now();
  const pcm = new Int16Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    pcm[index] = Math.trunc(Math.max(-1, Math.min(1, samples[index])) * 32767);
  }

  const encoder = new lamejs.Mp3Encoder(1, sampleRate, BIT_RATE_KBPS);
  const parts = [];
  let length = 0;
  for (let offset = 0; offset < pcm.length; offset += 1152) {
    const part = encoder.encodeBuffer(pcm.subarray(offset, Math.min(pcm.length, offset + 1152)));
    if (part.length) {
      parts.push(part);
      length += part.length;
    }
  }
  const finalPart = encoder.flush();
  if (finalPart.length) {
    parts.push(finalPart);
    length += finalPart.length;
  }

  const encoded = new Uint8Array(length);
  let targetOffset = 0;
  for (const part of parts) {
    encoded.set(part, targetOffset);
    targetOffset += part.length;
  }
  return {encoded, wallMs: performance.now() - started};
}

async function initialize() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const started = performance.now();
    postProgress('下載／讀取前端字典');
    const [lexicon, tokens] = await Promise.all([
      cachedText(LEXICON_URL),
      cachedText(TOKENS_URL),
    ]);
    const convertTraditional = OpenCC.Converter({from: 'tw', to: 'cn'});
    frontends = {
      official: MatchaFrontend.createFrontend({
        lexiconText: lexicon.text,
        tokensText: tokens.text,
        convertTraditional,
      }),
      taiwan: MatchaFrontend.createFrontend({
        lexiconText: lexicon.text,
        tokensText: tokens.text,
        convertTraditional,
        pronunciationOverrides: {'垃圾': 'le4 se4'},
      }),
    };

    postProgress('載入 Matcha acoustic model');
    const acoustic = await cachedArrayBuffer(ACOUSTIC_URL);
    postProgress('載入 Vocos');
    const vocoder = await cachedArrayBuffer(VOCODER_URL);
    engine = MatchaSynthesis.createEngine({ORT: ort});
    const session = await engine.init({
      acousticModel: new Uint8Array(acoustic.buffer),
      vocoderModel: new Uint8Array(vocoder.buffer),
    });

    postProgress('暖機文字前端、推論與 MP3 encoder');
    const warmupFrontendStarted = performance.now();
    const warmupInput = frontends.official.tokensFor('你好。');
    const warmupFrontendMs = performance.now() - warmupFrontendStarted;
    const warmupSynthesis = await engine.synthesize(warmupInput.ids);
    const warmupMp3 = encodeMp3(warmupSynthesis.samples, warmupSynthesis.sampleRate);
    initialization = {
      wallMs: performance.now() - started,
      session,
      sources: {
        lexicon: lexicon.source,
        tokens: tokens.source,
        acousticModel: acoustic.source,
        vocoder: vocoder.source,
      },
      frontend: {
        lexiconSize: frontends.official.lexiconSize,
        tokenCount: frontends.official.tokenCount,
        traditionalConversion: 'OpenCC tw2s',
        fst: false,
        numericNormalization: 'JavaScript common date/time/percentage/decimal/integer rules',
        englishFrontend: false,
      },
      warmup: {
        frontendMs: warmupFrontendMs,
        synthesisMs: warmupSynthesis.wallMs,
        mp3Ms: warmupMp3.wallMs,
        audioSeconds: warmupSynthesis.audioSeconds,
        mp3Bytes: warmupMp3.encoded.byteLength,
        waveform: warmupSynthesis.waveform,
      },
      runtime: {
        ort: '1.26.0-dev.20260416-b7804b056c',
        threads: 1,
        mp3: `lamejs 1.2.1 / ${BIT_RATE_KBPS} kbps`,
      },
    };
    return initialization;
  })();
  return initPromise;
}

async function synthesize(message) {
  await initialize();
  const profile = message.pronunciationProfile === 'taiwan' ? 'taiwan' : 'official';
  const totalStarted = performance.now();
  const frontendStarted = performance.now();
  const frontend = frontends[profile].tokensFor(message.text);
  const frontendMs = performance.now() - frontendStarted;
  const synthesis = await engine.synthesize(frontend.ids);
  if (
    synthesis.waveform.finiteSamples !== synthesis.waveform.samples
    || synthesis.waveform.peak === 0
    || synthesis.waveform.rms === 0
  ) {
    throw new Error(`Matcha waveform 無效：${JSON.stringify(synthesis.waveform)}`);
  }
  const mp3 = encodeMp3(synthesis.samples, synthesis.sampleRate);
  const result = {
    type: 'result',
    requestId: message.requestId,
    buffer: mp3.encoded.buffer,
    meta: {
      text: message.text,
      normalizedText: frontend.normalizedText,
      pronunciationProfile: profile,
      tokenCount: frontend.ids.length,
      phones: frontend.phones,
      unknown: frontend.unknown,
      sampleRate: synthesis.sampleRate,
      audioSeconds: synthesis.audioSeconds,
      waveform: synthesis.waveform,
      mp3Bytes: mp3.encoded.byteLength,
      phases: {
        frontendMs,
        ...synthesis.phases,
        synthesisMs: synthesis.wallMs,
        mp3Ms: mp3.wallMs,
        totalMs: performance.now() - totalStarted,
      },
    },
  };
  postMessage(result, [result.buffer]);
}

self.addEventListener('message', async (event) => {
  const message = event.data;
  try {
    if (message.type === 'init') {
      postMessage({type: 'ready', initialization: await initialize()});
      return;
    }
    if (message.type === 'synthesize') {
      await synthesize(message);
    }
  } catch (error) {
    postMessage({
      type: 'error',
      requestId: message.requestId,
      message: error?.message ?? String(error),
      stack: error?.stack ?? '',
      unknown: error?.unknown ?? [],
    });
  }
});
