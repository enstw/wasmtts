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
  normalizeLocalForms,
  normalizeNumbers,
  normalizePunctuation,
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

console.log(JSON.stringify(out, null, 2));
if (Object.values(out).some((v) => String(v).startsWith('FAIL'))) process.exit(1);
