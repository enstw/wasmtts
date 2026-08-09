/* global KaldifstNormalizerModule, lamejs, MatchaFrontend, MatchaKaldifst, MatchaSynthesis, ort */

importScripts(
  '/mobile-host/vendor/ort/ort.min.js',
  '/mobile-host/vendor/lame.min.js',
  '/mobile-host/vendor/kaldifst/matcha-kaldifst-normalizer.js',
  '/platform/kaldifst-normalizer.js',
  '/platform/matcha-frontend.js?v=20260808-022258',
  '/platform/matcha-synthesis.js',
);

const ASSET_CACHE = 'wasmtts-matcha-assets-v1';
const MODEL_ROOT = '/platform/models/matcha-icefall-zh-en';
const ACOUSTIC_URL = `${MODEL_ROOT}/model-steps-3.onnx`;
const VOCODER_URL = '/platform/models/vocos-16khz-univ.onnx';
const LEXICON_URL = `${MODEL_ROOT}/lexicon.txt`;
const TOKENS_URL = `${MODEL_ROOT}/tokens.txt`;
const RULE_FSTS = [
  {key: 'phoneFst', url: `${MODEL_ROOT}/phone-zh.fst`, label: '電話規則 FST'},
  {key: 'dateFst', url: `${MODEL_ROOT}/date-zh.fst`, label: '日期規則 FST'},
  {key: 'numberFst', url: `${MODEL_ROOT}/number-zh.fst`, label: '數字規則 FST'},
];
const BIT_RATE_KBPS = 96;
const EXPECTED_ASSET_BYTES = 131351620;

ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = false;
ort.env.wasm.wasmPaths = '/mobile-host/vendor/ort/';

let engine = null;
let frontends = null;
let initPromise = null;
let initialization = null;
let downloadedAssets = null;

function postProgress(stage, detail = {}) {
  postMessage({type: 'progress', stage, detail});
}

async function downloadResponse(url, onProgress) {
  const absolute = new URL(url, self.location.href).href;
  const cache = 'caches' in self ? await caches.open(ASSET_CACHE) : null;
  const cached = await cache?.match(absolute);
  const response = cached ?? await fetch(absolute, {cache: 'no-cache'});
  if (!response.ok) throw new Error(`${url} HTTP ${response.status}`);
  const source = cached ? 'cache' : cache ? 'network' : 'network (CacheStorage unavailable)';
  const total = Number(response.headers.get('content-length')) || 0;

  if (!response.body) {
    const buffer = await response.arrayBuffer();
    onProgress(buffer.byteLength, total || buffer.byteLength);
    if (!cached && cache) await cache.put(absolute, new Response(buffer, {headers: response.headers}));
    return {buffer, source};
  }

  const reader = response.body.getReader();
  const chunks = [];
  let loaded = 0;
  while (true) {
    const {done, value} = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress(loaded, total);
  }
  const bytes = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (!cached && cache) await cache.put(absolute, new Response(bytes, {headers: response.headers}));
  return {buffer: bytes.buffer, source};
}

