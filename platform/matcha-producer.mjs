// 頁面端封裝:把 matcha-worker.js 包成 continuous-stream-player.mjs 需要的
// producer(`next({index, signal}) → {buffer, meta} | null`),並從
// matcha-assets.json 機械組出 Worker 的 configure config。本模組不碰 DOM;
// UI 透過 onEvent 回呼自行呈現。
//
// 閱讀器契約(下游實機紀錄要求):
// - 每個音訊單位帶原文字元區間 meta.start/end(與 setSegments 給的 offset 同
//   座標),空句或不可讀句不佔 timeline、其 span 折入下一單位,對應永遠連續。
// - 切句 walk(ENDERS／CLOSERS)是唯一來源:sentenceSpans、sentenceStartFor、
//   sentenceEndFor 用同一個 walk,下游畫高亮與上游切音訊不會互相漂移。
// - seekTo(offset) 只從「含該 offset 的那句」起合成;more() 讓句子用盡時向
//   host 要下一章,timeline 不 endOfStream;meta.tag 原樣回傳給 host。
// - restore(tag) 讓 player 跨章重建(⏮ 回前一章、看門狗)時把那章要回來;
//   tag 是段落集合的身分,chapter 只是交給 producer 的段落集合計數。
// - packStatus(config) 在主執行緒、不開 Worker 就回答快取齊不齊(與 Worker 同一份
//   assetListFromConfig);prime() 在 ▶ 之前先把含書籤那句合成好,第一聲不用等;
//   minUnitChars(opt-in)把相鄰短句併成一個單位,接縫停頓交給模型自己。

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
export const DEFAULT_CACHE_NAME = 'wasmtts-assets-v1'; // 與 matcha-worker.js DEFAULTS.cacheName 相同

