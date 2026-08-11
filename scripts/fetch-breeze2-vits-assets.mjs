#!/usr/bin/env node

import {spawnSync} from 'node:child_process';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import {pipeline} from 'node:stream/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(
  path.join(root, 'platform/breeze2-vits-assets.json'),
  'utf8',
));
const targetDirectory = path.join(root, manifest.target);
const temporaryDirectory = path.join(os.tmpdir(), `wasmtts-breeze2-vits-${process.pid}`);

function sha256(file) {
  for (const [command, args] of [
    ['shasum', ['-a', '256', file]],
    ['sha256sum', [file]],
  ]) {
    const result = spawnSync(command, args, {encoding: 'utf8'});
    if (result.status === 0) return result.stdout.trim().split(/\s+/u)[0];
    if (result.error?.code !== 'ENOENT') {
      throw new Error(`${command} 失敗：${result.stderr.trim()}`);
    }
  }
  throw new Error('找不到 shasum 或 sha256sum，無法驗證模型資產');
}

function inspect(file) {
  return {bytes: statSync(file).size, sha256: sha256(file)};
}

function matches(actual, expected) {
  return actual?.bytes === expected.bytes && actual?.sha256 === expected.sha256;
}

async function download(url, target) {
  const response = await fetch(url, {redirect: 'follow'});
  if (!response.ok || !response.body) throw new Error(`${url}: HTTP ${response.status}`);
  await pipeline(response.body, createWriteStream(target));
}

rmSync(temporaryDirectory, {recursive: true, force: true});
mkdirSync(temporaryDirectory, {recursive: true});
mkdirSync(targetDirectory, {recursive: true});

try {
  const inspected = new Map();
  for (const [name, expected] of Object.entries(manifest.files)) {
    const target = path.join(targetDirectory, name);
    let actual = existsSync(target) ? inspect(target) : null;
    if (!matches(actual, expected)) {
      const temporary = path.join(temporaryDirectory, name);
      const source = `${manifest.repository}/resolve/${manifest.revision}/${name}`;
      await download(source, temporary);
      actual = inspect(temporary);
      if (!matches(actual, expected)) {
        throw new Error(`${name} 的大小或 SHA-256 與 manifest 不符`);
      }
      renameSync(temporary, target);
    }
    inspected.set(name, actual);
  }

  const report = {
    repository: manifest.repository,
    revision: manifest.revision,
    files: Object.fromEntries(inspected),
  };
  console.log(JSON.stringify(report, null, 2));
} finally {
  rmSync(temporaryDirectory, {recursive: true, force: true});
}
