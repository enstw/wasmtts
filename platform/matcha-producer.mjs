// 頁面端封裝:把 matcha-worker.js 包成 continuous-stream-player.mjs 需要的
// producer(`next({index, signal}) → {buffer, meta} | null`),並從
// matcha-assets.json 機械組出 Worker 的 configure config。本模組不碰 DOM;
// UI 透過 onEvent 回呼自行呈現。

// tarball 內 engine 檔案的固定檔名(release-manifest.json 的 basename)。
export const ENGINE_FILES = Object.freeze({
  frontend: 'matcha-frontend.js',
  profile: 'matcha-taiwan-profile.js',
  kaldifstGlue: 'kaldifst-normalizer.js',
  synthesis: 'matcha-synthesis.js',
  engine: 'matcha-engine.js',
  kaldifstModule: 'matcha-kaldifst-normalizer.js',
  kaldifstWasm: 'matcha-kaldifst-normalizer.wasm',
  profileRuntime: 'matcha-profile.runtime.json',
  lexicon: 'matcha-lexicon.txt',
  worker: 'matcha-worker.js',
});

// ORT 與 lamejs 在 matcha-assets.json runtime 區塊裡的檔案鍵。
export const RUNTIME_FILES = Object.freeze({
  ort: ['onnxruntime-web', 'dist/ort.wasm.min.js'],
  ortMjs: ['onnxruntime-web', 'dist/ort-wasm-simd-threaded.mjs'],
  ortWasm: ['onnxruntime-web', 'dist/ort-wasm-simd-threaded.wasm'],
  lamejs: ['lamejs', 'lame.min.js'],
});

const FST_ORDER = Object.freeze(['phone-zh.fst', 'date-zh.fst', 'number-zh.fst']);

function joinUrl(base, name) {
  if (typeof base !== 'string' || !base) throw new TypeError(`缺 base URL,無法解析 ${name}`);
  return `${base}${base.endsWith('/') ? '' : '/'}${name}`;
}

function runtimeEntry(assets, key) {
  const [pkg, file] = RUNTIME_FILES[key];
  const entry = assets.runtime?.[pkg]?.files?.[file];
  if (!entry?.packName) throw new Error(`matcha-assets.json 缺 runtime.${pkg}.files["${file}"]`);
  return {entry, version: assets.runtime[pkg].version};
}

