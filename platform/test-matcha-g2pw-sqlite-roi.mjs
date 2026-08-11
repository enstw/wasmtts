import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';

import {initializeG2pwIndex} from './g2pw-index-db.mjs';
import {setGroupDecision, syncImplementedProfile} from './manage-matcha-g2pw-review.mjs';
import {buildSqliteRoiReport} from './report-matcha-g2pw-sqlite-roi.mjs';

const db = new DatabaseSync(':memory:');
initializeG2pwIndex(db);
db.prepare(`INSERT INTO runs(id, fingerprint, created_at, completed_at, status, source_sha256,
  model_sha256, lexicon_sha256, fst_sha256, profile_sha256, backend, runtime, last_sentence_id)
  VALUES (1, 'fixture', '2026-08-11T00:00:00Z', '2026-08-11T01:00:00Z', 'complete',
    's', 'm', 'l', 'f', 'p', 'webgpu', 'fixture', 2)`).run();
const sentence = db.prepare('INSERT INTO sentences(run_id, source_sentence_id, text, source_text) VALUES (1, ?, ?, ?)');
sentence.run(0, '他和我說。', '他和我說。');
sentence.run(1, '她和你說。', '她和你說。');
sentence.run(2, '和平。', '和平。');
const occurrence = db.prepare(`INSERT INTO occurrences(run_id, source_sentence_id, character_offset,
  character, previous_character, following_character, matcha_phone, g2pw_phone, confidence, category)
  VALUES (1, ?, 1, '和', ?, ?, 'he2', ?, ?, ?)`);
occurrence.run(0, '他', '我', 'han4', 0.99, 'polyphone');
occurrence.run(1, '她', '你', 'han4', 0.95, 'polyphone');
occurrence.run(2, '', '平', 'he2', 0.98, 'agreement');

syncImplementedProfile(db, 1, {
  profiles: {taiwan: {phraseOverrides: ['他和']}},
  entries: [{pattern: '他和', observed: ['ta1', 'he2'], target: ['ta1', 'han4'],
    implementation: 'phrase-override', status: 'source-and-model-supported', scope: 'fixture'}],
});
setGroupDecision(db, 1, {character: '和', matchaPhone: 'he2', g2pwPhone: 'han4',
  category: 'polyphone', status: 'needs_context', rationale: '其餘語境仍需審核'});
const report = buildSqliteRoiReport(db, {minOccurrences: 1, limit: 10, contextLimit: 2, sampleLimit: 1});
assert.equal(report.run.id, 1);
assert.equal(report.summary.allOccurrences, 3);
assert.equal(report.summary.reviewOccurrences, 2);
assert.equal(report.summary.returnedCandidates, 1);
assert.deepEqual(report.candidates[0], {
  rank: 1,
  character: '和', matchaPhone: 'he2', g2pwPhone: 'han4', category: 'polyphone',
  occurrences: 1, highConfidenceOccurrences: 1, highConfidenceShare: 1,
  averageConfidence: 0.95, minimumConfidence: 0.95, maximumConfidence: 0.95,
  reviewStatus: 'needs_context',
  previousContexts: [{character: '她', occurrences: 1, averageConfidence: 0.95}],
  followingContexts: [{character: '你', occurrences: 1, averageConfidence: 0.95}],
  samples: [{sourceSentenceId: 1, characterOffset: 1, confidence: 0.95,
    normalizedText: '她和你說。', sourceText: '她和你說。'}],
});
setGroupDecision(db, 1, {character: '和', matchaPhone: 'he2', g2pwPhone: 'han4',
  category: 'polyphone', status: 'rejected_current_correct', rationale: 'fixture terminal'});
assert.equal(buildSqliteRoiReport(db, {minOccurrences: 1}).summary.returnedCandidates, 0);
db.close();

console.log(JSON.stringify(report.summary, null, 2));
