// player 實機規矩測試(Node,最小 media element／MediaSource stub):currentSegment、
// seekToSegment 兩條路徑、userPaused／suspended、看門狗 nudge→rebuild、
// visible 自動 resume、Media Session、producer 用盡 ≠ 播完(drained)、跨章重建(restore)。
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
    this.ended = false;
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

// currentSegment:currentTime 反查;segments():buffer 內全部段(形狀同 currentSegment)
audio.currentTime = 7;
audio.dispatch('timeupdate');
assert.equal(player.snapshot().currentSegment.index, 1);
assert.deepEqual(player.segments().map((segment) => [segment.index, segment.start, segment.end, segment.meta.tag]), [[0, 0, 5, 'ch'], [1, 5, 10, 'ch'], [2, 10, 15, 'ch']]);
assert.ok(!('segments' in player.snapshot())); // 清單不進 snapshot(會嵌進每行 log)
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

// ---- producer 用盡 ≠ 播完:只 endOfStream 一次、記 drained,status 等 element ended ----
{
  const audio2 = new FakeAudio();
  let nextCalls = 0;
  const short = {
    cursor: 0,
    setCursor(index) { this.cursor = index; },
    async next() {
      nextCalls += 1;
      if (this.cursor >= 2) return null;
      const i = this.cursor;
      this.cursor += 1;
      return {buffer: new ArrayBuffer(8), meta: {index: i, start: i * 10, end: i * 10 + 10}};
    },
  };
  const logs2 = [];
  const p2 = createContinuousStreamPlayer({audio: audio2, producer: short, targetAheadSeconds: 90, heartbeatSeconds: 0, onLog: (entry) => logs2.push(entry.message)});
  await p2.start();
  FakeMediaSource.last.dispatch('sourceopen');
  await settle();
  audio2.dispatch('playing'); // 實機順序:sourceopen → append → playing
  const snap = p2.snapshot();
  assert.equal(snap.appendCount, 2);
  assert.equal(snap.drained, true);
  assert.equal(snap.status, 'playing'); // element 還有 10 s 要唸,不是 ended
  assert.equal(FakeMediaSource.last.readyState, 'ended'); // endOfStream 已呼叫
  const callsAfterDrain = nextCalls;
  audio2.currentTime = 3;
  audio2.dispatch('timeupdate');
  audio2.currentTime = 6;
  audio2.dispatch('timeupdate');
  await settle(3);
  assert.equal(nextCalls, callsAfterDrain); // drained 後每個 timeupdate 不再打 producer.next
  assert.equal(logs2.filter((message) => message.startsWith('producer 已用盡')).length, 1);
  assert.equal(p2.snapshot().currentSegment.index, 1); // stub 每單位 5 s → 6 s 在第 1 段
  // element 播完:pause 先於 ended,不得記成 suspended
  audio2.ended = true;
  audio2.paused = true;
  audio2.dispatch('pause');
  assert.equal(p2.snapshot().status, 'playing');
  audio2.dispatch('ended');
  assert.equal(p2.snapshot().status, 'ended');
  assert.ok(!logs2.includes('非使用者暫停（鎖屏／系統）'));
  // 播完後回前景也不踢
  document.dispatch('visibilitychange');
  await settle(3);
  assert.equal(p2.snapshot().autoResumes, 0);
  p2.stop();

  // 一個單位都沒有:element 永遠不會 ended,直接標 ended
  const audio3 = new FakeAudio();
  const p3 = createContinuousStreamPlayer({audio: audio3, producer: {next: async () => null, setCursor() {}}, heartbeatSeconds: 0});
  await p3.start();
  FakeMediaSource.last.dispatch('sourceopen');
  await settle();
  assert.equal(p3.snapshot().status, 'ended');
  assert.equal(p3.snapshot().drained, true);
  p3.stop();
}

