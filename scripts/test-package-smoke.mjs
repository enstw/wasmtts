#!/usr/bin/env node

// package-smoke gate：從消費者視角驗證釋出套件完整可用。其他 gate 都測 repo
// 裡的檔案，只有這裡測「tarball 解開後拿不拿得動」— 完整的唯一非循環定義。
// 1. 用 release-manifest.json 實際打包（與 release.yml 打包步驟同一條路徑）。
// 1. 解壓 tarball 到乾淨暫存目錄，檔案清單須與 manifest 完全一致。
// 1. 只用解壓出的檔案建立 MatchaEngine 的文字前端與 kaldifst normalizer；
//    字典必須完整來自 tarball 的 matcha-lexicon.txt ＋ matcha-profile.runtime.json，
//    不得碰上游 lexicon。
// 模型權重、tokens 與 FST 不在 tarball 內 — 消費者依 tarball 內的
// matcha-assets.json 另行下載；此處取用已抓好的 platform/models/。

import assert from 'node:assert/strict';
import {existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync} from 'node:fs';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import {packageRelease} from './package-release.mjs';

const root = process.cwd();
const {manifest, tarball} = packageRelease({root});

const extracted = mkdtempSync(path.join(os.tmpdir(), 'wasmtts-package-smoke-'));
try {
  const tar = spawnSync('tar', ['xzf', tarball, '-C', extracted], {encoding: 'utf8'});
  assert.equal(tar.status, 0, `tar 解壓失敗：${(tar.stderr ?? '').trim()}`);

  // 解壓內容與 manifest 一致，不多不少；且不含任何上游 lexicon。
  const actual = readdirSync(extracted, {recursive: true})
    .map(String)
    .filter((entry) => statSync(path.join(extracted, entry)).isFile())
    .sort();
  const expected = manifest.files.map((file) => path.basename(file)).sort();
  assert.deepEqual(actual, expected, 'tarball 內容與 release-manifest.json 不一致');
  assert.ok(!actual.includes('lexicon.txt'), 'tarball 不得含上游 lexicon.txt');

  // JSON 附件須可解析；assets manifest 必須宣告編譯後 lexicon，且上游 lexicon 只是 build-input。
  const assets = JSON.parse(readFileSync(path.join(extracted, 'matcha-assets.json'), 'utf8'));
  const meta = JSON.parse(readFileSync(path.join(extracted, 'matcha-lexicon.meta.json'), 'utf8'));
  const profile = JSON.parse(readFileSync(path.join(extracted, 'matcha-profile.runtime.json'), 'utf8'));
  assert.equal(assets.schemaVersion, 4);
  assert.equal(assets.lexicon.file, 'matcha-lexicon.txt');
  assert.equal(assets.lexicon.packName, meta.packName);
  assert.equal(assets.matcha.files['lexicon.txt'].role, 'build-input');
  assert.equal(assets.matcha.files['lexicon.txt'].packName, undefined);
  const lexiconText = readFileSync(path.join(extracted, 'matcha-lexicon.txt'), 'utf8');
  assert.equal(Buffer.byteLength(lexiconText), assets.lexicon.bytes);
  assert.equal(meta.upstream.revision, assets.matcha.revision, 'lexicon meta 的上游 revision 與 assets pin 不一致');

  // 消費者載入流程：frontend → profile → kaldifst glue → synthesis → engine，皆取自解壓目錄。
  const requireFromTarball = createRequire(path.join(extracted, 'consumer.js'));
  const frontendApi = requireFromTarball(path.join(extracted, 'matcha-frontend.js'));
  const profileApi = requireFromTarball(path.join(extracted, 'matcha-taiwan-profile.js'));
  // kaldifst-normalizer.js 與 synthesis 以 global 掛載；Node 端從 globalThis 取回。
  requireFromTarball(path.join(extracted, 'kaldifst-normalizer.js'));
  const synthesisApi = requireFromTarball(path.join(extracted, 'matcha-synthesis.js'));
  const engineApi = requireFromTarball(path.join(extracted, 'matcha-engine.js'));
  const kaldifstApi = globalThis.MatchaKaldifst;
  assert.equal(typeof kaldifstApi?.createNormalizer, 'function');

  const modelsDir = path.join(root, 'platform/models/matcha-icefall-zh-en');
  for (const file of ['tokens.txt', 'phone-zh.fst', 'date-zh.fst', 'number-zh.fst']) {
    assert.ok(existsSync(path.join(modelsDir, file)), `缺模型資產 ${file} — 先跑 pnpm fetch:matcha-assets`);
  }
  const tokensText = readFileSync(path.join(modelsDir, 'tokens.txt'), 'utf8');

  // 缺 profile／lexicon 必 throw：沒有可漏傳就靜默降級的字典參數。
  await assert.rejects(() => engineApi.create({tokensText, profile, fstBuffers: [new Uint8Array(1)], frontendApi, profileApi, kaldifstApi, synthesisApi}), /lexiconText/u);
  await assert.rejects(() => engineApi.create({lexiconText, tokensText, fstBuffers: [new Uint8Array(1)], frontendApi, profileApi, kaldifstApi, synthesisApi}), /profile/u);

  // 文字前端：只用 tarball 的 lexicon ＋ runtime profile。
  const taiwan = profileApi.createFrontend({review: profile, frontendApi, lexiconText, tokensText});
  assert.equal(taiwan.lexiconSize, meta.entryCount);
  // 烘入的 override、runtime contextual rule、鏡像詞條、guard、邊界 — 證明 tarball 的 js 與字典有接上。
  assert.deepEqual(taiwan.tokensFor('垃圾').phones, ['le4', 'se4']);
  assert.deepEqual(taiwan.tokensFor('帶著').phones, ['dai4', 'zhe5']);
  assert.deepEqual(taiwan.tokensFor('銀行').phones, ['yin2', 'hang2']);
  assert.deepEqual(taiwan.tokensFor('不會計較').phones, ['bu4', 'hui4', 'ji4', 'jiao4']);
  assert.deepEqual(taiwan.tokensFor('孫道長久久不語').phones, ['sun1', 'dao4', 'zhang3', 'jiu3', 'jiu3', 'bu4', 'yu3']);

  // kaldifst 的 js＋wasm 成對可實例化（wasm bytes 也來自 tarball）。此 dist 以
  // ENVIRONMENT=web,worker 編譯、只會用 fetch 抓 wasm — Node 的 fetch 吃 data:
  // URL，故經 locateFile 以 data URL 餵入 tarball 自己的 bytes。
  const normalizerFactory = requireFromTarball(path.join(extracted, 'matcha-kaldifst-normalizer.js'));
  const wasmBinary = readFileSync(path.join(extracted, 'matcha-kaldifst-normalizer.wasm'));
  const wasmDataUrl = `data:application/wasm;base64,${wasmBinary.toString('base64')}`;
  const fstBuffers = ['phone-zh.fst', 'date-zh.fst', 'number-zh.fst']
    .map((file) => readFileSync(path.join(modelsDir, file)));
  const normalizer = await kaldifstApi.createNormalizer({
    moduleFactory: (options) => normalizerFactory({...options, locateFile: () => wasmDataUrl}),
    wasmUrl: wasmDataUrl,
    fstBuffers,
  });
  assert.equal(normalizer.fstCount, 3);
  assert.equal(normalizer('電話0912345678'), normalizer('電話0912345678'));
  const withFst = frontendApi.createFrontend({lexiconText, tokensText, ruleNormalizer: normalizer, ...profileApi.createConfig(profile, frontendApi)});
  assert.equal(withFst.ruleFstCount, 3);
  normalizer.dispose();

  console.log(JSON.stringify({
    gate: 'package-smoke',
    tarball: path.basename(tarball),
    files: actual.length,
    lexicon: {packName: meta.packName, entries: meta.entryCount, bytes: meta.bytes},
  }, null, 2));
} finally {
  rmSync(extracted, {recursive: true, force: true});
}
