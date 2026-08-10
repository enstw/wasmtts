#!/usr/bin/env node

import assert from 'node:assert/strict';
import {classifyPaths} from './ci-scope.mjs';

const cases = [
  {files: ['README.md'], artifact: false, renovateConfig: false},
  {files: ['platform/RESULTS.md'], artifact: false, renovateConfig: false},
  {files: ['platform/results/example.json'], artifact: false, renovateConfig: false},
  {files: ['mobile-host/README.md'], artifact: false, renovateConfig: false},
  {files: ['platform/matcha-assets.json'], artifact: true, renovateConfig: false},
  {files: ['platform/asr-baseline/current.json'], artifact: true, renovateConfig: false},
  {files: ['mobile-host/matcha-worker.js'], artifact: true, renovateConfig: false},
  {files: ['frameworks/matcha/samples/quality.txt'], artifact: true, renovateConfig: false},
  {files: ['package.json'], artifact: true, renovateConfig: false},
  {files: ['renovate.json'], artifact: false, renovateConfig: true},
  {files: ['.github/workflows/renovate.yml'], artifact: false, renovateConfig: true},
  {files: ['scripts/ci-scope.mjs'], artifact: false, renovateConfig: false},
  {files: ['scripts/test-ci-scope.mjs'], artifact: false, renovateConfig: false},
  {files: ['scripts/fetch-matcha-assets.mjs'], artifact: true, renovateConfig: false},
];

for (const testCase of cases) {
  assert.deepEqual(classifyPaths(testCase.files), {
    artifact: testCase.artifact,
    renovateConfig: testCase.renovateConfig,
  });
}

console.log(`PASS ci-scope (${cases.length} cases)`);
