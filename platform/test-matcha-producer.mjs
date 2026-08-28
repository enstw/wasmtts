// producer 契約測試(Node,mock Worker):切句 walk、span 折入、seekTo、more()、
// restore(tag)、單句失敗跳過不 reject、status() 形狀、workerConfigFromAssets 的
// lexicon cache-first 與 ortWasm 資產。不碰真 Worker／ORT。
import assert from 'node:assert/strict';

import {
  ENDERS, CLOSERS, sentenceSpans, sentenceStartFor, sentenceEndFor, chunkIndexFor, splitSentences,
  createMatchaProducer, workerConfigFromAssets,
} from './matcha-producer.mjs';

// ---- workerConfigFromAssets:lexicon packName 含 hash → cache-first;ORT wasm 進資產清單 ----
{
  const assets = {
    schemaVersion: 4, stage: 'complete',
    lexicon: {packName: 'matcha-lexicon-abcd1234.txt', bytes: 10},
    matcha: {files: {'tokens.txt': {packName: 'tokens.txt', bytes: 1}, 'phone-zh.fst': {packName: 'phone-zh.fst', bytes: 1}, 'date-zh.fst': {packName: 'date-zh.fst', bytes: 1}, 'number-zh.fst': {packName: 'number-zh.fst', bytes: 1}}},
    acoustic: {packName: 'model.onnx', bytes: 1}, vocos: {packName: 'vocos.onnx', bytes: 1},
    runtime: {
      'onnxruntime-web': {version: '1.27.0', files: {'dist/ort.wasm.min.js': {packName: 'ort-1.27.0-wasm.min.js'}, 'dist/ort-wasm-simd-threaded.mjs': {packName: 'ort-1.27.0-wasm-simd-threaded.mjs'}, 'dist/ort-wasm-simd-threaded.wasm': {packName: 'ort-1.27.0-wasm-simd-threaded.wasm', bytes: 13000000}}},
      lamejs: {version: '1.2.1', files: {'lame.min.js': {packName: 'lamejs-1.2.1.min.js'}}},
    },
  };
  const base = {assets, engineBaseUrl: '/e/', assetBaseUrl: '/a/', runtimeBaseUrl: '/r/'};
  const cfg = workerConfigFromAssets(base);
  assert.equal(cfg.assets.lexicon.networkFirst, false);
  assert.equal(cfg.assets.profile.networkFirst, true);
  assert.deepEqual(cfg.assets.ortWasm, {url: '/r/ort-1.27.0-wasm-simd-threaded.wasm', bytes: 13000000});
  assert.equal(cfg.assets.ortWasm.url, cfg.ortWasmPaths.wasm);
  // 覆寫 lexicon 成沒有 hash 的 URL → network-first;覆寫 ortWasmPaths 成字串前綴 → 交回 ORT 自己抓
  const over = workerConfigFromAssets({...base, overrides: {lexicon: '/research/lexicon.txt', ortWasmPaths: '/r/'}});
  assert.equal(over.assets.lexicon.networkFirst, true);
  assert.equal(over.assets.ortWasm, undefined);
  // 覆寫成別的 wasm URL → 仍進清單但 bytes 未知
  const other = workerConfigFromAssets({...base, overrides: {ortWasmPaths: {mjs: '/x/a.mjs', wasm: '/x/a.wasm'}}});
  assert.deepEqual(other.assets.ortWasm, {url: '/x/a.wasm', bytes: undefined});
}

