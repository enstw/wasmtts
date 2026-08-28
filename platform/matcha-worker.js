/* global importScripts, KaldifstNormalizerModule, lamejs, MatchaEngine, ort */

// wasmtts 合成 Worker:背景逐句「文字 → wasmtts lexicon → Matcha + Vocos → MP3」。
// 不寫死任何 URL:頁面 new Worker(url) 後第一則訊息必須是
//   {type: 'configure', config}
// config 由 matcha-producer.mjs 的 workerConfigFromAssets() 從 matcha-assets.json
// 機械產生,含所有 script／wasm／資產 URL、bytes、cache 名稱、synthesis 與 MP3
// 參數;Worker 在 configure 時才 importScripts。之後的協定:
//   → {type: 'download-assets'}          ← download-progress… / download-complete
//   → {type: 'init'}                      ← ready {initialization}
//   → {type: 'synthesize', requestId, text, noiseScale?, capturePcm?, format?, allowUnknown?}
//                                         ← result {requestId, buffer, meta} 或 error
//   → {type: 'status'}                    ← status {assets: [{key, url, cached, bytes}], cachedBytes, missingBytes, complete}
//                                            （不觸發任何下載——下游可據此先問使用者再抓 ~130 MB）
//   → {type: 'dispose'}
// config.progressEvents（預設 false）才會送逐句 progress；config.networkTimeoutMs（預設 1000）
// 是 network-first 資產的逾時，逾時走 cache fallback，壞訊號不會讓 init 掛住。
// config.assets.ortWasm（選填，{url, bytes}）把 ORT 的 wasm 納入同一條資產管線（status／
// 清掃／download-progress 都算得到它），init 時以 ort.env.wasm.wasmBinary 注入；沒給則 ORT
// 自己按 ortWasmPaths 抓。
// 任何錯誤以 {type: 'error', action, requestId?, message, stack, unknown} 回報。

'use strict';

const REQUIRED_SCRIPTS = ['ort', 'lamejs', 'kaldifstModule', 'frontend', 'profile', 'kaldifstGlue', 'synthesis', 'engine'];
const REQUIRED_ASSETS = ['lexicon', 'profile', 'tokens', 'acoustic', 'vocoder'];
const DEFAULTS = Object.freeze({
  cacheName: 'wasmtts-assets-v1',
  synthesis: {},
  mp3: {bitRateKbps: 96},
  defaultNoiseScale: 0.667,
  ort: {numThreads: 1},
  versions: {},
  pronunciationOverrides: {},
  warmupText: '你好。',
  networkTimeoutMs: 1000,
  progressEvents: false,
});

let config = null;
let engine = null;
let initPromise = null;
let initialization = null;
let downloadedAssets = null;

function postProgress(stage, detail = {}) {
  // 每句三則 progress 對飛行紀錄器是噪音;預設關,config.progressEvents 才開。
  if (!config?.progressEvents) return;
  postMessage({type: 'progress', stage, detail});
}

function requireConfigured() {
  if (!config) throw new Error('Worker 尚未 configure:第一則訊息必須是 {type: "configure", config}');
}

function configure(next) {
  if (config) throw new Error('Worker 已 configure,不可重複');
  if (!next || typeof next !== 'object') throw new TypeError('configure 需要 config 物件');
  for (const key of REQUIRED_SCRIPTS) {
    if (typeof next.scripts?.[key] !== 'string') throw new TypeError(`config.scripts.${key} 必須是 URL`);
  }
  if (typeof next.kaldifstWasmUrl !== 'string') throw new TypeError('config.kaldifstWasmUrl 必須是 URL');
  if (!next.ortWasmPaths) throw new TypeError('config.ortWasmPaths 必須提供(字串目錄或 {mjs, wasm})');
  for (const key of REQUIRED_ASSETS) {
    if (typeof next.assets?.[key]?.url !== 'string') throw new TypeError(`config.assets.${key}.url 必須是 URL`);
  }
  if (!Array.isArray(next.assets.fsts) || next.assets.fsts.length === 0
    || next.assets.fsts.some((fst) => typeof fst?.url !== 'string')) {
    throw new TypeError('config.assets.fsts 必須是 [{url}] 且順序固定(phone、date、number)');
  }
  config = {
    ...DEFAULTS,
    ...next,
    synthesis: {...DEFAULTS.synthesis, ...(next.synthesis ?? {})},
    mp3: {...DEFAULTS.mp3, ...(next.mp3 ?? {})},
    ort: {...DEFAULTS.ort, ...(next.ort ?? {})},
    versions: {...DEFAULTS.versions, ...(next.versions ?? {})},
  };
  const {scripts} = config;
  importScripts(
    scripts.ort,
    scripts.lamejs,
    scripts.kaldifstModule,
    scripts.frontend,
    scripts.profile,
    scripts.kaldifstGlue,
    scripts.synthesis,
    scripts.engine,
  );
  ort.env.wasm.numThreads = config.ort.numThreads;
  ort.env.wasm.proxy = false;
  ort.env.wasm.wasmPaths = config.ortWasmPaths;
  return {
    type: 'configured',
    cacheName: config.cacheName,
    assets: Object.fromEntries(assetList().map((asset) => [asset.key, asset.url])),
  };
}

