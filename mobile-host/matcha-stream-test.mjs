// 測試頁:engine tarball 元件(matcha-worker.js、matcha-producer.mjs、
// continuous-stream-player.mjs)的消費者示範。頁面只負責 DOM、telemetry、
// flight recorder 與 CDP hook;合成與播放邏輯全部來自 /platform/ 的出貨檔。
import {
  createMatchaProducer,
  splitSentences,
  workerConfigFromAssets,
} from '/platform/matcha-producer.mjs';
import {
  createContinuousStreamPlayer,
  mediaSourceSupport,
} from '/platform/continuous-stream-player.mjs';

const LOG_KEY = 'wasmtts-matcha-stream-flight-recorder-v1';
const BUILD_VERSION = '2026-08-28 engine tarball';
const $ = (selector) => document.querySelector(selector);
const startedAt = performance.now();
const telemetrySession = Math.random().toString(36).slice(2, 8);
const events = [];
let logLines = [];
let latest = null;
let latestMeta = null;

function fmt(value, digits = 1) {
  return Number.isFinite(value) ? value.toFixed(digits) : '—';
}

function persistLogs() {
  try {
    localStorage.setItem(LOG_KEY, JSON.stringify(logLines.slice(-400)));
  } catch {
    // Private mode 或 quota 不影響播放測試。
  }
}

function addLog(entry) {
  const enriched = {
    at: performance.now(),
    visibility: document.visibilityState,
    ...entry,
  };
  events.push(enriched);
  const seconds = (enriched.at - startedAt) / 1000;
  const detail = Object.keys(entry.detail ?? {}).length ? ` ${JSON.stringify(entry.detail)}` : '';
  logLines.push(`${seconds.toFixed(1)}s [${document.visibilityState}] ${entry.message}${detail}`);
  logLines = logLines.slice(-400);
  $('#flightLog').textContent = logLines.join('\n');
  $('#flightLog').scrollTop = $('#flightLog').scrollHeight;
  persistLogs();
  fetch('/mobile-host/telemetry', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      session: telemetrySession,
      elapsedSeconds: Number(seconds.toFixed(3)),
      visibility: enriched.visibility,
      message: entry.message,
      detail: entry.detail ?? {},
      snapshot: entry.snapshot ?? null,
    }),
    keepalive: true,
  }).catch(() => {});

  if (entry.message === 'append 完成' && entry.detail?.meta?.phases) {
    latestMeta = entry.detail.meta;
    const phases = latestMeta.phases;
    $('#frontendMs').textContent = `${fmt(phases.frontendMs)} ms`;
    $('#acousticMs').textContent = `${fmt(phases.acousticMs)} ms`;
    $('#vocoderMs').textContent = `${fmt(phases.vocoderMs)} ms`;
    $('#mp3Ms').textContent = `${fmt(phases.mp3Ms)} ms`;
  }
}

function restoreLogs() {
  try {
    const previous = JSON.parse(localStorage.getItem(LOG_KEY) ?? '[]');
    if (Array.isArray(previous) && previous.length) {
      logLines = previous.slice(-200);
      logLines.push('— 新頁面 session —');
    }
  } catch {
    logLines = [];
  }
  $('#flightLog').textContent = logLines.join('\n');
}

