#!/usr/bin/env node

// Matcha 小說文字前端稽核器。小說是外部輸入；報告只保存聚合統計與少量短上下文。

import {createReadStream, readFileSync, writeFileSync} from 'node:fs';
import {extname, resolve} from 'node:path';
import {createInterface} from 'node:readline';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

import './matcha-fst.js';
import './matcha-frontend.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const modelRoot = resolve(root, 'platform/models/matcha-icefall-zh-en');
const DEFAULT_OUTPUT = resolve(root, 'platform/results/matcha-g2p-audit.local.json');
const SEPARATOR_LINE = /^[\s　]*[-－—–―─]{2,}[\s　]*$/u;
const MAX_EXAMPLES = 3;
const MAX_CONTEXT_LENGTH = 80;

function usage() {
  console.error('用法：node platform/audit-matcha-g2p.mjs <novel.zip|novel.txt> [--review <review.json>] [--output <report.json>]');
}

function parseArguments(argv) {
  if (argv[0] === '--') argv = argv.slice(1);
  const input = argv[0];
  let output = DEFAULT_OUTPUT;
  let review = null;
  for (let index = 1; index < argv.length; index += 1) {
    if (argv[index] === '--output' && argv[index + 1]) {
      output = resolve(argv[++index]);
    } else if (argv[index] === '--review' && argv[index + 1]) {
      review = resolve(argv[++index]);
    } else {
      throw new Error(`不支援的參數：${argv[index]}`);
    }
  }
  if (!input) return null;
  return {input: resolve(input), output, review};
}

function sourceFor(input) {
  if (extname(input).toLowerCase() !== '.zip') {
    return {stream: createReadStream(input), completion: null};
  }
  const child = spawn('unzip', ['-p', input], {stdio: ['ignore', 'pipe', 'inherit']});
  const completion = new Promise((resolveExit) => child.once('close', resolveExit));
  return {stream: child.stdout, completion};
}

function shortContext(line) {
  const compact = line.trim().replace(/\s+/gu, ' ');
  return [...compact].slice(0, MAX_CONTEXT_LENGTH).join('');
}

function addAggregate(map, key, detail, lineNumber, line) {
  let entry = map.get(key);
  if (!entry) {
    entry = {...detail, count: 0, examples: []};
    map.set(key, entry);
  }
  entry.count += 1;
  const context = shortContext(line);
  if (entry.examples.length < MAX_EXAMPLES
      && !entry.examples.some((example) => example.line === lineNumber && example.context === context)) {
    entry.examples.push({line: lineNumber, context});
  }
}

function sortedValues(map) {
  return [...map.values()].sort((left, right) => right.count - left.count
    || String(left.word ?? left.character).localeCompare(String(right.word ?? right.character), 'zh-Hant'));
}

const args = parseArguments(process.argv.slice(2));
if (!args) {
  usage();
  process.exit(2);
}

const lexiconText = readFileSync(resolve(modelRoot, 'lexicon.txt'), 'utf8');
const tokensText = readFileSync(resolve(modelRoot, 'tokens.txt'), 'utf8');
const review = args.review ? JSON.parse(readFileSync(args.review, 'utf8')) : null;
const pronunciationOverrides = globalThis.MatchaFrontend.pronunciationOverridesFromReview(review);
const contextualRules = globalThis.MatchaFrontend.contextualRulesFromReview(review);
const normalize = globalThis.MatchaFst.createNormalizer(
  ['phone', 'date', 'number'].map((name) =>
    readFileSync(resolve(modelRoot, `${name}-zh.fst`))),
);
const frontend = globalThis.MatchaFrontend.createFrontend({
  lexiconText,
  tokensText,
  ruleNormalizer: normalize,
  pronunciationOverrides,
  contextualRules,
});

const unknown = new Map();
const singleCharacterFallbacks = new Map();
const lexiconMatches = new Map();
const stats = {
  lines: 0,
  nonEmptyLines: 0,
  normalizedEmptyLines: 0,
  layoutSeparators: 0,
  tokenCount: 0,
  unknownOccurrences: 0,
  singleCharacterFallbackOccurrences: 0,
  contextualMatchOccurrences: 0,
};

const source = sourceFor(args.input);
const lines = createInterface({input: source.stream, crlfDelay: Infinity});
for await (const line of lines) {
  stats.lines += 1;
  if (!line.trim()) continue;
  stats.nonEmptyLines += 1;
  if (SEPARATOR_LINE.test(line)) stats.layoutSeparators += 1;

  const trace = frontend.tokensFor(line, {allowUnknown: true});
  if (!trace.normalizedText) stats.normalizedEmptyLines += 1;
  stats.tokenCount += trace.ids.length;
  stats.unknownOccurrences += trace.unknown.length;
  stats.singleCharacterFallbackOccurrences += trace.singleCharacterFallbacks.length;
  stats.contextualMatchOccurrences += trace.contextualMatches.length;

  for (const item of trace.unknown) {
    const label = item.word ?? item.character;
    addAggregate(unknown, `${label}\u0000${(item.missingPhones ?? []).join(' ')}`, {
      character: item.character,
      word: item.word,
      missingPhones: item.missingPhones,
    }, stats.lines, line);
  }
  for (const item of trace.singleCharacterFallbacks) {
    addAggregate(singleCharacterFallbacks, `${item.word}\u0000${item.phones.join(' ')}`, {
      word: item.word,
      phones: item.phones,
    }, stats.lines, line);
  }
  for (const item of trace.lexiconMatches) {
    addAggregate(lexiconMatches, `${item.word}\u0000${item.phones.join(' ')}`, {
      word: item.word,
      phones: item.phones,
    }, stats.lines, line);
  }
}

if (source.completion) {
  const exitCode = await source.completion;
  if (exitCode !== 0) throw new Error(`unzip 結束碼：${exitCode}`);
}

const report = {
  schemaVersion: 1,
  input: {type: extname(args.input).toLowerCase() === '.zip' ? 'zip' : 'text'},
  frontend: {
    normalization: ['layout-separator', 'phone-zh.fst', 'date-zh.fst', 'number-zh.fst'],
    g2p: 'matcha-icefall-zh-en lexicon longest-match',
    reviewProfile: args.review ? {
      path: args.review,
      phraseOverrides: pronunciationOverrides,
    } : null,
    lexiconSize: frontend.lexiconSize,
    tokenInventorySize: frontend.tokenCount,
  },
  stats,
  unknown: sortedValues(unknown),
  singleCharacterFallbacks: sortedValues(singleCharacterFallbacks),
  lexiconMatches: sortedValues(lexiconMatches),
};

writeFileSync(args.output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({output: args.output, ...stats, uniqueUnknown: unknown.size,
  uniqueSingleCharacterFallbacks: singleCharacterFallbacks.size}, null, 2));