async function downloadAssets() {
  if (downloadedAssets) return downloadedAssets;
  const assets = [
    {key: 'lexicon', url: LEXICON_URL, label: '前端詞典'},
    {key: 'tokens', url: TOKENS_URL, label: 'Tokens'},
    ...RULE_FSTS,
    {key: 'acoustic', url: ACOUSTIC_URL, label: 'Matcha acoustic model'},
    {key: 'vocoder', url: VOCODER_URL, label: 'Vocos'},
  ];
  const completed = new Map();
  const totals = new Map();
  const results = {};
  for (const asset of assets) {
    results[asset.key] = await downloadResponse(asset.url, (loaded, total) => {
      completed.set(asset.key, loaded);
      totals.set(asset.key, total);
      postMessage({
        type: 'download-progress',
        asset: asset.label,
        loaded: [...completed.values()].reduce((sum, value) => sum + value, 0),
        total: EXPECTED_ASSET_BYTES,
      });
    });
  }
  downloadedAssets = results;
  postMessage({type: 'download-complete', sources: Object.fromEntries(
    Object.entries(results).map(([key, value]) => [key, value.source]),
  )});
  return downloadedAssets;
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
    if (!downloadedAssets) throw new Error('請先下載模型');
    const lexicon = downloadedAssets.lexicon;
    const tokens = downloadedAssets.tokens;
    const decoder = new TextDecoder();
    const lexiconText = decoder.decode(lexicon.buffer);
    const tokensText = decoder.decode(tokens.buffer);
    postProgress('載入 kaldifst text-normalizer WASM');
    const ruleNormalizer = await MatchaKaldifst.createNormalizer({
      moduleFactory: KaldifstNormalizerModule,
      wasmUrl: '/mobile-host/vendor/kaldifst/matcha-kaldifst-normalizer.wasm',
      fstBuffers: [
        downloadedAssets.phoneFst.buffer,
        downloadedAssets.dateFst.buffer,
        downloadedAssets.numberFst.buffer,
      ],
    });
    postProgress('建立文字前端');
    frontends = {
      official: MatchaFrontend.createFrontend({
        lexiconText,
        tokensText,
        ruleNormalizer,
      }),
      taiwan: MatchaFrontend.createFrontend({
        lexiconText,
        tokensText,
        ruleNormalizer,
        pronunciationOverrides: {'垃圾': 'le4 se4'},
      }),
    };

    postProgress('載入 Matcha acoustic model');
    const acoustic = downloadedAssets.acoustic;
    postProgress('載入 Vocos');
    const vocoder = downloadedAssets.vocoder;
    engine = MatchaSynthesis.createEngine({ORT: ort});
    const session = await engine.init({
      acousticModel: new Uint8Array(acoustic.buffer),
      vocoderModel: new Uint8Array(vocoder.buffer),
    });
    const assetSources = {
      lexicon: lexicon.source,
      tokens: tokens.source,
      phoneFst: downloadedAssets.phoneFst.source,
      dateFst: downloadedAssets.dateFst.source,
      numberFst: downloadedAssets.numberFst.source,
      acousticModel: acoustic.source,
      vocoder: vocoder.source,
    };
    // ORT session 建立後不再保留 123.6 MiB 原始 ONNX buffers；手機第一句
    // 合成需要額外 tensor 空間，重複保留模型會造成不必要的記憶體壓力。
    downloadedAssets = null;

    postProgress('暖機文字前端、推論與 MP3 encoder');
    const warmupFrontendStarted = performance.now();
    const warmupInput = frontends.official.tokensFor('你好。');
    const warmupFrontendMs = performance.now() - warmupFrontendStarted;
    const warmupSynthesis = await engine.synthesize(warmupInput.ids);
    const warmupMp3 = encodeMp3(warmupSynthesis.samples, warmupSynthesis.sampleRate);
    initialization = {
      wallMs: performance.now() - started,
      session,
      sources: assetSources,
      frontend: {
        lexiconSize: frontends.official.lexiconSize,
        tokenCount: frontends.official.tokenCount,
        traditionalConversion: false,
        inputNormalization: 'traditional-direct',
        fst: true,
        fstRuntime: 'standalone kaldifst 1.8.0 + OpenFST WASM',
        ruleFsts: ['phone-zh.fst', 'date-zh.fst', 'number-zh.fst'],
        numericNormalization: 'sherpa zh rule FSTs applied by standalone kaldifst WASM',
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
        textNormalizer: {
          kaldifst: '1.8.0 / ab5bdd013bdf13921e6aeee77db5722ebf9955fb',
          initialMemoryBytes: 16777216,
          currentMemoryBytes: ruleNormalizer.runtime.HEAPU8.buffer.byteLength,
          maximumMemoryBytes: 134217728,
          separateLinearMemory: true,
        },
        mp3: `lamejs 1.2.1 / ${BIT_RATE_KBPS} kbps`,
      },
    };
    return initialization;
  })();
  return initPromise;
}

async function synthesize(message) {
  await initialize();
  postProgress(`合成第 ${message.requestId} 段：文字前端`);
  const profile = message.pronunciationProfile === 'taiwan' ? 'taiwan' : 'official';
  const inputNormalization = 'traditional-direct';
  const totalStarted = performance.now();
  const frontendStarted = performance.now();
  const selectedFrontend = frontends[profile];
  const frontend = selectedFrontend.tokensFor(message.text);
  const frontendMs = performance.now() - frontendStarted;
  const noiseScale = Number.isFinite(message.noiseScale) ? message.noiseScale : 0.667;
  postProgress(`合成第 ${message.requestId} 段：Matcha + Vocos`);
  const synthesis = await engine.synthesize(frontend.ids, {noiseScale});
  if (
    synthesis.waveform.finiteSamples !== synthesis.waveform.samples
    || synthesis.waveform.peak === 0
    || synthesis.waveform.rms === 0
  ) {
    throw new Error(`Matcha waveform 無效：${JSON.stringify(synthesis.waveform)}`);
  }
  postProgress(`合成第 ${message.requestId} 段：MP3 encode`);
  const mp3 = encodeMp3(synthesis.samples, synthesis.sampleRate);
  const result = {
    type: 'result',
    requestId: message.requestId,
    buffer: mp3.encoded.buffer,
    meta: {
      text: message.text,
      normalizedText: frontend.normalizedText,
      pronunciationProfile: profile,
      inputNormalization,
      tokenCount: frontend.ids.length,
      phones: frontend.phones,
      unknown: frontend.unknown,
      sampleRate: synthesis.sampleRate,
      noiseScale: synthesis.noiseScale,
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
    if (message.type === 'download-assets') {
      await downloadAssets();
      return;
    }
    if (message.type === 'synthesize') {
      await synthesize(message);
    }
  } catch (error) {
    postMessage({
      type: 'error',
      action: message.type,
      requestId: message.requestId,
      message: error?.message ?? String(error),
      stack: error?.stack ?? '',
      unknown: error?.unknown ?? [],
    });
  }
});