// Worker 事件 → DOM。producer 本身不碰 DOM。
function onProducerEvent(label) {
  return (message) => {
    if (message.type === 'progress') {
      $('#workerState').textContent = message.stage;
      addLog({message: `Worker(${label})：${message.stage}`, detail: message.detail ?? {}});
      return;
    }
    if (message.type === 'download-progress') {
      const total = message.total || 1;
      const fraction = Math.min(1, message.loaded / total);
      $('#downloadStage').textContent = `下載：${message.asset}`;
      $('#downloadAmount').textContent = `${fmt(message.loaded / 1048576)} / ${fmt(total / 1048576)} MiB（${fmt(fraction * 100, 0)}%）`;
      $('#downloadProgress').value = fraction;
      $('#workerState').textContent = `下載 ${fmt(fraction * 100, 0)}%`;
      return;
    }
    if (message.type === 'download-complete') {
      $('#downloadStage').textContent = '模型下載完成';
      $('#downloadProgress').value = 1;
      $('#downloadModelsBtn').disabled = true;
      $('#initializeBtn').disabled = false;
      $('#workerState').textContent = '等待初始化';
      addLog({message: `模型下載完成（${label}）`, detail: message.sources});
      return;
    }
    if (message.type === 'ready') {
      $('#workerState').textContent = 'ready';
      $('#startBtn').disabled = !mediaSourceSupport().supported;
      $('#initializeBtn').disabled = true;
      addLog({message: `wasmtts Worker ready（${label}）`, detail: message.initialization});
      return;
    }
    if (message.type === 'skipped') {
      addLog({message: `跳過句子（${message.reason}）`, detail: {start: message.meta.start, end: message.meta.end, text: message.meta.text, error: message.error}});
      return;
    }
    if (message.type === 'cache-swept') {
      addLog({message: 'cache keep-set 清掃', detail: {evicted: message.evicted}});
      return;
    }
    if (message.type === 'error') {
      if (message.action === 'download-assets') {
        $('#downloadStage').textContent = `下載失敗：${message.message}`;
        $('#downloadModelsBtn').disabled = false;
        $('#workerState').textContent = '下載失敗';
        addLog({message: '模型下載失敗', detail: {error: message.message}});
        return;
      }
      $('#workerState').textContent = 'error';
      $('#state').textContent = 'error';
      addLog({message: `wasmtts Worker 錯誤（${label}／${message.action}）`, detail: {error: message.message}});
    }
  };
}

// 本 host 從 repository 根目錄供檔:engine 檔在 /platform/,建置產物在
// /platform/dist/,上游資產以原檔名放在 /platform/models/,ORT／lamejs 由
// vendor-mobile 以 packName 放在 /mobile-host/vendor/runtime/。
const assets = await (await fetch('/platform/dist/matcha-assets.json', {cache: 'no-cache'})).json();
const MODEL_ROOT = '/platform/models/matcha-icefall-zh-en';
const baseOverrides = {
  lexicon: '/platform/dist/matcha-lexicon.txt',
  profile: '/platform/dist/matcha-profile.runtime.json',
  tokens: `${MODEL_ROOT}/tokens.txt`,
  fsts: [`${MODEL_ROOT}/phone-zh.fst`, `${MODEL_ROOT}/date-zh.fst`, `${MODEL_ROOT}/number-zh.fst`],
  acoustic: `${MODEL_ROOT}/${assets.acoustic.file}`,
  vocoder: '/platform/models/vocos-16khz-univ.onnx',
  kaldifstWasmUrl: '/mobile-host/vendor/kaldifst/matcha-kaldifst-normalizer.wasm',
  scripts: {kaldifstModule: '/mobile-host/vendor/kaldifst/matcha-kaldifst-normalizer.js'},
};
function makeConfig(overrides = {}) {
  return workerConfigFromAssets({
    assets,
    engineBaseUrl: '/platform/',
    assetBaseUrl: MODEL_ROOT,
    runtimeBaseUrl: '/mobile-host/vendor/runtime/',
    overrides: {...baseOverrides, ...overrides, scripts: {...baseOverrides.scripts, ...(overrides.scripts ?? {})}},
    versions: {kaldifst: '1.8.0 / ab5bdd013bdf13921e6aeee77db5722ebf9955fb'},
    progressEvents: true, // 測試頁要看逐句階段;下游預設關
  });
}
const WORKER_URL = '/platform/matcha-worker.js?v=20260828-engine-tarball';
const producers = {
  // 產品路徑:tarball 元件 ＋ 編譯後 wasmtts lexicon。
  product: createMatchaProducer({workerUrl: WORKER_URL, config: makeConfig(), loop: true, onEvent: onProducerEvent('product')}),
  // 研究對照:上游原始 lexicon、空 profile;只在選擇時才建立(多一份模型記憶體)。
  official: null,
};
const EMPTY_PROFILE_URL = URL.createObjectURL(new Blob([JSON.stringify({
  schemaVersion: 3, locale: 'zh-TW', profiles: {taiwan: {phraseOverrides: [], contextualRules: []}}, entries: [],
})], {type: 'application/json'}));
function officialProducer() {
  producers.official ??= createMatchaProducer({
    workerUrl: WORKER_URL,
    config: makeConfig({lexicon: `${MODEL_ROOT}/lexicon.txt`, profile: EMPTY_PROFILE_URL}),
    loop: true,
    onEvent: onProducerEvent('official'),
  });
  return producers.official;
}
let activeProducer = producers.product;
// player 綁一個 proxy,切換研究對照時不必重建 player。
const producerProxy = {next: (args) => activeProducer.next(args)};

