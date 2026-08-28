import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';

import {buildMatchaLexicon, readBuildInputs} from './build-matcha-lexicon.mjs';

const require = createRequire(import.meta.url);
const frontendApi = require('./matcha-frontend.js');
const profileApi = require('./matcha-taiwan-profile.js');

const inputs = readBuildInputs();
const {lexiconText, tokensText, review, curation} = inputs;
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

// 決定性:同一組輸入建置兩次必須 byte 相同。
const first = buildMatchaLexicon(inputs);
const second = buildMatchaLexicon(inputs);
assert.equal(sha256(first.text), sha256(second.text), '編譯結果不具決定性');
assert.equal(first.entryCount, second.entryCount);

const tokens = frontendApi.parseTokens(tokensText);
const {lexicon: upstream} = frontendApi.parseLexicon(lexiconText);
const {lexicon: compiled} = frontendApi.parseLexicon(first.text);
assert.equal(compiled.size, first.entryCount);

// 上游每條 key 都在輸出中;除非被 overrides／guards 明列覆蓋,讀音不變。
const profile = profileApi.createConfig(review, frontendApi);
const overridden = new Set([
  ...Object.keys(profile.pronunciationOverrides),
  ...curation.guards.map((guard) => guard.pattern),
]);
for (const [word, phones] of upstream) {
  assert.ok(compiled.has(word), `上游詞條 ${word} 不在編譯結果`);
  if (!overridden.has(word)) assert.deepEqual(compiled.get(word), phones, `上游詞條 ${word} 讀音被改`);
}
// 每個 phone 都在 tokens.txt;每條 review phrase override 與 curation guard 都烘進檔內。
for (const [word, phones] of compiled) {
  for (const phone of phones) assert.ok(tokens.has(phone), `${word} 的 ${phone} 不在 tokens.txt`);
}
for (const [word, phones] of Object.entries(profile.pronunciationOverrides)) {
  assert.deepEqual(compiled.get(word), [...phones], `override ${word} 未烘入`);
}
for (const guard of curation.guards) {
  assert.deepEqual(compiled.get(guard.pattern), guard.phones, `guard ${guard.pattern} 未烘入`);
}
// curation exclusions 維持單字 fallback:不得以整詞出現。
for (const {pattern} of curation.exclusions) {
  assert.ok(!compiled.has(pattern) || upstream.has(pattern), `exclusion ${pattern} 被鏡像收錄`);
}

// 產品組合只用「編譯後 lexicon ＋ runtime profile」:證明單一檔即完整,
// 不再有 lexiconSupplementText 這種可漏接的 optional 參數。
const runtimeProfile = first.runtimeProfile;
assert.equal(runtimeProfile.entries.length, review.entries.length);
assert.ok(runtimeProfile.entries.every((entry) => entry.observed === undefined && entry.source === undefined));
const taiwan = profileApi.createFrontend({
  review: runtimeProfile, frontendApi, lexiconText: first.text, tokensText,
});
assert.equal(taiwan.lexiconSupplementSize, 0);
assert.equal(taiwan.lexiconSize, first.entryCount);

// base 音節修正(上游簡體詞條的繁體鏡像)。
assert.deepEqual(taiwan.tokensFor('銀行').phones, ['yin2', 'hang2']);
assert.deepEqual(taiwan.tokensFor('會計').phones, ['kuai4', 'ji4']);
assert.deepEqual(taiwan.tokensFor('會計師').phones, ['kuai4', 'ji4', 'shi1']);
assert.deepEqual(taiwan.tokensFor('類似').phones, ['lei4', 'si4']);
assert.deepEqual(taiwan.tokensFor('模樣').phones, ['mu2', 'yang4']);
assert.deepEqual(taiwan.tokensFor('一模一樣').phones, ['yi1', 'mu2', 'yi1', 'yang4']);
assert.deepEqual(taiwan.tokensFor('剎那').phones, ['cha4', 'na4']);
assert.deepEqual(taiwan.tokensFor('調侃').phones, ['tiao2', 'kan3']);
assert.deepEqual(taiwan.tokensFor('東躲西藏').phones, ['dong1', 'duo3', 'xi1', 'cang2']);
assert.deepEqual(taiwan.tokensFor('一語中的').phones, ['yi1', 'yu3', 'zhong4', 'di4']);
// 逐位合併:profile 已裁決的字位保留 profile 讀音(微 wei2),其餘位取上游鏡像(調 tiao2)。
assert.deepEqual(taiwan.tokensFor('微調').phones, ['wei2', 'tiao2']);

