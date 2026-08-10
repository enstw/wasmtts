#!/usr/bin/env node

// 外部小說 → 正式 Matcha frontend → g2pW WebGPU → SQLite 的可續跑全文 index。

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';

import './matcha-fst.js';
import './matcha-frontend.js';
import {launch} from './cdp/cdp-client.mjs';
import {differenceCategory, initializeG2pwIndex} from './g2pw-index-db.mjs';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const matchaModel = path.resolve(root, 'platform/models/matcha-icefall-zh-en');
const g2pwModel = path.resolve(root, 'platform/models/g2pw/G2PWModel');
const reviewFile = path.resolve(root, 'platform/matcha-g2p-review.json');
const SENTENCE_BOUNDARY = /(?<=[。！？!?])/u;
const HAN = /[\u3400-\u9fff\uf900-\ufaff]/u;
const MAX_BERT_CHARACTERS = 480;

function parseArguments(argv) {
  if (argv[0] === '--') argv = argv.slice(1);
  const input = argv.shift();
  let database = 'platform/results/matcha-g2p-index.local.sqlite';
  let maxSentences = Infinity;
  let sentenceBatchSize = 8;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--database' && argv[index + 1]) database = argv[++index];
    else if (argv[index] === '--max-sentences' && argv[index + 1]) maxSentences = Number(argv[++index]);
    else if (argv[index] === '--sentence-batch-size' && argv[index + 1]) sentenceBatchSize = Number(argv[++index]);
    else throw new Error(`不支援的參數：${argv[index]}`);
  }
  if (!input) throw new Error('用法：index-matcha-g2pw-webgpu.mjs <novel.zip> [--max-sentences N]');
  if (!(maxSentences > 0) || !(sentenceBatchSize > 0)) throw new Error('句數參數必須大於零');
  return {input: path.resolve(input), database: path.resolve(database), maxSentences, sentenceBatchSize};
}

async function sha256File(filename) {
  const digest = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filename)) digest.update(chunk);
  return digest.digest('hex');
}

