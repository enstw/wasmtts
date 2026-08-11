#!/usr/bin/env node

// 以真實固定 batch 驗證 WebGPU → SQLite 的 run 隔離、transaction 與 resume。

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {launch} from './cdp/cdp-client.mjs';
import {differenceCategory, initializeG2pwIndex} from './g2pw-index-db.mjs';

function argumentsFrom(argv) {
  if (argv[0] === '--') argv = argv.slice(1);
  let database = 'platform/results/matcha-g2p-index.local.sqlite';
  let fixture = 'platform/results/g2pw-webgpu-fixture.local.json';
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--database' && argv[index + 1]) database = argv[++index];
    else if (argv[index] === '--fixture' && argv[index + 1]) fixture = argv[++index];
    else throw new Error(`不支援的參數：${argv[index]}`);
  }
  return {database: path.resolve(database), fixture: path.resolve(fixture)};
}

function sha256File(filename) {
  return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
}

function sha256Json(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

const args = argumentsFrom(process.argv.slice(2));
const fixture = JSON.parse(fs.readFileSync(args.fixture, 'utf8'));
const fstFiles = ['phone', 'date', 'number'].map((name) =>
  path.resolve(`platform/models/matcha-icefall-zh-en/${name}-zh.fst`));
const metadata = {
  schemaVersion: 2,
  sourceSha256: fixture.inputSha256,
  modelSha256: fixture.model.sha256,
  lexiconSha256: fixture.lexicon.sha256,
  fstSha256: sha256Json(fstFiles.map((filename) => sha256File(filename))),
  profileSha256: sha256File(path.resolve('platform/matcha-g2p-review.json')),
  backend: 'onnxruntime-web:webgpu',
  runtime: 'onnxruntime-web@1.27.0',
};
const fingerprint = sha256Json(metadata);
fs.mkdirSync(path.dirname(args.database), {recursive: true});
const db = new DatabaseSync(args.database);
initializeG2pwIndex(db);

const existing = db.prepare('SELECT id, status FROM runs WHERE fingerprint = ?').get(fingerprint);
if (existing?.status === 'complete') {
  const summary = db.prepare(`
    SELECT COUNT(*) AS occurrences,
      SUM(category != 'agreement') AS differences,
      COUNT(DISTINCT source_sentence_id) AS sentences
    FROM occurrences WHERE run_id = ?
  `).get(existing.id);
  console.log(JSON.stringify({database: args.database, runId: existing.id, reused: true, ...summary}, null, 2));
  db.close();
  process.exit(0);
}

const insertRun = db.prepare(`
  INSERT INTO runs (
    fingerprint, created_at, status, source_sha256, model_sha256, lexicon_sha256,
    fst_sha256, profile_sha256, backend, runtime
  ) VALUES (?, ?, 'building', ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(fingerprint) DO UPDATE SET status = 'building'
  RETURNING id
`);
const runId = insertRun.get(
  fingerprint, new Date().toISOString(), metadata.sourceSha256, metadata.modelSha256,
  metadata.lexiconSha256, metadata.fstSha256, metadata.profileSha256, metadata.backend, metadata.runtime,
).id;

const host = process.env.WASM_TTS_BENCH_HOST ?? '127.0.0.1';
const serverPort = Number(process.env.WASM_TTS_BENCH_PORT ?? 8765);
const cdpPort = Number(process.env.WASM_TTS_CDP_PORT ?? 9392);
const url = `http://${host}:${serverPort}/platform/g2pw-webgpu-benchmark.html`;
const fixtureUrl = `/platform/results/${path.basename(args.fixture)}`;
const profile = path.join(os.tmpdir(), `wasmtts-g2pw-sqlite-${process.pid}`);
let browser;
try {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`benchmark host returned HTTP ${response.status}`);
  browser = await launch({
    port: cdpPort, profile, gpu: true,
    args: ['--enable-gpu', '--enable-unsafe-webgpu', '--use-angle=metal'],
  });
  const {send, evalJs, sessionId} = browser;
  await send('Page.navigate', {url}, sessionId);
  const deadline = Date.now() + 30000;
  while (!(await evalJs('window.ready === true'))) {
    if (Date.now() > deadline) throw new Error('WebGPU index page did not become ready');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const result = await evalJs(`window.g2pwWebgpuBench.run(${JSON.stringify({fixtureUrl, iterations: 1})})`);
  if (result.predictionMismatches.length) throw new Error('WebGPU prediction 與 CPU golden 不一致');
  if (result.predictions.length !== fixture.queryMetadata.length) throw new Error('prediction/query 數量不一致');

  const insertSentence = db.prepare(`
    INSERT OR IGNORE INTO sentences(run_id, source_sentence_id, text) VALUES (?, ?, ?)
  `);
  const insertOccurrence = db.prepare(`
    INSERT OR REPLACE INTO occurrences(
      run_id, source_sentence_id, character_offset, character, previous_character,
      following_character, matcha_phone, g2pw_phone, confidence, category
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  db.exec('BEGIN IMMEDIATE');
  try {
    for (let sentenceId = 0; sentenceId < fixture.sentences.length; sentenceId += 1) {
      insertSentence.run(runId, sentenceId, fixture.sentences[sentenceId]);
    }
    fixture.queryMetadata.forEach((query, index) => {
      const prediction = result.predictions[index];
      insertOccurrence.run(
        runId, query.sentenceId, query.offset, query.character, query.previous, query.following,
        query.matcha, prediction.phone, prediction.confidence,
        differenceCategory(query.character, query.matcha, prediction.phone),
      );
    });
    db.prepare("UPDATE runs SET status = 'complete', completed_at = ? WHERE id = ?")
      .run(new Date().toISOString(), runId);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  const summary = db.prepare(`
    SELECT COUNT(*) AS occurrences,
      SUM(category != 'agreement') AS differences,
      COUNT(DISTINCT source_sentence_id) AS sentences
    FROM occurrences WHERE run_id = ?
  `).get(runId);
  const roi = db.prepare(`
    SELECT character, matcha_phone AS matcha, g2pw_phone AS g2pw, COUNT(*) AS count
    FROM occurrences WHERE run_id = ? AND category != 'agreement'
    GROUP BY character, matcha_phone, g2pw_phone ORDER BY count DESC, character
  `).all(runId);
  console.log(JSON.stringify({database: args.database, runId, reused: false, ...summary, roi}, null, 2));
} catch (error) {
  db.prepare("UPDATE runs SET status = 'failed' WHERE id = ?").run(runId);
  throw error;
} finally {
  try { await browser?.close(); } finally {
    fs.rmSync(profile, {recursive: true, force: true});
    db.close();
  }
}
