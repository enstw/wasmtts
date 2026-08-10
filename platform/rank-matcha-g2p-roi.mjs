#!/usr/bin/env node

// 將分層 g2pW pilot 的抽樣證據與全文前字次數合併，產生可審核的候選 ROI 排名。

import {readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';

function usage() {
  console.error('用法：node platform/rank-matcha-g2p-roi.mjs <pilot.local.json> [--min-samples <n>] [--output <report.local.json>]');
}

function argumentsFrom(argv) {
  if (argv[0] === '--') argv = argv.slice(1);
  const input = argv[0] ? resolve(argv[0]) : null;
  let minSamples = 3;
  let output = null;
  for (let index = 1; index < argv.length; index += 1) {
    if (argv[index] === '--min-samples' && argv[index + 1]) {
      minSamples = Number(argv[++index]);
    } else if (argv[index] === '--output' && argv[index + 1]) {
      output = resolve(argv[++index]);
    } else {
      throw new Error(`不支援的參數：${argv[index]}`);
    }
  }
  if (!Number.isInteger(minSamples) || minSamples < 1) throw new Error('--min-samples 必須是正整數');
  return {input, minSamples, output};
}

export function rankPilot(pilot, minSamples = 3) {
  const target = pilot.input?.stratifyPrevious;
  const corpusOccurrences = pilot.input?.stratifiedOccurrences;
  if (!target || !corpusOccurrences || !Array.isArray(pilot.focusContexts)) {
    throw new Error('輸入必須是 --stratify-previous 產生的 g2pW pilot report');
  }
  const currentPhones = [...new Set((pilot.differenceGroups ?? [])
    .filter((group) => group.character === target)
    .map((group) => group.matcha))];
  if (currentPhones.length !== 1) throw new Error(`無法唯一判定 ${target} 的目前 phone`);
  const currentPhone = currentPhones[0];

  const grouped = new Map();
  for (const context of pilot.focusContexts) {
    const entry = grouped.get(context.previous) ?? {samples: 0, predictions: new Map()};
    entry.samples += context.count;
    entry.predictions.set(context.g2pw, (entry.predictions.get(context.g2pw) ?? 0) + context.count);
    grouped.set(context.previous, entry);
  }

  const candidates = [...grouped].map(([previous, evidence]) => {
    const predictions = [...evidence.predictions]
      .map(([phone, count]) => ({phone, count}))
      .sort((left, right) => right.count - left.count || left.phone.localeCompare(right.phone));
    let status = 'insufficient';
    if (evidence.samples >= minSamples) {
      if (predictions.length > 1) status = 'mixed';
      else status = predictions[0].phone === currentPhone ? 'consistent-current' : 'actionable';
    }
    return {
      previous,
      corpusOccurrences: corpusOccurrences[previous] ?? 0,
      samples: evidence.samples,
      predictions,
      status,
      estimatedAffectedCeiling: status === 'actionable' ? (corpusOccurrences[previous] ?? 0) : 0,
    };
  }).sort((left, right) => right.estimatedAffectedCeiling - left.estimatedAffectedCeiling
    || right.samples - left.samples || left.previous.localeCompare(right.previous, 'zh-Hant'));

  return {
    schemaVersion: 1,
    target,
    currentPhone,
    selection: 'previous-character stratified',
    minSamples,
    caveat: 'estimatedAffectedCeiling 是同前字的全文上限，不是已確認錯讀數；actionable 仍須辭典與上下文審核',
    summary: {
      candidates: candidates.length,
      actionable: candidates.filter((item) => item.status === 'actionable').length,
      consistentCurrent: candidates.filter((item) => item.status === 'consistent-current').length,
      mixed: candidates.filter((item) => item.status === 'mixed').length,
      insufficient: candidates.filter((item) => item.status === 'insufficient').length,
    },
    candidates,
  };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (isMain) {
  const args = argumentsFrom(process.argv.slice(2));
  if (!args.input) {
    usage();
    process.exit(2);
  }
  const report = rankPilot(JSON.parse(readFileSync(args.input, 'utf8')), args.minSamples);
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (args.output) writeFileSync(args.output, serialized);
  else process.stdout.write(serialized);
}