// 與 matcha-producer.mjs 的 assetListFromConfig 同一份推導（Worker 是 classic script 不能
// import，test-matcha-producer 以 vm 驗兩者逐項一致）；config.assets.<key>.label 可覆寫顯示名。
function assetList() {
  const {assets} = config;
  return [
    {key: 'lexicon', url: assets.lexicon.url, bytes: assets.lexicon.bytes, label: assets.lexicon.label ?? 'wasmtts 詞典', networkFirst: assets.lexicon.networkFirst ?? true},
    {key: 'profile', url: assets.profile.url, bytes: assets.profile.bytes, label: assets.profile.label ?? '臺灣讀音 runtime profile', networkFirst: assets.profile.networkFirst ?? true},
    {key: 'tokens', url: assets.tokens.url, bytes: assets.tokens.bytes, label: assets.tokens.label ?? 'Tokens'},
    ...assets.fsts.map((fst, index) => ({key: `fst${index}`, url: fst.url, bytes: fst.bytes, label: fst.label ?? `規則 FST ${index + 1}`})),
    ...(typeof assets.ortWasm?.url === 'string'
      ? [{key: 'ortWasm', url: assets.ortWasm.url, bytes: assets.ortWasm.bytes, label: assets.ortWasm.label ?? 'ORT WASM runtime'}]
      : []),
    {key: 'acoustic', url: assets.acoustic.url, bytes: assets.acoustic.bytes, label: assets.acoustic.label ?? 'Matcha acoustic model'},
    {key: 'vocoder', url: assets.vocoder.url, bytes: assets.vocoder.bytes, label: assets.vocoder.label ?? 'Vocos'},
  ];
}