// 從 matcha-assets.json 產生 Worker config。預設:
//   engine 檔(frontend/profile/synthesis/engine/kaldifst/profile runtime)→ engineBaseUrl + 檔名
//   lexicon/tokens/FST/模型 → assetBaseUrl + packName
//   ORT/lamejs → runtimeBaseUrl + runtime packName
// overrides 以 key 覆寫任一 URL:scripts.*、ortWasmPaths、kaldifstWasmUrl、
// lexicon、profile、tokens、fsts[]、acoustic、vocoder。
export function workerConfigFromAssets({
  assets,
  engineBaseUrl,
  assetBaseUrl,
  runtimeBaseUrl,
  overrides = {},
  cacheName,
  mp3,
  ort,
  defaultNoiseScale,
  versions = {},
  synthesis,
}) {
  if (assets?.schemaVersion !== 4) throw new Error(`matcha-assets.json schemaVersion ${assets?.schemaVersion} — 本 producer 只認 4`);
  if (!assets.lexicon?.packName) throw new Error('matcha-assets.json 缺 lexicon 區塊(需先 pnpm lexicon:build 的產物)');
  const engineFile = (key) => overrides.scripts?.[key] ?? joinUrl(engineBaseUrl, ENGINE_FILES[key]);
  const pack = (entry, label) => {
    if (!entry?.packName) throw new Error(`matcha-assets.json 缺 ${label} 的 packName`);
    return joinUrl(assetBaseUrl, entry.packName);
  };
  const ortMain = runtimeEntry(assets, 'ort');
  const ortMjs = runtimeEntry(assets, 'ortMjs');
  const ortWasm = runtimeEntry(assets, 'ortWasm');
  const lame = runtimeEntry(assets, 'lamejs');
  const fsts = FST_ORDER.map((file, index) => {
    const entry = assets.matcha?.files?.[file];
    return {
      url: overrides.fsts?.[index] ?? pack(entry, file),
      bytes: entry?.bytes,
      label: file,
    };
  });
  return {
    scripts: {
      ort: overrides.scripts?.ort ?? joinUrl(runtimeBaseUrl, ortMain.entry.packName),
      lamejs: overrides.scripts?.lamejs ?? joinUrl(runtimeBaseUrl, lame.entry.packName),
      kaldifstModule: engineFile('kaldifstModule'),
      frontend: engineFile('frontend'),
      profile: engineFile('profile'),
      kaldifstGlue: engineFile('kaldifstGlue'),
      synthesis: engineFile('synthesis'),
      engine: engineFile('engine'),
    },
    ortWasmPaths: overrides.ortWasmPaths ?? {
      mjs: joinUrl(runtimeBaseUrl, ortMjs.entry.packName),
      wasm: joinUrl(runtimeBaseUrl, ortWasm.entry.packName),
    },
    kaldifstWasmUrl: overrides.kaldifstWasmUrl ?? joinUrl(engineBaseUrl, ENGINE_FILES.kaldifstWasm),
    assets: {
      lexicon: {url: overrides.lexicon ?? pack(assets.lexicon, 'lexicon'), bytes: assets.lexicon.bytes, networkFirst: true},
      profile: {url: overrides.profile ?? joinUrl(engineBaseUrl, ENGINE_FILES.profileRuntime), networkFirst: true},
      tokens: {url: overrides.tokens ?? pack(assets.matcha?.files?.['tokens.txt'], 'tokens.txt'), bytes: assets.matcha?.files?.['tokens.txt']?.bytes},
      fsts,
      acoustic: {url: overrides.acoustic ?? pack(assets.acoustic, 'acoustic'), bytes: assets.acoustic?.bytes},
      vocoder: {url: overrides.vocoder ?? pack(assets.vocos, 'vocos'), bytes: assets.vocos?.bytes},
    },
    ...(cacheName ? {cacheName} : {}),
    ...(mp3 ? {mp3} : {}),
    ...(ort ? {ort} : {}),
    ...(Number.isFinite(defaultNoiseScale) ? {defaultNoiseScale} : {}),
    synthesis: synthesis ?? assets.synthesis ?? {},
    versions: {ort: ortMain.version, lamejs: lame.version, ...versions},
  };
}

// 長篇文字切句:句末標點後切,過長句再以逗號切段。
export function splitSentences(text, {maxLength = 72, subLength = 60} = {}) {
  const compact = String(text ?? '').replace(/\r/gu, '').trim();
  if (!compact) return [];
  const sentences = compact.match(/[^。！？!?；;\n]+[。！？!?；;]?[」』”’）》】]*/gu)
    ?.map((sentence) => sentence.trim())
    .filter(Boolean) ?? [];
  const subPattern = new RegExp(`.{1,${subLength}}(?:[，,、]|$)`, 'gu');
  return sentences.flatMap((sentence) => {
    if (sentence.length <= maxLength) return [sentence];
    const parts = sentence.match(subPattern)?.map((part) => part.trim()).filter(Boolean);
    return parts?.length ? parts : [sentence];
  });
}

function abortError() {
  return new DOMException('已停止', 'AbortError');
}