// ---- 切句 walk ----
{
  const text = '清晨的陽光。她說：「別急。」\n\n第二段沒有句尾';
  const spans = sentenceSpans(text);
  // 空行(第二個 \n)折入前一句,第三段從真正的內容起。
  assert.deepEqual(spans.map((s) => [s.start, s.end]), [[0, 6], [6, 16], [16, 23]]);
  assert.deepEqual(spans.map((s) => s.text), ['清晨的陽光。', '她說：「別急。」\n\n', '第二段沒有句尾']);
  // span 連續且覆蓋整段文字
  assert.equal(spans[0].start, 0);
  assert.equal(spans[spans.length - 1].end, text.length);
  for (let i = 1; i < spans.length; i += 1) assert.equal(spans[i].start, spans[i - 1].end);
  // 「唱到哪、畫到哪」:每個 span 內任一 index 的 start/end 都回同一句
  for (const span of sentenceSpans(text)) {
    for (let i = span.start; i < span.end; i += 1) {
      const rawStart = sentenceStartFor(text, i);
      const rawEnd = sentenceEndFor(text, i);
      assert.ok(rawStart >= span.start - 1 && rawEnd <= span.end + 1, `${i}: [${rawStart},${rawEnd}) vs [${span.start},${span.end})`);
    }
  }
  assert.equal(sentenceStartFor(text, 8), 6);
  assert.equal(sentenceEndFor(text, 8), 14);
  assert.equal(chunkIndexFor(spans, 8), 1);
  assert.equal(chunkIndexFor(spans, 999), 2);
  assert.deepEqual(splitSentences(text), ['清晨的陽光。', '她說：「別急。」', '第二段沒有句尾']);
  assert.ok(ENDERS.includes('\n') && CLOSERS.includes('」'));
}
{
  // 開頭空白折入第一段;尾端空白折入最後一段;whitespace-only 文字回單一 span。
  const text = '\n\n甲。乙。\n\n';
  const spans = sentenceSpans(text);
  assert.deepEqual(spans.map((s) => [s.start, s.end]), [[0, 4], [4, 8]]);
  assert.deepEqual(sentenceSpans('   ').map((s) => [s.start, s.end]), [[0, 3]]);
  assert.deepEqual(sentenceSpans(''), []);
}
{
  // 超長句:pauses 次切(≥ subLength)、maxLength 硬切;仍連續覆蓋。
  const long = `${'一'.repeat(30)}，${'二'.repeat(35)}，${'三'.repeat(80)}。`;
  const spans = sentenceSpans(long, {maxLength: 72, subLength: 60});
  assert.ok(spans.length >= 3);
  assert.equal(spans[0].start, 0);
  assert.equal(spans[spans.length - 1].end, long.length);
  for (let i = 1; i < spans.length; i += 1) assert.equal(spans[i].start, spans[i - 1].end);
  for (const span of spans) assert.ok(span.end - span.start <= 72);
}

// ---- mock Worker ----
class MockWorker {
  constructor() {
    this.listeners = {message: [], error: []};
    this.posted = [];
    this.script = MockWorker.script;
  }

  addEventListener(type, listener) {
    this.listeners[type].push(listener);
  }

  emit(data) {
    for (const listener of this.listeners.message) listener({data});
  }

  postMessage(message) {
    this.posted.push(message);
    queueMicrotask(() => this.script(message, this));
  }

  terminate() {}
}
globalThis.Worker = MockWorker;
globalThis.DOMException ??= class DOMException extends Error {
  constructor(message, name) {
    super(message);
    this.name = name;
  }
};

const config = {scripts: {ort: 'x'}, assets: {}};
const mp3 = () => new Uint8Array([1, 2, 3]).buffer;

// 腳本:configure→configured;init→ready;synthesize:含「空」回 empty、含「壞」回 error、其餘回 result。
MockWorker.script = (message, worker) => {
  if (message.type === 'configure') return worker.emit({type: 'configured'});
  if (message.type === 'init') return worker.emit({type: 'ready', initialization: {frontend: {lexiconSize: 1}}});
  if (message.type === 'download-assets') return worker.emit({type: 'download-complete', sources: {}});
  if (message.type === 'status') return worker.emit({type: 'status', assets: [{key: 'acoustic', cached: false, bytes: 10}], cachedBytes: 0, missingBytes: 10, complete: false});
  if (message.type === 'synthesize') {
    if (message.text.includes('空')) return worker.emit({type: 'result', requestId: message.requestId, empty: true, meta: {text: message.text}});
    if (message.text.includes('壞')) return worker.emit({type: 'error', requestId: message.requestId, message: 'waveform not audible', code: 'inaudible'});
    return worker.emit({type: 'result', requestId: message.requestId, buffer: mp3(), meta: {text: message.text, audioSeconds: 1, allowUnknown: message.allowUnknown}});
  }
  return undefined;
};

const events = [];
const chapters = [
  '第一句。空。壞句。第四句。',
  '次章甲。次章乙。',
];
let served = 0;
const producer = createMatchaProducer({
  workerUrl: 'mock://worker',
  config,
  onEvent: (event) => events.push(event),
  more: async ({tag}) => {
    served += 1;
    if (served > 1) return null;
    return {segments: sentenceSpans(chapters[1]), tag: `${tag}+1`};
  },
});
await producer.download();
await producer.initialize();
assert.equal(producer.setText(chapters[0], {tag: 'ch1'}), 4);