async function downloadResponse(url, onProgress, {networkFirst = false} = {}) {
  const absolute = new URL(url, self.location.href).href;
  // Cache API 只收 http(s);blob:／data: 這類頁面自製資源直接 fetch。
  const cacheable = /^https?:/u.test(absolute) && 'caches' in self;
  const cache = cacheable ? await caches.open(config.cacheName) : null;
  let cached = null;
  let response = null;
  let source = 'network';
  if (networkFirst) {
    try {
      // 壞訊號下 fetch 不是失敗而是掛住;逾時即走 cache fallback。
      const signal = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(config.networkTimeoutMs) : undefined;
      response = await fetch(absolute, {cache: 'no-cache', signal});
    } catch (error) {
      cached = await cache?.match(absolute);
      if (!cached) throw error;
      response = cached;
      source = 'cache fallback';
    }
  } else {
    cached = await cache?.match(absolute);
    response = cached ?? await fetch(absolute, {cache: 'no-cache'});
    source = cached ? 'cache' : 'network';
  }
  if (!response.ok && networkFirst) {
    cached = await cache?.match(absolute);
    if (cached) {
      response = cached;
      source = 'cache fallback';
    }
  }
  if (!response.ok) throw new Error(`${url} HTTP ${response.status}`);
  if (!cache && source === 'network') source = 'network (CacheStorage unavailable)';
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

async function sweepCache() {
  // keep-set 清掃:cache 內任何不在本次資產清單的 key 都刪(換模型、換 revision、
  // 舊時代殘留),避免裝置殘留數百 MiB;不必再逐名維護。
  if (!('caches' in self)) return [];
  const cache = await caches.open(config.cacheName);
  const keep = new Set(assetList().map((asset) => new URL(asset.url, self.location.href).href));
  const evicted = [];
  for (const request of await cache.keys()) {
    if (!keep.has(request.url) && await cache.delete(request)) evicted.push(request.url);
  }
  return evicted;
}

// 不下載就能回答狀態:每個資產是否已在 cache、bytes、共缺多少。
async function status() {
  requireConfigured();
  const cache = 'caches' in self ? await caches.open(config.cacheName) : null;
  const assets = [];
  for (const asset of assetList()) {
    const absolute = new URL(asset.url, self.location.href).href;
    const cached = cache ? Boolean(await cache.match(absolute)) : false;
    assets.push({key: asset.key, url: asset.url, label: asset.label, cached, bytes: Number.isFinite(asset.bytes) ? asset.bytes : null});
  }
  const sum = (list) => list.reduce((total, asset) => total + (asset.bytes ?? 0), 0);
  return {
    type: 'status',
    cacheStorage: Boolean(cache),
    assets,
    cachedBytes: sum(assets.filter((asset) => asset.cached)),
    missingBytes: sum(assets.filter((asset) => !asset.cached)),
    complete: assets.every((asset) => asset.cached),
    downloaded: Boolean(downloadedAssets) || Boolean(initialization),
  };
}

async function downloadAssets() {
  requireConfigured();
  if (downloadedAssets) return downloadedAssets;
  const evicted = await sweepCache();
  if (evicted.length) postMessage({type: 'cache-swept', evicted});
  const assets = assetList();
  const expected = assets.reduce((sum, asset) => sum + (Number.isFinite(asset.bytes) ? asset.bytes : 0), 0);
  const completed = new Map();
  const totals = new Map();
  const results = {};
  for (const asset of assets) {
    results[asset.key] = await downloadResponse(asset.url, (loaded, total) => {
      completed.set(asset.key, loaded);
      totals.set(asset.key, Number.isFinite(asset.bytes) ? asset.bytes : total);
      // 已知 bytes 的資產以 manifest 為準;未知者(如 profile)以回應長度補上。
      const unknown = assets
        .filter((entry) => !Number.isFinite(entry.bytes))
        .reduce((sum, entry) => sum + (totals.get(entry.key) || 0), 0);
      postMessage({
        type: 'download-progress',
        asset: asset.label,
        key: asset.key,
        loaded: [...completed.values()].reduce((sum, value) => sum + value, 0),
        total: expected + unknown,
      });
    }, {networkFirst: asset.networkFirst});
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

  const encoder = new lamejs.Mp3Encoder(1, sampleRate, config.mp3.bitRateKbps);
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
  requireConfigured();
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const started = performance.now();
    if (!downloadedAssets) throw new Error('請先下載模型');
    const decoder = new TextDecoder();
    const fstKeys = config.assets.fsts.map((_, index) => `fst${index}`);
    postProgress('建立文字前端、text-normalizer 與 ORT session');
    // ORT wasm 走了資產管線就直接注入,ORT 不再自己按 URL 抓(.mjs 仍由 ortWasmPaths.mjs 載入)。
    if (downloadedAssets.ortWasm) ort.env.wasm.wasmBinary = downloadedAssets.ortWasm.buffer;
    engine = await MatchaEngine.create({
      lexiconText: decoder.decode(downloadedAssets.lexicon.buffer),
      tokensText: decoder.decode(downloadedAssets.tokens.buffer),
      profile: JSON.parse(decoder.decode(downloadedAssets.profile.buffer)),
      fstBuffers: fstKeys.map((key) => downloadedAssets[key].buffer),
      kaldifstModuleFactory: KaldifstNormalizerModule,
      wasmUrl: config.kaldifstWasmUrl,
      ORT: ort,
      acousticModel: new Uint8Array(downloadedAssets.acoustic.buffer),
      vocoderModel: new Uint8Array(downloadedAssets.vocoder.buffer),
      synthesis: config.synthesis,
      pronunciationOverrides: config.pronunciationOverrides,
    });
    const sources = Object.fromEntries(
      Object.entries(downloadedAssets).map(([key, value]) => [key, value.source]),
    );
    // ORT session 建立後不再保留原始 ONNX buffers;手機第一句合成需要額外
    // tensor 空間,重複保留模型會造成不必要的記憶體壓力。
    downloadedAssets = null;
    // ORT 的 wasm 只在 backend 第一次初始化時讀一次,之後同樣放掉。
    ort.env.wasm.wasmBinary = undefined;

    postProgress('暖機文字前端、推論與 MP3 encoder');
    const warmup = await engine.synthesize(config.warmupText, {noiseScale: config.defaultNoiseScale});
    const warmupMp3 = encodeMp3(warmup.samples, warmup.sampleRate);
    const runtime = engine.ruleNormalizer.runtime;
    initialization = {
      wallMs: performance.now() - started,
      session: engine.session,
      sources,
      frontend: {
        lexiconSize: engine.info.lexiconSize,
        tokenCount: engine.info.tokenCount,
        inputNormalization: 'traditional-direct',
        fst: true,
        fstRuntime: config.versions.kaldifst
          ? `standalone kaldifst ${config.versions.kaldifst} + OpenFST WASM`
          : 'standalone kaldifst + OpenFST WASM',
        ruleFsts: config.assets.fsts.map((fst) => fst.label ?? fst.url.split('/').pop()),
        numericNormalization: 'sherpa zh rule FSTs applied by standalone kaldifst WASM',
        englishFrontend: false,
        contextualRules: engine.info.contextualRules,
        localOverrides: engine.info.localOverrides,
        profileSchemaVersion: engine.info.profileSchemaVersion,
      },
      warmup: {
        frontendMs: warmup.frontendMs,
        synthesisMs: warmup.wallMs,
        mp3Ms: warmupMp3.wallMs,
        audioSeconds: warmup.audioSeconds,
        mp3Bytes: warmupMp3.encoded.byteLength,
        waveform: warmup.waveform,
      },
      runtime: {
        ort: config.versions.ort ?? null,
        threads: config.ort.numThreads,
        textNormalizer: {
          kaldifst: config.versions.kaldifst ?? null,
          currentMemoryBytes: runtime?.HEAPU8?.buffer?.byteLength ?? null,
          separateLinearMemory: true,
        },
        mp3: `lamejs ${config.versions.lamejs ?? ''} / ${config.mp3.bitRateKbps} kbps`.replace('  ', ' '),
        synthesis: engine.info.synthesis,
      },
    };
    return initialization;
  })();
  return initPromise;
}

