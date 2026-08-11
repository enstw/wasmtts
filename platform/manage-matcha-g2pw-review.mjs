#!/usr/bin/env node

// 管理完整 SQLite ROI 的持久化審核決策；不改寫原始 occurrence。

import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';

import {differenceCategory, initializeG2pwIndex} from './g2pw-index-db.mjs';

const DEFAULT_DATABASE = 'platform/results/matcha-g2p-index.local.sqlite';
const DEFAULT_REVIEW = 'platform/matcha-g2p-review.json';
const STATUSES = new Set([
  'needs_context', 'accepted', 'implemented', 'rejected_current_correct',
  'rejected_model_error', 'rejected_regional_difference', 'deferred', 'superseded',
]);

function argumentsFrom(argv) {
  if (argv[0] === '--') argv = argv.slice(1);
  const command = argv.shift();
  let database = DEFAULT_DATABASE;
  let review = DEFAULT_REVIEW;
  let runId;
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    const value = argv[index + 1];
    if (!option.startsWith('--') || value === undefined) throw new Error(`不支援的參數：${option}`);
    const key = option.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (key === 'database') database = value;
    else if (key === 'review') review = value;
    else if (key === 'runId') runId = Number(value);
    else values[key] = value;
    index += 1;
  }
  return {command, database: resolve(database), review: resolve(review), runId, values};
}

function selectedRun(db, runId) {
  const run = runId === undefined
    ? db.prepare("SELECT * FROM runs WHERE status = 'complete' ORDER BY completed_at DESC, id DESC LIMIT 1").get()
    : db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
  if (!run) throw new Error('找不到指定 run');
  return run;
}

function decisionWriter(db) {
  return db.prepare(`
    INSERT INTO review_decisions(run_id, character, matcha_phone, g2pw_phone, category,
      scope_type, scope_value, scope_offset, status, rationale, source_url, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_id, character, matcha_phone, g2pw_phone, category,
      scope_type, scope_value, scope_offset) DO UPDATE SET
      status = excluded.status, rationale = excluded.rationale,
      source_url = excluded.source_url, updated_at = excluded.updated_at
  `);
}

export function syncImplementedProfile(db, runId, review) {
  const enabled = new Set(review.profiles?.taiwan?.phraseOverrides ?? []);
  const write = decisionWriter(db);
  const now = new Date().toISOString();
  let decisions = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const entry of review.entries ?? []) {
      if (!enabled.has(entry.pattern) || entry.implementation !== 'phrase-override' ||
          !Array.isArray(entry.observed) || !Array.isArray(entry.target)) continue;
      const characters = [...entry.pattern];
      if (characters.length !== entry.observed.length || characters.length !== entry.target.length) continue;
      for (let offset = 0; offset < characters.length; offset += 1) {
        const matcha = entry.observed[offset];
        const g2pw = entry.target[offset];
        if (matcha === g2pw) continue;
        const category = differenceCategory(characters[offset], matcha, g2pw);
        write.run(runId, characters[offset], matcha, g2pw, category, 'phrase', entry.pattern,
          offset, 'implemented', entry.scope ?? 'Taiwan profile phrase override', entry.source?.url ?? null,
          now, now);
        decisions += 1;
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return decisions;
}

export function setGroupDecision(db, runId, values) {
  for (const key of ['character', 'matchaPhone', 'g2pwPhone', 'category', 'status']) {
    if (!values[key]) throw new Error(`set-group 缺少 --${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`);
  }
  if (!STATUSES.has(values.status)) throw new Error(`不支援的 status：${values.status}`);
  const now = new Date().toISOString();
  decisionWriter(db).run(runId, values.character, values.matchaPhone, values.g2pwPhone,
    values.category, 'group', '', 0, values.status, values.rationale ?? '', values.sourceUrl ?? null,
    now, now);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = argumentsFrom(process.argv.slice(2));
  if (!args.command) {
    console.error('用法：manage-matcha-g2pw-review.mjs <sync-profile|set-group|status> [options]');
    process.exit(2);
  }
  const db = new DatabaseSync(args.database);
  try {
    initializeG2pwIndex(db);
    const run = selectedRun(db, args.runId);
    if (args.command === 'sync-profile') {
      const count = syncImplementedProfile(db, run.id, JSON.parse(readFileSync(args.review, 'utf8')));
      console.log(JSON.stringify({runId: run.id, syncedDecisions: count}, null, 2));
    } else if (args.command === 'set-group') {
      setGroupDecision(db, run.id, args.values);
      console.log(JSON.stringify({runId: run.id, ...args.values}, null, 2));
    } else if (args.command === 'status') {
      const rows = db.prepare(`SELECT status, scope_type, COUNT(*) AS decisions
        FROM review_decisions WHERE run_id = ? GROUP BY status, scope_type ORDER BY status, scope_type`).all(run.id);
      console.log(JSON.stringify({runId: run.id, decisions: rows}, null, 2));
    } else throw new Error(`不支援的 command：${args.command}`);
  } finally {
    db.close();
  }
}
