import { chromium } from 'playwright-core';
import fs from 'node:fs';

const executablePath = `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const dtype = process.argv[2] || 'fp32';
const browser = await chromium.launch({ executablePath, headless: true });
const browserVersion = browser.version();
const page = await browser.newPage();
page.on('console', message => console.log('browser:', message.text()));
page.on('pageerror', error => console.error('pageerror:', error));
await page.goto('http://127.0.0.1:8765/benchmarks/kokoro-browser.html');
await page.waitForFunction(() => window.ready === true);
const initMs = await page.evaluate(dtype => window.bench.init(false, dtype), dtype);
const cdp = await page.context().newCDPSession(page);
await cdp.send('Performance.enable');
const runs = [];
for (let i = 0; i < 3; ++i) {
  const before = await cdp.send('Performance.getMetrics');
  const result = await page.evaluate(() => window.bench.run());
  if (result.finite !== result.samples || result.peak === 0 || result.rms === 0) throw new Error(`Invalid ${dtype} audio output: ${JSON.stringify(result)}`);
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
    numThreads: 1,
    measurement: 'Chromium CDP Performance.TaskDuration',
  },
  model: `onnx-community/Kokoro-82M-v1.1-zh-ONNX (${dtype})`,
  speaker: 'sid 45 (zf_078)',
  initMs,
  runs,
  medianTaskMsPer10s,
  piperHuaYanBaselineCpuMsPer10s,
  relativeToPiperHuaYan: medianTaskMsPer10s / piperHuaYanBaselineCpuMsPer10s,
};
fs.writeFileSync(new URL(`./results/results-kokoro_v1_1_zh_${dtype}-browser-wasm.json`, import.meta.url), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
await browser.close();
