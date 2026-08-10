// matcha-frontend.js 純文字層的單元測試：不需要模型檔，常駐 release gate。
//
// 這裡固定的是文字進入 FST／lexicon 之前與之後的形狀——全形折疊、
// 臺灣格式重整、JS 數字規則、標點對映。任何一步走樣，錯的不是一個
// token 而是整句的讀法，而 ASR gate 只能在事後聽出「有東西壞了」，
// 說不出是哪一步。
//
//   pnpm test:matcha-frontend

import './matcha-frontend.js';

const {
  createFrontend,
  normalizeFullWidth,
  normalizeLayoutSeparators,
  normalizeLocalForms,
  normalizeNumbers,
  normalizePunctuation,
  contextualRulesFromReview,
  pronunciationOverridesFromReview,
} = globalThis.MatchaFrontend;

const out = {};
const eq = (name, got, want) => {
  out[name] = got === want ? `ok (${JSON.stringify(got)})`
    : `FAIL ${JSON.stringify(got)} ≠ ${JSON.stringify(want)}`;
};

// ---- 全形折疊 -------------------------------------------------------------
// 全形數字必須折成同值的 ASCII 字元。曾經的 String(charCode - 0xfee0) 把
// ０ 變成字串 "48"（字碼的十進位表示），１４ 變成 "4952"——數字在進 FST
// 之前就已經是垃圾，而下游每一層都會把它當真數字讀完。
eq('fullWidthDigits', normalizeFullWidth('０１２３４５６７８９'), '0123456789');
eq('fullWidthPercent', normalizeFullWidth('１００％'), '100%');
eq('fullWidthColonTime', normalizeFullWidth('１４：３０'), '14:30');
eq('fullWidthDecimal', normalizeFullWidth('２５．５％'), '25.5%');

// ---- 小說版面分隔符 -------------------------------------------------------
// 只移除獨立成行的分隔線；句內破折號、負數及數值範圍必須原樣保留。
eq('layoutAsciiSeparator', normalizeLayoutSeparators('　　-------------'), '');
eq('layoutEmDashSeparator', normalizeLayoutSeparators('　　————'), '');
eq('layoutMixedSeparator', normalizeLayoutSeparators('　　——-'), '');
eq('layoutHorizontalBarSeparator', normalizeLayoutSeparators('――――'), '');
eq('layoutSeparatorKeepsBoundary', normalizeLayoutSeparators('甲\n————\n乙'), '甲\n\n乙');
eq('layoutInlineDash', normalizeLayoutSeparators('他喊道——快走！'), '他喊道——快走！');
eq('layoutRange', normalizeLayoutSeparators('3-5 公里'), '3-5 公里');
eq('layoutNegative', normalizeLayoutSeparators('-12 度'), '-12 度');

// ---- 臺灣格式重整 ---------------------------------------------------------
// normalizeLocalForms 只重整 FST 已知會誤讀的外形；全形輸入先經
// normalizeFullWidth 折疊後才輪到它，這裡直接餵折疊後的形狀。
eq('localTime', normalizeLocalForms('14:30'), '14点30分');
eq('localPercent', normalizeLocalForms('25.5%'), '百分之25.5');
eq('localDashDate', normalizeLocalForms('2026-08-07'), '2026年8月7日');
eq('localTwMobile', normalizeLocalForms('0912345678'), '零九一二三四五六七八');

// ---- JS 數字規則（無 FST 的後備讀法） -------------------------------------
eq('jsTime', normalizeNumbers('14:30'), '十四点三十分');
eq('jsPercent', normalizeNumbers('100%'), '百分之一百');

// ---- prepareText 端到端（無 ruleNormalizer 的路徑） -----------------------
// lexicon／tokens 只是 createFrontend 的必要參數，prepareText 不查它們。
const frontend = createFrontend({
  lexiconText: '你好 n i3 h ao3\n',
  tokensText: 'n 1\ni3 2\n',
});
eq('prepareFullWidthTime', frontend.prepareText('１４：３０'), '十四点三十分');
eq('preparePercent', frontend.prepareText('２５．５％'), '百分之二十五点五');

