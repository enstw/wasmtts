import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {launch} from './cdp/cdp-client.mjs';
import {GOLDEN} from './test-matcha-fst.mjs';

const host = process.env.WASM_TTS_BENCH_HOST ?? '127.0.0.1';
const port = Number(process.env.WASM_TTS_BENCH_PORT ?? 8765);
const cdpPort = Number(process.env.WASM_TTS_CDP_PORT ?? 9391);
const profile = path.join(os.tmpdir(), `wasmtts-kaldifst-test-${process.pid}`);
const url = `http://${host}:${port}/platform/matcha-browser.html`;
let browser;

try {
  browser = await launch({port: cdpPort, profile});
  await browser.send('Page.navigate', {url}, browser.sessionId);
  await new Promise((resolve) => setTimeout(resolve, 800));
  const result = await browser.evalJs(`(async () => {
    const load = (src) => new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.onload = resolve;
      script.onerror = () => reject(new Error('unable to load ' + src));
      document.head.append(script);
    });
    await load('/mobile-host/vendor/kaldifst/matcha-kaldifst-normalizer.js');
    await load('/platform/kaldifst-normalizer.js');
    const buffers = await Promise.all(['phone', 'date', 'number'].map(async (name) => {
      const response = await fetch('/platform/models/matcha-icefall-zh-en/' + name + '-zh.fst');
      if (!response.ok) throw new Error(name + ' FST HTTP ' + response.status);
      return response.arrayBuffer();
    }));
    const normalize = await MatchaKaldifst.createNormalizer({
      moduleFactory: KaldifstNormalizerModule,
      wasmUrl: '/mobile-host/vendor/kaldifst/matcha-kaldifst-normalizer.wasm',
      fstBuffers: buffers,
    });
    const cases = ${JSON.stringify(GOLDEN)};
    const drift = cases.flatMap(([input, want]) => {
      const got = normalize(input);
      return got === want ? [] : [{input, want, got}];
    });
    const memoryBytes = normalize.runtime.HEAPU8.buffer.byteLength;
    normalize.dispose();
    return {cases: cases.length, drift, memoryBytes};
  })()`);
  console.log(JSON.stringify(result, null, 2));
  if (result.drift.length) process.exitCode = 1;
} finally {
  await browser?.close();
  fs.rmSync(profile, {recursive: true, force: true});
}