// 單位 1:第一句 → start 0。
const u1 = await producer.next({index: 0});
assert.deepEqual([u1.meta.start, u1.meta.end, u1.meta.tag, u1.meta.sentence, u1.meta.chapter], [0, 4, 'ch1', 1, 1]);
assert.equal(u1.meta.allowUnknown, true);
// 單位 2:空句與壞句被跳過,其 span 折入第四句 → start 從「空」的起點(4)開始。
const u2 = await producer.next({index: 1});
assert.deepEqual([u2.meta.start, u2.meta.end, u2.meta.sentence], [4, 13, 4]);
const skipped = events.filter((event) => event.type === 'skipped');
assert.deepEqual(skipped.map((event) => [event.reason, event.meta.start]), [['empty', 4], ['error', 6]]);
assert.equal(skipped[1].code, 'inaudible');
assert.equal(producer.skipped, 2);
// 跨章:more() 提供次章,tag 換新、chapter 遞增、座標從 0。
const u3 = await producer.next({index: 2});
assert.deepEqual([u3.meta.start, u3.meta.end, u3.meta.tag, u3.meta.chapter, u3.meta.sentence], [0, 4, 'ch1+1', 2, 1]);
const u4 = await producer.next({index: 3});
assert.equal(u4.meta.start, 4);
// more() 回 null → 結束。
assert.equal(await producer.next({index: 4}), null);
assert.equal(served, 2);

// seekTo:只從含該 offset 的那句起。
producer.setText(chapters[0], {tag: 'again'});
assert.equal(producer.seekTo(10), 3);
const u5 = await producer.next({index: 0});
assert.deepEqual([u5.meta.start, u5.meta.text], [9, '第四句。']);
assert.equal(producer.setCursor(1), 1);
assert.equal(producer.cursor, 1);

// status():不觸發下載,形狀固定。
const status = await producer.status();
assert.equal(status.missingBytes, 10);
assert.equal(status.complete, false);
assert.ok(!producer.worker.posted.some((message, i) => message.type === 'download-assets' && i > 2));

// setSegments 接受 {text, start, end}:座標原樣保留。
producer.setSegments([{text: '甲。', start: 100, end: 102}, {text: '乙。', start: 102, end: 104}], {tag: 'raw'});
const u6 = await producer.next({index: 0});
assert.deepEqual([u6.meta.start, u6.meta.end, u6.meta.tag], [100, 102, 'raw']);

// restore(tag):player 跨章重建時把某章要回來。沒有 hook → 跨 tag throw、同 tag 不動。
await assert.rejects(producer.restore('ch1'), /restore/);
assert.equal(producer.tag, 'raw');
assert.equal(await producer.restore('raw'), 2);
{
  const restoreCalls = [];
  const book = createMatchaProducer({
    workerUrl: 'mock://worker',
    config,
    more: async () => ({segments: sentenceSpans(chapters[1]), tag: 'c2'}),
    restore: async (tag) => {
      restoreCalls.push(tag);
      return tag === 'c1' ? {segments: sentenceSpans(chapters[0]), tag} : null;
    },
  });
  await book.initialize();
  book.setText(chapters[0], {tag: 'c1'});
  await book.next({index: 0});
  await book.next({index: 1});
  const c2 = await book.next({index: 2}); // more() 換到 c2
  assert.equal(c2.meta.tag, 'c2');
  assert.equal(book.tag, 'c2');
  // 看門狗要在 c1 第 2 句重建:restore('c1') 後 setCursor(1) → 下一單位是 c1 的第 4 句(空／壞句折入)
  assert.equal(await book.restore('c1'), 4);
  assert.equal(book.tag, 'c1');
  assert.deepEqual(restoreCalls, ['c1']);
  book.setCursor(1);
  const back = await book.next({index: 0});
  assert.deepEqual([back.meta.tag, back.meta.start, back.meta.text], ['c1', 4, '第四句。']);
  // host 給不出來 → throw
  await assert.rejects(book.restore('c9'), /沒有回段落/);
}

// allowUnknown 可關;透傳到 worker 訊息。
const strict = createMatchaProducer({workerUrl: 'mock://worker', config, allowUnknown: false});
await strict.initialize();
strict.setText('嚴格句。');
const u7 = await strict.next({index: 0});
assert.equal(u7.meta.allowUnknown, false);

console.log(JSON.stringify({gate: 'producer', spans: 'ok', skipped: producer.skipped, status: status.missingBytes}, null, 2));
