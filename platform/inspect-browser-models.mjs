import { chromium } from 'playwright-core';

const executablePath = `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage();
page.on('pageerror', error => console.error(error));
await page.goto('http://127.0.0.1:8765/platform/kokoro-browser.html');
await page.waitForFunction(() => window.ready === true);
for (const path of [
  '/platform/models/vits-piper-zh_CN-huayan-medium/zh_CN-huayan-medium.onnx',
  '/platform/models/vits-icefall-zh-aishell3/model.onnx',
  '/platform/models/vits-melo-tts-zh_en/model.onnx',
]) {
  console.log(path, JSON.stringify(await page.evaluate(path => window.bench.inspectModel(path), path), null, 2));
}
await browser.close();
