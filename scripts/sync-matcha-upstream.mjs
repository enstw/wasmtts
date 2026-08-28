#!/usr/bin/env node

// 上游 matcha-icefall-zh-en 追蹤:lexicon／tokens／FST 是該模型 release 的一部分,
// 模型出新版時整組換 pin、以新 lexicon 重編 wasmtts lexicon。
//
// 1. 查 HuggingFace 最新 revision,與 platform/matcha-assets.source.json 的 pin 比對。
// 1. 有更新:改寫 matcha-assets.source.json 與 platform/upstreams.yaml 的 revision,
//    重抓上游檔(scripts/fetch-matcha-assets.mjs 同一條驗證路徑)並回填
//    bytes／sha256。
// 1. 以舊 pin 的編譯結果為基準重建 wasmtts lexicon,輸出 diff 報告:上游詞條
//    新增／移除／讀音改變、受影響的 review patterns 與 curation 條目、
//    編譯 stats 差異。
//
// CI 的每週 Renovate roll-up 也會改同一個 pin 並跑同一條 build;本 script
// 是本機同步與診斷入口,不取代 Renovate。
//
// 用法:node scripts/sync-matcha-upstream.mjs [--check] [--revision <sha>]
//   --check     只比對,不改檔(有更新 exit 2)
//   --revision  指定 revision 模擬更新路徑(測試用)
//   WASM_TTS_UPSTREAM_API 可覆寫 HF API 端點(測試用)

import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

import {buildMatchaLexicon, readBuildInputs} from '../platform/build-matcha-lexicon.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assetsPath = path.join(root, 'platform/matcha-assets.source.json');
const upstreamsPath = path.join(root, 'platform/upstreams.yaml');
const modelDir = path.join(root, 'platform/models/matcha-icefall-zh-en');
const distDir = path.join(root, 'platform/dist');

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

export async function latestUpstreamRevision(repository, api = process.env.WASM_TTS_UPSTREAM_API) {
  const model = repository.replace(/^https:\/\/huggingface\.co\//u, '').replace(/\.git$/u, '');
  const url = api ?? `https://huggingface.co/api/models/${model}`;
  const response = await fetch(url, {redirect: 'follow'});
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const body = await response.json();
  if (!/^[0-9a-f]{40}$/u.test(body.sha ?? '')) throw new Error(`${url} 沒有回傳 40 碼 revision:${JSON.stringify(body.sha)}`);
  return {revision: body.sha, lastModified: body.lastModified ?? null};
}

function parseLexicon(text) {
  const entries = new Map();
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    const separator = trimmed.indexOf(' ');
    if (separator < 1) continue;
    entries.set(trimmed.slice(0, separator), trimmed.slice(separator + 1).trim());
  }
  return entries;
}

// 兩份上游 lexicon 的差異,以及它們在 review／curation 決策上的落點。
export function diffUpstreamLexicon(previousText, nextText, {review, curation}) {
  const previous = parseLexicon(previousText);
  const next = parseLexicon(nextText);
  const added = [...next.keys()].filter((key) => !previous.has(key));
  const removed = [...previous.keys()].filter((key) => !next.has(key));
  const changed = [...next.keys()].filter((key) => previous.has(key) && previous.get(key) !== next.get(key));
  const touched = new Set([...added, ...removed, ...changed]);
  const affects = (patterns) => patterns.filter((pattern) => [...touched].some((key) => key.includes(pattern) || pattern.includes(key)));
  return {
    added, removed, changed,
    affectedReviewPatterns: affects(review.entries.map((entry) => entry.pattern)),
    affectedCurationExclusions: affects(curation.exclusions.map((entry) => entry.pattern)),
    affectedCurationGuards: affects(curation.guards.map((entry) => entry.pattern)),
  };
}

function statsDiff(previous, next) {
  const keys = new Set([...Object.keys(previous ?? {}), ...Object.keys(next ?? {})]);
  return [...keys].map((key) => ({key, previous: previous?.[key] ?? null, next: next?.[key] ?? null}))
    .filter((row) => row.previous !== row.next);
}

export function renderReport({assets, previousRevision, nextRevision, lastModified, lexiconDiff, previousStats, nextStats, previousMeta, nextMeta}) {
  const list = (items, limit = 40) => (items.length
    ? `${items.slice(0, limit).map((item) => `\`${item}\``).join('、')}${items.length > limit ? ` …（共 ${items.length}）` : ''}`
    : '無');
  return [
    '# 上游 matcha-icefall-zh-en 同步報告',
    '',
    `- Repository: \`${assets.matcha.repository}\``,
    `- Revision: \`${previousRevision}\` → \`${nextRevision}\`${lastModified ? `（上游最後修改 ${lastModified}）` : ''}`,
    `- wasmtts lexicon: \`${previousMeta?.packName ?? '（無舊建置）'}\` → \`${nextMeta.packName}\`（${nextMeta.entryCount.toLocaleString('en-US')} 條、${nextMeta.bytes.toLocaleString('en-US')} bytes）`,
    '',
    '## 上游 lexicon 差異',
    '',
    `- 新增 ${lexiconDiff.added.length} 條：${list(lexiconDiff.added)}`,
    `- 移除 ${lexiconDiff.removed.length} 條：${list(lexiconDiff.removed)}`,
    `- 讀音改變 ${lexiconDiff.changed.length} 條：${list(lexiconDiff.changed)}`,
    '',
    '## 受影響的既有決策（需人工複核）',
    '',
    `- review patterns：${list(lexiconDiff.affectedReviewPatterns)}`,
    `- curation exclusions：${list(lexiconDiff.affectedCurationExclusions)}`,
    `- curation guards：${list(lexiconDiff.affectedCurationGuards)}`,
    '',
    '## 編譯 stats 差異',
    '',
    '| stat | 前 | 後 |',
    '|---|---:|---:|',
    ...(statsDiff(previousStats, nextStats).map((row) => `| ${row.key} | ${row.previous ?? '—'} | ${row.next ?? '—'} |`)),
    ...(statsDiff(previousStats, nextStats).length ? [] : ['| （無差異） | | |']),
    '',
  ].join('\n');
}

