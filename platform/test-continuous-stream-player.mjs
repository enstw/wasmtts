// player 實機規矩測試(Node,最小 media element／MediaSource stub):currentSegment、
// seekToSegment 兩條路徑、userPaused／suspended、看門狗 nudge→rebuild、
// visible 自動 resume、Media Session。
import assert from 'node:assert/strict';

// ---- stubs ----
class Emitter {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }

  dispatch(type, event = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

class FakeSourceBuffer extends Emitter {
  constructor() {
    super();
    this.mode = '';
    this.updating = false;
    this.ranges = [];
    this.buffered = {
      get length() { return 0; },
    };
    this.setRanges([]);
  }

  setRanges(ranges) {
    this.ranges = ranges;
    const self = this;
    this.buffered = {
      get length() { return self.ranges.length; },
      start: (i) => self.ranges[i][0],
      end: (i) => self.ranges[i][1],
    };
  }

  appendBuffer(buffer) {
    // 每個單位 5 秒音訊
    const end = this.ranges.length ? this.ranges[this.ranges.length - 1][1] : 0;
    this.setRanges([[this.ranges.length ? this.ranges[0][0] : 0, end + 5]]);
    this.lastAppended = buffer;
    queueMicrotask(() => this.dispatch('updateend'));
  }

  remove(start, end) {
    this.setRanges([[end, this.ranges[0][1]]]);
  }
}

class FakeMediaSource extends Emitter {
  static isTypeSupported() { return true; }

  constructor() {
    super();
    this.readyState = 'open';
    this.streaming = true;
    FakeMediaSource.last = this;
  }

  addSourceBuffer() {
    this.sourceBuffer = new FakeSourceBuffer();
    return this.sourceBuffer;
  }

  endOfStream() { this.readyState = 'ended'; }
}
globalThis.MediaSource = FakeMediaSource;
globalThis.URL.createObjectURL = () => 'blob:fake'; // Node 的原生版只收 Blob
globalThis.URL.revokeObjectURL = () => {};
globalThis.document = Object.assign(new Emitter(), {visibilityState: 'visible'});
const mediaSessionCalls = [];
Object.defineProperty(globalThis, 'navigator', {configurable: true, value: {mediaSession: {metadata: null, setActionHandler: (action, handler) => mediaSessionCalls.push([action, typeof handler])}}});
globalThis.MediaMetadata = class { constructor(data) { Object.assign(this, data); } };

class FakeAudio extends Emitter {
  constructor() {
    super();
    this.currentTime = 0;
    this.paused = true;
    this.src = '';
    this.playCalls = 0;
  }

  play() {
    this.playCalls += 1;
    this.paused = false;
    queueMicrotask(() => this.dispatch('playing'));
    return Promise.resolve();
  }

  pause() {
    this.paused = true;
    queueMicrotask(() => this.dispatch('pause'));
  }

  removeAttribute() {}

  load() {}
}

const {createContinuousStreamPlayer} = await import('./continuous-stream-player.mjs');

// producer stub:10 個單位,每個帶 meta.index 與 start/end
const cursorCalls = [];
const producer = {
  cursor: 0,
  setCursor(index) { cursorCalls.push(index); this.cursor = index; },
  async next() {
    if (this.cursor >= 10) return null;
    const i = this.cursor;
    this.cursor += 1;
    return {buffer: new ArrayBuffer(8), meta: {index: i, start: i * 10, end: i * 10 + 10, tag: 'ch'}};
  },
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async (n = 30) => { for (let i = 0; i < n; i += 1) await tick(); };

const audio = new FakeAudio();
const logs = [];
const segmentEvents = [];
const stallEvents = [];
const timerCalls = [];
const player = createContinuousStreamPlayer({
  audio,
  producer,
  targetAheadSeconds: 12, // 12 s → 前 3 個單位(15 s)後停止 refill
  heartbeatSeconds: 10,
  mediaSession: {metadata: {title: '第一章'}, handlers: {nexttrack: () => {}, previoustrack: () => {}}},
  onLog: (entry) => logs.push(entry.message),
  onSegment: (segment) => segmentEvents.push(segment.index),
  onStall: (event) => stallEvents.push(event.phase),
  timers: {setInterval: (fn, ms) => { timerCalls.push(ms); return 1; }, clearInterval: () => {}},
});

await player.start();
FakeMediaSource.last.dispatch('sourceopen');
await settle();
assert.ok(player.snapshot().appendCount >= 3, `appends=${player.snapshot().appendCount}`);
assert.deepEqual(timerCalls, [10000]);
// Media Session:metadata 與 play/pause + 自訂 handlers
assert.equal(navigator.mediaSession.metadata.title, '第一章');
assert.deepEqual(mediaSessionCalls.map(([action]) => action).sort(), ['nexttrack', 'pause', 'play', 'previoustrack']);
assert.ok(player.setMetadata({title: '第二章'}));
assert.equal(navigator.mediaSession.metadata.title, '第二章');

// currentSegment:currentTime 反查
audio.currentTime = 7;
audio.dispatch('timeupdate');
assert.equal(player.snapshot().currentSegment.index, 1);
assert.equal(player.snapshot().currentSegment.meta.start, 10);
assert.deepEqual(segmentEvents, [0, 1]);

// seekToSegment:buffer 內 → seek
const seek = await player.seekToSegment(2);
assert.equal(seek.mode, 'seek');
assert.ok(Math.abs(audio.currentTime - 10.01) < 1e-6);

// userPaused vs suspended
player.pause();
await settle(3);
assert.equal(player.snapshot().status, 'paused');
assert.equal(player.snapshot().userPaused, true);
await player.resume();
await settle(3);
assert.equal(player.snapshot().status, 'playing');
audio.pause(); // 系統暫停
await settle(3);
assert.equal(player.snapshot().status, 'suspended');
assert.equal(player.snapshot().userPaused, false);
// visible 自動 resume(非使用者暫停)
document.visibilityState = 'hidden';
document.dispatch('visibilitychange');
document.visibilityState = 'visible';
document.dispatch('visibilitychange');
await settle(3);
assert.equal(player.snapshot().status, 'playing');
assert.equal(player.snapshot().autoResumes, 1);
// 使用者暫停時不踢
player.pause();
await settle(3);
document.dispatch('visibilitychange');
await settle(3);
assert.equal(player.snapshot().status, 'paused');
await player.resume();
await settle(3);

// 看門狗:currentTime 不動、ahead 充足 → 第 1 拍基準、第 2 拍 nudge、第 3 拍 rebuild
audio.currentTime = 3;
audio.dispatch('timeupdate');
const playsBefore = audio.playCalls;
assert.equal(player.heartbeat().action, null); // 第 1 拍記錄基準
assert.equal(player.heartbeat().action, 'nudge'); // 第 2 拍未動 → 推一下
assert.ok(Math.abs(audio.currentTime - 3.01) < 1e-6);
assert.equal(audio.playCalls, playsBefore + 1);
audio.currentTime = 3.01; // 仍不動(nudge 後 currentTime 沒前進)
assert.equal(player.heartbeat().action, 'rebuild');
await settle();
assert.deepEqual(stallEvents, ['nudge', 'rebuild']);
assert.equal(player.snapshot().nudges, 1);
assert.equal(player.snapshot().rebuilds, 1);
assert.equal(cursorCalls[cursorCalls.length - 1], 0); // 3 s 落在第 0 段 → cursor 0
assert.ok(logs.includes('卡死 — 推一下') && logs.includes('卡死未解 — 重建') && logs.includes('♥ heartbeat'));

// 重建後 timeline 再次開啟並 append
FakeMediaSource.last.dispatch('sourceopen');
await settle();
assert.ok(player.snapshot().appendCount >= 1);

// seekToSegment:buffer 外 → rebuild(以 producerIndex)
const seek2 = await player.seekToSegment(99, {producerIndex: 7});
assert.equal(seek2.mode, 'rebuild');
assert.equal(cursorCalls[cursorCalls.length - 1], 7);

player.stop();
assert.equal(player.snapshot().status, 'stopped');
console.log(JSON.stringify({gate: 'player', appends: 'ok', stalls: stallEvents, segments: segmentEvents.slice(0, 3)}, null, 2));
