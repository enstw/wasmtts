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
  pronunciationOverrides,
  networkTimeoutMs,
  progressEvents,
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
  const ortWasm = runtimeEntry(assets, 'ortWasm');
  const lame = runtimeEntry(assets, 'lamejs');
  const ortWasmPaths = overrides.ortWasmPaths ?? {
    mjs: joinUrl(runtimeBaseUrl, ortMjs.entry.packName),
    wasm: joinUrl(runtimeBaseUrl, ortWasm.entry.packName),
  };
  const lexiconUrl = overrides.lexicon ?? pack(assets.lexicon, 'lexicon');
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
    ortWasmPaths,
    kaldifstWasmUrl: overrides.kaldifstWasmUrl ?? joinUrl(engineBaseUrl, ENGINE_FILES.kaldifstWasm),
    assets: {
      // lexicon packName 含內容 hash,同名即同 bytes → cache-first;覆寫成沒有 hash 的 URL 才 network-first。
      lexicon: {url: lexiconUrl, bytes: assets.lexicon.bytes, networkFirst: !lexiconUrl.endsWith(assets.lexicon.packName)},
      profile: {url: overrides.profile ?? joinUrl(engineBaseUrl, ENGINE_FILES.profileRuntime), networkFirst: true},
      tokens: {url: overrides.tokens ?? pack(assets.matcha?.files?.['tokens.txt'], 'tokens.txt'), bytes: assets.matcha?.files?.['tokens.txt']?.bytes},
      fsts,
      acoustic: {url: overrides.acoustic ?? pack(assets.acoustic, 'acoustic'), bytes: assets.acoustic?.bytes},
      vocoder: {url: overrides.vocoder ?? pack(assets.vocos, 'vocos'), bytes: assets.vocos?.bytes},
      // ORT 的 wasm 也走 Worker 的資產管線(status() 算得到、keep-set 清掃認得),init 時以
      // ort.env.wasm.wasmBinary 注入;ortWasmPaths 覆寫成字串前綴時交回 ORT 自己抓。
      ...(typeof ortWasmPaths?.wasm === 'string' ? {ortWasm: {
        url: ortWasmPaths.wasm,
        bytes: ortWasmPaths.wasm.endsWith(ortWasm.entry.packName) ? ortWasm.entry.bytes : undefined,
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
  noiseScale,
  format = 'mp3',
  onEvent = () => {},
  workerOptions = {},
}) {
  if (!workerUrl) throw new TypeError('createMatchaProducer 需要 workerUrl');
  if (!config?.scripts) throw new TypeError('createMatchaProducer 需要 config(workerConfigFromAssets 的結果)');
  if (more !== null && typeof more !== 'function') throw new TypeError('more 必須是 async 函式或 null');
  if (restore !== null && typeof restore !== 'function') throw new TypeError('restore 必須是 async 函式或 null');
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

  // player 契約:逐句回傳可 append 的音訊;句子用盡回 null。
  // 空句／不可讀句不佔 timeline,其 span 折入下一單位,對應永遠連續。
  async function next({index, signal} = {}) {
    await ready;
    while (true) {
      if (signal?.aborted) throw abortError();
      if (state.cursor >= state.segments.length) {
        if (!(await replenish())) return null;
        continue;
      }
      const sentenceIndex = state.cursor;
      const segment = state.segments[sentenceIndex];
      state.cursor += 1;
      let unit;
      try {
        unit = await synthesize(segment.text, {signal});
      } catch (error) {
        if (error?.name === 'AbortError') throw error;
        // 單句失敗(無聲、NaN、未知字過多…)跳過;只有 init／worker 失敗才 reject ready。
        state.skipped += 1;
        if (state.held < 0) state.held = segment.start;
        emit({type: 'skipped', reason: 'error', error: error.message, code: error.code, meta: {index: sentenceIndex, start: segment.start, end: segment.end, tag: segment.tag, text: segment.text}});
        continue;
      }
      if (unit.empty) {
        state.skipped += 1;
        if (state.held < 0) state.held = segment.start;
        emit({type: 'skipped', reason: 'empty', meta: {index: sentenceIndex, start: segment.start, end: segment.end, tag: segment.tag, text: segment.text}});
        continue;
      }
      const start = state.held >= 0 ? state.held : segment.start;
      state.held = -1;
      const meta = {
        ...unit.meta,
        index: sentenceIndex,
        playerIndex: index,
        sentence: sentenceIndex + 1,
        chapter: state.chapter,
        start,
        end: segment.end,
        tag: segment.tag,
      };
      state.results.push(meta); // results = 實際交給 player 的單位(含字元區間)
      return {buffer: unit.buffer, pcmBuffer: unit.pcmBuffer, meta};
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
      return setSegments(sentenceSpans(text, spanOptions), {tag});
    },
    setSegments,
    // 從任意字元位置開始:只合成含該 offset 的那句起。
    seekTo(offset) {
      if (!state.segments.length) return 0;
      state.cursor = chunkIndexFor(state.segments, offset);
      state.held = -1;
      return state.cursor;
    },
    setCursor(index) {
      state.cursor = Math.max(0, Math.min(state.segments.length, Math.trunc(index)));
      state.held = -1;
      return state.cursor;
    },
    // 把某個 tag 的段落要回來(player 跨章重建用):已在該 tag 就不動;否則問 host 的
    // restore(tag),回 {segments, tag} 或陣列;沒有 hook 或 host 給不出來就 throw,
    // player 據此明確失敗,不會默默在錯章的同序句重建。
    async restore(tag) {
      if (state.segments.length && state.tag === tag) return state.segments.length;
      if (!restore) throw new Error(`producer 已在 tag=${JSON.stringify(state.tag)},沒有 restore hook 可取回 tag=${JSON.stringify(tag)}`);
      const next = await restore(tag);
      const list = Array.isArray(next) ? next : next?.segments;
      if (!Array.isArray(list) || !list.length) throw new Error(`restore(${JSON.stringify(tag)}) 沒有回段落`);
      return setSegments(list, {tag: Array.isArray(next) ? tag : (next.tag ?? tag)});
    },
    setNoiseScale(value) {
      state.noiseScale = Number.isFinite(value) ? value : undefined;
    },
    rewind() {
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
