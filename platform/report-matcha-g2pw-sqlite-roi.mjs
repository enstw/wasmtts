#!/usr/bin/env node

// 從完整 g2pW SQLite index 產生人工審核用 ROI；模型差異不等同 Matcha 錯誤。

import {writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';

const DEFAULT_DATABASE = 'platform/results/matcha-g2p-index.local.sqlite';
const REVIEW_CATEGORIES = ['polyphone', 'neutral_tone', 'tone_disagreement'];
const ACTIVE_STATUSES = ['needs_context', 'accepted'];
const UNHANDLED_SQL = `NOT EXISTS (
  SELECT 1 FROM review_decisions d
  WHERE d.run_id = o.run_id AND d.character = o.character
    AND d.matcha_phone = o.matcha_phone AND d.g2pw_phone = o.g2pw_phone
    AND d.category = o.category AND d.status NOT IN ('needs_context', 'accepted')
    AND (d.scope_type = 'group' OR (d.scope_type = 'phrase'
      AND substr(s.text, o.character_offset - d.scope_offset + 1, length(d.scope_value)) = d.scope_value))
)`;

function parseArguments(argv) {
  if (argv[0] === '--') argv = argv.slice(1);
  let database = DEFAULT_DATABASE;
  let output = 'platform/results/matcha-g2pw-sqlite-roi.local.json';
  let runId;
  let minOccurrences = 3;
  let highConfidence = 0.9;
  let limit = 100;
  let contextLimit = 10;
  let sampleLimit = 5;
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    const value = argv[index + 1];
    if (option === '--database' && value) database = value, index += 1;
    else if (option === '--output' && value) output = value, index += 1;
    else if (option === '--run-id' && value) runId = Number(value), index += 1;
    else if (option === '--min-occurrences' && value) minOccurrences = Number(value), index += 1;
    else if (option === '--high-confidence' && value) highConfidence = Number(value), index += 1;
    else if (option === '--limit' && value) limit = Number(value), index += 1;
    else if (option === '--context-limit' && value) contextLimit = Number(value), index += 1;
    else if (option === '--sample-limit' && value) sampleLimit = Number(value), index += 1;
    else throw new Error(`不支援的參數：${option}`);
  }
  for (const [name, value] of Object.entries({minOccurrences, limit, contextLimit, sampleLimit})) {
    if (!Number.isInteger(value) || value < 1) throw new Error(`--${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} 必須是正整數`);
  }
  if (!(highConfidence >= 0 && highConfidence <= 1)) throw new Error('--high-confidence 必須介於 0 與 1');
  if (runId !== undefined && (!Number.isInteger(runId) || runId < 1)) throw new Error('--run-id 必須是正整數');
  return {database: resolve(database), output: resolve(output), runId, minOccurrences,
    highConfidence, limit, contextLimit, sampleLimit};
}

function rounded(value) {
  return Number(Number(value).toFixed(6));
}

function contextRows(db, runId, group, column, limit) {
  return db.prepare(`
    SELECT o.${column} AS character, COUNT(*) AS occurrences,
      AVG(o.confidence) AS average_confidence
    FROM occurrences o JOIN sentences s
      ON s.run_id = o.run_id AND s.source_sentence_id = o.source_sentence_id
    WHERE o.run_id = ? AND o.character = ? AND o.matcha_phone = ? AND o.g2pw_phone = ?
      AND o.category = ? AND o.${column} != '' AND ${UNHANDLED_SQL}
    GROUP BY o.${column}
    ORDER BY occurrences DESC, average_confidence DESC, character
    LIMIT ?
  `).all(runId, group.character, group.matcha_phone, group.g2pw_phone, group.category, limit)
    .map((row) => ({...row, averageConfidence: rounded(row.average_confidence)}))
    .map(({average_confidence: _, ...row}) => row);
}

function sampleRows(db, runId, group, limit) {
  return db.prepare(`
    SELECT o.source_sentence_id, o.character_offset, o.confidence, s.text, s.source_text
    FROM occurrences o JOIN sentences s
      ON s.run_id = o.run_id AND s.source_sentence_id = o.source_sentence_id
    WHERE o.run_id = ? AND o.character = ? AND o.matcha_phone = ? AND o.g2pw_phone = ?
      AND o.category = ?
      AND ${UNHANDLED_SQL}
    ORDER BY o.confidence DESC, o.source_sentence_id, o.character_offset
    LIMIT ?
  `).all(runId, group.character, group.matcha_phone, group.g2pw_phone, group.category, limit)
    .map((row) => ({
      sourceSentenceId: row.source_sentence_id,
      characterOffset: row.character_offset,
      confidence: rounded(row.confidence),
      normalizedText: row.text,
      sourceText: row.source_text,
    }));
}