export function createMatchaProducer({
  workerUrl,
  config,
  loop = false,
  noiseScale,
  format = 'mp3',
  onEvent = () => {},
  workerOptions = {},
}) {
  if (!workerUrl) throw new TypeError('createMatchaProducer 需要 workerUrl');
  if (!config?.scripts) throw new TypeError('createMatchaProducer 需要 config(workerConfigFromAssets 的結果)');
  const worker = new Worker(workerUrl, workerOptions);
  const pending = new Map();
  const state = {
    segments: [],
    cursor: 0,
    nextRequestId: 1,
    results: [],
    initialization: null,
    downloaded: false,
    configured: false,
    noiseScale,
  };
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  ready.catch(() => {});
  let resolveDownloaded;
  let rejectDownloaded;
  const downloadedPromise = new Promise((resolve, reject) => {
    resolveDownloaded = resolve;
    rejectDownloaded = reject;
  });
  downloadedPromise.catch(() => {});

  function emit(event) {
    try {
      onEvent(event);
    } catch {
      // UI 回呼失敗不得影響合成。
    }
  }

  worker.addEventListener('error', (event) => {
    const error = new Error(event.message || 'wasmtts Worker 啟動失敗');
    rejectReady(error);
    rejectDownloaded(error);
    emit({type: 'error', action: 'worker', message: error.message});
  });
  worker.addEventListener('message', (event) => {
    const message = event.data;
    switch (message.type) {
      case 'configured':
        state.configured = true;
        emit(message);
        return;
      case 'progress':
      case 'download-progress':
        emit(message);
        return;
      case 'download-complete':
        state.downloaded = true;
        resolveDownloaded(message.sources);
        emit(message);
        return;
      case 'ready':
        state.initialization = message.initialization;
        resolveReady(message.initialization);
        emit(message);
        return;
      case 'disposed':
        emit(message);
        return;
      default:
        break;
    }
    if (message.type === 'error' && message.requestId === undefined) {
      if (message.action === 'init' || message.action === 'configure') rejectReady(new Error(message.message));
      if (message.action === 'download-assets' || message.action === 'configure') rejectDownloaded(new Error(message.message));
      emit(message);
      return;
    }
    const request = pending.get(message.requestId);
    if (!request) return;
    pending.delete(message.requestId);
    request.cleanup();
    if (message.type === 'error') {
      request.reject(Object.assign(new Error(message.message), {unknown: message.unknown ?? []}));
      return;
    }
    if (!message.empty) state.results.push(message.meta);
    request.resolve(message);
  });

  worker.postMessage({type: 'configure', config});

  function request(payload, signal) {
    const requestId = state.nextRequestId;
    state.nextRequestId += 1;
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        pending.delete(requestId);
        reject(abortError());
      };
      signal?.addEventListener('abort', onAbort, {once: true});
      pending.set(requestId, {
        resolve,
        reject,
        cleanup: () => signal?.removeEventListener('abort', onAbort),
      });
      worker.postMessage({type: 'synthesize', requestId, format, ...payload});
    });
  }

  async function synthesize(text, {noiseScale: requestNoise, capturePcm = false, signal} = {}) {
    await ready;
    if (signal?.aborted) throw abortError();
    const message = await request({
      text,
      noiseScale: Number.isFinite(requestNoise) ? requestNoise : state.noiseScale,
      capturePcm,
    }, signal);
    return {buffer: message.buffer, pcmBuffer: message.pcmBuffer, meta: message.meta, empty: message.empty === true};
  }

  // player 契約:逐句回傳可 append 的音訊;句子用盡回 null(loop 時循環)。
  // 空句(只有標點)不佔 timeline,直接跳到下一句。
  async function next({index = state.cursor, signal} = {}) {
    await ready;
    while (true) {
      if (signal?.aborted) throw abortError();
      const total = state.segments.length;
      if (!total) return null;
      if (state.cursor >= total && !loop) return null;
      const sentenceIndex = state.cursor % total;
      const chapter = Math.floor(state.cursor / total) + 1;
      state.cursor += 1;
      const unit = await synthesize(state.segments[sentenceIndex], {signal});
      if (unit.empty) continue;
      return {
        buffer: unit.buffer,
        pcmBuffer: unit.pcmBuffer,
        meta: {...unit.meta, index, sentence: sentenceIndex + 1, chapter},
      };
    }
  }

  return {
    worker,
    ready,
    get initialization() {
      return state.initialization;
    },
    get downloaded() {
      return state.downloaded;
    },
    get results() {
      return state.results;
    },
    get segments() {
      return state.segments;
    },
    // 兩者都回 promise:下載失敗／初始化失敗會 reject,呼叫端不必輪詢旗標。
    download() {
      if (!state.downloaded) worker.postMessage({type: 'download-assets'});
      return downloadedPromise;
    },
    initialize() {
      if (!state.initialization) worker.postMessage({type: 'init'});
      return ready;
    },
    setText(text, options) {
      return this.setSegments(splitSentences(text, options));
    },
    setSegments(segments) {
      state.segments = [...segments].map((segment) => String(segment)).filter((segment) => segment.trim());
      state.cursor = 0;
      state.results = [];
      return state.segments.length;
    },
    setNoiseScale(value) {
      state.noiseScale = Number.isFinite(value) ? value : undefined;
    },
    rewind() {
      state.cursor = 0;
    },
    synthesize,
    next,
    dispose() {
      for (const [, entry] of pending) entry.reject(abortError());
      pending.clear();
      worker.postMessage({type: 'dispose'});
      worker.terminate();
    },
  };
}
