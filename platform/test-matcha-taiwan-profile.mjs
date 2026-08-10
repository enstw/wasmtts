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
assert.deepEqual(official.tokensFor('覺得曉得顯得懶得捨得').phones, [
  'jue2', 'de2', 'xiao3', 'de2', 'xian3', 'de2', 'lan3', 'de2', 'she3', 'de2',
]);
assert.deepEqual(taiwan.tokensFor('覺得曉得顯得懶得捨得').phones, [
  'jue2', 'de5', 'xiao3', 'de5', 'xian3', 'de5', 'lan3', 'de5', 'she3', 'de5',
]);
assert.deepEqual(taiwan.tokensFor('值得使得免得省得懂得').phones, [
  'zhi2', 'de5', 'shi3', 'de5', 'mian3', 'de5', 'sheng3', 'de5', 'dong3', 'de5',
]);
assert.deepEqual(official.tokensFor('長城長劍長河長凳長橋堤壩').phones, [
  'zhang3', 'cheng2', 'zhang3', 'jian4', 'zhang3', 'he2',
  'zhang3', 'deng4', 'zhang3', 'qiao2', 'di1', 'ba4',
]);
assert.deepEqual(taiwan.tokensFor('長城長劍長河長凳長橋堤壩').phones, [
  'chang2', 'cheng2', 'chang2', 'jian4', 'chang2', 'he2',
  'chang2', 'deng4', 'chang2', 'qiao2', 'ti2', 'ba4',
]);
for (const [text, phones] of [
  ['長輩', ['zhang3', 'bei4']],
  ['長大', ['zhang3', 'da4']],
  ['成長', ['cheng2', 'zhang3']],
  ['生長', ['sheng1', 'zhang3']],
  ['長子', ['zhang3', 'zi5']],
  ['長女', ['zhang3', 'nv3']],
]) assert.deepEqual(taiwan.tokensFor(text).phones, phones);
assert.deepEqual(taiwan.tokensFor('長命長生長久長遠長袍').phones, [
  'chang2', 'ming4', 'chang2', 'sheng1', 'chang2', 'jiu3',
  'chang2', 'yuan3', 'chang2', 'pao2',
]);

console.log(JSON.stringify({
  profile: 'taiwan',
  schemaVersion: review.schemaVersion,
  phraseOverrides: review.profiles.taiwan.phraseOverrides.length,
  contextualRules: review.profiles.taiwan.contextualRules.length,
}, null, 2));
