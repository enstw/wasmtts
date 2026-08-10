import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const review = JSON.parse(readFileSync(new URL('./matcha-g2p-review.json', import.meta.url), 'utf8'));
assert.equal(review.schemaVersion, 2);
assert.equal(review.locale, 'zh-TW');
assert.ok(Array.isArray(review.entries) && review.entries.length > 0);

const patterns = new Set();
for (const entry of review.entries) {
  assert.equal(typeof entry.pattern, 'string');
  assert.ok(entry.pattern.length > 0);
  assert.equal(patterns.has(entry.pattern), false, `重複候選：${entry.pattern}`);
  patterns.add(entry.pattern);
  assert.ok(['contextual-rule', 'phrase-override'].includes(entry.implementation));
  assert.ok(['confirmed', 'source-and-model-supported', 'model-supported'].includes(entry.status));
  if (entry.implementation === 'contextual-rule') {
    assert.match(entry.previousCharacters, /^\p{Script=Han}+$/u);
    assert.equal(new Set([...entry.previousCharacters]).size, [...entry.previousCharacters].length,
      `${entry.pattern} 的前字 allowlist 不可重複`);
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
