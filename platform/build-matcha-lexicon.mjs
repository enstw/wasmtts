#!/usr/bin/env node

// wasmtts lexicon 編譯器:把上游 matcha-icefall-zh-en 的簡體 lexicon 編成
// 下游唯一需要的單一字典檔 platform/dist/matcha-lexicon.txt。
//
//   wasmtts lexicon = f(上游簡體 lexicon, matcha-g2p-review.json, curation)
//
// 分層(後者覆蓋前者,最後以 Map 合併、單一排序輸出):
// 1. 上游簡體全量原樣。
// 1. 全量繁體鏡像:以 OpenCC 詞組級 cn→tw 鏡像每條多字詞條。讀音規則——
//    - base 音節修正(銀行 xing2→hang2、會計 hui4→kuai4):取「逐位合併」讀音,
//      taiwan profile 已裁決的字位保留 profile 讀音,其餘位取上游鏡像讀音;
//    - 其餘鏡像詞條(讀音相同或只差聲調)一律取現行 taiwan frontend 對該詞的
//      讀音,不引入任何新讀音裁決。收錄它們的目的是 longest-match 邊界:
//      繁體直輸少了 道長 整詞,長 會被後面的 長久／長生 跨界吃成 chang2,
//      而上游簡體因為有 道长 整詞不會發生;全量鏡像讓兩邊分詞一致。
//    curation 的 exclusions(維持單字 fallback)、charPhoneExclusions(上游
//    系統性錯讀)與 guards(明列讀音)照舊生效。
// 1. review 的 phrase overrides 與 profile base override(垃圾)烘入檔內;
//    runtime 只剩 contextual rules(matcha-profile.runtime.json)。
//
// 產出為決定性:相同輸入與 opencc-js 版本必然產生相同 bytes;
// test-matcha-lexicon.mjs 以重建兩次比對 sha256 作 gate。產物不提交 git,
// 由 CI 在 fetch 上游資產後建置並隨 release tarball 出貨。
//
// 用法:node platform/build-matcha-lexicon.mjs [--out platform/dist]

import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const OpenCC = require('opencc-js');
// opencc-js 的 exports map 不允許 require 其 package.json;版本以本 repo
// devDependencies 的精確 pin 為準(非 semver range,見 package.json)。
const openccVersion = require('../package.json').devDependencies['opencc-js'];
const frontendApi = require('./matcha-frontend.js');
const profileApi = require('./matcha-taiwan-profile.js');

export const RUNTIME_PROFILE_ENTRY_FIELDS = Object.freeze([
  'pattern', 'target', 'implementation', 'status', 'previousCharacters', 'followingCharacters',
]);

const stripTone = (phone) => phone.replace(/[1-5]$/u, '');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function phonesOf(frontend, text) {
  try {
    return frontend.tokensFor(text, {allowUnknown: true}).phones;
  } catch {
    return null;
  }
}

function lexiconTextOf(entries) {
  return `${[...entries].map(([word, phones]) => `${word} ${phones.join(' ')}`).join('\n')}\n`;
}

// 從完整審核帳本抽出 runtime 真正讀取的欄位;createConfig 仍可直接吃它。
export function runtimeProfileFromReview(review) {
  return {
    schemaVersion: review.schemaVersion,
    locale: review.locale,
    purpose: 'matcha-g2p-review.json 的 runtime 子集;完整證據、來源與 groupDecisions 留在 repo',
    profiles: review.profiles,
    entries: review.entries.map((entry) => Object.fromEntries(
      RUNTIME_PROFILE_ENTRY_FIELDS
        .filter((field) => entry[field] !== undefined)
        .map((field) => [field, entry[field]]),
    )),
  };
}