function rewritePins(nextRevision) {
  const assets = JSON.parse(readFileSync(assetsPath, 'utf8'));
  const previousRevision = assets.matcha.revision;
  const assetsText = readFileSync(assetsPath, 'utf8');
  writeFileSync(assetsPath, assetsText.replaceAll(previousRevision, nextRevision));
  if (existsSync(upstreamsPath)) {
    const yaml = readFileSync(upstreamsPath, 'utf8');
    writeFileSync(upstreamsPath, yaml.replaceAll(previousRevision, nextRevision));
  }
  return previousRevision;
}

function refillAssetHashes() {
  // fetch-matcha-assets.mjs 以 manifest 的 sha256 驗證下載;換 pin 後先把
  // 五個 matcha 檔的 sha256/bytes 改成「未知」讓它重抓,再以落地檔回填。
  const assets = JSON.parse(readFileSync(assetsPath, 'utf8'));
  const repository = assets.matcha.repository.replace(/\.git$/u, '');
  return Promise.all(Object.keys(assets.matcha.files).map(async (file) => {
    const url = `${repository}/resolve/${assets.matcha.revision}/${file}`;
    const response = await fetch(url, {redirect: 'follow'});
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    mkdirSync(modelDir, {recursive: true});
    writeFileSync(path.join(modelDir, file), buffer);
    assets.matcha.files[file] = {...assets.matcha.files[file], bytes: buffer.byteLength, sha256: sha256(buffer)};
  })).then(() => {
    writeFileSync(assetsPath, `${JSON.stringify(assets, null, 2)}\n`);
    return assets;
  });
}

export async function syncUpstream({check = false, revision = null} = {}) {
  const assets = JSON.parse(readFileSync(assetsPath, 'utf8'));
  const current = assets.matcha.revision;
  const latest = revision
    ? {revision, lastModified: null}
    : await latestUpstreamRevision(assets.matcha.repository);
  if (latest.revision === current) {
    return {updated: false, revision: current, message: `上游 revision 未變（${current}）`};
  }
  if (check) {
    return {updated: true, revision: latest.revision, message: `上游有新 revision ${latest.revision}（目前 pin ${current}）；未改檔`};
  }

  // 舊基準:以目前 pin 的落地檔與既有建置(若有)為比較基準。
  const previousLexiconPath = path.join(modelDir, 'lexicon.txt');
  const previousLexiconText = existsSync(previousLexiconPath) ? readFileSync(previousLexiconPath, 'utf8') : '';
  const previousMetaPath = path.join(distDir, 'matcha-lexicon.meta.json');
  const previousMeta = existsSync(previousMetaPath) ? JSON.parse(readFileSync(previousMetaPath, 'utf8')) : null;

  const previousRevision = rewritePins(latest.revision);
  await refillAssetHashes();
  // 走正式 fetch 路徑再驗一次(sha256/bytes 與 manifest 一致、acoustic/vocos 到位)。
  const fetched = spawnSync(process.execPath, [path.join(root, 'scripts/fetch-matcha-assets.mjs')], {stdio: 'inherit'});
  if (fetched.status !== 0) throw new Error('fetch-matcha-assets 失敗');

  const inputs = readBuildInputs(root);
  const built = buildMatchaLexicon(inputs);
  const {buildAndWrite} = await import('../platform/build-matcha-lexicon.mjs');
  const {meta} = buildAndWrite({root});
  const report = renderReport({
    assets: inputs.assets,
    previousRevision,
    nextRevision: latest.revision,
    lastModified: latest.lastModified,
    lexiconDiff: diffUpstreamLexicon(previousLexiconText, inputs.lexiconText, inputs),
    previousStats: previousMeta?.stats,
    nextStats: built.stats,
    previousMeta,
    nextMeta: meta,
  });
  mkdirSync(distDir, {recursive: true});
  const reportPath = path.join(distDir, 'lexicon-diff.md');
  writeFileSync(reportPath, report);
  return {updated: true, revision: latest.revision, previousRevision, reportPath, report, bytes: statSync(path.join(distDir, 'matcha-lexicon.txt')).size};
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const revisionIndex = args.indexOf('--revision');
  const result = await syncUpstream({
    check: args.includes('--check'),
    revision: revisionIndex >= 0 ? args[revisionIndex + 1] : null,
  });
  if (result.report) {
    console.log(result.report);
    console.log(`報告已寫入 ${path.relative(root, result.reportPath)}；記得跑 pnpm test:matcha-lexicon 與 test:release-gates。`);
  } else {
    console.log(result.message);
  }
  if (args.includes('--check') && result.updated) process.exit(2);
}