// ---- 標點對映 -------------------------------------------------------------
// 引號是剝除而不是對映：實聽確認引號 acoustic token 會被發音（05b5b35）。
eq('punctQuoteStrip', normalizePunctuation('「清晨」'), '清晨');
// 散文冒號讀成停頓；時間的冒號早被時間規則吃掉（見 prepareFullWidthTime），
// 不會走到這張表。
eq('punctProseColon', normalizePunctuation('提示:內容'), '提示,內容');
eq('prepareProseColon', frontend.prepareText('她說:「你好」'), '她說,你好');
eq('prepareStandaloneSeparator', frontend.prepareText('　　-------------'), '');

// ---- lexicon trace --------------------------------------------------------
const tracedFrontend = createFrontend({
  lexiconText: '你好 n i3 h ao3\n你 n i3\n好 h ao3\n',
  tokensText: 'n 1\ni3 2\nh 3\nao3 4\n',
});
const phraseTrace = tracedFrontend.tokensFor('你好');
eq('tracePhraseMatch', JSON.stringify(phraseTrace.lexiconMatches),
  JSON.stringify([{word: '你好', offset: 0, phones: ['n', 'i3', 'h', 'ao3']}]));
eq('tracePhraseNoSingleFallback', phraseTrace.singleCharacterFallbacks.length, 0);
const singleTrace = tracedFrontend.tokensFor('你');
eq('traceSingleFallback', JSON.stringify(singleTrace.singleCharacterFallbacks),
  JSON.stringify([{word: '你', offset: 0, phones: ['n', 'i3']}]));

// ---- 有來源的 profile -----------------------------------------------------
// 只有已確認的規則能進產品 profile；pending 資料不能自動生效。
const reviewOverrides = pronunciationOverridesFromReview({entries: [
  {pattern: '記得', target: ['ji4', 'de5'], implementation: 'phrase-override', status: 'confirmed'},
  {pattern: '著', target: ['zhe5'], implementation: 'contextual-rule', status: 'confirmed-needs-rule'},
  {pattern: '待審', target: ['dai4', 'shen3'], implementation: 'phrase-override', status: 'pending'},
]});
eq('reviewConfirmedPhrasesOnly', JSON.stringify(reviewOverrides),
  JSON.stringify({'記得': ['ji4', 'de5']}));
const reviewContextualRules = contextualRulesFromReview({entries: [
  {pattern: '著', target: ['zhe5'], previousCharacters: '看笑',
    implementation: 'contextual-rule', status: 'confirmed'},
  {pattern: '待', target: ['dai5'], previousCharacters: '等',
    implementation: 'contextual-rule', status: 'confirmed-needs-rule'},
]});
const contextualFrontend = createFrontend({
  lexiconText: '看 kan4\n笑 xiao4\n著 zhu4\n著急 zhu4 ji2\n急 ji2\n',
  tokensText: 'kan4 1\nxiao4 2\nzhu4 3\nzhe5 4\nji2 5\nzhao1 6\n',
  contextualRules: reviewContextualRules,
  pronunciationOverrides: {'著急': ['zhao1', 'ji2']},
});
eq('reviewContextualRule', JSON.stringify(contextualFrontend.tokensFor('看著').phones),
  JSON.stringify(['kan4', 'zhe5']));
eq('reviewContextualTrace', contextualFrontend.tokensFor('看著').contextualMatches.length, 1);
eq('reviewContextualNoFallback', contextualFrontend.tokensFor('看著').singleCharacterFallbacks.length, 1);
eq('reviewContextualAllowlist', JSON.stringify(contextualFrontend.tokensFor('笑著').phones),
  JSON.stringify(['xiao4', 'zhe5']));
eq('reviewContextualOutsideAllowlist', JSON.stringify(contextualFrontend.tokensFor('著').phones),
  JSON.stringify(['zhu4']));
eq('reviewLongerPhraseWins', JSON.stringify(contextualFrontend.tokensFor('看著急').phones),
  JSON.stringify(['kan4', 'zhao1', 'ji2']));

console.log(JSON.stringify(out, null, 2));
if (Object.values(out).some((v) => String(v).startsWith('FAIL'))) process.exit(1);