export function buildMatchaLexicon({lexiconText, tokensText, review, curation}) {
  const convert = OpenCC.Converter({from: 'cn', to: 'tw'});
  const tokens = frontendApi.parseTokens(tokensText);
  const {lexicon: upstream} = frontendApi.parseLexicon(lexiconText);
  const official = frontendApi.createFrontend({lexiconText, tokensText});
  const taiwan = profileApi.createFrontend({review, frontendApi, lexiconText, tokensText});
  const profile = profileApi.createConfig(review, frontendApi);

  const stats = {
    upstreamEntries: upstream.size,
    multiCharacterEntries: 0,
    identity: 0,
    alreadyInSource: 0,
    conversionCollision: 0,
    lengthMismatch: 0,
    curationExcluded: 0,
    charPhoneExcluded: 0,
    baseFixEntries: 0,
    mirrorSameReading: 0,
    mirrorToneLevelCurrentReading: 0,
    guards: curation.guards.length,
    overrides: Object.keys(profile.pronunciationOverrides).length,
  };

  // 1. OpenCC 詞組級 cn→tw 鏡像;已存在的繁體 key 不覆寫,同鍵不同音的
  //    轉換 collision(仰屋著書類成語)整組放棄。
  const mirror = new Map();
  const collisions = new Set();
  for (const [key, phones] of upstream) {
    if ([...key].length < 2) continue;
    stats.multiCharacterEntries += 1;
    const traditional = convert(key);
    if (traditional === key) {
      stats.identity += 1;
      continue;
    }
    if (upstream.has(traditional)) {
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

  const excluded = new Set(curation.exclusions.map((entry) => entry.pattern));
  const charPhoneExcluded = new Set(
    curation.charPhoneExclusions.map((rule) => `${rule.character} ${rule.phone}`));
  const violatesCharPhone = (word, phones) => {
    const characters = [...word];
    return phones.some((phone, index) => charPhoneExcluded.has(`${characters[index]} ${phone}`));
  };

  // 2a. base 音節修正:逐位合併,profile 已裁決的字位保留 profile 讀音。
  const baseFixes = new Map();
  const remaining = [];
  for (const [word, target] of mirror) {
    if (excluded.has(word)) {
      stats.curationExcluded += 1;
      continue;
    }
    const currentTaiwan = phonesOf(taiwan, word);
    const currentOfficial = phonesOf(official, word);
    if (!currentTaiwan || !currentOfficial
      || currentTaiwan.length !== target.length || currentOfficial.length !== target.length) {
      stats.lengthMismatch += 1;
      continue;
    }
    let hasBaseFix = false;
    const merged = target.map((phone, index) => {
      if (currentTaiwan[index] !== currentOfficial[index]) return currentTaiwan[index];
      if (stripTone(phone) !== stripTone(currentTaiwan[index])) hasBaseFix = true;
      return phone;
    });
    if (!hasBaseFix) {
      remaining.push([word, target, currentTaiwan]);
      continue;
    }
    if (violatesCharPhone(word, merged)) {
      stats.charPhoneExcluded += 1;
      continue;
    }
    baseFixes.set(word, merged);
    stats.baseFixEntries += 1;
  }

  // 2b. 其餘鏡像詞條:讀音取「含 base 修正的現行 taiwan frontend」對該詞的
  //     讀音,只補 longest-match 邊界。
  const taiwanWithBaseFixes = profileApi.createFrontend({
    review, frontendApi, lexiconText, tokensText, lexiconSupplementText: lexiconTextOf(baseFixes),
  });
  const boundaryEntries = new Map();
  for (const [word, target, currentTaiwan] of remaining) {
    const current = phonesOf(taiwanWithBaseFixes, word) ?? currentTaiwan;
    if (current.length !== target.length) {
      stats.lengthMismatch += 1;
      continue;
    }
    if (violatesCharPhone(word, current)) {
      stats.charPhoneExcluded += 1;
      continue;
    }
    if (current.join(' ') === target.join(' ')) stats.mirrorSameReading += 1;
    else stats.mirrorToneLevelCurrentReading += 1;
    boundaryEntries.set(word, current);
  }

  // 3. 合併:上游原樣 → 鏡像 → curation guards(明列讀音)→ overrides。
  const compiled = new Map(upstream);
  for (const [word, phones] of baseFixes) compiled.set(word, [...phones]);
  for (const [word, phones] of boundaryEntries) compiled.set(word, [...phones]);
  for (const guard of curation.guards) compiled.set(guard.pattern, [...guard.phones]);
  for (const [word, phones] of Object.entries(profile.pronunciationOverrides)) {
    compiled.set(word, Array.isArray(phones) ? [...phones] : String(phones).trim().split(/\s+/u));
  }

  for (const [word, phones] of compiled) {
    for (const phone of phones) {
      if (!tokens.has(phone)) throw new Error(`詞條 ${word} 含 tokens.txt 沒有的 phone:${phone}`);
    }
  }

  const sorted = [...compiled.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const text = lexiconTextOf(sorted);
  stats.entryCount = compiled.size;
  return {
    text,
    stats,
    entryCount: compiled.size,
    runtimeProfile: runtimeProfileFromReview(review),
  };
}

export function buildMetadata({text, stats, entryCount, inputs, upstream}) {
  const outputSha256 = sha256(text);
  return {
    schemaVersion: 2,
    generator: 'platform/build-matcha-lexicon.mjs',
    openccJsVersion: openccVersion,
    upstream,
    inputs,
    entryCount,
    stats,
    bytes: Buffer.byteLength(text),
    outputSha256,
    packName: `matcha-lexicon-${outputSha256.slice(0, 8)}.txt`,
  };
}

export function readBuildInputs(root = path.resolve(here, '..')) {
  const modelDir = path.join(root, 'platform/models/matcha-icefall-zh-en');
  for (const file of ['lexicon.txt', 'tokens.txt']) {
    if (!existsSync(path.join(modelDir, file))) {
      throw new Error(`缺上游資產 ${path.relative(root, path.join(modelDir, file))} — 先跑 pnpm fetch:matcha-assets`);
    }
  }
  const assets = JSON.parse(readFileSync(path.join(root, 'platform/matcha-assets.json'), 'utf8'));
  return {
    root,
    assets,
    lexiconText: readFileSync(path.join(modelDir, 'lexicon.txt'), 'utf8'),
    tokensText: readFileSync(path.join(modelDir, 'tokens.txt'), 'utf8'),
    review: JSON.parse(readFileSync(path.join(root, 'platform/matcha-g2p-review.json'), 'utf8')),
    curation: JSON.parse(readFileSync(path.join(root, 'platform/matcha-lexicon-traditional-curation.json'), 'utf8')),
  };
}

// 建置並落地:matcha-lexicon.txt、matcha-lexicon.meta.json、
// matcha-profile.runtime.json 與含 lexicon 區塊的 matcha-assets.json。
export function buildAndWrite({root, outDir} = {}) {
  const inputs = readBuildInputs(root);
  const output = path.resolve(inputs.root, outDir ?? 'platform/dist');
  const built = buildMatchaLexicon(inputs);
  const meta = buildMetadata({
    ...built,
    inputs: {
      lexiconSha256: sha256(inputs.lexiconText),
      tokensSha256: sha256(inputs.tokensText),
      reviewSha256: sha256(JSON.stringify(inputs.review)),
      curationSha256: sha256(JSON.stringify(inputs.curation)),
    },
    upstream: {
      repository: inputs.assets.matcha.repository,
      revision: inputs.assets.matcha.revision,
    },
  });
  const assets = {
    ...inputs.assets,
    lexicon: {
      file: 'matcha-lexicon.txt',
      packName: meta.packName,
      bytes: meta.bytes,
      sha256: meta.outputSha256,
      source: 'tarball',
      meta: 'matcha-lexicon.meta.json',
    },
  };
  mkdirSync(output, {recursive: true});
  writeFileSync(path.join(output, 'matcha-lexicon.txt'), built.text);
  writeFileSync(path.join(output, 'matcha-lexicon.meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
  writeFileSync(path.join(output, 'matcha-profile.runtime.json'), `${JSON.stringify(built.runtimeProfile, null, 2)}\n`);
  writeFileSync(path.join(output, 'matcha-assets.json'), `${JSON.stringify(assets, null, 2)}\n`);
  return {output, meta, stats: built.stats};
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const outIndex = process.argv.indexOf('--out');
  const outDir = outIndex > 0 ? process.argv[outIndex + 1] : undefined;
  const {output, meta, stats} = buildAndWrite({outDir});
  console.log(JSON.stringify({output, packName: meta.packName, bytes: meta.bytes, outputSha256: meta.outputSha256, stats}, null, 2));
}
