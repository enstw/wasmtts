import { chromium } from 'playwright-core';
import fs from 'node:fs';

const name = process.argv[2];
const iterations = Number(process.argv[3] ?? 50);
if (!name) throw new Error('usage: node benchmarks/run-ort-operator-probe.mjs OP [ITERATIONS]');
const executablePath = `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage();
page.on('pageerror', error => console.error('pageerror:', error));
await page.goto('http://127.0.0.1:8765/benchmarks/ort-operator-probe.html');
await page.waitForFunction(() => window.ready === true);
await page.evaluate(name => window.probe.init(name), name);
const cdp = await page.context().newCDPSession(page);
await cdp.send('Profiler.enable');
await cdp.send('Profiler.setSamplingInterval', { interval: 100 });
await cdp.send('Profiler.start');
const wallMs = await page.evaluate(iterations => window.probe.run(iterations), iterations);
const { profile } = await cdp.send('Profiler.stop');
const nodes = new Map(profile.nodes.map(node => [node.id, node]));
const totals = new Map();
for (let i = 0; i < profile.samples.length; ++i) {
  const frame = nodes.get(profile.samples[i])?.callFrame ?? {};
  const functionName = frame.functionName || '(anonymous)';
  const key = `${functionName}\n${frame.url || ''}`;
  totals.set(key, (totals.get(key) ?? 0) + (profile.timeDeltas[i] ?? 0) / 1000);
}
const functions = [...totals].map(([key, selfMs]) => {
  const [functionName, url] = key.split('\n');
  return { function: functionName, selfMs, url };
}).sort((a, b) => b.selfMs - a.selfMs);
const result = { name, iterations, wallMs, functions: functions.slice(0, 15) };
fs.mkdirSync(new URL('./results/operator-probes/', import.meta.url), { recursive: true });
fs.writeFileSync(new URL(`./results/operator-probes/${name}.json`, import.meta.url), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
await browser.close();