restoreLogs();
const audio = $('#streamAudio');
audio.disableRemotePlayback = true;
const support = mediaSourceSupport();
const player = createContinuousStreamPlayer({
  audio,
  producer: producerProxy,
  targetAheadSeconds: 90,
  inactiveAheadSeconds: 45,
  retainBehindSeconds: 30,
  trimStepSeconds: 60,
  mediaSession: {
    metadata: {title: 'Matcha 長篇小說測試', artist: 'matcha-icefall-zh-en', album: '單一 MediaSource timeline'},
    handlers: {
      previoustrack: () => skipSegment(-1),
      nexttrack: () => skipSegment(1),
    },
  },
  onSegment(segment) {
    $('#segmentNow').textContent = `#${segment.index} 字元 ${segment.meta.start ?? '—'}–${segment.meta.end ?? '—'}`;
    addLog({message: '進入段', detail: {index: segment.index, start: segment.meta.start, end: segment.meta.end, sentence: segment.meta.sentence}});
  },
  onStall(event) {
    addLog({message: `看門狗 ${event.phase}`, detail: event});
  },
  onLog: addLog,
  onUpdate(snapshot) {
    latest = snapshot;
    $('#state').textContent = snapshot.status;
    $('#visibility').textContent = snapshot.visibility;
    $('#appends').textContent = String(snapshot.appendCount);
    $('#rtf').textContent = fmt(snapshot.rtf, 3);
    $('#multiplier').textContent = Number.isFinite(snapshot.realtimeMultiplier)
      ? `${fmt(snapshot.realtimeMultiplier, 2)}x`
      : '—';
    $('#ahead').textContent = `${fmt(snapshot.bufferAheadSeconds)} 秒`;
    $('#underflows').textContent = String(snapshot.underflows);
    $('#startBtn').disabled = snapshot.active || !snapshot.supported || !producers.product.initialization;
    $('#stopBtn').disabled = !snapshot.active;
    $('#pauseBtn').disabled = !snapshot.active;
    $('#pauseBtn').textContent = snapshot.status === 'paused' ? '繼續播放' : '暫停';
    $('#novelText').disabled = snapshot.active;
    $('#pronunciationProfile').disabled = snapshot.active;
    document.body.dataset.streamState = snapshot.status;
    document.body.dataset.appendCount = String(snapshot.appendCount);
    document.body.dataset.bufferAhead = String(snapshot.bufferAheadSeconds);
    document.body.dataset.underflows = String(snapshot.underflows);
    document.body.dataset.rtf = String(snapshot.rtf ?? '');
  },
});

// ⏮⏭:目標段在 buffer 內就 seek,不在就以 producer cursor 重建。
function skipSegment(delta) {
  const current = player.currentSegment();
  const target = (current?.index ?? 0) + delta;
  if (target < 0) return;
  player.seekToSegment(target, {producerIndex: (current?.meta?.index ?? 0) + delta})
    .then((result) => addLog({message: `⏮⏭ ${result.mode}`, detail: result}))
    .catch((error) => addLog({message: '⏮⏭ 失敗', detail: {error: error.message}}));
}
$('#prevBtn').addEventListener('click', () => skipSegment(-1));
$('#nextBtn').addEventListener('click', () => skipSegment(1));

$('#downloadModelsBtn').addEventListener('click', () => {
  $('#downloadModelsBtn').disabled = true;
  $('#downloadStage').textContent = '準備下載…';
  producers.product.download();
});

