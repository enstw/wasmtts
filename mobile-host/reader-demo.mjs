// 閱讀器示範:把 tarball 的閱讀器契約各用一次,給下游照抄。
//   1. packStatus(config) 開頁不開 Worker 就知道缺幾 MB(labels 給顯示名)
//   2. createMatchaProducer({more, restore, minUnitChars}) 跨章供章、單位合併 opt-in
//   3. ▶ 前 producer.prime({offset}) 先合成含書籤那句,再 player.start()
//   4. onSegment 以 meta.start/end/tag 高亮、寫書籤、換 Media Session 章名
//   5. ⏮⏭ 先在 player.segments() 找目標(跨章也在 buffer 內就直接 seek),
//      不在就 restartFrom({tag, index})(跨章由 producer.restore 要回那章)
//   6. onLog 以 code 過濾;status 只在 element 真正播完才是 ended(drained ≠ ended)
// 頁面只碰 DOM;合成與播放邏輯全部來自 /platform/ 的出貨檔。
import {
  createMatchaProducer,
  packStatus,
  sentenceSpans,
  workerConfigFromAssets,
} from '/platform/matcha-producer.mjs';
import {
  createContinuousStreamPlayer,
  mediaSourceSupport,
} from '/platform/continuous-stream-player.mjs';

const $ = (selector) => document.querySelector(selector);
const BOOKMARK_KEY = 'wasmtts-reader-demo-bookmark-v1';
const mib = (bytes) => `${(bytes / 1048576).toFixed(1)} MiB`;

// ---- 書:三章短文;tag 就是章索引。真實閱讀器在 more／restore 裡 fetch 章節即可。----
const BOOK = {
  title: '示範短篇',
  chapters: [
    {title: '第一章 清晨', text: '清晨的陽光穿過窗簾，輕輕落在安靜的房間裡。遠處傳來清脆的鳥鳴。微風帶著花草的清香。她伸了個懶腰，看了看牆上的日曆：2026年8月29日。\n「今天要走完剩下的25.5%。」她對自己說。'},
    {title: '第二章 車站', text: '巷口堆著一袋垃圾，他繞過水窪，朝燈火明亮的車站走去。售票機前排著三個人。他掏出零錢，數了兩遍。\n列車在14:30準時進站，車廂裡空得出奇。'},
    {title: '第三章 夜', text: '夜深了。窗外只剩下路燈。她合上書，把書籤夾在第128頁。\n明天還有一段路要走；但今晚，先睡吧。'},
  ],
};
const chapterSpans = (index) => sentenceSpans(BOOK.chapters[index].text);

// ---- 書籤:{tag, offset} 存 localStorage;onSegment 每進一段就更新。----
let bookmark = {tag: 0, offset: 0};
try {
  const saved = JSON.parse(localStorage.getItem(BOOKMARK_KEY) ?? 'null');
  if (saved && BOOK.chapters[saved.tag]) bookmark = saved;
} catch {
  // 讀不到就從頭。
}
function setBookmark(tag, offset) {
  bookmark = {tag, offset};
  try {
    localStorage.setItem(BOOKMARK_KEY, JSON.stringify(bookmark));
  } catch {
    // Private mode 不影響播放。
  }
  $('#bookmark').textContent = `第 ${tag + 1} 章 · 字元 ${offset}`;
  for (const el of document.querySelectorAll('.sentence.bookmark')) el.classList.remove('bookmark');
  sentenceElementAt(tag, offset)?.classList.add('bookmark');
}