function sha256Json(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function* novelSentences(filename) {
  const child = spawn('unzip', ['-p', filename], {stdio: ['ignore', 'pipe', 'inherit']});
  const lines = createInterface({input: child.stdout, crlfDelay: Infinity});
  let sourceSentenceId = 0;
  for await (const line of lines) {
    if (!line.trim()) continue;
    for (const part of line.split(SENTENCE_BOUNDARY)) {
      const trimmed = part.trim();
      if (!trimmed || !HAN.test(trimmed)) continue;
      const characters = [...trimmed];
      for (let offset = 0; offset < characters.length; offset += MAX_BERT_CHARACTERS) {
        yield {sourceSentenceId, sourceText: characters.slice(offset, offset + MAX_BERT_CHARACTERS).join('')};
        sourceSentenceId += 1;
      }
    }
  }
  const exitCode = await new Promise((resolve) => child.once('close', resolve));
  if (exitCode !== 0) throw new Error(`unzip 結束碼：${exitCode}`);
}

function matchaReadings(trace) {
  const readings = Array.from({length: [...trace.normalizedText].length}, () => null);
  for (const match of trace.lexiconMatches) {
    const word = [...match.word];
    if (word.length !== match.phones.length) continue;
    const codePointOffset = [...trace.normalizedText.slice(0, match.offset)].length;
    match.phones.forEach((phone, index) => { readings[codePointOffset + index] = phone; });
  }
  return readings;
}

function startPreprocessor() {
  const child = spawn('uv', [
    'run', '--with', 'g2pw==0.1.1', '--with', 'requests==2.32.5', '--with', 'torch==2.13.0',
    '--with', 'onnxruntime==1.28.0', '--with', 'transformers==5.15.0',
    'platform/g2pw-preprocess-worker.py', '--batch-size', '32',
  ], {
    cwd: root,
    env: {...process.env, HF_HOME: 'platform/models/g2pw/hf', TRANSFORMERS_OFFLINE: '1', HF_HUB_OFFLINE: '1'},
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const lines = createInterface({input: child.stdout, crlfDelay: Infinity})[Symbol.asyncIterator]();
  const next = async () => {
    const item = await lines.next();
    if (item.done) throw new Error('g2pW preprocessing worker 提前結束');
    const value = JSON.parse(item.value);
    if (value.error) throw new Error(`g2pW preprocessing: ${value.error}`);
    return value;
  };
  return {
    child,
    ready: next(),
    async encode(sentences, id) {
      child.stdin.write(`${JSON.stringify({id, sentences})}\n`);
      const response = await next();
      if (response.id !== id) throw new Error(`g2pW response id 錯位：${response.id} != ${id}`);
      return response;
    },
  };
}

const args = parseArguments(process.argv.slice(2));
const fstFiles = ['phone', 'date', 'number'].map((name) => path.resolve(matchaModel, `${name}-zh.fst`));
const review = JSON.parse(fs.readFileSync(reviewFile, 'utf8'));
const frontend = globalThis.MatchaFrontend.createFrontend({
  lexiconText: fs.readFileSync(path.resolve(matchaModel, 'lexicon.txt'), 'utf8'),
  tokensText: fs.readFileSync(path.resolve(matchaModel, 'tokens.txt'), 'utf8'),
  ruleNormalizer: globalThis.MatchaFst.createNormalizer(fstFiles.map((filename) => fs.readFileSync(filename))),
  pronunciationOverrides: globalThis.MatchaFrontend.pronunciationOverridesFromReview(review),
  contextualRules: globalThis.MatchaFrontend.contextualRulesFromReview(review),
});
const metadata = {
  sourceSha256: await sha256File(args.input),
  modelSha256: await sha256File(path.resolve(g2pwModel, 'g2pw.onnx')),
  lexiconSha256: await sha256File(path.resolve(matchaModel, 'lexicon.txt')),
  fstSha256: sha256Json(await Promise.all(fstFiles.map(sha256File))),
  profileSha256: await sha256File(reviewFile),
  backend: 'onnxruntime-web:webgpu', runtime: 'onnxruntime-web@1.27.0+g2pw@0.1.1',
};
const fingerprint = sha256Json(metadata);
fs.mkdirSync(path.dirname(args.database), {recursive: true});
const db = new DatabaseSync(args.database);
initializeG2pwIndex(db);
const existing = db.prepare('SELECT id, status, last_sentence_id FROM runs WHERE fingerprint = ?').get(fingerprint);
if (existing?.status === 'complete') {
  console.log(JSON.stringify({database: args.database, runId: existing.id, reused: true, status: 'complete'}, null, 2));
  db.close();
  process.exit(0);
}
const runId = existing?.id ?? db.prepare(`
  INSERT INTO runs(fingerprint, created_at, status, source_sha256, model_sha256, lexicon_sha256,
    fst_sha256, profile_sha256, backend, runtime) VALUES (?, ?, 'building', ?, ?, ?, ?, ?, ?, ?) RETURNING id
`).get(fingerprint, new Date().toISOString(), metadata.sourceSha256, metadata.modelSha256,
  metadata.lexiconSha256, metadata.fstSha256, metadata.profileSha256, metadata.backend, metadata.runtime).id;
let checkpoint = existing?.last_sentence_id ?? -1;
if (existing) db.prepare("UPDATE runs SET status = 'building', completed_at = NULL WHERE id = ?").run(runId);

const host = process.env.WASM_TTS_BENCH_HOST ?? '127.0.0.1';
const serverPort = Number(process.env.WASM_TTS_BENCH_PORT ?? 8765);
const cdpPort = Number(process.env.WASM_TTS_CDP_PORT ?? 9393);
const pageUrl = `http://${host}:${serverPort}/platform/g2pw-webgpu-benchmark.html`;
const browserProfile = path.join(os.tmpdir(), `wasmtts-g2pw-full-${process.pid}`);
let browser;
let worker;
let processed = 0;
let reachedLimit = false;
try {
  if (!(await fetch(pageUrl)).ok) throw new Error('mobile-host 未在 8765 提供 benchmark page');
  browser = await launch({port: cdpPort, profile: browserProfile, gpu: true,
    args: ['--enable-gpu', '--enable-unsafe-webgpu', '--use-angle=metal']});
  const {send, evalJs, sessionId} = browser;
  await send('Page.navigate', {url: pageUrl}, sessionId);
  const deadline = Date.now() + 30000;
  while (!(await evalJs('window.ready === true'))) {
    if (Date.now() > deadline) throw new Error('WebGPU page 未就緒');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await evalJs(`window.g2pwWebgpuBench.initialize(${JSON.stringify('/platform/models/g2pw/G2PWModel/g2pw.onnx')})`);
  worker = startPreprocessor();
  const {labels} = await worker.ready;
  const insertSentence = db.prepare(`INSERT OR REPLACE INTO sentences
    (run_id, source_sentence_id, text, source_text) VALUES (?, ?, ?, ?)`);
  const insertOccurrence = db.prepare(`INSERT OR REPLACE INTO occurrences(
    run_id, source_sentence_id, character_offset, character, previous_character, following_character,
    matcha_phone, g2pw_phone, confidence, category) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  let pending = [];
  const flush = async () => {
    if (!pending.length) return;
    const encoded = await worker.encode(pending.map(({sourceSentenceId, normalizedText}) =>
      ({sourceSentenceId, text: normalizedText})), checkpoint + processed + 1);
    const predictions = [];
    for (const batch of encoded.batches) {
      const result = await evalJs(`window.g2pwWebgpuBench.inferFeeds(${JSON.stringify(batch.feeds)})`);
      result.argmax.forEach((labelId, index) => predictions.push({
        ...batch.queries[index], phone: labels[labelId], confidence: result.maxProbability[index],
      }));
    }
    const byId = new Map(pending.map((sentence) => [sentence.sourceSentenceId, sentence]));
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const sentence of pending) insertSentence.run(
        runId, sentence.sourceSentenceId, sentence.normalizedText, sentence.sourceText);
      for (const prediction of predictions) {
        const sentence = byId.get(prediction.sourceSentenceId);
        const characters = [...sentence.normalizedText];
        const matcha = sentence.readings[prediction.offset];
        insertOccurrence.run(runId, prediction.sourceSentenceId, prediction.offset,
          characters[prediction.offset], characters[prediction.offset - 1] ?? '',
          characters[prediction.offset + 1] ?? '', matcha, prediction.phone, prediction.confidence,
          differenceCategory(characters[prediction.offset], matcha, prediction.phone));
      }
      checkpoint = pending.at(-1).sourceSentenceId;
      db.prepare('UPDATE runs SET last_sentence_id = ? WHERE id = ?').run(checkpoint, runId);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    processed += pending.length;
    pending = [];
  };
  for await (const sentence of novelSentences(args.input)) {
    if (sentence.sourceSentenceId <= checkpoint) continue;
    if (processed + pending.length >= args.maxSentences) { reachedLimit = true; break; }
    const trace = frontend.tokensFor(sentence.sourceText, {allowUnknown: true});
    if (!trace.normalizedText || !HAN.test(trace.normalizedText)) continue;
    pending.push({...sentence, normalizedText: trace.normalizedText, readings: matchaReadings(trace)});
    if (pending.length >= args.sentenceBatchSize) await flush();
  }
  await flush();
  if (!reachedLimit) db.prepare("UPDATE runs SET status = 'complete', completed_at = ? WHERE id = ?")
    .run(new Date().toISOString(), runId);
  const summary = db.prepare(`SELECT COUNT(*) AS occurrences,
    SUM(category != 'agreement') AS differences, COUNT(DISTINCT source_sentence_id) AS sentences
    FROM occurrences WHERE run_id = ?`).get(runId);
  console.log(JSON.stringify({database: args.database, runId, reused: false,
    status: reachedLimit ? 'building' : 'complete', checkpoint, processed, ...summary}, null, 2));
} catch (error) {
  db.prepare("UPDATE runs SET status = 'failed' WHERE id = ?").run(runId);
  throw error;
} finally {
  worker?.child.stdin.end();
  worker?.child.kill();
  try { await browser?.close(); } finally {
    fs.rmSync(browserProfile, {recursive: true, force: true});
    db.close();
  }
}