export function buildSqliteRoiReport(db, options = {}) {
  const minOccurrences = options.minOccurrences ?? 3;
  const highConfidence = options.highConfidence ?? 0.9;
  const limit = options.limit ?? 100;
  const contextLimit = options.contextLimit ?? 10;
  const sampleLimit = options.sampleLimit ?? 5;
  const run = options.runId === undefined
    ? db.prepare("SELECT * FROM runs WHERE status = 'complete' ORDER BY completed_at DESC, id DESC LIMIT 1").get()
    : db.prepare('SELECT * FROM runs WHERE id = ?').get(options.runId);
  if (!run) throw new Error('找不到指定 run；資料庫必須至少有一個 complete run');
  if (run.status !== 'complete') throw new Error(`run ${run.id} 尚未完成：${run.status}`);

  const categorySummary = db.prepare(`
    SELECT category, COUNT(*) AS occurrences, AVG(confidence) AS average_confidence
    FROM occurrences WHERE run_id = ? GROUP BY category ORDER BY occurrences DESC
  `).all(run.id).map((row) => ({category: row.category, occurrences: row.occurrences,
    averageConfidence: rounded(row.average_confidence)}));
  const placeholders = REVIEW_CATEGORIES.map(() => '?').join(', ');
  const groups = db.prepare(`
    SELECT o.character, o.matcha_phone, o.g2pw_phone, o.category,
      COUNT(*) AS occurrences,
      SUM(CASE WHEN o.confidence >= ? THEN 1 ELSE 0 END) AS high_confidence_occurrences,
      AVG(o.confidence) AS average_confidence,
      MIN(o.confidence) AS minimum_confidence,
      MAX(o.confidence) AS maximum_confidence,
      COALESCE(MAX(CASE WHEN d.scope_type = 'group' THEN d.status END), 'unreviewed') AS review_status
    FROM occurrences o JOIN sentences s
      ON s.run_id = o.run_id AND s.source_sentence_id = o.source_sentence_id
    LEFT JOIN review_decisions d ON d.run_id = o.run_id AND d.character = o.character
      AND d.matcha_phone = o.matcha_phone AND d.g2pw_phone = o.g2pw_phone
      AND d.category = o.category AND d.scope_type = 'group'
    WHERE o.run_id = ? AND o.category IN (${placeholders}) AND ${UNHANDLED_SQL}
    GROUP BY o.character, o.matcha_phone, o.g2pw_phone, o.category
    HAVING COUNT(*) >= ?
    ORDER BY high_confidence_occurrences DESC, occurrences DESC, average_confidence DESC,
      o.character, o.matcha_phone, o.g2pw_phone
    LIMIT ?
  `).all(highConfidence, run.id, ...REVIEW_CATEGORIES, minOccurrences, limit);

  const candidates = groups.map((group, index) => ({
    rank: index + 1,
    character: group.character,
    matchaPhone: group.matcha_phone,
    g2pwPhone: group.g2pw_phone,
    category: group.category,
    occurrences: group.occurrences,
    highConfidenceOccurrences: group.high_confidence_occurrences,
    highConfidenceShare: rounded(group.high_confidence_occurrences / group.occurrences),
    averageConfidence: rounded(group.average_confidence),
    minimumConfidence: rounded(group.minimum_confidence),
    maximumConfidence: rounded(group.maximum_confidence),
    reviewStatus: group.review_status,
    previousContexts: contextRows(db, run.id, group, 'previous_character', contextLimit),
    followingContexts: contextRows(db, run.id, group, 'following_character', contextLimit),
    samples: sampleRows(db, run.id, group, sampleLimit),
  }));
  const reviewOccurrenceCount = categorySummary
    .filter(({category}) => REVIEW_CATEGORIES.includes(category))
    .reduce((sum, {occurrences}) => sum + occurrences, 0);
  return {
    schemaVersion: 1,
    purpose: '完整 SQLite index 的人工校正 ROI；任何候選都必須經辭典與語境審核後才能加入 Taiwan profile',
    run: {id: run.id, status: run.status, createdAt: run.created_at, completedAt: run.completed_at,
      lastSentenceId: run.last_sentence_id, fingerprint: run.fingerprint},
    selection: {categories: REVIEW_CATEGORIES, excludedCategories: ['agreement', 'tone_sandhi', 'unalignable'],
      minOccurrences, highConfidenceThreshold: highConfidence, limit, contextLimit, sampleLimit,
      activeDecisionStatuses: ACTIVE_STATUSES, ordering: 'highConfidenceOccurrences DESC, occurrences DESC, averageConfidence DESC'},
    summary: {allOccurrences: categorySummary.reduce((sum, row) => sum + row.occurrences, 0),
      reviewOccurrences: reviewOccurrenceCount, returnedCandidates: candidates.length, categories: categorySummary},
    caveats: [
      'g2pW 是候選產生器，不是發音真值；高信心只表示模型自信。',
      'neutral tone、變調、臺灣讀音與詞義差異必須分開判讀。',
      '相鄰字桶只提供 ROI 線索，不足以直接建立全域 contextual rule。',
    ],
    candidates,
  };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = parseArguments(process.argv.slice(2));
  const db = new DatabaseSync(args.database, {readOnly: true});
  try {
    const report = buildSqliteRoiReport(db, args);
    writeFileSync(args.output, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({output: args.output, runId: report.run.id,
      reviewOccurrences: report.summary.reviewOccurrences,
      candidates: report.summary.returnedCandidates}, null, 2));
  } finally {
    db.close();
  }
}
