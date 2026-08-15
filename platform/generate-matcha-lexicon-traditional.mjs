#!/usr/bin/env node

// 繁體 lexicon 鏡像產生器:把上游簡體多字詞條經 OpenCC 詞組轉換鏡像為繁體,
// 只輸出「base 音節修正」詞條(銀行 xing2→hang2、會計 hui4→kuai4 這一類),
// 聲調層差異(一/不變調、兒化、輕聲)一律不進補充詞典,留給既有逐詞審核流程。
// 決策依據與逐條理由見 matcha-lexicon-traditional-curation.json。
//
// 產出 matcha-lexicon-traditional.txt 為決定性(deterministic):相同的上游
// lexicon、tokens、review、curation 與 opencc-js 版本必然產生相同 bytes;
// test-matcha-lexicon-traditional.mjs 以重新生成比對提交檔作為 codegen gate。
//
// 用法:node platform/generate-matcha-lexicon-traditional.mjs

import {createHash} from 'node:crypto';
import {readFileSync, writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const OpenCC = require('opencc-js');
// opencc-js 的 exports map 不允許 require 其 package.json;版本以本 repo
// devDependencies 的精確 pin 為準(非 semver range,見 package.json)。
const openccVersion = require('../package.json').devDependencies['opencc-js'];
const frontendApi = require('./matcha-frontend.js');
const profileApi = require('./matcha-taiwan-profile.js');

const stripTone = (phone) => phone.replace(/[1-5]$/u, '');

export function buildTraditionalLexicon({lexiconText, tokensText, review, curation}) {
  const convert = OpenCC.Converter({from: 'cn', to: 'tw'});
  const official = frontendApi.createFrontend({lexiconText, tokensText});
  const taiwan = profileApi.createFrontend({review, frontendApi, lexiconText, tokensText});
  const phonesOf = (frontend, text) => {
    try {
      return frontend.tokensFor(text, {allowUnknown: true}).phones;
    } catch {
      return null;
    }
  };

  const {lexicon} = frontendApi.parseLexicon(lexiconText);
  const stats = {
    sourceEntries: lexicon.size,
    multiCharacterEntries: 0,
    identity: 0,
    alreadyInSource: 0,
    conversionCollision: 0,
    redundant: 0,
    toneLevelOnly: 0,
    lengthMismatch: 0,
    curationExcluded: 0,
    charPhoneExcluded: 0,
    baseFixEntries: 0,
    guards: curation.guards.length,
  };

  // 1. OpenCC 詞組級 cn→tw 鏡像;已存在的繁體 key 不覆寫,同鍵不同音的
  //    轉換 collision(仰屋著書類成語)整組放棄。
  const mirror = new Map();
  const collisions = new Set();
  for (const [key, phones] of lexicon) {
    if ([...key].length < 2) continue;
    stats.multiCharacterEntries += 1;
    const traditional = convert(key);
    if (traditional === key) {
      stats.identity += 1;
      continue;
    }
    if (lexicon.has(traditional)) {
      stats.alreadyInSource += 1;
      continue;
    }
    if (collisions.has(traditional)) continue;
    if (mirror.has(traditional) && mirror.get(traditional).join(' ') !== phones.join(' ')) {
      mirror.delete(traditional);
      collisions.add(traditional);
      stats.conversionCollision += 1;
      continue;
    }
    mirror.set(traditional, phones);
  }

  // 2. 分層:與現行輸出相同者冗餘;只差聲調者留給逐詞審核;僅收 base 音節
  //    修正,且 taiwan profile 已裁決的字位保留 profile 讀音(逐位合成)。
  const excluded = new Set(curation.exclusions.map((entry) => entry.pattern));
  const charPhoneExcluded = new Set(
    curation.charPhoneExclusions.map((rule) => `${rule.character} ${rule.phone}`));
  const supplement = new Map();
  for (const [key, target] of mirror) {
    const currentTaiwan = phonesOf(taiwan, key);
    const currentOfficial = phonesOf(official, key);
    if (!currentTaiwan || !currentOfficial
      || currentTaiwan.length !== target.length || currentOfficial.length !== target.length) {
      stats.lengthMismatch += 1;
      continue;
    }
    if (currentTaiwan.join(' ') === target.join(' ')) {
      stats.redundant += 1;
      continue;
    }
    let hasBaseFix = false;
    const merged = target.map((phone, index) => {
      if (currentTaiwan[index] !== currentOfficial[index]) return currentTaiwan[index];
      if (stripTone(phone) !== stripTone(currentTaiwan[index])) hasBaseFix = true;
      return phone;
    });
    if (!hasBaseFix) {
      stats.toneLevelOnly += 1;
      continue;
    }
    if (excluded.has(key)) {
      stats.curationExcluded += 1;
      continue;
    }
    const characters = [...key];
    if (merged.some((phone, index) => charPhoneExcluded.has(`${characters[index]} ${phone}`))) {
      stats.charPhoneExcluded += 1;
      continue;
    }
    supplement.set(key, merged);
    stats.baseFixEntries += 1;
  }

  // 3. guards:讀音由 curation 明列(不機械凍結現況),用 longest-match
  //    優先權保護鏡像詞條的已知跨詞邊界。
  for (const guard of curation.guards) {
    supplement.set(guard.pattern, [...guard.phones]);
  }

  const tokens = frontendApi.parseTokens(tokensText);
  for (const [word, phones] of supplement) {
    for (const phone of phones) {
      if (!tokens.has(phone)) throw new Error(`補充詞條 ${word} 含 tokens.txt 沒有的 phone:${phone}`);
    }
  }

  const lines = [...supplement.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([word, phones]) => `${word} ${phones.join(' ')}`);
  return {text: `${lines.join('\n')}\n`, stats, entryCount: supplement.size};
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
  const lexiconText = readFileSync(path.join(here, 'models/matcha-icefall-zh-en/lexicon.txt'), 'utf8');
  const tokensText = readFileSync(path.join(here, 'models/matcha-icefall-zh-en/tokens.txt'), 'utf8');
  const review = JSON.parse(readFileSync(path.join(here, 'matcha-g2p-review.json'), 'utf8'));
  const curation = JSON.parse(readFileSync(path.join(here, 'matcha-lexicon-traditional-curation.json'), 'utf8'));
  const {text, stats, entryCount} = buildTraditionalLexicon({lexiconText, tokensText, review, curation});
  writeFileSync(path.join(here, 'matcha-lexicon-traditional.txt'), text);
  const meta = {
    schemaVersion: 1,
    generator: 'platform/generate-matcha-lexicon-traditional.mjs',
    openccJsVersion: openccVersion,
    inputs: {
      lexiconSha256: sha256(lexiconText),
      tokensSha256: sha256(tokensText),
      reviewSha256: sha256(JSON.stringify(review)),
      curationSha256: sha256(JSON.stringify(curation)),
    },
    entryCount,
    stats,
    outputSha256: sha256(text),
  };
  writeFileSync(path.join(here, 'matcha-lexicon-traditional.meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
  console.log(JSON.stringify({entryCount, stats}, null, 2));
}
