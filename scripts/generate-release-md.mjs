#!/usr/bin/env node

import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const artifacts = path.resolve(process.env.WASM_TTS_RELEASE_ARTIFACTS ?? 'release-artifacts');
const output = path.resolve(process.env.WASM_TTS_RELEASE_MD ?? path.join(artifacts, 'RELEASE.md'));

function readJson(file) {
  const target = path.resolve(root, file);
  if (!existsSync(target)) return null;
  try {
    return JSON.parse(readFileSync(target, 'utf8'));
  } catch (error) {
    return {readError: error.message};
  }
}

function cell(value) {
  return String(value ?? '—').replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function number(value, digits = 4) {
  return Number.isFinite(value) ? value.toFixed(digits) : '—';
}

function bytes(value) {
  if (!Number.isFinite(value)) return '—';
  return `${(value / 1024 / 1024).toFixed(1)} MiB (${value.toLocaleString('en-US')} bytes)`;
}

function result(value) {
  if (!value) return 'NOT RUN';
  return String(value).toUpperCase();
}

const gates = readJson(path.join(artifacts, 'release-gates.json'));
const combinations = Array.isArray(gates?.combinations) ? gates.combinations : [];
const hasExecutedGates = combinations.some(({name}) => name === 'release-results');
const core = hasExecutedGates
  ? readJson('platform/results/results-matcha_icefall_zh_en-browser-wasm.json')
  : null;
const stream = hasExecutedGates
  ? readJson('platform/results/results-matcha_icefall_zh_en-stream-browser-wasm.json')
  : null;
const asr = hasExecutedGates
  ? readJson('platform/results/asr-listening-report.json')
  : null;
const product = hasExecutedGates
  ? readJson('platform/results/results-matcha_icefall_zh_en-product-browser-wasm.json')
  : null;
const asrProduct = hasExecutedGates
  ? readJson('platform/results/asr-listening-product-report.json')
  : null;
const assets = readJson(path.join(artifacts, 'assets.json'));
const manifest = readJson('platform/matcha-assets.json');
const packageJson = readJson('package.json');

const coreWaveforms = Array.isArray(core?.runs) ? core.runs.map(({waveform}) => waveform) : [];
const waveformValid = coreWaveforms.length > 0 && coreWaveforms.every((waveform) => (
  waveform?.finiteSamples === waveform?.samples && waveform?.peak > 0 && waveform?.rms > 0
));
const releaseTag = process.env.RELEASE_TAG || 'unassigned';
const commit = gates?.commit || process.env.GITHUB_SHA || 'local';
const runUrl = process.env.GITHUB_RUN_URL;
const status = gates?.status ?? 'not run';

const lines = [
  '# wasmtts tested release',
  '',
  `- Release: \`${releaseTag}\``,
  `- Commit: \`${commit}\``,
  `- Result: **${result(status)}**`,
  `- Generated: ${gates?.generatedAt ?? new Date().toISOString()}`,
  ...(runUrl ? [`- GitHub Actions run: ${runUrl}`] : []),
  '',
  '## Release scope',
  '',
  '本 Release 驗證 Matcha browser frontend 的免費 GitHub runner 可重現桌面 gates。iPhone／PWA 實機驗收與英文 eSpeak frontend 不屬於自動 release gate。',
  '',
];

if (hasExecutedGates) {
  lines.push(
    '## Product metrics',
    '',
    '| Metric | Result | Gate |',
    '|---|---:|---:|',
    `| Core median wall RTF | ${number(core?.summary?.medianWallRtf)} | < 1 |`,
    `| Producer RTF | ${number(stream?.summary?.producerRtf)} | < 1 |`,
    `| Producer realtime multiplier | ${number(stream?.summary?.producerRealtimeMultiplier, 2)}x | > 1x |`,
    `| Memory after initialization | ${bytes(stream?.memory?.afterInitialization?.bytes)} | ≤ 512 MiB |`,
    `| Memory after stream | ${bytes(stream?.memory?.afterStream?.bytes)} | ≤ 512 MiB |`,
    `| Core waveform | ${waveformValid ? 'valid' : 'invalid or unavailable'} | finite; peak > 0; RMS > 0 |`,
    `| Stream underflows | ${stream?.summary?.underflows ?? '—'} | 0 |`,
    `| Append errors | ${stream?.summary?.appendErrors ?? '—'} | 0 |`,
    `| Producer errors | ${stream?.summary?.producerErrors ?? '—'} | 0 |`,
    `| Whisper ASR CER | ${Number.isFinite(asr?.metrics?.cer) ? `${(asr.metrics.cer * 100).toFixed(2)}%` : '—'} | ≤ ${Number.isFinite(asr?.metrics?.absoluteCerLimit) ? `${(asr.metrics.absoluteCerLimit * 100).toFixed(2)}%` : 'configured limit'} |`,
    `| Product-recipe median wall RTF | ${number(product?.summary?.medianWallRtf)} | < 1 (sanity only) |`,
    `| Product-recipe Whisper ASR CER | ${Number.isFinite(asrProduct?.metrics?.cer) ? `${(asrProduct.metrics.cer * 100).toFixed(2)}%` : '—'} | ≤ ${Number.isFinite(asrProduct?.metrics?.absoluteCerLimit) ? `${(asrProduct.metrics.absoluteCerLimit * 100).toFixed(2)}%` : 'configured limit'} |`,
    '',
    '> Memory figures are Chromium measurement snapshots, not true peak memory measurements and not iPhone results.',
    '> Product-recipe rows use the `synthesis` block from `matcha-assets.json` (silenceScale 1 lengthens audio); they are a separate series and must not be compared with the research-series RTF above.',
    '',
    '## Tested configuration',
    '',
    `- Model: \`${stream?.model?.name ?? core?.model?.name ?? 'matcha-icefall-zh-en'}\``,
    `- Acoustic model: \`${assets?.acoustic?.file ?? manifest?.acoustic?.file ?? 'unavailable'}\` @ \`${assets?.acoustic?.revision ?? manifest?.acoustic?.revision ?? 'unavailable'}\``,
    `- Matcha frontend assets revision: \`${assets?.matcha?.revision ?? manifest?.matcha?.revision ?? 'unavailable'}\``,
    `- Runtime: \`${core?.environment?.runtime ?? (stream?.initialization?.runtime?.ort ? `ONNX Runtime Web ${stream.initialization.runtime.ort}` : packageJson?.dependencies?.['onnxruntime-web'] ?? 'unavailable')}\``,
    `- Text frontend: ${stream?.frontend?.inputNormalization ?? 'unavailable'}; FST order \`${stream?.frontend?.ruleFsts?.join(' → ') ?? 'phone-zh.fst → date-zh.fst → number-zh.fst'}\``,
    `- FST runtime: \`${stream?.frontend?.fstRuntime ?? 'unavailable'}\``,
    `- WASM threads: ${stream?.model?.threads ?? core?.environment?.requestedThreads ?? 'unavailable'}`,
    `- Noise scale: ${stream?.segments?.[0]?.noiseScale ?? core?.model?.noiseScale ?? 'unavailable'}`,
    `- Audio transport: ${stream?.protocol?.transport ?? 'unavailable'}`,
    '',
  );
} else {
  lines.push(
    '## Product metrics',
    '',
    'Product metrics were not reported because the complete browser gate did not execute. Checked-in benchmark files are intentionally ignored in this case.',
    '',
  );
}

lines.push(
  '## Gate results',
  '',
  '| Gate | Result | Duration | Failure reason |',
  '|---|---:|---:|---|',
  ...(combinations.length
    ? combinations.map((gate) => `| ${cell(gate.name)} | ${cell(result(gate.status))} | ${Number.isFinite(gate.durationMs) ? `${gate.durationMs} ms` : '—'} | ${cell(gate.reason ?? '')} |`)
    : ['| release-gates | NOT RUN | — | release-gates.json unavailable |']),
  '',
);

if (assets?.matcha?.files || assets?.acoustic || assets?.vocos) {
  const assetRows = Object.entries(assets?.matcha?.files ?? {}).map(([name, metadata]) => (
    `| ${cell(name)} | ${bytes(metadata.bytes)} | \`${metadata.sha256}\` |`
  ));
  if (assets?.acoustic) {
    assetRows.push(`| ${cell(assets.acoustic.file)} | ${bytes(assets.acoustic.bytes)} | \`${assets.acoustic.sha256}\` |`);
  }
  if (assets?.vocos) {
    assetRows.push(`| vocos-16khz-univ.onnx | ${bytes(assets.vocos.bytes)} | \`${assets.vocos.sha256}\` |`);
  }
  lines.push(
    '## Immutable assets',
    '',
    '| Asset | Size | SHA-256 |',
    '|---|---:|---|',
    ...assetRows,
    '',
  );
}

if (gates?.readError) {
  lines.push('## Report error', '', `Could not parse release-gates.json: ${gates.readError}`, '');
}

mkdirSync(path.dirname(output), {recursive: true});
writeFileSync(output, `${lines.join('\n').trimEnd()}\n`);
console.log(`Wrote ${path.relative(root, output)}`);