async function synthesize(message) {
  await initialize();
  postProgress(`合成第 ${message.requestId} 段：文字前端`);
  const totalStarted = performance.now();
  const noiseScale = Number.isFinite(message.noiseScale) ? message.noiseScale : config.defaultNoiseScale;
  const allowUnknown = message.allowUnknown !== false;
  const synthesis = await engine.synthesize(message.text, {noiseScale, allowUnknown});
  if (synthesis.empty) {
    postMessage({type: 'result', requestId: message.requestId, empty: true, meta: {text: message.text, normalizedText: synthesis.tokenized.normalizedText}});
    return;
  }
  postProgress(`合成第 ${message.requestId} 段：Matcha + Vocos 完成`);
  const format = message.format === 'pcm' ? 'pcm' : 'mp3';
  let buffer;
  let mp3 = null;
  if (format === 'mp3') {
    postProgress(`合成第 ${message.requestId} 段：MP3 encode`);
    mp3 = encodeMp3(synthesis.samples, synthesis.sampleRate);
    buffer = mp3.encoded.buffer;
  } else {
    buffer = synthesis.samples.buffer;
  }
  const result = {
    type: 'result',
    requestId: message.requestId,
    buffer,
    meta: {
      text: message.text,
      normalizedText: synthesis.tokenized.normalizedText,
      format,
      tokenCount: synthesis.tokenized.ids.length,
      phones: synthesis.tokenized.phones,
      unknown: synthesis.tokenized.unknown,
      sampleRate: synthesis.sampleRate,
      noiseScale: synthesis.noiseScale,
      audioSeconds: synthesis.audioSeconds,
      waveform: synthesis.waveform,
      mp3Bytes: mp3 ? mp3.encoded.byteLength : 0,
      phases: {
        frontendMs: synthesis.frontendMs,
        ...synthesis.phases,
        synthesisMs: synthesis.wallMs,
        mp3Ms: mp3 ? mp3.wallMs : 0,
        totalMs: performance.now() - totalStarted,
      },
    },
  };
  const transfer = [result.buffer];
  if (message.capturePcm && format === 'mp3') {
    result.pcmBuffer = synthesis.samples.buffer;
    transfer.push(result.pcmBuffer);
  }
  postMessage(result, transfer);
}

self.addEventListener('message', async (event) => {
  const message = event.data;
  try {
    if (message.type === 'configure') {
      postMessage(configure(message.config));
      return;
    }
    if (message.type === 'download-assets') {
      await downloadAssets();
      return;
    }
    if (message.type === 'init') {
      postMessage({type: 'ready', initialization: await initialize()});
      return;
    }
    if (message.type === 'synthesize') {
      await synthesize(message);
      return;
    }
    if (message.type === 'status') {
      postMessage(await status());
      return;
    }
    if (message.type === 'dispose') {
      engine?.dispose();
      engine = null;
      initPromise = null;
      initialization = null;
      downloadedAssets = null;
      postMessage({type: 'disposed'});
      return;
    }
    throw new Error(`未知的訊息類型：${message.type}`);
  } catch (error) {
    postMessage({
      type: 'error',
      action: message?.type,
      requestId: message?.requestId,
      message: error?.message ?? String(error),
      code: error?.code,
      stack: error?.stack ?? '',
      unknown: error?.unknown ?? [],
    });
  }
});
