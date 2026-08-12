#!/usr/bin/env node

import assert from 'node:assert/strict';
import {nextStablePatchTag} from './next-release-tag.mjs';

assert.equal(nextStablePatchTag([]), 'v0.1.0');
assert.equal(nextStablePatchTag([
  {tagName: 'v0.1.15', isDraft: false, isPrerelease: false},
  {tagName: 'v1.0.0', isDraft: false, isPrerelease: false},
]), 'v1.0.1');
assert.equal(nextStablePatchTag([
  {tagName: 'candidate-failed-123', isDraft: false, isPrerelease: true},
  {tagName: 'v2.4.8', isDraft: false, isPrerelease: false},
  {tagName: 'v9.0.0', isDraft: true, isPrerelease: false},
  {tagName: 'not-semver', isDraft: false, isPrerelease: false},
]), 'v2.4.9');
assert.equal(nextStablePatchTag([
  {tagName: 'v1.9.12', isDraft: false, isPrerelease: false},
  {tagName: 'v1.10.2', isDraft: false, isPrerelease: false},
]), 'v1.10.3');

console.log('PASS release version：最高穩定 SemVer 的 patch + 1');
