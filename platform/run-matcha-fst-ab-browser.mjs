import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {launch} from './cdp/cdp-client.mjs';

const host = process.env.WASM_TTS_BENCH_HOST ?? '127.0.0.1';
const serverPort = Number(process.env.WASM_TTS_BENCH_PORT ?? 8765);
const baseCdpPort = Number(process.env.WASM_TTS_CDP_PORT ?? 9393);
const url = `http://${host}:${serverPort}/platform/matcha-upstream-benchmark.html`;
const platformRoot = path.dirname(fileURLToPath(import.meta.url));
const resultPath = path.join(
  platformRoot,
  'results',
  'results-matcha_icefall_zh_en-fst-ab-browser-wasm.json',
);

const corpora = {
  novel: '清晨的阳光穿过窗帘。轻轻落在安静的房间里。远处传来清脆的鸟鸣。微风带着花草的清香。让崭新的一天显得格外明亮。',
  canonicalStructured: '第十二章开始于二零二六年八月七日十四点三十分。请拨打一一零或者一八九二零二六零八零七。她说：“我们还有百分之二十五点五的路没走完。”巷口堆着一袋垃圾。',
  rawStructured: '第12章开始于2026年8月7日14:30。请拨打110或者18920260807。她说：“我们还有25.5%的路没走完。”巷口堆着一袋垃圾。',
};

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function metric(metrics, name) {
  return metrics.metrics.find((entry) => entry.name === name)?.value ?? 0;
}

async function waitFor(evalJs, expression, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (!(await evalJs(expression))) {
    if (Date.now() > deadline) throw new Error(`等待逾時：${label}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function memorySnapshot(evalJs) {
  return evalJs(`({
    wasmHeapBytes: globalThis.Module?.HEAPU8?.buffer?.byteLength ?? null,
    userAgentSpecificMemory: null,
  })`);
}

async function runVariant({name, fst, cdpPort}) {
  const profile = path.join(os.tmpdir(), `wasmtts-matcha-${name}-cdp-${process.pid}`);
  const removeProfile = () => fs.rmSync(profile, {
    recursive: true,
    force: true,
    maxRetries: 8,
    retryDelay: 250,
  });
  let browser;
  removeProfile();
  try {
    console.log(`[${name}] 啟動瀏覽器`);
    browser = await launch({port: cdpPort, profile});
    const {send, evalJs, sessionId} = browser;
    const navigationStarted = performance.now();
    console.log(`[${name}] 載入 benchmark harness`);
    await send('Page.navigate', {url: `${url}?fst=${fst ? 1 : 0}`}, sessionId);
    await waitFor(
      evalJs,
      'Boolean(globalThis.matchaUpstreamBench)',
      30000,
      `${name} benchmark harness`,
    );
    console.log(`[${name}] 初始化 Matcha`);
    const configuration = await evalJs(
      `globalThis.matchaUpstreamBench.init({fst: ${fst}})`,
    );
    console.log(`[${name}] 初始化完成`);
    const initializationWallMs = performance.now() - navigationStarted;
    const memoryAfterInitialization = await memorySnapshot(evalJs);
    await send('Performance.enable', {}, sessionId);

    const results = {};
    for (const [corpusName, text] of Object.entries(corpora)) {
      try {
        console.log(`[${name}/${corpusName}] 暖機`);
        await evalJs(`globalThis.matchaUpstreamBench.run(${JSON.stringify(text)}, false)`);
        const runs = [];
        for (let index = 0; index < 3; index += 1) {
          const before = await send('Performance.getMetrics', {}, sessionId);
          const result = await evalJs(
            `globalThis.matchaUpstreamBench.run(${JSON.stringify(text)}, false)`,
          );
          const after = await send('Performance.getMetrics', {}, sessionId);
          const taskMs = (metric(after, 'TaskDuration') - metric(before, 'TaskDuration')) * 1000;
          const run = {
            index: index + 1,
            ...result,
            taskMs,
            taskRtf: taskMs / 1000 / result.audioSeconds,
            wallRtf: result.wallMs / 1000 / result.audioSeconds,
          };
          if (
            run.waveform.finiteSamples !== run.waveform.samples
            || run.waveform.peak === 0
            || run.waveform.rms === 0
          ) {
            throw new Error(`${name}/${corpusName} run ${index + 1} waveform 無效`);
          }
          runs.push(run);
          console.log(JSON.stringify({variant: name, corpus: corpusName, ...run}));
        }
        results[corpusName] = {
          text,
          warmups: 1,
          runs,
          summary: {
            medianTaskRtf: median(runs.map((run) => run.taskRtf)),
            medianWallRtf: median(runs.map((run) => run.wallRtf)),
            medianTaskRealtimeMultiplier: 1 / median(runs.map((run) => run.taskRtf)),
            medianWallRealtimeMultiplier: 1 / median(runs.map((run) => run.wallRtf)),
            medianAudioSeconds: median(runs.map((run) => run.audioSeconds)),
          },
        };
      } catch (error) {
        results[corpusName] = {text, error: error.message};
      }
    }

    return {
      name,
      configuration,
      initializationWallMs,
      memoryAfterInitialization,
      corpora: results,
      memoryAfterBenchmark: await memorySnapshot(evalJs),
    };
  } finally {
    try {
      await browser?.close();
    } finally {
      removeProfile();
    }
  }
}

const response = await fetch(url);
if (!response.ok) throw new Error(`benchmark host returned HTTP ${response.status}`);

const withFst = await runVariant({name: 'recommended-fst', fst: true, cdpPort: baseCdpPort});
const withoutFst = await runVariant({name: 'no-fst-control', fst: false, cdpPort: baseCdpPort + 1});
const novelWith = withFst.corpora.novel.summary;
const novelWithout = withoutFst.corpora.novel.summary;
const report = {
  generatedAt: new Date().toISOString(),
  purpose: '同一 sherpa-onnx browser WASM runtime 的 FST on/off control；只改 ruleFsts',
  fixedConfiguration: {
    sherpaOnnx: '1.12.20',
    model: 'matcha-icefall-zh-en / model-steps-3.onnx',
    vocoder: 'vocos-16khz-univ.onnx',
    lexicon: 'lexicon.txt',
    tokens: 'tokens.txt',
    dataDir: 'espeak-ng-data',
    noiseScale: 0.667,
    lengthScale: 1,
    silenceScale: 0.2,
    numThreads: 1,
    maxNumSentences: 1,
  },
  variants: {withFst, withoutFst},
  comparison: {
    novelMedianTaskRtfDeltaPercent:
      (novelWith.medianTaskRtf / novelWithout.medianTaskRtf - 1) * 100,
    novelMedianWallRtfDeltaPercent:
      (novelWith.medianWallRtf / novelWithout.medianWallRtf - 1) * 100,
    initializationMemoryDeltaBytes:
      Number.isFinite(withFst.memoryAfterInitialization.userAgentSpecificMemory)
        && Number.isFinite(withoutFst.memoryAfterInitialization.userAgentSpecificMemory)
        ? withFst.memoryAfterInitialization.userAgentSpecificMemory
          - withoutFst.memoryAfterInitialization.userAgentSpecificMemory
        : null,
    wasmHeapDeltaBytes:
      withFst.memoryAfterInitialization.wasmHeapBytes
      - withoutFst.memoryAfterInitialization.wasmHeapBytes,
  },
};

fs.writeFileSync(resultPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
console.log(`Wrote ${resultPath}`);
