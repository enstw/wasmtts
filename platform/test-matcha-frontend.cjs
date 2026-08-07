const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const OpenCC = require('opencc-js/t2cn');
const {createFrontend, normalizeNumbers} = require('./matcha-frontend.js');

const modelRoot = path.join(__dirname, 'models', 'matcha-icefall-zh-en');
const lexiconText = fs.readFileSync(path.join(modelRoot, 'lexicon.txt'), 'utf8');
const tokensText = fs.readFileSync(path.join(modelRoot, 'tokens.txt'), 'utf8');
const convertTraditional = OpenCC.Converter({from: 'tw', to: 'cn'});
const frontend = createFrontend({lexiconText, tokensText, convertTraditional});

const cases = [
  {
    text: '清晨的阳光穿过窗帘。',
    expected: [1431, 292, 420, 1932, 661, 331, 679, 336, 992, 5],
  },
  {
    text: '輕輕落在安靜的房間裡。',
    expected: [1431, 1431, 1059, 2004, 126, 819, 420, 547, 791, 983, 5],
  },
];

for (const testCase of cases) {
  assert.deepEqual(frontend.tokensFor(testCase.text).ids, testCase.expected);
}

const garbage = frontend.tokensFor('垃圾。');
assert.deepEqual(garbage.phones, ['la1', 'ji1', '.']);
assert.deepEqual(garbage.ids, [941, 781, 5]);

assert.equal(
  normalizeNumbers('第12章，日期2026年8月7日，14:30完成25.5%。'),
  '第十二章，日期二零二六年八月七日，十四点三十分完成百分之二十五点五。',
);

const numeric = frontend.tokensFor('第12章，日期2026年8月7日，14:30完成25.5%。');
assert.equal(numeric.unknown.length, 0);

const taiwanOverride = createFrontend({
  lexiconText,
  tokensText,
  convertTraditional,
  pronunciationOverrides: {'垃圾': 'le4 se4'},
});
assert.deepEqual(taiwanOverride.tokensFor('垃圾。').phones, ['le4', 'se4', '.']);

const english = frontend.tokensFor('AI 小说。', {allowUnknown: true});
assert.deepEqual(english.unknown.map((entry) => entry.character), ['A', 'I']);

const traditionalDirect = createFrontend({lexiconText, tokensText});
const quoted = traditionalDirect.tokensFor('「清晨」，她說：“你好。” ‘再見。’');
assert.equal(quoted.normalizedText, '清晨,她說:你好. 再見.');
assert.equal(quoted.unknown.length, 0);
assert.equal(quoted.phones.some((phone) => ['“', '”', '‘', '’', '"'].includes(phone)), false);

console.log(JSON.stringify({
  lexiconSize: frontend.lexiconSize,
  tokenCount: frontend.tokenCount,
  verifiedCases: cases.length,
  garbagePhones: garbage.phones,
  numericNormalized: numeric.normalizedText,
  englishUnknown: english.unknown,
}, null, 2));
