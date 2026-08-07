import {
  createContinuousStreamPlayer,
  mediaSourceSupport,
} from './continuous-stream-player.mjs';

const LOG_KEY = 'wasmtts-matcha-stream-flight-recorder-v1';
const BUILD_VERSION = '2026-08-08 01:48:01 +0800';
const $ = (selector) => document.querySelector(selector);
const startedAt = performance.now();
const telemetrySession = Math.random().toString(36).slice(2, 8);
const events = [];
let logLines = [];
let latest = null;
let latestMeta = null;

function splitNovelText(text) {
  const compact = String(text).replace(/\r/gu, '').trim();
  if (!compact) throw new Error('請輸入測試文字');
  const sentences = compact.match(/[^。！？!?；;\n]+[。！？!?；;]?[」』”’）》】]*/gu)
    ?.map((sentence) => sentence.trim())
    .filter(Boolean) ?? [];
  if (!sentences.length) throw new Error('無法切出測試句子');
  return sentences.flatMap((sentence) => {
    if (sentence.length <= 72) return [sentence];
    const parts = sentence.match(/.{1,60}(?:[，,、]|$)/gu)?.map((part) => part.trim()).filter(Boolean);
    return parts?.length ? parts : [sentence];
  });
}

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

class MatchaWorkerProducer {
  constructor() {
    this.worker = new Worker('/mobile-host/matcha-worker.js?v=4');
    this.pending = new Map();
    this.nextRequestId = 1;
    this.segments = [];
    this.pronunciationProfile = 'official';
    this.inputNormalization = 'traditional-direct';
    this.noiseScale = 1;
    this.results = [];
    this.initialization = null;
    this.downloaded = false;
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.worker.addEventListener('message', (event) => this.onMessage(event.data));
    this.worker.addEventListener('error', (event) => {
      const error = new Error(event.message || 'Matcha Worker 啟動失敗');
      this.rejectReady(error);
      addLog({message: 'Worker error', detail: {error: error.message}});
    });
  }

  onMessage(message) {
    if (message.type === 'progress') {
      $('#workerState').textContent = message.stage;
      addLog({message: `Worker：${message.stage}`, detail: message.detail ?? {}});
      return;
    }
    if (message.type === 'download-progress') {
      const total = message.total || 129599930;
      const fraction = Math.min(1, message.loaded / total);
      $('#downloadStage').textContent = `下載：${message.asset}`;
      $('#downloadAmount').textContent = `${fmt(message.loaded / 1048576)} / ${fmt(total / 1048576)} MiB（${fmt(fraction * 100, 0)}%）`;
      $('#downloadProgress').value = fraction;
      $('#workerState').textContent = `下載 ${fmt(fraction * 100, 0)}%`;
      return;
    }
    if (message.type === 'download-complete') {
      this.downloaded = true;
      $('#downloadStage').textContent = '模型下載完成';
      $('#downloadProgress').value = 1;
      $('#downloadModelsBtn').disabled = true;
      $('#initializeBtn').disabled = false;
      $('#workerState').textContent = '等待初始化';
      addLog({message: '模型下載完成', detail: message.sources});
      return;
    }
    if (message.type === 'ready') {
      this.initialization = message.initialization;
      $('#workerState').textContent = 'ready';
      $('#startBtn').disabled = !mediaSourceSupport().supported;
      $('#initializeBtn').disabled = true;
      addLog({message: 'Matcha Worker ready', detail: message.initialization});
      this.resolveReady(message.initialization);
      return;
    }

    if (message.type === 'error' && message.requestId === undefined) {
      const error = new Error(message.message);
      if (message.action === 'download-assets') {
        $('#downloadStage').textContent = `下載失敗：${error.message}`;
        $('#downloadModelsBtn').disabled = false;
        $('#workerState').textContent = '下載失敗';
        addLog({message: '模型下載失敗', detail: {error: error.message}});
        return;
      }
      $('#workerState').textContent = 'error';
      $('#state').textContent = 'error';
      addLog({message: 'Matcha Worker 初始化失敗', detail: {error: error.message}});
      this.rejectReady(error);
      return;
    }

    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    this.pending.delete(message.requestId);
    pending.cleanup();
    if (message.type === 'error') {
      pending.reject(new Error(message.message));
      return;
    }
    this.results.push(message.meta);
    pending.resolve({buffer: message.buffer, meta: message.meta});
  }

  download() {
    this.worker.postMessage({type: 'download-assets'});
  }

  initialize() {
    this.worker.postMessage({type: 'init'});
  }

