import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

import './matcha-frontend.js';

const read = (name) => readFileSync(new URL(name, import.meta.url), 'utf8');
const review = JSON.parse(read('./matcha-g2p-review.json'));
const common = {
  lexiconText: read('./models/matcha-icefall-zh-en/lexicon.txt'),
  tokensText: read('./models/matcha-icefall-zh-en/tokens.txt'),
};
const official = MatchaFrontend.createFrontend(common);
const taiwan = MatchaFrontend.createFrontend({
  ...common,
  pronunciationOverrides: {
    '垃圾': ['le4', 'se4'],
    ...MatchaFrontend.pronunciationOverridesFromReview(review, 'taiwan'),
  },
  contextualRules: MatchaFrontend.contextualRulesFromReview(review, 'taiwan'),
});

assert.deepEqual(official.tokensFor('帶著').phones, ['dai4', 'zhu4']);
assert.deepEqual(taiwan.tokensFor('帶著').phones, ['dai4', 'zhe5']);
assert.deepEqual(taiwan.tokensFor('找著').phones, ['zhao3', 'zhao2']);
assert.deepEqual(taiwan.tokensFor('著手').phones, ['zhuo2', 'shou3']);
assert.deepEqual(taiwan.tokensFor('看著急').phones, ['kan4', 'zhao1', 'ji2']);
assert.deepEqual(taiwan.tokensFor('垃圾').phones, ['le4', 'se4']);

console.log(JSON.stringify({
  profile: 'taiwan',
  schemaVersion: review.schemaVersion,
  phraseOverrides: review.profiles.taiwan.phraseOverrides.length,
  contextualRules: review.profiles.taiwan.contextualRules.length,
}, null, 2));
