import {
  createContinuousStreamPlayer,
  mediaSourceSupport,
} from './continuous-stream-player.mjs';

const SEGMENT_URL = '/mobile-host/assets/huayan-medium-segment.mp3';
const LOG_KEY = 'wasmtts-stream-flight-recorder-v1';
const $ = (selector) => document.querySelector(selector);
const startedAt = performance.now();
let logLines = [];

class RepeatingMp3Producer {
  constructor(url) {
    this.url = url;
    this.bytes = null;
  }

  reset() {
    // 保留已載入 bytes，讓後續片段只測播放 transport，不重複量網路。
  }

  async next({ index, signal }) {
    const begin = performance.now();
    if (!this.bytes) {
      const response = await fetch(this.url, { signal, cache: 'force-cache' });
      if (!response.ok) throw new Error(`測試片段 HTTP ${response.status}`);
      this.bytes = await response.arrayBuffer();
    }
    const chapter = Math.floor(index / 6) + 1;
    const sentence = index % 6 + 1;
    return {
      buffer: this.bytes.slice(0),
      meta: {
        chapter,
        sentence,
        label: `第 ${chapter} 章・片段 ${sentence}`,
        fixtureWallMs: performance.now() - begin,
      },
    };
  }
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
  const seconds = (performance.now() - startedAt) / 1000;
  const detail = Object.keys(entry.detail ?? {}).length ? ` ${JSON.stringify(entry.detail)}` : '';
  logLines.push(`${seconds.toFixed(1)}s [${document.visibilityState}] ${entry.message}${detail}`);
  logLines = logLines.slice(-400);
  $('#flightLog').textContent = logLines.join('\n');
  $('#flightLog').scrollTop = $('#flightLog').scrollHeight;
  persistLogs();
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

const audio = $('#streamAudio');
const producer = new RepeatingMp3Producer(SEGMENT_URL);
const support = mediaSourceSupport();
let latest = null;

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
    $('#sourceKind').textContent = snapshot.sourceKind;
    $('#visibility').textContent = snapshot.visibility;
    $('#elapsed').textContent = `${fmt(snapshot.elapsedSeconds, 0)} 秒`;
    $('#playhead').textContent = `${fmt(snapshot.currentTime)} 秒`;
    $('#ahead').textContent = `${fmt(snapshot.bufferAheadSeconds)} 秒`;
    $('#appends').textContent = String(snapshot.appendCount);
    $('#audioSeconds').textContent = `${fmt(snapshot.appendedAudioSeconds)} 秒`;
    $('#underflows').textContent = String(snapshot.underflows);
    $('#bytes').textContent = `${fmt(snapshot.bytes / 1024)} KiB`;
    $('#fixtureRtf').textContent = snapshot.rtf === null ? '—' : fmt(snapshot.rtf, 3);
    $('#fixtureMultiplier').textContent = snapshot.realtimeMultiplier === null
      ? '—'
      : `${fmt(snapshot.realtimeMultiplier)}×`;
    $('#startBtn').disabled = snapshot.active || !snapshot.supported;
    $('#stopBtn').disabled = !snapshot.active;
    $('#pauseBtn').disabled = !snapshot.active;
    $('#pauseBtn').textContent = snapshot.status === 'paused' ? '繼續播放' : '暫停';
    document.body.dataset.streamState = snapshot.status;
    document.body.dataset.appendCount = String(snapshot.appendCount);
    document.body.dataset.bufferAhead = String(snapshot.bufferAheadSeconds);
    document.body.dataset.underflows = String(snapshot.underflows);
  },
});

restoreLogs();

$('#startBtn').addEventListener('click', () => {
  producer.reset();
  player.start().catch((error) => addLog({ message: '初始 play() 失敗', detail: { error: error.message } }));
});

$('#stopBtn').addEventListener('click', () => player.stop());
$('#pauseBtn').addEventListener('click', () => {
  if (latest?.status === 'paused') {
    player.resume().catch((error) => addLog({ message: '恢復播放失敗', detail: { error: error.message } }));
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
  const url = URL.createObjectURL(new Blob([logLines.join('\n')], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `wasmtts-stream-${new Date().toISOString().replaceAll(':', '-')}.log`;
  link.click();
  URL.revokeObjectURL(url);
});

if ('mediaSession' in navigator) {
  navigator.mediaSession.metadata = new MediaMetadata({
    title: 'WASM TTS 長篇串流測試',
    artist: 'Piper HuaYan medium fixture',
    album: '單一 MediaSource timeline',
  });
  navigator.mediaSession.setActionHandler('play', () => player.resume().catch(() => {}));
  navigator.mediaSession.setActionHandler('pause', () => player.pause());
}

const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
$('#secure').textContent = String(window.isSecureContext);
$('#isolated').textContent = String(window.crossOriginIsolated);
$('#standalone').textContent = String(standalone);
$('#sourceSupport').textContent = support.supported ? `${support.kind} / audio/mpeg` : '不支援 audio/mpeg MediaSource';
if (!support.supported) $('#unsupported').hidden = false;

setInterval(() => {
  if (!latest?.active) return;
  addLog({
    message: '♥ heartbeat',
    detail: {
      status: latest.status,
      playhead: Number(latest.currentTime.toFixed(1)),
      ahead: Number(latest.bufferAheadSeconds.toFixed(1)),
      appends: latest.appendCount,
      underflows: latest.underflows,
    },
  });
  player.kick('heartbeat');
}, 10000);

if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('/mobile-host/sw.js', { scope: '/mobile-host/' })
    .then(() => addLog({ message: '測試 PWA service worker ready', detail: {} }))
    .catch((error) => addLog({ message: 'service worker 註冊失敗', detail: { error: error.message } }));
}

globalThis.streamTest = {
  player,
  producer,
  snapshot: () => player.snapshot(),
};
