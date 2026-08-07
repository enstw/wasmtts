import fs from 'node:fs';
import { chromium } from 'playwright-core';

const executablePath = `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage();
page.on('pageerror', error => console.error(error));
await page.goto('http://127.0.0.1:8765/platform/kokoro-browser.html');
await page.waitForFunction(() => window.ready === true);
await page.evaluate(() => window.bench.init(true, 'fp32'));
const { samples, sampleRate, finite, peak, rms } = await page.evaluate(() => window.bench.capture());
await browser.close();

if (finite !== samples.length || peak === 0 || rms === 0) {
  throw new Error(`Invalid audio: finite=${finite}/${samples.length}, peak=${peak}, rms=${rms}`);
}

const pcm = Buffer.alloc(samples.length * 2);
for (let i = 0; i < samples.length; ++i) {
  const value = Math.max(-1, Math.min(1, samples[i]));
  pcm.writeInt16LE(Math.round(value < 0 ? value * 32768 : value * 32767), i * 2);
}
const header = Buffer.alloc(44);
header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8);
header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
header.writeUInt16LE(1, 22); header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28);
header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
const output = new URL('./results/kokoro_v1_1_zh_fp32_sid45.wav', import.meta.url);
fs.writeFileSync(output, Buffer.concat([header, pcm]));
console.log(JSON.stringify({ output: output.pathname, sampleRate, samples: samples.length, audioSeconds: samples.length / sampleRate, peak, rms }, null, 2));