$('#initializeBtn').addEventListener('click', () => {
  $('#initializeBtn').disabled = true;
  $('#workerState').textContent = '初始化中';
  producers.product.initialize();
});

async function start({
  muted = false,
  text = $('#novelText').value,
  pronunciationProfile = $('#pronunciationProfile').value,
} = {}) {
  if (!producers.product.initialization) throw new Error('wasmtts Worker 尚未初始化完成');
  const useOfficial = pronunciationProfile === 'official';
  activeProducer = useOfficial ? officialProducer() : producers.product;
  if (useOfficial && !activeProducer.initialization) {
    addLog({message: '建立研究對照 Worker（上游 lexicon）'});
    await activeProducer.download();
    await activeProducer.initialize();
  }
  const sentences = activeProducer.setText(text);
  if (!sentences) throw new Error('請輸入測試文字');
  const seekOffset = Number($('#seekOffset')?.value ?? 0);
  if (seekOffset > 0) addLog({message: 'seekTo', detail: {offset: seekOffset, cursor: activeProducer.seekTo(seekOffset)}});
  addLog({message: 'producer reset', detail: {sentences, pronunciationProfile: useOfficial ? 'official' : 'product'}});
  audio.muted = muted;
  return player.start();
}

$('#startBtn').addEventListener('click', () => {
  start().catch((error) => addLog({message: '初始 play() 失敗', detail: {error: error.message}}));
});
$('#stopBtn').addEventListener('click', () => player.stop());
$('#pauseBtn').addEventListener('click', () => {
  if (latest?.status === 'paused') {
    player.resume().catch((error) => addLog({message: '恢復播放失敗', detail: {error: error.message}}));
  } else {
    player.pause();
  }
});

$('#clearLogBtn').addEventListener('click', () => {
  logLines = [];
  persistLogs();
  $('#flightLog').textContent = '';
});
$('#downloadLogBtn').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([logLines.join('\n')], {type: 'text/plain;charset=utf-8'}));
  const link = document.createElement('a');
  link.href = url;
  link.download = `wasmtts-matcha-stream-${new Date().toISOString().replaceAll(':', '-')}.log`;
  link.click();
  URL.revokeObjectURL(url);
});

const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
$('#buildVersion').textContent = BUILD_VERSION;
$('#secure').textContent = String(window.isSecureContext);
$('#isolated').textContent = String(window.crossOriginIsolated);
$('#standalone').textContent = String(standalone);
$('#sourceSupport').textContent = support.supported ? `${support.kind} / audio/mpeg` : '不支援 audio/mpeg MediaSource';
if (!support.supported) $('#unsupported').hidden = false;
addLog({
  message: '頁面 telemetry ready',
  detail: {
    session: telemetrySession,
    buildVersion: BUILD_VERSION,
    userAgent: navigator.userAgent,
    secureContext: window.isSecureContext,
    standalone,
    sourceKind: support.kind,
    sourceSupported: support.supported,
    lexiconPackName: assets.lexicon.packName,
  },
});

// 心跳與看門狗已內建在 player(heartbeatSeconds 10);頁面只補一個 kick,
// 讓背景 timer 被 iOS 節流時仍由播放事件驅動 refill。
setInterval(() => {
  if (latest?.active) player.kick('heartbeat');
}, 10000);

if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('/mobile-host/sw.js', {scope: '/mobile-host/'})
    .then(() => addLog({message: '測試 PWA service worker ready', detail: {}}))
    .catch((error) => addLog({message: 'service worker 註冊失敗', detail: {error: error.message}}));
}
navigator.storage?.persist?.().catch(() => {});

// CDP hook(platform/run-matcha-stream-browser.mjs 依賴):形狀維持不變。
globalThis.matchaStreamTest = {
  events,
  player,
  get producer() {
    return activeProducer;
  },
  producers,
  ready: producers.product.ready,
  splitNovelText: splitSentences,
  start,
  snapshot: () => player.snapshot(),
  latestMeta: () => latestMeta,
};
