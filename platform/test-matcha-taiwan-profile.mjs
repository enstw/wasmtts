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
assert.deepEqual(official.tokensFor('微血究熟叔姐姐差不多').phones, [
  'wei1', 'xue4', 'jiu1', 'shu2', 'shu1', 'jie3', 'jie3',
  'cha4', 'bu5', 'duo1',
]);
assert.deepEqual(taiwan.tokensFor('微血究熟叔姐姐差不多').phones, [
  'wei2', 'xie3', 'jiu4', 'shou2', 'shu2', 'jie3', 'jie5',
  'cha1', 'bu5', 'duo1',
]);
assert.deepEqual(official.tokensFor('擁顫藉爺爺下巴啞巴嘴巴掙錢').phones, [
  'yong1', 'chan4', 'ji2', 'ye2', 'ye2', 'xia4', 'ba1',
  'ya3', 'ba1', 'zui3', 'ba1', 'zheng1', 'qian2',
]);
assert.deepEqual(taiwan.tokensFor('擁顫藉爺爺下巴啞巴嘴巴掙錢').phones, [
  'yong3', 'zhan4', 'jie4', 'ye2', 'ye5', 'xia4', 'ba5',
  'ya3', 'ba5', 'zui3', 'ba5', 'zheng4', 'qian2',
]);
assert.deepEqual(taiwan.tokensFor('狼藉東西東西向').phones, [
  'lang2', 'ji2', 'dong1', 'xi1', 'dong1', 'xi1', 'xiang4',
]);
assert.deepEqual(official.tokensFor('倒是武將適應感應對應應對重複').phones, [
  'dao3', 'shi4', 'wu3', 'jiang1', 'shi4', 'ying1', 'gan3', 'ying1',
  'dui4', 'ying1', 'ying1', 'dui4', 'zhong4', 'fu4',
]);
assert.deepEqual(taiwan.tokensFor('倒是武將適應感應對應應對重複').phones, [
  'dao4', 'shi4', 'wu3', 'jiang4', 'shi4', 'ying4', 'gan3', 'ying4',
  'dui4', 'ying4', 'ying4', 'dui4', 'chong2', 'fu4',
]);
assert.deepEqual(taiwan.tokensFor('跌倒將來應該重要').phones, [
  'die1', 'dao3', 'jiang1', 'lai2', 'ying1', 'gai1', 'zhong4', 'yao4',
]);
assert.deepEqual(official.tokensFor('勁識期質頗咋仔細彷彿露出謝謝當真').phones, [
  'jin4', 'shi2', 'qi1', 'zhi4', 'po1', 'za3', 'zai3', 'xi4',
  'pang2', 'fu2', 'lu4', 'chu1', 'xie4', 'xie4', 'dang1', 'zhen1',
]);
assert.deepEqual(taiwan.tokensFor('勁識期質頗咋仔細彷彿露出謝謝當真').phones, [
  'jing4', 'shi4', 'qi2', 'zhi2', 'po3', 'ze2', 'zi3', 'xi4',
  'fang3', 'fu2', 'lou4', 'chu1', 'xie4', 'xie5', 'dang4', 'zhen1',
]);
assert.deepEqual(taiwan.tokensFor('標識品質露水當前').phones, [
  'biao1', 'shi4', 'pin3', 'zhi2', 'lu4', 'shui3', 'dang1', 'qian2',
]);
assert.deepEqual(official.tokensFor('說得看得打得聽得變得以為頗為認為稱為').phones, [
  'shuo1', 'de2', 'kan4', 'de2', 'da3', 'de2', 'ting1', 'de2', 'bian4', 'de2',
  'yi3', 'wei4', 'po1', 'wei4', 'ren4', 'wei4', 'cheng1', 'wei4',
]);
assert.deepEqual(taiwan.tokensFor('說得看得打得聽得變得以為頗為認為稱為').phones, [
  'shuo1', 'de5', 'kan4', 'de5', 'da3', 'de5', 'ting1', 'de5', 'bian4', 'de5',
  'yi3', 'wei2', 'po3', 'wei2', 'ren4', 'wei2', 'cheng1', 'wei2',
]);
assert.deepEqual(taiwan.tokensFor('獲得因為為了').phones, [
  'huo4', 'de2', 'yin1', 'wei4', 'wei4', 'le5',
]);
assert.deepEqual(taiwan.tokensFor('公子男子童子瓜子仙子棋子甲子').phones, [
  'gong1', 'zi3', 'nan2', 'zi3', 'tong2', 'zi3', 'gua1', 'zi3',
  'xian1', 'zi3', 'qi2', 'zi3', 'jia3', 'zi3',
]);
assert.deepEqual(taiwan.tokensFor('丫頭念頭拳頭裡頭苦頭石頭骨頭枕頭').phones, [
  'ya1', 'tou5', 'nian4', 'tou5', 'quan2', 'tou5', 'li3', 'tou5',
  'ku3', 'tou5', 'shi2', 'tou5', 'gu3', 'tou5', 'zhen3', 'tou5',
]);
assert.deepEqual(taiwan.tokensFor('乾脆乾淨乾涸乾枯乾糧乾瘦差點').phones, [
  'gan1', 'cui4', 'gan1', 'jing4', 'gan1', 'he2', 'gan1', 'ku1',
  'gan1', 'liang2', 'gan1', 'shou4', 'cha1', 'dian3',
]);
assert.deepEqual(taiwan.tokensFor('當是當做當回事當成當作').phones, [
  'dang4', 'shi4', 'dang4', 'zuo4', 'dang4', 'hui2', 'shi4',
  'dang4', 'cheng2', 'dang4', 'zuo4',
]);
assert.deepEqual(taiwan.tokensFor('時分輩分過分緣分情分身分').phones, [
  'shi2', 'fen4', 'bei4', 'fen4', 'guo4', 'fen4', 'yuan2', 'fen4',
  'qing2', 'fen4', 'shen1', 'fen4',
]);
assert.deepEqual(taiwan.tokensFor('椅子頭部乾坤差勁當前分開').phones, [
  'yi3', 'zi5', 'tou2', 'bu4', 'qian2', 'kun1', 'cha4', 'jing4',
  'dang1', 'qian2', 'fen1', 'kai1',
]);
for (const [text, phones] of [
  ['聊得', ['liao2', 'de5']],
  ['化為', ['hua4', 'wei2']],
  ['還禮', ['huan2', 'li3']],
  ['歸還', ['gui1', 'huan2']],
  ['處境', ['chu3', 'jing4']],
  ['相處', ['xiang1', 'chu3']],
  ['教書', ['jiao1', 'shu1']],
  ['畫卷', ['hua4', 'juan4']],
  ['晃動', ['huang4', 'dong4']],
  ['擅長', ['shan4', 'chang2']],
  ['長槍', ['chang2', 'qiang1']],
]) assert.deepEqual(taiwan.tokensFor(text).phones, phones);
for (const [text, phones] of [
  ['獲得', ['huo4', 'de2']],
  ['因為', ['yin1', 'wei4']],
  ['還是', ['hai2', 'shi4']],
  ['到處', ['dao4', 'chu4']],
  ['教育', ['jiao4', 'yu4']],
  ['卷起', ['juan3', 'qi3']],
  ['一晃', ['yi1', 'huang3']],
  ['長大', ['zhang3', 'da4']],
]) assert.deepEqual(taiwan.tokensFor(text).phones, phones);

console.log(JSON.stringify({
  profile: 'taiwan',
  schemaVersion: review.schemaVersion,
  phraseOverrides: review.profiles.taiwan.phraseOverrides.length,
  contextualRules: review.profiles.taiwan.contextualRules.length,
}, null, 2));
