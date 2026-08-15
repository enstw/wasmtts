import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';

import {buildTraditionalLexicon} from './generate-matcha-lexicon-traditional.mjs';

const require = createRequire(import.meta.url);
const frontendApi = require('./matcha-frontend.js');
const profileApi = require('./matcha-taiwan-profile.js');

const read = (name) => readFileSync(new URL(name, import.meta.url), 'utf8');
const lexiconText = read('./models/matcha-icefall-zh-en/lexicon.txt');
const tokensText = read('./models/matcha-icefall-zh-en/tokens.txt');
const review = JSON.parse(read('./matcha-g2p-review.json'));
const curation = JSON.parse(read('./matcha-lexicon-traditional-curation.json'));
const committedText = read('./matcha-lexicon-traditional.txt');
const meta = JSON.parse(read('./matcha-lexicon-traditional.meta.json'));

// codegen gate:提交的補充詞典必須等於由上游 lexicon + review + curation
// 重新生成的結果;任何一邊改動而未重跑產生器都在這裡紅燈。
const regenerated = buildTraditionalLexicon({lexiconText, tokensText, review, curation});
assert.equal(committedText, regenerated.text,
  '提交的 matcha-lexicon-traditional.txt 與重新生成結果不一致 — 請跑 pnpm generate:matcha-lexicon-traditional');
assert.equal(meta.entryCount, regenerated.entryCount);

// 補充詞條與主詞典 key 互斥;phones 全部存在於 tokens.txt。
const {lexicon: baseLexicon} = frontendApi.parseLexicon(lexiconText);
const {lexicon: supplementLexicon} = frontendApi.parseLexicon(committedText);
const tokens = frontendApi.parseTokens(tokensText);
for (const [word, phones] of supplementLexicon) {
  assert.ok(!baseLexicon.has(word), `補充詞條 ${word} 與主詞典重複`);
  for (const phone of phones) assert.ok(tokens.has(phone), `${word} 的 ${phone} 不在 tokens.txt`);
}

// 產品組合:taiwan profile + 補充詞典。
const taiwan = profileApi.createFrontend({
  review, frontendApi, lexiconText, tokensText,
  lexiconSupplementText: committedText,
});
assert.equal(taiwan.lexiconSupplementSize, regenerated.entryCount);

// 上游 golden 不吃補充詞典,繁體單字 fallback 行為保持可對照。
const official = frontendApi.createFrontend({lexiconText, tokensText});
assert.deepEqual(official.tokensFor('銀行').phones, ['yin2', 'xing2']);
assert.equal(official.lexiconSupplementSize, 0);

// base 音節修正:整詞讀音來自上游簡體詞條的繁體鏡像。
assert.deepEqual(taiwan.tokensFor('銀行').phones, ['yin2', 'hang2']);
assert.deepEqual(taiwan.tokensFor('會計').phones, ['kuai4', 'ji4']);
assert.deepEqual(taiwan.tokensFor('會計師').phones, ['kuai4', 'ji4', 'shi1']);
assert.deepEqual(taiwan.tokensFor('類似').phones, ['lei4', 'si4']);
assert.deepEqual(taiwan.tokensFor('模樣').phones, ['mu2', 'yang4']);
assert.deepEqual(taiwan.tokensFor('一模一樣').phones, ['yi1', 'mu2', 'yi1', 'yang4']);
assert.deepEqual(taiwan.tokensFor('剎那').phones, ['cha4', 'na4']);
assert.deepEqual(taiwan.tokensFor('調侃').phones, ['tiao2', 'kan3']);
assert.deepEqual(taiwan.tokensFor('摻和').phones, ['chan1', 'huo5']);
assert.deepEqual(taiwan.tokensFor('東躲西藏').phones, ['dong1', 'duo3', 'xi1', 'cang2']);
assert.deepEqual(taiwan.tokensFor('一語中的').phones, ['yi1', 'yu3', 'zhong4', 'di4']);
assert.deepEqual(taiwan.tokensFor('洩露天機').phones, ['xie4', 'lou4', 'tian1', 'ji1']);

// 逐位合成:profile 已裁決的字位保留 profile 讀音(微 wei2),其餘位取
// 詞條的 base 修正(調 tiao2)。
assert.deepEqual(taiwan.tokensFor('微調').phones, ['wei2', 'tiao2']);

// guards:鏡像詞條的已知跨詞邊界維持正確讀音。
assert.deepEqual(taiwan.tokensFor('不會計較').phones, ['bu4', 'hui4', 'ji4', 'jiao4']);
assert.deepEqual(taiwan.tokensFor('只會計算').phones, ['zhi3', 'hui4', 'ji4', 'suan4']);
assert.deepEqual(taiwan.tokensFor('沒有著急').phones, ['mei2', 'you3', 'zhao1', 'ji2']);
assert.deepEqual(taiwan.tokensFor('沒有著落').phones, ['mei2', 'you3', 'zhuo2', 'luo4']);
assert.deepEqual(taiwan.tokensFor('守一覺得').phones, ['shou3', 'yi1', 'jue2', 'de5']);
assert.deepEqual(taiwan.tokensFor('睡了一覺').phones, ['shui4', 'le5', 'yi1', 'jiao4']);

// curation 排除:跨詞邊界為主的字串維持現行讀音,不得因鏡像倒退。
assert.deepEqual(taiwan.tokensFor('什麼都會做').phones, ['shen2', 'me5', 'dou1', 'hui4', 'zuo4']);
assert.deepEqual(taiwan.tokensFor('沒過多久').phones, ['mei2', 'guo4', 'duo1', 'jiu3']);
const dangDi = taiwan.tokensFor('住在泥瓶巷的當地人').phones;
assert.deepEqual(dangDi.slice(-4), ['de5', 'dang1', 'di4', 'ren2']);

// profile 優先權:review overrides 與聲調層決策不被補充詞條覆蓋。
assert.deepEqual(taiwan.tokensFor('垃圾').phones, ['le4', 'se4']);
assert.deepEqual(taiwan.tokensFor('品質').phones, ['pin3', 'zhi2']);
assert.deepEqual(taiwan.tokensFor('覺得').phones, ['jue2', 'de5']);

// 主詞典優先:補充詞條若與主詞典同 key(合成情境)必須被忽略。
const synthetic = frontendApi.createFrontend({
  lexiconText, tokensText,
  lexiconSupplementText: '天 tian2\n合成新詞 tian1 tian1\n',
});
assert.deepEqual(synthetic.tokensFor('天').phones, ['tian1']);
assert.equal(synthetic.lexiconSupplementSize, 1);

console.log(JSON.stringify({
  gate: 'lexicon-traditional',
  entries: regenerated.entryCount,
  stats: regenerated.stats,
}, null, 2));
