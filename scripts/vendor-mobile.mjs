#!/usr/bin/env node

import {copyFileSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'mobile-host', 'vendor');

const files = [
  {
    package: 'onnxruntime-web',
    source: 'dist/ort.wasm.min.js',
    target: 'ort/ort.min.js',
  },
  {
    package: 'onnxruntime-web',
    source: 'dist/ort-wasm-simd-threaded.mjs',
    target: 'ort/ort-wasm-simd-threaded.mjs',
  },
  {
    package: 'onnxruntime-web',
    source: 'dist/ort-wasm-simd-threaded.wasm',
    target: 'ort/ort-wasm-simd-threaded.wasm',
  },
  {
    package: 'opencc-js',
    source: 'dist/umd/t2cn.js',
    target: 'opencc-t2cn.js',
  },
  {
    package: 'lamejs',
    source: 'lame.min.js',
    target: 'lame.min.js',
  },
];

mkdirSync(path.join(output, 'ort'), {recursive: true});

const versions = {};
for (const entry of files) {
  const packageRoot = path.join(root, 'node_modules', entry.package);
  const manifest = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  versions[entry.package] = manifest.version;
  copyFileSync(path.join(packageRoot, entry.source), path.join(output, entry.target));
}

writeFileSync(
  path.join(output, 'versions.json'),
  `${JSON.stringify(versions, null, 2)}\n`,
);
console.log(`已準備 mobile runtime：${Object.entries(versions).map(([name, version]) => `${name}@${version}`).join('、')}`);
