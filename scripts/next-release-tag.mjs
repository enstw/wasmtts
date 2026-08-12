#!/usr/bin/env node

import {pathToFileURL} from 'node:url';

const SEMVER_TAG = /^v(\d+)\.(\d+)\.(\d+)$/u;

function parseTag(tagName) {
  const match = SEMVER_TAG.exec(tagName);
  if (!match) return null;
  return match.slice(1).map(Number);
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

export function nextStablePatchTag(releases) {
  const versions = releases
    .filter((release) => !release.isDraft && !release.isPrerelease)
    .map((release) => parseTag(release.tagName))
    .filter(Boolean)
    .sort(compareVersions);
  if (!versions.length) return 'v0.1.0';
  const [major, minor, patch] = versions.at(-1);
  return `v${major}.${minor}.${patch + 1}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const source = process.env.WASM_TTS_RELEASES_JSON;
  if (!source) throw new Error('缺少 WASM_TTS_RELEASES_JSON');
  const releases = JSON.parse(source);
  if (!Array.isArray(releases)) throw new Error('WASM_TTS_RELEASES_JSON 必須是陣列');
  console.log(nextStablePatchTag(releases));
}