// ---- 渲染:每章每句一個 span(sentenceSpans 與 producer 同一個 walk,高亮才不會漂)。----
function sentenceElementAt(tag, offset) {
  return [...document.querySelectorAll(`.sentence[data-tag="${tag}"]`)]
    .find((el) => Number(el.dataset.start) <= offset && offset < Number(el.dataset.end));
}
function renderBook() {
  const book = $('#book');
  book.replaceChildren(...BOOK.chapters.map((chapter, tag) => {
    const section = document.createElement('section');
    section.className = 'chapter';
    const heading = document.createElement('h3');
    heading.textContent = chapter.title;
    const jump = document.createElement('button');
    jump.type = 'button';
    jump.textContent = '從本章開始';
    jump.addEventListener('click', () => jumpTo(tag, 0));
    heading.append(jump);
    const paragraph = document.createElement('p');
    for (const span of chapterSpans(tag)) {
      const el = document.createElement('span');
      el.className = 'sentence';
      el.dataset.tag = String(tag);
      el.dataset.start = String(span.start);
      el.dataset.end = String(span.end);
      el.textContent = span.text;
      el.addEventListener('click', () => jumpTo(tag, span.start));
      paragraph.append(el);
    }
    section.append(heading, paragraph);
    return section;
  }));
}
function highlight(meta) {
  for (const el of document.querySelectorAll('.sentence.now')) el.classList.remove('now');
  // 合併單位(minUnitChars)涵蓋多句:高亮仍以句為界,把區間內的句子都點亮。
  for (const el of document.querySelectorAll(`.sentence[data-tag="${meta.tag}"]`)) {
    if (Number(el.dataset.start) < meta.end && Number(el.dataset.end) > meta.start) el.classList.add('now');
  }
}

// ---- log:每行比 code;預設隱藏 heartbeat／append 這類高頻 code。----
const HIDDEN_BY_DEFAULT = new Set(['heartbeat', 'append', 'appended', 'visibility', 'trim']);
const seenCodes = new Map();
const logLines = [];
function logLine(entry) {
  if (!seenCodes.has(entry.code)) {
    seenCodes.set(entry.code, !HIDDEN_BY_DEFAULT.has(entry.code));
    const label = document.createElement('label');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = seenCodes.get(entry.code);
    box.addEventListener('change', () => { seenCodes.set(entry.code, box.checked); renderLog(); });
    label.append(box, entry.code);
    $('#codeFilter').append(label);
  }
  logLines.push(entry);
  if (logLines.length > 400) logLines.shift();
  renderLog();
}
function renderLog() {
  $('#log').textContent = logLines
    .filter((entry) => seenCodes.get(entry.code))
    .map((entry) => `${(entry.at / 1000).toFixed(1)}s ${entry.code.padEnd(18)} ${entry.message}${entry.detail && Object.keys(entry.detail).length ? ` ${JSON.stringify(entry.detail)}` : ''}`)
    .join('\n');
  $('#log').scrollTop = $('#log').scrollHeight;
}
const note = (code, message, detail) => logLine({at: performance.now(), code, message, detail});

// ---- 1. config 與 packStatus(不開 Worker)。----
// 本 host 從 repository 根目錄供檔;下游只要給三個 base URL,不需要 overrides。
const assets = await (await fetch('/platform/dist/matcha-assets.json', {cache: 'no-cache'})).json();
const MODEL_ROOT = '/platform/models/matcha-icefall-zh-en';
const config = workerConfigFromAssets({
  assets,
  engineBaseUrl: '/platform/',
  assetBaseUrl: '/platform/dist/',
  runtimeBaseUrl: '/mobile-host/vendor/runtime/',
  overrides: {
    lexicon: '/platform/dist/matcha-lexicon.txt',
    profile: '/platform/dist/matcha-profile.runtime.json',
    tokens: `${MODEL_ROOT}/tokens.txt`,
    fsts: [`${MODEL_ROOT}/phone-zh.fst`, `${MODEL_ROOT}/date-zh.fst`, `${MODEL_ROOT}/number-zh.fst`],
    acoustic: `${MODEL_ROOT}/${assets.acoustic.file}`,
    vocoder: '/platform/models/vocos-16khz-univ.onnx',
    kaldifstWasmUrl: '/mobile-host/vendor/kaldifst/matcha-kaldifst-normalizer.wasm',
    scripts: {kaldifstModule: '/mobile-host/vendor/kaldifst/matcha-kaldifst-normalizer.js'},
  },
  labels: {
    lexicon: '詞典', profile: '讀音 profile', tokens: 'Tokens',
    'phone-zh.fst': '電話規則', 'date-zh.fst': '日期規則', 'number-zh.fst': '數字規則',
    ortWasm: '推論引擎（ORT）', acoustic: 'Matcha 聲學模型', vocoder: 'Vocos 聲碼器',
  },
});

