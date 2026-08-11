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
assert.deepEqual(official.tokensFor('和他').phones, ['he2', 'ta1']);
assert.deepEqual(taiwan.tokensFor('和他').phones, ['han4', 'ta1']);
assert.deepEqual(taiwan.tokensFor('和平和氣附和摻和').phones, [
  'he2', 'ping2', 'he2', 'qi4', 'fu4', 'he4', 'can4', 'he2',
]);
assert.deepEqual(official.tokensFor('作為成為名為修為極為身為視為最為譽為淪為').phones, [
  'zuo4', 'wei4', 'cheng2', 'wei4', 'ming2', 'wei4', 'xiu1', 'wei4', 'ji2', 'wei4',
  'shen1', 'wei4', 'shi4', 'wei4', 'zui4', 'wei4', 'yu4', 'wei4', 'lun2', 'wei4',
]);
assert.deepEqual(taiwan.tokensFor('作為成為名為修為極為身為視為最為譽為淪為').phones, [
  'zuo4', 'wei2', 'cheng2', 'wei2', 'ming2', 'wei2', 'xiu1', 'wei2', 'ji2', 'wei2',
  'shen1', 'wei2', 'shi4', 'wei2', 'zui4', 'wei2', 'yu4', 'wei2', 'lun2', 'wei2',
]);
assert.deepEqual(taiwan.tokensFor('因為為了為何為此').phones, [
  'yin1', 'wei4', 'wei4', 'le5', 'wei4', 'he2', 'wei4', 'ci3',
]);
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
assert.deepEqual(official.tokensFor('徵兆地自主地').phones, [
  'zheng1', 'zhao4', 'di4', 'zi4', 'zhu3', 'di4',
]);
assert.deepEqual(taiwan.tokensFor('徵兆地自主地').phones, [
  'zheng1', 'zhao4', 'de5', 'zi4', 'zhu3', 'de5',
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
assert.deepEqual(official.tokensFor('答應幾乎暫時熟悉認識意識見識資質材質期間期待').phones, [
  'da2', 'ying1', 'ji3', 'hu1', 'zan4', 'shi2', 'shu2', 'xi1', 'ren4', 'shi2',
  'yi4', 'shi2', 'jian4', 'shi2', 'zi1', 'zhi4', 'cai2', 'zhi4', 'qi1', 'jian1',
  'qi1', 'dai4',
]);
assert.deepEqual(taiwan.tokensFor('答應幾乎暫時熟悉認識意識見識資質材質期間期待').phones, [
  'da1', 'ying4', 'ji1', 'hu1', 'zhan4', 'shi2', 'shou2', 'xi1', 'ren4', 'shi4',
  'yi4', 'shi4', 'jian4', 'shi4', 'zi1', 'zhi2', 'cai2', 'zhi2', 'qi2', 'jian1',
  'qi2', 'dai4',
]);
assert.deepEqual(official.tokensFor('誰').phones, ['shui2']);
assert.equal(MatchaFrontend.pronunciationOverridesFromReview(review).誰, undefined);
assert.deepEqual(official.tokensFor('會兒今兒這兒個兒那兒').phones, [
  'hui4', 'er2', 'jin1', 'er2', 'zhe4', 'er2', 'ge4', 'er2', 'na4', 'er2',
]);
assert.deepEqual(taiwan.tokensFor('會兒今兒這兒個兒那兒').phones, [
  'hui3', 'er1', 'jin1', 'er1', 'zhe4', 'er1', 'ge4', 'er1', 'na4', 'er1',
]);
assert.deepEqual(taiwan.tokensFor('兒童嬰兒女兒').phones, [
  'er2', 'tong2', 'ying1', 'er2', 'nv3', 'er2',
]);
assert.deepEqual(taiwan.tokensFor('事兒哪兒地兒玩意兒明兒娃兒人兒鴉兒老聾兒').phones, [
  'shi4', 'er1', 'na3', 'er1', 'di4', 'er1', 'wan2', 'yi4', 'er1',
  'ming2', 'er1', 'wa2', 'er1', 'ren2', 'er1', 'ya1', 'er1',
  'lao3', 'long2', 'er1',
]);

console.log(JSON.stringify({
  profile: 'taiwan',
  schemaVersion: review.schemaVersion,
  phraseOverrides: review.profiles.taiwan.phraseOverrides.length,
  contextualRules: review.profiles.taiwan.contextualRules.length,
}, null, 2));
