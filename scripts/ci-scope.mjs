#!/usr/bin/env node

import {appendFileSync, readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';

const EXACT_ARTIFACT_PATHS = new Set([
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'frameworks/matcha/samples/quality.txt',
]);

const EXACT_RENOVATE_PATHS = new Set([
  'renovate.json',
  '.github/workflows/renovate.yml',
]);

const EXACT_CI_CONFIG_PATHS = new Set([
  'scripts/ci-scope.mjs',
  'scripts/test-ci-scope.mjs',
]);

function isArtifactPath(file) {
  if (EXACT_CI_CONFIG_PATHS.has(file)) return false;
  if (EXACT_ARTIFACT_PATHS.has(file) || file.startsWith('scripts/')) return true;
  if (file.startsWith('platform/')) {
    return !file.startsWith('platform/results/') && !file.endsWith('.md');
  }
  if (file.startsWith('mobile-host/')) return !file.endsWith('.md');
  return false;
}

export function classifyPaths(files) {
  return {
    artifact: files.some(isArtifactPath),
    renovateConfig: files.some((file) => EXACT_RENOVATE_PATHS.has(file)),
  };
}

function readOption(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

function resolveRange() {
  if (process.argv.includes('--force')) return {force: true};

  const base = readOption('--base');
  const head = readOption('--head');
  if (base || head) {
    if (!base || !head) throw new Error('必須同時提供 --base 與 --head');
    return {base, head, force: false};
  }

  const eventName = process.env.GITHUB_EVENT_NAME;
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventName || !eventPath) throw new Error('缺少 GitHub event，請提供 --base/--head 或 --force');
  if (eventName === 'workflow_dispatch') return {force: true};

  const event = JSON.parse(readFileSync(eventPath, 'utf8'));
  if (eventName === 'pull_request') {
    return {base: event.pull_request.base.sha, head: event.pull_request.head.sha, force: false};
  }
  if (eventName === 'merge_group') {
    return {base: event.merge_group.base_sha, head: event.merge_group.head_sha, force: false};
  }
  if (eventName === 'push') {
    if (/^0+$/u.test(event.before)) return {force: true};
    return {base: event.before, head: event.after, force: false};
  }
  throw new Error(`不支援的 GitHub event：${eventName}`);
}

function changedPaths(base, head) {
  const result = spawnSync('git', ['diff', '--name-only', '-z', base, head, '--'], {
    encoding: 'buffer',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr.toString('utf8').trim() || `git diff 結束狀態：${result.status}`);
  }
  return result.stdout.toString('utf8').split('\0').filter(Boolean);
}

function main() {
  const range = resolveRange();
  const scope = range.force
    ? {artifact: true, renovateConfig: true}
    : classifyPaths(changedPaths(range.base, range.head));
  const output = [
    `artifact=${scope.artifact}`,
    `renovate_config=${scope.renovateConfig}`,
  ].join('\n');
  console.log(output);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${output}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
