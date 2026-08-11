import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const review = JSON.parse(readFileSync(new URL('./matcha-g2p-review.json', import.meta.url), 'utf8'));
assert.equal(review.schemaVersion, 3);
assert.equal(review.locale, 'zh-TW');
assert.ok(Array.isArray(review.entries) && review.entries.length > 0);
assert.ok(Array.isArray(review.groupDecisions));

for (const decision of review.groupDecisions) {
  assert.match(decision.character, /^.$/u);
  assert.match(decision.matchaPhone, /^[a-z]+[1-5]$/u);
  assert.match(decision.g2pwPhone, /^[a-z]+[1-5]$/u);
  assert.ok(['polyphone', 'neutral_tone', 'tone_disagreement'].includes(decision.category));
  assert.ok(['rejected_current_correct', 'rejected_model_error',
    'rejected_regional_difference', 'deferred'].includes(decision.status));
  assert.ok(decision.rationale.length > 0);
  assert.match(decision.source.url, /^https:\/\/dict\.(?:concised|revised)\.moe\.edu\.tw\//u);
}

const patterns = new Set();
for (const entry of review.entries) {
  assert.equal(typeof entry.pattern, 'string');
  assert.ok(entry.pattern.length > 0);
  assert.equal(patterns.has(entry.pattern), false, `重複候選：${entry.pattern}`);
  patterns.add(entry.pattern);
  assert.ok(['contextual-rule', 'phrase-override'].includes(entry.implementation));
  assert.ok(['confirmed', 'source-and-model-supported', 'model-supported'].includes(entry.status));
  if (entry.implementation === 'contextual-rule') {
    const directions = ['previousCharacters', 'followingCharacters']
      .filter((key) => typeof entry[key] === 'string');
    assert.ok(directions.length > 0, `${entry.pattern} 至少需要一側 allowlist`);
    for (const key of directions) {
      assert.match(entry[key], /^\S+$/u);
      assert.equal(new Set([...entry[key]]).size, [...entry[key]].length,
        `${entry.pattern} 的 ${key} allowlist 不可重複`);
    }
    assert.ok(entry.evidence.pilotMatches > 0);
    assert.equal(entry.evidence.pilotCounterexamples, 0);
  }
  assert.equal(entry.observed.length, [...entry.pattern].length);
  assert.equal(entry.target.length, [...entry.pattern].length);
  for (const phone of [...entry.observed, ...entry.target]) {
    assert.match(phone, /^[a-z]+[1-5]$/u);
  }
  assert.match(entry.source.url, /^https:\/\/dict\.(?:concised|revised)\.moe\.edu\.tw\//u);
  assert.equal(typeof entry.source.version, 'string');
}

const taiwan = review.profiles?.taiwan;
assert.ok(taiwan);
const enabled = [...taiwan.phraseOverrides, ...taiwan.contextualRules];
assert.equal(new Set(enabled).size, enabled.length, 'Taiwan profile 不可重複啟用 pattern');
for (const pattern of enabled) assert.ok(patterns.has(pattern), `Taiwan profile 找不到：${pattern}`);

console.log(JSON.stringify({locale: review.locale, verifiedEntries: review.entries.length}, null, 2));
