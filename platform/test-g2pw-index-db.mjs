import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {differenceCategory, initializeG2pwIndex} from './g2pw-index-db.mjs';

assert.equal(differenceCategory('為', 'wei4', 'wei2'), 'tone_disagreement');
assert.equal(differenceCategory('和', 'he2', 'han4'), 'polyphone');
assert.equal(differenceCategory('得', 'de2', 'de5'), 'neutral_tone');
assert.equal(differenceCategory('的', 'de5', 'de5'), 'agreement');
assert.equal(differenceCategory('字', null, 'zi4'), 'unalignable');

const db = new DatabaseSync(':memory:');
initializeG2pwIndex(db);
const columns = db.prepare("SELECT name FROM pragma_table_info('occurrences') ORDER BY cid").all().map(({name}) => name);
assert.deepEqual(columns, [
  'run_id', 'source_sentence_id', 'character_offset', 'character', 'previous_character',
  'following_character', 'matcha_phone', 'g2pw_phone', 'confidence', 'category',
]);
assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
db.close();

console.log(JSON.stringify({categories: 5, occurrenceColumns: columns.length, integrity: 'ok'}, null, 2));
