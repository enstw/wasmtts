#!/usr/bin/env node

// package-smoke gate：從消費者視角驗證釋出套件完整可用。其他 gate 都測 repo
// 裡的檔案，只有這裡測「tarball 解開後拿不拿得動」— 完整的唯一非循環定義。
// 1. 用 release-manifest.json 實際打包（與 release.yml 打包步驟同一條路徑）。
// 1. 解壓 tarball 到乾淨暫存目錄，檔案清單須與 manifest 完全一致。
// 1. 只用解壓出的檔案載入 MatchaFrontend + MatchaTaiwanProfile 驗證發音，
//    並以 tarball 自己的 wasm bytes 實例化 kaldifst normalizer。
// 模型資產（lexicon/tokens）本來就不在 tarball 內 — 消費者依 matcha-assets.json
// 另行下載，此處取用已抓好的 platform/models/。

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

  // 解壓內容與 manifest 一致，不多不少。
  const actual = readdirSync(extracted, {recursive: true})
    .map(String)
    .filter((entry) => statSync(path.join(extracted, entry)).isFile())
    .sort();
  const expected = manifest.files.map((file) => path.basename(file)).sort();
  assert.deepEqual(actual, expected, 'tarball 內容與 release-manifest.json 不一致');

  // JSON 附件須可解析。
  const review = JSON.parse(readFileSync(path.join(extracted, 'matcha-g2p-review.json'), 'utf8'));
  JSON.parse(readFileSync(path.join(extracted, 'matcha-assets.json'), 'utf8'));

  // 消費者載入流程：先 MatchaFrontend、再 MatchaTaiwanProfile，皆取自解壓目錄。
  const requireFromTarball = createRequire(path.join(extracted, 'consumer.js'));
  const frontendApi = requireFromTarball(path.join(extracted, 'matcha-frontend.js'));
  const profileApi = requireFromTarball(path.join(extracted, 'matcha-taiwan-profile.js'));

  const modelsDir = path.join(root, 'platform/models/matcha-icefall-zh-en');
  for (const file of ['lexicon.txt', 'tokens.txt']) {
    assert.ok(existsSync(path.join(modelsDir, file)), `缺模型資產 ${file} — 先跑 pnpm fetch:matcha-assets`);
  }
  const taiwan = profileApi.createFrontend({
    review,
    frontendApi,
    lexiconText: readFileSync(path.join(modelsDir, 'lexicon.txt'), 'utf8'),
    lexiconSupplementText: readFileSync(path.join(extracted, 'matcha-lexicon-traditional.txt'), 'utf8'),
    tokensText: readFileSync(path.join(modelsDir, 'tokens.txt'), 'utf8'),
  });
  // 一條 base override、一條 review 規則 — 證明 tarball 的 js 與 review JSON 有接上。
  assert.deepEqual(taiwan.tokensFor('垃圾').phones, ['le4', 'se4']);
  assert.deepEqual(taiwan.tokensFor('帶著').phones, ['dai4', 'zhe5']);
  // 一條鏡像詞條、一條 guard — 證明 tarball 的繁體補充詞典有接上且不誤傷跨界。
  assert.deepEqual(taiwan.tokensFor('銀行').phones, ['yin2', 'hang2']);
  assert.deepEqual(taiwan.tokensFor('不會計較').phones, ['bu4', 'hui4', 'ji4', 'jiao4']);

  // kaldifst 的 js＋wasm 成對可實例化（wasm bytes 也來自 tarball）。此 dist 以
  // ENVIRONMENT=web,worker 編譯、只會用 fetch 抓 wasm — Node 的 fetch 吃 data:
  // URL，故經 locateFile 以 data URL 餵入 tarball 自己的 bytes。
  const normalizerFactory = requireFromTarball(path.join(extracted, 'matcha-kaldifst-normalizer.js'));
  const wasmBinary = readFileSync(path.join(extracted, 'matcha-kaldifst-normalizer.wasm'));
  const wasmDataUrl = `data:application/wasm;base64,${wasmBinary.toString('base64')}`;
  const normalizer = await normalizerFactory({locateFile: () => wasmDataUrl});
  assert.equal(typeof normalizer._kaldifst_normalizer_create, 'function', 'kaldifst normalizer 實例化失敗');

  console.log(JSON.stringify({
    gate: 'package-smoke',
    tarball: path.basename(tarball),
    files: actual.length,
  }, null, 2));
} finally {
  rmSync(extracted, {recursive: true, force: true});
}
