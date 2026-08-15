#!/usr/bin/env node

import {createHash} from 'node:crypto';
import {createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, copyFileSync} from 'node:fs';
import {pipeline} from 'node:stream/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(path.join(root, 'platform/matcha-assets.json'), 'utf8'));
const modelDir = path.join(root, 'platform/models/matcha-icefall-zh-en');
const temporary = path.join(os.tmpdir(), `wasmtts-matcha-assets-${process.pid}`);

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

async function download(url, target) {
  const response = await fetch(url, {redirect: 'follow'});
  if (!response.ok || !response.body) throw new Error(`${url}: HTTP ${response.status}`);
  mkdirSync(path.dirname(target), {recursive: true});
  await pipeline(response.body, createWriteStream(target));
}

rmSync(temporary, {recursive: true, force: true});
mkdirSync(temporary, {recursive: true});
try {
  mkdirSync(modelDir, {recursive: true});
  for (const [file, meta] of Object.entries(manifest.matcha.files)) {
    const source = path.join(temporary, file);
    const repository = manifest.matcha.repository.replace(/\.git$/u, '');
    await download(`${repository}/resolve/${manifest.matcha.revision}/${file}`, source);
    const hash = sha256(source);
    if (hash !== meta.sha256) {
      throw new Error(`${file} SHA-256 mismatch: ${hash} != ${meta.sha256}`);
    }
    const size = statSync(source).size;
    if (size !== meta.bytes) {
      throw new Error(`${file} byte-size mismatch: ${size} != ${meta.bytes}`);
    }
    copyFileSync(source, path.join(modelDir, file));
  }

  const acousticRepository = manifest.acoustic.repository.replace(/\.git$/u, '');
  const acousticTarget = path.join(root, manifest.acoustic.target);
  if (!existsSync(acousticTarget) || sha256(acousticTarget) !== manifest.acoustic.sha256) {
    await download(`${acousticRepository}/resolve/${manifest.acoustic.revision}/${manifest.acoustic.file}`, acousticTarget);
  }
  const acousticHash = sha256(acousticTarget);
  if (acousticHash !== manifest.acoustic.sha256) {
    throw new Error(`Acoustic model SHA-256 mismatch: ${acousticHash} != ${manifest.acoustic.sha256}`);
  }
  const acousticBytes = statSync(acousticTarget).size;
  if (acousticBytes !== manifest.acoustic.bytes) {
    throw new Error(`Acoustic model byte-size mismatch: ${acousticBytes} != ${manifest.acoustic.bytes}`);
  }
  for (const stale of readdirSync(modelDir)) {
    if (/^model-steps-\d+\.onnx$/u.test(stale) && stale !== manifest.acoustic.file) {
      rmSync(path.join(modelDir, stale));
    }
  }

  const vocosTarget = path.join(root, manifest.vocos.target);
  if (!existsSync(vocosTarget) || sha256(vocosTarget) !== manifest.vocos.sha256) {
    await download(manifest.vocos.url, vocosTarget);
  }
  const vocosHash = sha256(vocosTarget);
  if (vocosHash !== manifest.vocos.sha256) {
    throw new Error(`Vocos SHA-256 mismatch: ${vocosHash} != ${manifest.vocos.sha256}`);
  }
  const vocosBytes = statSync(vocosTarget).size;
  if (vocosBytes !== manifest.vocos.bytes) {
    throw new Error(`Vocos byte-size mismatch: ${vocosBytes} != ${manifest.vocos.bytes}`);
  }

  const report = {
    matcha: {
      repository: manifest.matcha.repository,
      revision: manifest.matcha.revision,
      files: Object.fromEntries(Object.entries(manifest.matcha.files).map(([file, meta]) => {
        const target = path.join(modelDir, file);
        return [file, {packName: meta.packName, bytes: statSync(target).size, sha256: sha256(target)}];
      })),
    },
    acoustic: {
      repository: manifest.acoustic.repository,
      revision: manifest.acoustic.revision,
      file: manifest.acoustic.file,
      packName: manifest.acoustic.packName,
      bytes: statSync(acousticTarget).size,
      sha256: acousticHash,
    },
    vocos: {url: manifest.vocos.url, packName: manifest.vocos.packName, bytes: statSync(vocosTarget).size, sha256: vocosHash},
  };
  const reportTarget = process.env.WASM_TTS_ASSET_REPORT;
  if (reportTarget) {
    mkdirSync(path.dirname(path.resolve(reportTarget)), {recursive: true});
    await import('node:fs/promises').then(({writeFile}) => writeFile(reportTarget, `${JSON.stringify(report, null, 2)}\n`));
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  rmSync(temporary, {recursive: true, force: true});
}
