#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {launch} from './cdp/cdp-client.mjs';

const host = process.env.WASM_TTS_BENCH_HOST ?? '127.0.0.1';
const serverPort = Number(process.env.WASM_TTS_BENCH_PORT ?? 8765);
const cdpPort = Number(process.env.WASM_TTS_CDP_PORT ?? 9391);
const fixture = process.env.G2PW_WEBGPU_FIXTURE ?? '/platform/results/g2pw-webgpu-fixture.local.json';
const iterations = Number(process.env.G2PW_WEBGPU_ITERATIONS ?? 5);
const url = `http://${host}:${serverPort}/platform/g2pw-webgpu-benchmark.html`;
const profile = path.join(os.tmpdir(), `wasmtts-g2pw-webgpu-${process.pid}`);
const output = new URL('./results/g2pw-webgpu-benchmark.local.json', import.meta.url);

let browser;
fs.rmSync(profile, {recursive: true, force: true});
try {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`benchmark host returned HTTP ${response.status}`);
  browser = await launch({
    port: cdpPort,
    profile,
    gpu: true,
    args: ['--enable-gpu', '--enable-unsafe-webgpu', '--use-angle=metal'],
  });
  const {send, evalJs, sessionId} = browser;
  await send('Page.navigate', {url}, sessionId);
  const deadline = Date.now() + 30000;
  while (!(await evalJs('window.ready === true'))) {
    if (Date.now() > deadline) throw new Error('WebGPU benchmark page did not become ready');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const result = await evalJs(`window.g2pwWebgpuBench.run(${JSON.stringify({fixtureUrl: fixture, iterations})})`);
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    environment: {platform: process.platform, architecture: process.arch, osRelease: os.release(), node: process.version},
    ...result,
  };
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  if (report.predictionMismatches.length) process.exitCode = 1;
} finally {
  try { await browser?.close(); } finally { fs.rmSync(profile, {recursive: true, force: true}); }
}
