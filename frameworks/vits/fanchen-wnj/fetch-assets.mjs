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

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDirectory, '../../..');
const manifest = JSON.parse(readFileSync(
  path.join(scriptDirectory, 'assets.json'),
  'utf8',
));
const targetDirectory = path.join(root, manifest.target);
const temporaryDirectory = path.join(os.tmpdir(), `wasmtts-fanchen-vits-wnj-${process.pid}`);
const archivePath = path.join(temporaryDirectory, 'model.tar.bz2');

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

function report(files) {
  console.log(JSON.stringify({
    repository: manifest.repository,
    releaseTag: manifest.releaseTag,
    archive: manifest.archive,
    files,
  }, null, 2));
}

const inspected = {};
let complete = true;
for (const [name, expected] of Object.entries(manifest.files)) {
  const target = path.join(targetDirectory, name);
  const actual = existsSync(target) ? inspect(target) : null;
  inspected[name] = actual;
  if (!matches(actual, expected)) complete = false;
}

if (complete) {
  report(inspected);
  process.exit(0);
}

rmSync(temporaryDirectory, {recursive: true, force: true});
mkdirSync(temporaryDirectory, {recursive: true});
mkdirSync(targetDirectory, {recursive: true});

try {
  await download(manifest.archive.url, archivePath);
  if (!matches(inspect(archivePath), manifest.archive)) {
    throw new Error('release archive 的大小或 SHA-256 與 manifest 不符');
  }

  const extractedDirectory = path.join(temporaryDirectory, 'extracted');
  mkdirSync(extractedDirectory, {recursive: true});
  const extraction = spawnSync('tar', ['xjf', archivePath, '-C', extractedDirectory], {
    encoding: 'utf8',
  });
  if (extraction.status !== 0) {
    throw new Error(`解壓縮失敗：${extraction.stderr.trim()}`);
  }

  for (const [name, expected] of Object.entries(manifest.files)) {
    const source = path.join(extractedDirectory, manifest.sourceDirectory, expected.source);
    const actual = inspect(source);
    if (!matches(actual, expected)) {
      throw new Error(`${expected.source} 的大小或 SHA-256 與 manifest 不符`);
    }
    renameSync(source, path.join(targetDirectory, name));
    inspected[name] = actual;
  }
  report(inspected);
} finally {
  rmSync(temporaryDirectory, {recursive: true, force: true});
}