  reset({
    text = $('#novelText').value,
    pronunciationProfile = $('#pronunciationProfile').value,
    inputNormalization = 'traditional-direct',
    noiseScale = 1,
  } = {}) {
    this.segments = splitNovelText(text);
    this.pronunciationProfile = pronunciationProfile === 'taiwan' ? 'taiwan' : 'official';
    this.inputNormalization = 'traditional-direct';
    this.noiseScale = Number.isFinite(noiseScale) ? noiseScale : 1;
    this.results = [];
    addLog({
      message: 'producer reset',
      detail: {
        sentences: this.segments.length,
        pronunciationProfile: this.pronunciationProfile,
        inputNormalization: this.inputNormalization,
        noiseScale: this.noiseScale,
      },
    });
  }

  async next({index, signal}) {
    await this.ready;
    if (!this.segments.length) this.reset();
    if (signal.aborted) throw new DOMException('已停止', 'AbortError');
    const requestId = this.nextRequestId;
    this.nextRequestId += 1;
    const sentenceIndex = index % this.segments.length;
    const chapter = Math.floor(index / this.segments.length) + 1;
    const text = this.segments[sentenceIndex];
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.pending.delete(requestId);
        reject(new DOMException('已停止', 'AbortError'));
      };
      signal.addEventListener('abort', onAbort, {once: true});
      this.pending.set(requestId, {
        resolve: (unit) => resolve({
          ...unit,
          meta: {...unit.meta, chapter, sentence: sentenceIndex + 1},
        }),
        reject,
        cleanup: () => signal.removeEventListener('abort', onAbort),
      });
      this.worker.postMessage({
        type: 'synthesize',
        requestId,
        text,
        pronunciationProfile: this.pronunciationProfile,
        inputNormalization: this.inputNormalization,
        noiseScale: this.noiseScale,
      });
    });
  }
}

restoreLogs();
const audio = $('#streamAudio');
audio.disableRemotePlayback = true;
const support = mediaSourceSupport();
const producer = new MatchaWorkerProducer();
const player = createContinuousStreamPlayer({
  audio,
  producer,
  targetAheadSeconds: 90,
  inactiveAheadSeconds: 45,
  retainBehindSeconds: 30,
  trimStepSeconds: 60,
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
    $('#startBtn').disabled = snapshot.active || !snapshot.supported || !producer.initialization;
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

$('#downloadModelsBtn').addEventListener('click', () => {
  $('#downloadModelsBtn').disabled = true;
  $('#downloadStage').textContent = '準備下載…';
  producer.download();
});

$('#initializeBtn').addEventListener('click', () => {
  $('#initializeBtn').disabled = true;
  $('#workerState').textContent = '初始化中';
  producer.initialize();
});

function start({
  muted = false,
  text = $('#novelText').value,
  pronunciationProfile = $('#pronunciationProfile').value,
} = {}) {
  if (!producer.initialization) return Promise.reject(new Error('Matcha Worker 尚未初始化完成'));
  producer.reset({text, pronunciationProfile});
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

if ('mediaSession' in navigator) {
  navigator.mediaSession.metadata = new MediaMetadata({
    title: 'Matcha 長篇小說測試',
    artist: 'matcha-icefall-zh-en',
    album: '單一 MediaSource timeline',
  });
  navigator.mediaSession.setActionHandler('play', () => player.resume().catch(() => {}));
  navigator.mediaSession.setActionHandler('pause', () => player.pause());
}

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
  },
});

setInterval(() => {
  if (!latest?.active) return;
  addLog({
    message: '♥ heartbeat',
    detail: {
      status: latest.status,
      playhead: Number(latest.currentTime.toFixed(1)),
      ahead: Number(latest.bufferAheadSeconds.toFixed(1)),
      rtf: latest.rtf === null ? null : Number(latest.rtf.toFixed(3)),
      appends: latest.appendCount,
      underflows: latest.underflows,
    },
  });
  player.kick('heartbeat');
}, 10000);

if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('/mobile-host/sw.js', {scope: '/mobile-host/'})
    .then(() => addLog({message: '測試 PWA service worker ready', detail: {}}))
    .catch((error) => addLog({message: 'service worker 註冊失敗', detail: {error: error.message}}));
}
navigator.storage?.persist?.().catch(() => {});

globalThis.matchaStreamTest = {
  events,
  player,
  producer,
  ready: producer.ready,
  splitNovelText,
  start,
  snapshot: () => player.snapshot(),
  latestMeta: () => latestMeta,
};
