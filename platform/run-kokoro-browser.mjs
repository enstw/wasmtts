import { chromium } from 'playwright-core';
import fs from 'node:fs';

const executablePath = `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const dtype = process.argv[2] || 'fp32';
const profile = process.argv.includes('--profile');
const modelPathIndex = process.argv.indexOf('--model-path');
const modelPath = modelPathIndex === -1 ? null : process.argv[modelPathIndex + 1];
const allowInvalid = process.argv.includes('--allow-invalid');
const shapeProbe = process.argv.includes('--shape-probe');
const textIndex = process.argv.indexOf('--text');
const textOverride = textIndex === -1 ? null : process.argv[textIndex + 1];
const outputSuffixIndex = process.argv.indexOf('--output-suffix');
const threadsIndex = process.argv.indexOf('--threads');
const numThreads = threadsIndex === -1 ? 1 : Number(process.argv[threadsIndex + 1]);
if (!Number.isInteger(numThreads) || numThreads < 1) throw new Error(`Invalid --threads value: ${numThreads}`);
const explicitSuffix = outputSuffixIndex === -1 ? '' : `-${process.argv[outputSuffixIndex + 1]}`;
const outputSuffix = `${explicitSuffix}${numThreads === 1 ? '' : `-${numThreads}threads`}`;
const browser = await chromium.launch({ executablePath, headless: true });
const browserVersion = browser.version();
const page = await browser.newPage();
page.on('console', message => console.log('browser:', message.text()));
page.on('pageerror', error => console.error('pageerror:', error));
page.on('requestfailed', request => console.error('requestfailed:', request.url(), request.failure()?.errorText));
page.on('response', response => {
  if (!response.ok()) console.error('response:', response.status(), response.url());
});
await page.goto('http://127.0.0.1:8765/platform/kokoro-browser.html');
await page.waitForFunction(() => window.ready === true);
const initMs = await page.evaluate(
  ({ dtype, modelPath, shapeProbe, textOverride, numThreads }) => window.bench.init(shapeProbe, dtype, modelPath, undefined, textOverride ?? undefined, numThreads),
  { dtype, modelPath, shapeProbe, textOverride, numThreads },
);
const runtime = await page.evaluate(() => window.bench.runtime());
if (numThreads > 1 && (!runtime.crossOriginIsolated || !runtime.sharedArrayBuffer)) {
  throw new Error(`WASM threads unavailable: ${JSON.stringify(runtime)}`);
}
if (shapeProbe) {
  const outputs = await page.evaluate(() => window.bench.probeShapes());
  const result = { model: modelPath, initMs, outputs };
  fs.writeFileSync(new URL('./results/kokoro-runtime-shapes.json', import.meta.url), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  await browser.close();
  process.exit(0);
}
const cdp = await page.context().newCDPSession(page);
await cdp.send('Performance.enable');
if (profile) {
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 100 });
}
const runs = [];
for (let i = 0; i < 3; ++i) {
  if (profile && i === 0) await cdp.send('Profiler.start');
  const before = await cdp.send('Performance.getMetrics');
  const result = await page.evaluate(() => window.bench.run());
  if (profile && i === 0) {
    const { profile: cpuProfile } = await cdp.send('Profiler.stop');
    const nodes = new Map(cpuProfile.nodes.map(node => [node.id, node]));
    const selfUs = new Map();
    for (let j = 0; j < cpuProfile.samples.length; ++j) {
      const id = cpuProfile.samples[j];
      const frame = nodes.get(id)?.callFrame ?? {};
      const key = `${frame.functionName || '(anonymous)'}\n${frame.url || ''}\n${(frame.lineNumber ?? -1) + 1}`;
      selfUs.set(key, (selfUs.get(key) ?? 0) + (cpuProfile.timeDeltas[j] ?? 0));
    }
    const functions = [...selfUs].map(([key, us]) => {
      const [functionName, url, line] = key.split('\n');
      return { function: functionName, url, line: Number(line), selfMs: us / 1000 };
    }).sort((a, b) => b.selfMs - a.selfMs);
    fs.writeFileSync(new URL(`./results/profile-kokoro_v1_1_zh_${dtype}-browser-wasm${outputSuffix}.json`, import.meta.url), JSON.stringify({ samplingIntervalUs: 100, functions }, null, 2));
    console.log('Top CPU profile functions:', functions.slice(0, 30));
  }
  if (!allowInvalid && (result.finite !== result.samples || result.peak === 0 || result.rms === 0)) throw new Error(`Invalid ${dtype} audio output: ${JSON.stringify(result)}`);
  const after = await cdp.send('Performance.getMetrics');
  const metric = (x, name) => x.metrics.find(v => v.name === name)?.value ?? 0;
  const taskMs = (metric(after, 'TaskDuration') - metric(before, 'TaskDuration')) * 1000;
  runs.push({ ...result, taskMs, taskMsPer10s: taskMs * 10 / result.audioSeconds });
  console.log(runs.at(-1));
}
const values = runs.map(x => x.taskMsPer10s).sort((a, b) => a - b);
const medianTaskMsPer10s = values[Math.floor(values.length / 2)];
const piperHuaYanBaselineCpuMsPer10s = 1575.7706292656726;
const result = {
  environment: {
    browser: browserVersion,
    runtime: 'Transformers.js 4.2.0 / ONNX Runtime Web 1.26.0-dev.20260416-b7804b056c',
    executionProvider: 'wasm',
    numThreads,
    ...runtime,
    measurement: 'Chromium CDP Performance.TaskDuration',
  },
  model: modelPath ?? `onnx-community/Kokoro-82M-v1.1-zh-ONNX (${dtype})`,
  speaker: 'sid 45 (zf_078)',
  text: textOverride ?? 'default five-sentence benchmark text',
  initMs,
  runs,
  medianTaskMsPer10s,
  piperHuaYanBaselineCpuMsPer10s,
  relativeToPiperHuaYan: medianTaskMsPer10s / piperHuaYanBaselineCpuMsPer10s,
};
fs.writeFileSync(new URL(`./results/results-kokoro_v1_1_zh_${dtype}-browser-wasm${outputSuffix}.json`, import.meta.url), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
await browser.close();
