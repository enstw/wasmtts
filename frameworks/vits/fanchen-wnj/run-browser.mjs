import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {launch} from '../../../platform/cdp/cdp-client.mjs';

const host = process.env.WASM_TTS_BENCH_HOST ?? '127.0.0.1';
const serverPort = Number(process.env.WASM_TTS_BENCH_PORT ?? 8765);
const cdpPort = Number(process.env.WASM_TTS_CDP_PORT ?? 9397);
const url = `http://${host}:${serverPort}/frameworks/vits/fanchen-wnj/browser.html`;
const profile = path.join(os.tmpdir(), `wasmtts-fanchen-vits-wnj-cdp-${process.pid}`);
const modelRoot = new URL('../../../platform/models/fanchen-vits-wnj/', import.meta.url);
const resultPath = new URL('../../../platform/results/results-fanchen_vits_wnj-browser-wasm.json', import.meta.url);
const wavPath = new URL('../../../platform/results/fanchen_vits_wnj-browser-wasm.wav', import.meta.url);
const artifactNames = ['model.onnx', 'lexicon.txt', 'tokens.txt'];

function metric(metrics, name) {
  return metrics.metrics.find((entry) => entry.name === name)?.value ?? 0;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function sha256(file) {
  for (const [command, args] of [
    ['shasum', ['-a', '256', file]],
    ['sha256sum', [file]],
  ]) {
    const result = spawnSync(command, args, {encoding: 'utf8'});
    if (result.status === 0) return result.stdout.trim().split(/\s+/u)[0];
    if (result.error?.code !== 'ENOENT') {
      throw new Error(`${command} 失敗：${result.stderr.trim()}`);
    }
  }
  throw new Error('找不到 shasum 或 sha256sum，無法驗證模型資產');
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
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]));
    buffer.writeInt16LE(
      Math.round(sample < 0 ? sample * 32768 : sample * 32767),
      44 + index * 2,
    );
  }
  return buffer;
}

async function waitFor(evalJs, expression, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (!(await evalJs(expression))) {
    if (Date.now() > deadline) throw new Error(`等待逾時：${label}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function memorySnapshot(evalJs) {
  return evalJs(`(async () => {
    const result = {
      supported: typeof performance.measureUserAgentSpecificMemory === 'function',
      bytes: null,
      error: null,
    };
    if (!result.supported) return result;
    try {
      result.bytes = (await performance.measureUserAgentSpecificMemory()).bytes;
    } catch (error) {
      result.error = error?.message ?? String(error);
    }
    return result;
  })()`);
}

const artifacts = Object.fromEntries(artifactNames.map((name) => {
  const file = fileURLToPath(new URL(name, modelRoot));
  return [name, {bytes: fs.statSync(file).size, sha256: sha256(file)}];
}));

let browser;
const removeProfile = () => fs.rmSync(profile, {
  recursive: true,
  force: true,
  maxRetries: 8,
  retryDelay: 250,
});

removeProfile();
try {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`benchmark host returned HTTP ${response.status}`);

  browser = await launch({
    port: cdpPort,
    profile,
    args: ['--enable-precise-memory-info'],
  });
  const {send, evalJs, sessionId} = browser;
  await send('Page.navigate', {url}, sessionId);
  await waitFor(evalJs, 'window.ready === true', 30000, 'Fanchen WNJ benchmark page');

  const version = await send('Browser.getVersion');
  const environment = await evalJs(`({
    userAgent: navigator.userAgent,
    crossOriginIsolated,
    sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
  })`);
  const metadata = await evalJs('window.benchmarkMetadata');
  const initializationStarted = performance.now();
  const initialization = await evalJs('window.bench.init()');
  const initializationWallMs = performance.now() - initializationStarted;
  const memoryAfterInitialization = await memorySnapshot(evalJs);

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
    if (
      run.waveform.finiteSamples !== run.waveform.samples
      || run.waveform.peak === 0
      || run.waveform.rms === 0
    ) {
      throw new Error(`run ${index + 1} waveform 無效：${JSON.stringify(run.waveform)}`);
    }
    runs.push(run);
    console.log(JSON.stringify(run));
  }

  const capture = await evalJs('window.bench.run(true)');
  const samples = capture.samples;
  delete capture.samples;
  if (
    capture.waveform.finiteSamples !== samples.length
    || capture.waveform.peak === 0
    || capture.waveform.rms === 0
  ) {
    throw new Error(`captured waveform 無效：${JSON.stringify(capture.waveform)}`);
  }
  const memoryAfterBenchmark = await memorySnapshot(evalJs);

  const report = {
    generatedAt: new Date().toISOString(),
    environment: {
      browser: version.product,
      browserBinary: browser.bin,
      userAgent: environment.userAgent,
      hostPlatform: process.platform,
      hostArchitecture: process.arch,
      osRelease: os.release(),
      node: process.version,
      runtime: metadata.runtime,
      executionProvider: 'wasm',
      requestedThreads: metadata.numThreads,
      crossOriginIsolated: environment.crossOriginIsolated,
      sharedArrayBuffer: environment.sharedArrayBuffer,
      measurement: 'Chromium CDP Performance.TaskDuration',
    },
    model: {
      name: 'k2-fsa/sherpa-onnx vits-zh-hf-fanchen-wnj',
      releaseTag: 'tts-models',
      archiveSha256: metadata.archiveSha256,
      architecture: 'VITS-fast-fine-tuning full waveform graph',
      sampleRate: metadata.sampleRate,
      speakers: 1,
      speakerId: metadata.speakerId,
      noiseScale: metadata.noiseScale,
      lengthScale: metadata.lengthScale,
      noiseScaleW: metadata.noiseScaleW,
      artifacts,
      totalArtifactBytes: Object.values(artifacts)
        .reduce((sum, artifact) => sum + artifact.bytes, 0),
    },
    text: metadata.text,
    sentences: metadata.sentences,
    frontend: metadata.frontend,
    protocol: {
      warmups: 1,
      measuredRuns: 3,
      sentenceBatchSize: 1,
      waveformValidation: 'all samples finite, peak > 0, RMS > 0',
    },
    initialization: {...initialization, initializationWallMs},
    memory: {afterInitialization: memoryAfterInitialization, afterBenchmark: memoryAfterBenchmark},
    runs,
    summary: {
      medianTaskMsPer10s: median(runs.map((run) => run.taskMsPer10s)),
      medianTaskRtf: median(runs.map((run) => run.taskRtf)),
      medianWallRtf: median(runs.map((run) => run.wallRtf)),
      medianTaskRealtimeMultiplier: 1 / median(runs.map((run) => run.taskRtf)),
      medianWallRealtimeMultiplier: 1 / median(runs.map((run) => run.wallRtf)),
      medianAudioSeconds: median(runs.map((run) => run.audioSeconds)),
      medianModelMs: median(runs.map((run) => run.phases.modelMs)),
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
    removeProfile();
  }
}