async function refreshPackStatus() {
  const status = await packStatus(config);
  $('#assetRows').replaceChildren(...status.assets.map((asset) => {
    const row = document.createElement('tr');
    row.innerHTML = `<td>${asset.label}</td><td>${asset.bytes === null ? '—' : mib(asset.bytes)}</td><td class="${asset.cached ? 'ok' : 'missing'}">${asset.cached ? '已快取' : '缺'}</td>`;
    return row;
  }));
  $('#packSummary').textContent = status.complete
    ? `語音包已齊（${mib(status.cachedBytes)}）`
    : `缺 ${mib(status.missingBytes)}${status.cacheStorage ? '' : '（無 Cache API，每次都要重抓）'}`;
  $('#downloadBtn').disabled = status.complete;
  $('#initBtn').disabled = false;
  return status;
}

// ---- 2. producer:more 供下一章、restore 要回某章;minUnitChars 由下拉決定。----
let producer = null;
let player = null;
let primeStartedAt = 0;

function makeProducer() {
  producer?.dispose();
  producer = createMatchaProducer({
    workerUrl: '/platform/matcha-worker.js',
    config,
    minUnitChars: Number($('#minUnitChars').value),
    // 句子用盡 → 下一章;回 null 才結束(全書播完)。
    more: async ({tag}) => (BOOK.chapters[tag + 1] ? {segments: chapterSpans(tag + 1), tag: tag + 1} : null),
    // player 跨章重建(⏮ 回前一章、看門狗)時把那章要回來;真實閱讀器在這裡 fetch。
    restore: async (tag) => (BOOK.chapters[tag] ? {segments: chapterSpans(tag), tag} : null),
    onEvent: (event) => {
      if (event.type === 'download-progress') {
        const fraction = Math.min(1, event.loaded / (event.total || 1));
        $('#downloadStage').textContent = `下載：${event.asset}`;
        $('#downloadAmount').textContent = `${mib(event.loaded)} / ${mib(event.total)}`;
        $('#downloadProgress').value = fraction;
      } else if (event.type === 'download-complete') {
        $('#downloadStage').textContent = '下載完成';
        refreshPackStatus();
      } else if (event.type === 'ready') {
        $('#downloadStage').textContent = `引擎 ready（${(event.initialization.wallMs / 1000).toFixed(1)} s，詞條 ${event.initialization.frontend.lexiconSize}）`;
        $('#playBtn').disabled = !mediaSourceSupport().supported;
        $('#initBtn').disabled = true;
      } else if (event.type === 'skipped') {
        note('skipped', `跳過句子（${event.reason}）`, {start: event.meta.start, end: event.meta.end, error: event.error});
      } else if (event.type === 'error') {
        note('producer-event-error', event.message, {action: event.action});
        $('#downloadStage').textContent = `錯誤：${event.message}`;
      }
    },
  });
  return producer;
}

// ---- 3–6. player。----
function makePlayer() {
  player = createContinuousStreamPlayer({
    audio: $('#audio'),
    producer,
    mediaSession: {
      metadata: {title: BOOK.chapters[bookmark.tag].title, artist: BOOK.title},
      handlers: {previoustrack: () => skip(-1), nexttrack: () => skip(1)},
    },
    onSegment: (segment) => {
      const {meta} = segment;
      highlight(meta);
      setBookmark(meta.tag, meta.start);
      $('#segmentNow').textContent = `#${segment.index} 第 ${meta.tag + 1} 章 ${meta.start}–${meta.end}${meta.sentences > 1 ? `（${meta.sentences} 句併）` : ''}`;
      if (segment.index === 0 && primeStartedAt) {
        $('#firstSound').textContent = `${((performance.now() - primeStartedAt) / 1000).toFixed(2)} s`;
      }
      player.setMetadata({title: BOOK.chapters[meta.tag].title, artist: BOOK.title});
    },
    onStall: (event) => note('stall', `看門狗 ${event.phase}`, event),
    onLog: (entry) => logLine({at: entry.at, code: entry.code, message: entry.message, detail: entry.detail}),
    onUpdate: (snap) => {
      // drained ≠ ended:producer 用盡後 status 仍是 playing,element 播完才 ended。
      $('#status').textContent = snap.status;
      $('#drained').textContent = String(snap.drained);
      $('#ahead').textContent = `${snap.bufferAheadSeconds.toFixed(1)} 秒`;
      $('#stalls').textContent = `${snap.stalls}／${snap.rebuilds}`;
      $('#multiplier').textContent = Number.isFinite(snap.realtimeMultiplier) ? `${snap.realtimeMultiplier.toFixed(2)}x` : '—';
      $('#pauseBtn').textContent = snap.status === 'paused' ? '繼續' : '暫停';
      for (const id of ['pauseBtn', 'prevBtn', 'nextBtn', 'stopBtn']) $(`#${id}`).disabled = !snap.active;
      $('#playBtn').disabled = snap.active || !producer?.initialization;
      $('#minUnitChars').disabled = snap.active;
    },
  });
  return player;
}