// 邊界:全量鏡像讓繁體直輸的分詞與上游簡體一致。孫道長+久久 曾被切成
// 道/長久 chang2;上游簡體有 道长 整詞不會發生。
assert.ok(compiled.has('道長'));
assert.deepEqual(taiwan.tokensFor('孫道長久久不語').phones, ['sun1', 'dao4', 'zhang3', 'jiu3', 'jiu3', 'bu4', 'yu3']);
assert.deepEqual(taiwan.tokensFor('孫道長眉一挑').phones.slice(0, 4), ['sun1', 'dao4', 'zhang3', 'mei2']);
assert.deepEqual(taiwan.tokensFor('孫道長嘆一聲').phones.slice(0, 4), ['sun1', 'dao4', 'zhang3', 'tan4']);
assert.deepEqual(taiwan.tokensFor('道長達').phones, ['dao4', 'zhang3', 'da2']);
assert.deepEqual(taiwan.tokensFor('孙道长久久').phones, taiwan.tokensFor('孫道長久久').phones);
// 邊界只改分詞,不改讀音:被守住的詞與被擋下的詞各自單獨出現時讀音不變。
assert.deepEqual(taiwan.tokensFor('道長').phones, ['dao4', 'zhang3']);
assert.deepEqual(taiwan.tokensFor('長久').phones, ['chang2', 'jiu3']);
assert.deepEqual(taiwan.tokensFor('長眉').phones, ['chang2', 'mei2']);

// curation guards 與 exclusions:已知跨詞邊界維持正確讀音。
assert.deepEqual(taiwan.tokensFor('不會計較').phones, ['bu4', 'hui4', 'ji4', 'jiao4']);
assert.deepEqual(taiwan.tokensFor('只會計算').phones, ['zhi3', 'hui4', 'ji4', 'suan4']);
assert.deepEqual(taiwan.tokensFor('沒有著急').phones, ['mei2', 'you3', 'zhao1', 'ji2']);
assert.deepEqual(taiwan.tokensFor('沒有著落').phones, ['mei2', 'you3', 'zhuo2', 'luo4']);
assert.deepEqual(taiwan.tokensFor('守一覺得').phones, ['shou3', 'yi1', 'jue2', 'de5']);
assert.deepEqual(taiwan.tokensFor('睡了一覺').phones, ['shui4', 'le5', 'yi1', 'jiao4']);
assert.deepEqual(taiwan.tokensFor('什麼都會做').phones, ['shen2', 'me5', 'dou1', 'hui4', 'zuo4']);
assert.deepEqual(taiwan.tokensFor('沒過多久').phones, ['mei2', 'guo4', 'duo1', 'jiu3']);
assert.deepEqual(taiwan.tokensFor('住在泥瓶巷的當地人').phones.slice(-4), ['de5', 'dang1', 'di4', 'ren2']);

// 烘入的 overrides 與 runtime contextual rules 都生效。
assert.deepEqual(taiwan.tokensFor('垃圾').phones, ['le4', 'se4']);
assert.deepEqual(taiwan.tokensFor('品質').phones, ['pin3', 'zhi2']);
assert.deepEqual(taiwan.tokensFor('覺得').phones, ['jue2', 'de5']);
assert.deepEqual(taiwan.tokensFor('帶著').phones, ['dai4', 'zhe5']);

// 只給 lexicon 不給 profile 時,contextual rules 不生效——engine 層會把這當成
// 缺件而 throw;這裡固定 frontend 本身的行為以免兩層互相掩蓋。
const bare = frontendApi.createFrontend({lexiconText: first.text, tokensText});
assert.deepEqual(bare.tokensFor('垃圾').phones, ['le4', 'se4']);
assert.deepEqual(bare.tokensFor('帶著').phones, ['dai4', 'zhu4']);

console.log(JSON.stringify({
  gate: 'lexicon',
  entries: first.entryCount,
  bytes: Buffer.byteLength(first.text),
  outputSha256: sha256(first.text),
  stats: first.stats,
}, null, 2));