// ---- 跨章重建:段記得自己的 tag;producer 已被 more() 換章 → 先 restore(tag) 再 setCursor ----
{
  const audio4 = new FakeAudio();
  const calls = [];
  const chaptered = {
    tag: 'ch1',
    cursor: 0,
    setCursor(index) { calls.push(['setCursor', index]); this.cursor = index; },
    async restore(tag) { calls.push(['restore', tag]); this.tag = tag; this.cursor = 0; },
    async next() {
      if (this.cursor >= 3) {
        if (this.tag !== 'ch1') return null;
        this.tag = 'ch2'; // more() 換章
        this.cursor = 0;
      }
      const i = this.cursor;
      this.cursor += 1;
      return {buffer: new ArrayBuffer(8), meta: {index: i, tag: this.tag, start: i * 10, end: i * 10 + 10}};
    },
  };
  const logs4 = [];
  const p4 = createContinuousStreamPlayer({
    audio: audio4, producer: chaptered, targetAheadSeconds: 25, heartbeatSeconds: 10,
    onLog: (entry) => logs4.push(entry.message),
    timers: {setInterval: () => 1, clearInterval() {}},
  });
  await p4.start();
  FakeMediaSource.last.dispatch('sourceopen');
  await settle();
  assert.equal(chaptered.tag, 'ch2'); // producer 已領先到下一章
  audio4.currentTime = 7; // playhead 仍在 ch1 第 2 句
  audio4.dispatch('timeupdate');
  audio4.dispatch('playing');
  assert.equal(p4.currentSegment().meta.tag, 'ch1');
  // ⏮ 回前一章:segments() 列出 buffer 內兩章的段,host 挑到目標後 seek 不必重建
  assert.deepEqual(p4.segments().map((segment) => segment.meta.tag), ['ch1', 'ch1', 'ch1', 'ch2', 'ch2']);
  audio4.currentTime = 22; // 在 ch2
  const lastOfCh1 = p4.segments().filter((segment) => segment.meta.tag === 'ch1').at(-1);
  assert.equal((await p4.seekToSegment(lastOfCh1.index)).mode, 'seek');
  assert.equal(p4.currentSegment().meta.tag, 'ch1');
  audio4.currentTime = 7;
  audio4.dispatch('timeupdate');
  p4.heartbeat();
  assert.equal(p4.heartbeat().action, 'nudge');
  audio4.currentTime = 7.01;
  assert.equal(p4.heartbeat().action, 'rebuild');
  await settle();
  assert.deepEqual(calls.slice(-2), [['restore', 'ch1'], ['setCursor', 1]]);
  assert.equal(chaptered.tag, 'ch1');
  assert.ok(logs4.includes('重建前先要回目標章'));
  // seekToSegment 出 buffer 且段已被裁掉 → 以 index 數字重建(無 tag 可查,不問 restore)
  FakeMediaSource.last.dispatch('sourceopen');
  await settle();
  const seek3 = await p4.seekToSegment(99);
  assert.equal(seek3.mode, 'rebuild');
  assert.deepEqual(calls[calls.length - 1], ['setCursor', 99]);
  p4.stop();

  // 沒有 restore 的 producer:跨章明確 reject,而且不動現有播放;同 tag／無 tag 照常重建
  const audio5 = new FakeAudio();
  const noRestore = {tag: 'ch2', setCursor(index) { calls.push(['plain', index]); }, next: async () => null};
  const p5 = createContinuousStreamPlayer({audio: audio5, producer: noRestore, heartbeatSeconds: 0});
  await p5.start();
  await assert.rejects(p5.restartFrom({tag: 'ch1', index: 0}), /restore/);
  assert.equal(p5.snapshot().active, true);
  await p5.restartFrom({tag: 'ch2', index: 4});
  await p5.restartFrom(5);
  assert.deepEqual(calls.slice(-2), [['plain', 4], ['plain', 5]]);
  p5.stop();
}

console.log(JSON.stringify({gate: 'player', appends: 'ok', stalls: stallEvents, segments: segmentEvents.slice(0, 3), drained: 'ok', restore: 'ok'}, null, 2));