// ▶:setText 該章 → prime 含書籤那句 → start()。
async function play() {
  producer.setText(BOOK.chapters[bookmark.tag].text, {tag: bookmark.tag});
  primeStartedAt = performance.now();
  $('#firstSound').textContent = 'prime…';
  const primed = await producer.prime({offset: bookmark.offset});
  note('prime', 'prime 完成', {ms: Math.round(performance.now() - primeStartedAt), start: primed?.start, text: primed?.text});
  await player.start();
}

// 點句子／章名:播放中就重建到那裡(跨章由 restore 要回),否則只移書籤。
function jumpTo(tag, offset) {
  setBookmark(tag, offset);
  if (!player?.snapshot().active) return;
  const spans = chapterSpans(tag);
  const index = spans.findIndex((span) => span.start <= offset && offset < span.end);
  player.restartFrom({tag, index: Math.max(0, index)}).catch((error) => note('host-error', '重建失敗', {error: error.message}));
}

// ⏮⏭:先在 buffer 內找(跨章的段也在 segments() 裡,找到就直接 seek),不在才重建。
function skip(delta) {
  const current = player.currentSegment();
  if (!current) return;
  const inBuffer = player.segments().find((segment) => segment.index === current.index + delta);
  if (inBuffer) {
    player.seekToSegment(inBuffer.index).catch((error) => note('host-error', 'seek 失敗', {error: error.message}));
    return;
  }
  // 出了 buffer:算出目標是哪一章第幾句,交給 restartFrom(跨章 restore 由 player 處理)。
  let {tag, index} = current.meta;
  index += delta;
  if (index < 0 && BOOK.chapters[tag - 1]) {
    tag -= 1;
    index = chapterSpans(tag).length - 1;
  } else if (index >= chapterSpans(tag).length && BOOK.chapters[tag + 1]) {
    tag += 1;
    index = 0;
  }
  player.restartFrom({tag, index: Math.max(0, index)}).catch((error) => note('host-error', '重建失敗', {error: error.message}));
}

// ---- 綁 DOM。----
renderBook();
setBookmark(bookmark.tag, bookmark.offset);
if (!mediaSourceSupport().supported) $('#unsupported').hidden = false;
makeProducer();
makePlayer();
await refreshPackStatus();

$('#downloadBtn').addEventListener('click', () => {
  $('#downloadBtn').disabled = true;
  producer.download().catch((error) => note('host-error', '下載失敗', {error: error.message}));
});
$('#initBtn').addEventListener('click', () => {
  $('#initBtn').disabled = true;
  $('#downloadStage').textContent = '初始化中…';
  // download() 對已 cached 的資產不重抓;initialize() 需要先 download。
  producer.download().then(() => producer.initialize()).catch((error) => note('host-error', '初始化失敗', {error: error.message}));
});
$('#playBtn').addEventListener('click', () => play().catch((error) => note('host-error', '播放失敗', {error: error.message})));
$('#pauseBtn').addEventListener('click', () => {
  if (player.snapshot().status === 'paused') player.resume().catch(() => {});
  else player.pause();
});
$('#prevBtn').addEventListener('click', () => skip(-1));
$('#nextBtn').addEventListener('click', () => skip(1));
$('#stopBtn').addEventListener('click', () => player.stop());
$('#clearLogBtn').addEventListener('click', () => { logLines.length = 0; renderLog(); });
$('#minUnitChars').addEventListener('change', () => {
  // 換 producer 就要重新 initialize(Worker 是新的);已快取的資產不會重抓。
  makeProducer();
  makePlayer();
  $('#initBtn').disabled = false;
  $('#playBtn').disabled = true;
  $('#downloadStage').textContent = 'minUnitChars 已改，請重新初始化';
});

// 給 DevTools／自動化用。
globalThis.readerDemo = {get producer() { return producer; }, get player() { return player; }, BOOK, play, skip, jumpTo};