// Worker 的資產清單(與 matcha-worker.js assetList 同一份推導;Worker 是 classic script
// 不能 import,測試以 vm 驗兩者逐項一致)。只有這份清單裡的東西會被下載、計入 status、
// 留在 keep-set 清掃之後。
export function assetListFromConfig(config) {
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

// 不開 Worker 就回答 pack 狀態(主執行緒、只用 Cache API):形狀同 Worker 的 status()
// (少 downloaded)。cache key 是絕對 URL,config 的 URL 應為絕對或根相對,主執行緒與
// Worker 才會解析到同一個 key。
export async function packStatus(config, {caches = globalThis.caches, baseUrl = globalThis.location?.href} = {}) {
  if (!config?.assets) throw new TypeError('packStatus 需要 workerConfigFromAssets 的結果');
  const cache = caches ? await caches.open(config.cacheName ?? DEFAULT_CACHE_NAME) : null;
  const assets = [];
  for (const asset of assetListFromConfig(config)) {
    const absolute = /^https?:/u.test(asset.url) || !baseUrl ? asset.url : new URL(asset.url, baseUrl).href;
    const cached = cache ? Boolean(await cache.match(absolute)) : false;
    assets.push({key: asset.key, url: asset.url, label: asset.label, cached, bytes: Number.isFinite(asset.bytes) ? asset.bytes : null});
  }
  const sum = (list) => list.reduce((total, asset) => total + (asset.bytes ?? 0), 0);
  return {
    cacheStorage: Boolean(cache),
    assets,
    cachedBytes: sum(assets.filter((asset) => asset.cached)),
    missingBytes: sum(assets.filter((asset) => !asset.cached)),
    complete: assets.every((asset) => asset.cached),
  };
}

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
// lexicon、profile、tokens、fsts[]、acoustic、vocoder。labels 以資產 key(lexicon、
// profile、tokens、phone-zh.fst…、ortWasm、acoustic、vocoder)覆寫顯示名。
// ortWasm(預設 true)把 ORT 的 wasm 列為資產;bytes／sha256 取自 manifest,覆寫成
// 別的檔案時請給 ortWasm: false 交回 ORT 自己抓。
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
  pronunciationOverrides,
  networkTimeoutMs,
  progressEvents,
  labels = {},
  ortWasm = true,
}) {
  if (assets?.schemaVersion !== 4) throw new Error(`matcha-assets.json schemaVersion ${assets?.schemaVersion} — 本 producer 只認 4`);
  // 同名兩形的陷阱:git tree 的 platform/matcha-assets.source.json(stage: source)沒有
  // lexicon／runtime 區塊;只有 tarball 內 pnpm lexicon:build 產出的檔是 stage: complete。
  if (assets.stage !== 'complete') {
    throw new Error(`matcha-assets.json stage=${JSON.stringify(assets.stage)} — 請使用 tarball 內 stage: complete 的檔,不是 repo 裡的 matcha-assets.source.json`);
  }
  if (!assets.lexicon?.packName) throw new Error('matcha-assets.json 缺 lexicon 區塊(需先 pnpm lexicon:build 的產物)');
  const engineFile = (key) => overrides.scripts?.[key] ?? joinUrl(engineBaseUrl, ENGINE_FILES[key]);
  const pack = (entry, label) => {
    if (!entry?.packName) throw new Error(`matcha-assets.json 缺 ${label} 的 packName`);
    return joinUrl(assetBaseUrl, entry.packName);
  };
  const ortMain = runtimeEntry(assets, 'ort');
  const ortMjs = runtimeEntry(assets, 'ortMjs');
  const ortWasmEntry = runtimeEntry(assets, 'ortWasm');
  const lame = runtimeEntry(assets, 'lamejs');
  const ortWasmPaths = overrides.ortWasmPaths ?? {
    mjs: joinUrl(runtimeBaseUrl, ortMjs.entry.packName),
    wasm: joinUrl(runtimeBaseUrl, ortWasmEntry.entry.packName),
  };
  const ortWasmUrl = typeof ortWasmPaths === 'string' ? joinUrl(ortWasmPaths, ortWasmEntry.entry.packName) : ortWasmPaths?.wasm;
  const lexiconUrl = overrides.lexicon ?? pack(assets.lexicon, 'lexicon');
  const label = (key) => (labels[key] ? {label: labels[key]} : {});
  const fsts = FST_ORDER.map((file, index) => {
    const entry = assets.matcha?.files?.[file];
    return {
      url: overrides.fsts?.[index] ?? pack(entry, file),
      bytes: entry?.bytes,
      label: labels[file] ?? file,
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
    ortWasmPaths,
    kaldifstWasmUrl: overrides.kaldifstWasmUrl ?? joinUrl(engineBaseUrl, ENGINE_FILES.kaldifstWasm),
    assets: {
      // lexicon packName 含內容 hash,同名即同 bytes → cache-first;覆寫成沒有 hash 的 URL 才 network-first。
      lexicon: {url: lexiconUrl, bytes: assets.lexicon.bytes, networkFirst: !lexiconUrl.endsWith(assets.lexicon.packName), ...label('lexicon')},
      profile: {url: overrides.profile ?? joinUrl(engineBaseUrl, ENGINE_FILES.profileRuntime), networkFirst: true, ...label('profile')},
      tokens: {url: overrides.tokens ?? pack(assets.matcha?.files?.['tokens.txt'], 'tokens.txt'), bytes: assets.matcha?.files?.['tokens.txt']?.bytes, ...label('tokens')},
      fsts,
      acoustic: {url: overrides.acoustic ?? pack(assets.acoustic, 'acoustic'), bytes: assets.acoustic?.bytes, ...label('acoustic')},
      vocoder: {url: overrides.vocoder ?? pack(assets.vocos, 'vocos'), bytes: assets.vocos?.bytes, ...label('vocoder')},
      // ORT 的 wasm 一律走 Worker 的資產管線(status() 算得到、keep-set 清掃認得),init 時以
      // ort.env.wasm.wasmBinary 注入;不靠 URL 後綴推斷,要 opt-out 才給 ortWasm: false。
      ...(ortWasm && typeof ortWasmUrl === 'string' ? {ortWasm: {
        url: ortWasmUrl,
        bytes: ortWasmEntry.entry.bytes,
        ...(ortWasmEntry.entry.sha256 ? {sha256: ortWasmEntry.entry.sha256} : {}),
        ...label('ortWasm'),
      }} : {}),
    },
    ...(cacheName ? {cacheName} : {}),
    ...(mp3 ? {mp3} : {}),
    ...(ort ? {ort} : {}),
    ...(Number.isFinite(defaultNoiseScale) ? {defaultNoiseScale} : {}),
    ...(Number.isFinite(networkTimeoutMs) ? {networkTimeoutMs} : {}),
    ...(progressEvents !== undefined ? {progressEvents: Boolean(progressEvents)} : {}),
    synthesis: synthesis ?? assets.synthesis ?? {},
    // 下游本地讀音暫存層(尚未進 review 的聽測修正),原樣交給 Worker → MatchaEngine.create。
    ...(pronunciationOverrides ? {pronunciationOverrides} : {}),
    versions: {ort: ortMain.version, lamejs: lame.version, ...versions},
  };
}

// ---- 切句 walk(唯一來源)------------------------------------------------
// 句尾:。！？；與換行;句尾後把右引號／括號吸進同一句,句子才不會以「」開頭。
export const ENDERS = '。！？；\n';
export const CLOSERS = '」』”’）)】';
const DEFAULT_PAUSES = '，、：,;';

// 逐句 walk:以 callback 回報每個 [start, end) 原始區間(含空白 span)。
function walkSentences(text, onSpan) {
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (!ENDERS.includes(text[i])) continue;
    let end = i + 1;
    while (end < text.length && CLOSERS.includes(text[end])) end += 1;
    onSpan(start, end);
    start = end;
    i = end - 1;
  }
  if (start < text.length) onSpan(start, text.length);
}

// 原文 → [{start, end, text}]:span 連續且覆蓋 [0, text.length),不 trim 原文
// (offset 座標與呼叫端一致);whitespace-only span 併入前一段(第一段則併入
// 下一段);超長句在 pauses 次切(長度 ≥ subLength 才切),maxLength 硬切。
export function sentenceSpans(text, {maxLength = 72, subLength = 60, pauses = DEFAULT_PAUSES} = {}) {
  const source = String(text ?? '');
  const raw = [];
  walkSentences(source, (start, end) => {
    if (end - start <= maxLength) {
      raw.push([start, end]);
      return;
    }
    let cut = start;
    for (let i = start; i < end; i += 1) {
      if ((pauses.includes(source[i]) && i + 1 - cut >= subLength) || i + 1 - cut >= maxLength) {
        raw.push([cut, i + 1]);
        cut = i + 1;
      }
    }
    if (cut < end) raw.push([cut, end]);
  });
  const spans = [];
  let pendingStart = -1;
  for (const [start, end] of raw) {
    if (!source.slice(start, end).trim()) {
      // 空白 span:併入前一段;沒有前一段時記下起點,併入下一段。
      if (spans.length) spans[spans.length - 1].end = end;
      else if (pendingStart < 0) pendingStart = start;
      continue;
    }
    const spanStart = pendingStart >= 0 ? pendingStart : start;
    pendingStart = -1;
    spans.push({start: spanStart, end});
  }
  if (pendingStart >= 0 && spans.length === 0) spans.push({start: pendingStart, end: source.length});
  return spans.map((span) => ({...span, text: source.slice(span.start, span.end)}));
}

// 含原始 index i 的那句的起點／終點;與 sentenceSpans 用同一個 walk,
// 「唱到哪、畫到哪」永遠一致。
export function sentenceStartFor(text, i) {
  const source = String(text ?? '');
  let result = 0;
  walkSentences(source, (start, end) => {
    if (start <= i && i < end) result = start;
  });
  return result;
}

export function sentenceEndFor(text, i) {
  const source = String(text ?? '');
  let result = source.length;
  let found = false;
  walkSentences(source, (start, end) => {
    if (!found && start <= i && i < end) {
      result = end;
      found = true;
    }
  });
  return result;
}

// 含字元 offset 的 span 索引(夾在合法範圍內)。
export function chunkIndexFor(spans, offset) {
  let index = 0;
  for (let i = 0; i < spans.length; i += 1) {
    if (spans[i].start <= offset) index = i;
    else break;
  }
  return index;
}

// 相容包裝:只要句子文字。
export function splitSentences(text, options) {
  return sentenceSpans(text, options).map((span) => span.text.trim()).filter(Boolean);
}

function abortError() {
  return new DOMException('已停止', 'AbortError');
}

function normalizeSegments(list, tag) {
  let offset = 0;
  const segments = [];
  for (const item of list) {
    const segment = typeof item === 'string'
      ? {text: item, start: offset, end: offset + item.length}
      : {text: String(item.text ?? ''), start: item.start ?? offset, end: item.end ?? (item.start ?? offset) + String(item.text ?? '').length, tag: item.tag};
    if (segment.tag === undefined) segment.tag = tag;
    offset = segment.end;
    segments.push(segment);
  }
  return segments;
}

export function createMatchaProducer({
  workerUrl,
  config,
  loop = false,
  more = null,
  restore = null,
  allowUnknown = true,
  minUnitChars = 0, // > 0:相鄰短句併成一個單位(總長 < minUnitChars 就繼續併,不超過 maxUnitChars)
  maxUnitChars = 72,
  noiseScale,
  format = 'mp3',
  onEvent = () => {},
  workerOptions = {},
}) {
  if (!workerUrl) throw new TypeError('createMatchaProducer 需要 workerUrl');
  if (!config?.scripts) throw new TypeError('createMatchaProducer 需要 config(workerConfigFromAssets 的結果)');
  if (more !== null && typeof more !== 'function') throw new TypeError('more 必須是 async 函式或 null');
  if (restore !== null && typeof restore !== 'function') throw new TypeError('restore 必須是 async 函式或 null');
  if (!(minUnitChars >= 0) || !(maxUnitChars > 0)) throw new TypeError('minUnitChars 須 ≥ 0、maxUnitChars 須 > 0');
  const worker = new Worker(workerUrl, workerOptions);
  const pending = new Map();
  const state = {
    segments: [],
    tag: undefined,
    cursor: 0,
    chapter: 1,
    held: -1, // 折入下一單位的 span 起點(空句／不可讀句)
    nextRequestId: 1,
    results: [],
    skipped: 0,
    primed: null, // prime() 先合成好的單位:{generation, promise}
    cursorGeneration: 0, // 任何外部移動 cursor／換段落都 +1,primed 隨之失效
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
  const statusWaiters = [];

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
      case 'cache-swept':
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
      case 'status':
        while (statusWaiters.length) statusWaiters.shift().resolve(message);
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
      if (message.action === 'status') while (statusWaiters.length) statusWaiters.shift().reject(new Error(message.message));
      emit(message);
      return;
    }
    const request = pending.get(message.requestId);
    if (!request) return;
    pending.delete(message.requestId);
    request.cleanup();
    if (message.type === 'error') {
      request.reject(Object.assign(new Error(message.message), {unknown: message.unknown ?? [], code: message.code}));
      return;
    }
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
      worker.postMessage({type: 'synthesize', requestId, format, allowUnknown, ...payload});
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

  function setSegments(list, {tag} = {}) {
    state.segments = normalizeSegments([...list].filter((item) => (typeof item === 'string' ? item.trim() : String(item?.text ?? '').trim())), tag);
    state.tag = tag;
    state.cursor = 0;
    state.held = -1;
    state.results = [];
    return state.segments.length;
  }

  // 外部移動 cursor／換段落:prime() 先合成好的單位不再對應 cursor,作廢。
  function invalidatePrimed() {
    state.cursorGeneration += 1;
    state.primed = null;
  }

  // 句子用盡:先問 host 要下一段(下一章);host 回 null 才結束(loop 則回頭)。
  async function replenish() {
    if (more) {
      const next = await more({tag: state.tag, lastIndex: state.segments.length - 1, chapter: state.chapter});
      if (next) {
        const list = Array.isArray(next) ? next : next.segments;
        const tag = Array.isArray(next) ? undefined : next.tag;
        if (Array.isArray(list) && list.length) {
          const held = state.held;
          setSegments(list, {tag});
          state.held = -1; // 新段落座標不同,折入的 span 不跨段
          if (held >= 0) emit({type: 'skipped-span-dropped', start: held});
          state.chapter += 1;
          return true;
        }
      }
    }
    if (loop && state.segments.length) {
      state.cursor = 0;
      state.chapter += 1;
      return true;
    }
    return false;
  }

  // 從 cursor 取一個單位的句子:預設一句;minUnitChars > 0 時相鄰短句併成一單位
  // (併到總長 ≥ minUnitChars 為止,且不超過 maxUnitChars),接縫停頓交給模型自己。
  function takeSegments() {
    const first = state.cursor;
    let end = first + 1;
    if (minUnitChars > 0) {
      let chars = state.segments[first].text.length;
      while (chars < minUnitChars && end < state.segments.length && chars + state.segments[end].text.length <= maxUnitChars) {
        chars += state.segments[end].text.length;
        end += 1;
      }
    }
    state.cursor = end;
    return state.segments.slice(first, end);
  }

  // 合成下一個單位(不記入 results):句子用盡回 null。
  // 空句／不可讀句不佔 timeline,其 span 折入下一單位,對應永遠連續。
  async function produceUnit(signal) {
    while (true) {
      if (signal?.aborted) throw abortError();
      if (state.cursor >= state.segments.length) {
        if (!(await replenish())) return null;
        continue;
      }
      const sentenceIndex = state.cursor;
      const group = takeSegments();
      const first = group[0];
      const last = group[group.length - 1];
      const text = group.map((segment) => segment.text).join('');
      const skipMeta = {index: sentenceIndex, sentences: group.length, start: first.start, end: last.end, tag: first.tag, text};
      let unit;
      try {
        unit = await synthesize(text, {signal});
      } catch (error) {
        if (error?.name === 'AbortError') throw error;
        // 單句失敗(無聲、NaN、未知字過多…)跳過;只有 init／worker 失敗才 reject ready。
        state.skipped += 1;
        if (state.held < 0) state.held = first.start;
        emit({type: 'skipped', reason: 'error', error: error.message, code: error.code, meta: skipMeta});
        continue;
      }
      if (unit.empty) {
        state.skipped += 1;
        if (state.held < 0) state.held = first.start;
        emit({type: 'skipped', reason: 'empty', meta: skipMeta});
        continue;
      }
      const start = state.held >= 0 ? state.held : first.start;
      state.held = -1;
      const meta = {
        ...unit.meta,
        index: sentenceIndex,
        sentence: sentenceIndex + 1,
        sentences: group.length,
        chapter: state.chapter,
        start,
        end: last.end,
        tag: first.tag,
      };
      return {buffer: unit.buffer, pcmBuffer: unit.pcmBuffer, meta};
    }
  }

  // player 契約:逐單位回傳可 append 的音訊;句子用盡回 null。
  // prime() 先合成好的單位(cursor 未被外部動過)直接交出,第一聲不用等。
  async function next({index, signal} = {}) {
    await ready;
    const primed = state.primed?.generation === state.cursorGeneration ? state.primed : null;
    state.primed = null;
    const unit = primed ? await primed.promise : await produceUnit(signal);
    if (!unit) return null;
    unit.meta.playerIndex = index;
    state.results.push(unit.meta); // results = 實際交給 player 的單位(含字元區間)
    return unit;
  }

  // ▶ 之前先把 cursor 那個單位合成好(不 append);回該單位的 meta,句子用盡回 null。
  // 之後任何 seekTo／setCursor／setSegments／restore 都會讓它作廢。
  async function prime({offset, signal} = {}) {
    await ready;
    if (Number.isFinite(offset)) seekTo(offset);
    if (state.primed?.generation === state.cursorGeneration) return (await state.primed.promise)?.meta ?? null;
    const primed = {generation: state.cursorGeneration, promise: produceUnit(signal)};
    primed.promise.catch(() => {});
    state.primed = primed;
    const unit = await primed.promise;
    return unit?.meta ?? null;
  }

  function seekTo(offset) {
    invalidatePrimed();
    if (!state.segments.length) return 0;
    state.cursor = chunkIndexFor(state.segments, offset);
    state.held = -1;
    return state.cursor;
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
    get cursor() {
      return state.cursor;
    },
    get tag() {
      return state.tag;
    },
    get skipped() {
      return state.skipped;
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
    // 不下載就能回答:每個資產 cached／bytes、缺幾 bytes;呼叫端據此決定要不要問使用者。
    status() {
      return new Promise((resolve, reject) => {
        statusWaiters.push({resolve, reject});
        worker.postMessage({type: 'status'});
      });
    },
    setText(text, {tag, ...spanOptions} = {}) {
      invalidatePrimed();
      return setSegments(sentenceSpans(text, spanOptions), {tag});
    },
    setSegments(list, options) {
      invalidatePrimed();
      return setSegments(list, options);
    },
    // 從任意字元位置開始:只合成含該 offset 的那句起。
    seekTo,
    setCursor(index) {
      invalidatePrimed();
      state.cursor = Math.max(0, Math.min(state.segments.length, Math.trunc(index)));
      state.held = -1;
      return state.cursor;
    },
    prime,
    // 把某個 tag 的段落要回來(player 跨章重建用):已在該 tag 就不動;否則問 host 的
    // restore(tag),回 {segments, tag} 或陣列;沒有 hook 或 host 給不出來就 throw,
    // player 據此明確失敗,不會默默在錯章的同序句重建。
    async restore(tag) {
      if (state.segments.length && state.tag === tag) return state.segments.length;
      if (!restore) throw new Error(`producer 已在 tag=${JSON.stringify(state.tag)},沒有 restore hook 可取回 tag=${JSON.stringify(tag)}`);
      const next = await restore(tag);
      const list = Array.isArray(next) ? next : next?.segments;
      if (!Array.isArray(list) || !list.length) throw new Error(`restore(${JSON.stringify(tag)}) 沒有回段落`);
      invalidatePrimed();
      return setSegments(list, {tag: Array.isArray(next) ? tag : (next.tag ?? tag)});
    },
    setNoiseScale(value) {
      state.noiseScale = Number.isFinite(value) ? value : undefined;
    },
    rewind() {
      invalidatePrimed();
      state.cursor = 0;
      state.held = -1;
    },
    synthesize,
    next,
    dispose() {
      for (const [, entry] of pending) entry.reject(abortError());
      pending.clear();
      while (statusWaiters.length) statusWaiters.shift().reject(abortError());
      worker.postMessage({type: 'dispose'});
      worker.terminate();
    },
  };
}
