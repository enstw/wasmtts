import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {launch} from './cdp/cdp-client.mjs';

const host = process.env.WASM_TTS_BENCH_HOST ?? '127.0.0.1';
const serverPort = Number(process.env.WASM_TTS_BENCH_PORT ?? 8765);
const cdpPort = Number(process.env.WASM_TTS_CDP_PORT ?? 9388);
const url = `http://${host}:${serverPort}/platform/matcha-browser.html`;
const profile = path.join(os.tmpdir(), `wasmtts-matcha-cdp-${process.pid}`);
const resultPath = new URL('./results/results-matcha_icefall_zh_en-browser-wasm.json', import.meta.url);
const wavPath = new URL('./results/matcha_icefall_zh_en-browser-wasm.wav', import.meta.url);
const acousticModelPath = new URL('./models/matcha-icefall-zh-en/model-steps-3.onnx', import.meta.url);
const vocoderPath = new URL('./models/vocos-16khz-univ.onnx', import.meta.url);

function metric(metrics, name) {
  return metrics.metrics.find((entry) => entry.name === name)?.value ?? 0;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function encodeWav(samples, sampleRate) {
  const pcmBytes = samples.length * 2;
  const buffer = Buffer.alloc(44 + pcmBytes);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + pcmBytes, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(pcmBytes, 40);
  for (let i = 0; i < samples.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, samples[i]));
    buffer.writeInt16LE(Math.round(sample < 0 ? sample * 32768 : sample * 32767), 44 + i * 2);
  }
  return buffer;
}

let browser;
fs.rmSync(profile, {recursive: true, force: true});
try {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`benchmark host returned HTTP ${response.status}`);

  browser = await launch({port: cdpPort, profile});
  const {send, evalJs, sessionId} = browser;
  await send('Page.navigate', {url}, sessionId);

  const deadline = Date.now() + 30000;
  while (!(await evalJs('window.ready === true'))) {
    if (Date.now() > deadline) throw new Error('benchmark page did not become ready');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const version = await send('Browser.getVersion');
  const userAgent = await evalJs('navigator.userAgent');
  const runtime = await evalJs('({crossOriginIsolated, sharedArrayBuffer: typeof SharedArrayBuffer !== "undefined"})');
  const metadata = await evalJs('window.benchmarkMetadata');
  const init = await evalJs('window.bench.init()');
  await send('Performance.enable', {}, sessionId);

  const runs = [];
  for (let index = 0; index < 3; index += 1) {
    const before = await send('Performance.getMetrics', {}, sessionId);
    const result = await evalJs('window.bench.run(false)');
    const after = await send('Performance.getMetrics', {}, sessionId);
    const taskMs = (metric(after, 'TaskDuration') - metric(before, 'TaskDuration')) * 1000;
    const run = {
      index: index + 1,
      ...result,
      taskMs,
      taskMsPer10s: taskMs * 10 / result.audioSeconds,
      taskRtf: taskMs / 1000 / result.audioSeconds,
      wallRtf: result.wallMs / 1000 / result.audioSeconds,
    };
    if (run.waveform.finiteSamples !== run.waveform.samples || run.waveform.peak === 0) {
      throw new Error(`invalid waveform in run ${index + 1}: ${JSON.stringify(run.waveform)}`);
    }
    runs.push(run);
    console.log(JSON.stringify(run));
  }

  const capture = await evalJs('window.bench.run(true)');
  const samples = capture.samples;
  delete capture.samples;
  if (capture.waveform.finiteSamples !== samples.length || capture.waveform.peak === 0) {
    throw new Error(`invalid captured waveform: ${JSON.stringify(capture.waveform)}`);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    environment: {
      browser: version.product,
      browserBinary: browser.bin,
      userAgent,
      hostPlatform: process.platform,
      hostArchitecture: process.arch,
      osRelease: os.release(),
      node: process.version,
      runtime: metadata.runtime,
      executionProvider: 'wasm',
      requestedThreads: metadata.numThreads,
      ...runtime,
      measurement: 'Chromium CDP Performance.TaskDuration',
    },
    model: {
      name: 'matcha-icefall-zh-en',
      acousticModel: 'model-steps-3.onnx',
      vocoder: 'vocos-16khz-univ.onnx',
      acousticModelBytes: fs.statSync(acousticModelPath).size,
      vocoderBytes: fs.statSync(vocoderPath).size,
      totalModelBytes: fs.statSync(acousticModelPath).size + fs.statSync(vocoderPath).size,
      noiseScale: metadata.noiseScale,
      lengthScale: metadata.lengthScale,
      silenceScale: metadata.silenceScale,
    },
    text: metadata.text,
    sentenceIds: metadata.sentenceIds,
    frontend: metadata.frontend,
    protocol: {
      warmups: 1,
      measuredRuns: 3,
      sentenceBatchSize: 1,
      waveformValidation: 'all samples finite, peak > 0, RMS recorded',
    },
    initialization: init,
    runs,
    summary: {
      medianTaskMsPer10s: median(runs.map((run) => run.taskMsPer10s)),
      medianTaskRtf: median(runs.map((run) => run.taskRtf)),
      medianWallRtf: median(runs.map((run) => run.wallRtf)),
      medianTaskRealtimeMultiplier: 1 / median(runs.map((run) => run.taskRtf)),
      medianWallRealtimeMultiplier: 1 / median(runs.map((run) => run.wallRtf)),
      medianAudioSeconds: median(runs.map((run) => run.audioSeconds)),
      medianPhasesMs: {
        acoustic: median(runs.map((run) => run.phases.acousticMs)),
        vocoder: median(runs.map((run) => run.phases.vocoderMs)),
        istft: median(runs.map((run) => run.phases.istftMs)),
        silence: median(runs.map((run) => run.phases.silenceMs)),
      },
      capture,
    },
  };

  fs.writeFileSync(resultPath, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(wavPath, encodeWav(samples, capture.sampleRate));
  console.log(JSON.stringify(report, null, 2));
  console.log(`Wrote ${resultPath.pathname}`);
  console.log(`Wrote ${wavPath.pathname}`);
} finally {
  try {
    await browser?.close();
  } finally {
    fs.rmSync(profile, {recursive: true, force: true});
  }
}
