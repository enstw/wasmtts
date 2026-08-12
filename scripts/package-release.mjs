#!/usr/bin/env node

// 依 scripts/release-manifest.json（發布內容的唯一事實來源）組出釋出套件：
// 把清單檔案複製到 <output>/package/ 並打包成 <output>/wasmtts-frontend.tar.gz。
// release.yml 的打包步驟與 package-smoke gate 共用這條路徑，確保「測過的組包」
// 與「出貨的組包」是同一份邏輯 — 過去 release 不完整就是因為打包是工作流程裡
// 一份沒人驗證的 cp 清單。

import {cpSync, existsSync, mkdirSync, readFileSync, rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const manifestPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'release-manifest.json');

export function loadManifest() {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const names = manifest.files.map((file) => path.basename(file));
  const duplicates = [...new Set(names.filter((name, index) => names.indexOf(name) !== index))];
  if (duplicates.length > 0) {
    throw new Error(`release-manifest.json 有同名檔案，打包時會互相覆蓋：${duplicates.join('、')}`);
  }
  return manifest;
}

export function packageRelease({
  root = process.cwd(),
  output = path.resolve(root, process.env.WASM_TTS_RELEASE_ARTIFACTS ?? 'release-artifacts'),
} = {}) {
  const manifest = loadManifest();
  const missing = manifest.files.filter((file) => !existsSync(path.resolve(root, file)));
  if (missing.length > 0) {
    throw new Error([
      `清單檔案不存在：${missing.join('、')}`,
      '（kaldifst dist 需先 pnpm build:matcha-kaldifst，或由 CI 的 native-wasm artifact 下載）',
    ].join('\n'));
  }
  // 先清掉 package/，避免上一輪的殘留檔混進 tarball。
  const packageDir = path.join(output, 'package');
  rmSync(packageDir, {recursive: true, force: true});
  mkdirSync(packageDir, {recursive: true});
  for (const file of manifest.files) {
    cpSync(path.resolve(root, file), path.join(packageDir, path.basename(file)));
  }
  const tarball = path.join(output, manifest.tarball);
  const tar = spawnSync('tar', ['czf', tarball, '-C', packageDir, '.'], {encoding: 'utf8'});
  if (tar.status !== 0) {
    throw new Error(`tar 打包失敗：${(tar.stderr ?? '').trim() || tar.error?.message}`);
  }
  return {manifest, packageDir, tarball};
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const {manifest, tarball} = packageRelease();
  console.log(`packaged ${manifest.files.length} files -> ${tarball}`);
}
