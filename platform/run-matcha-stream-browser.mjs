import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {launch} from './cdp/cdp-client.mjs';

const host = process.env.WASM_TTS_BENCH_HOST ?? '127.0.0.1';
const serverPort = Number(process.env.WASM_TTS_BENCH_PORT ?? 8765);
const cdpPort = Number(process.env.WASM_TTS_CDP_PORT ?? 9390);
const targetAppendCount = Number(process.env.WASM_TTS_STREAM_APPENDS ?? 10);
const url = `http://${host}:${serverPort}/mobile-host/matcha-stream-test.html`;
const profile = path.join(os.tmpdir(), `wasmtts-matcha-stream-cdp-${process.pid}`);
const resultPath = process.env.WASM_TTS_STREAM_RESULT
  ? new URL(`file://${path.resolve(process.env.WASM_TTS_STREAM_RESULT)}`)
  : new URL('./results/results-matcha_icefall_zh_en-stream-browser-wasm.json', import.meta.url);

function metric(metrics, name) {
  return metrics.metrics.find((entry) => entry.name === name)?.value ?? 0;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

async function waitFor(evalJs, expression, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (!(await evalJs(expression))) {
    if (Date.now() > deadline) throw new Error(`等待逾時：${label}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function measureMemory(evalJs) {
  return evalJs(`(async () => {
    if (typeof performance.measureUserAgentSpecificMemory !== 'function') {
      return {supported: false, error: 'API unavailable'};
    }
    try {
      const result = await performance.measureUserAgentSpecificMemory();
      return {supported: true, bytes: result.bytes, breakdown: result.breakdown};
    } catch (error) {
      return {supported: true, error: error?.message ?? String(error)};
    }
  })()`);
}

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
  if (!response.ok) throw new Error(`mobile host returned HTTP ${response.status}`);

  browser = await launch({port: cdpPort, profile, args: ['--autoplay-policy=no-user-gesture-required']});
  const {send, evalJs, sessionId} = browser;
  await send('Page.navigate', {url}, sessionId);
  await waitFor(evalJs, 'Boolean(globalThis.matchaStreamTest)', 30000, '測試頁載入');
  await evalJs('globalThis.matchaStreamTest.producer.download()');
  await waitFor(evalJs, 'globalThis.matchaStreamTest.producer.downloaded', 180000, '模型下載');
  await evalJs('globalThis.matchaStreamTest.producer.initialize()');
  await waitFor(evalJs, 'Boolean(globalThis.matchaStreamTest?.producer?.initialization)', 180000, '模型初始化與暖機');

  const version = await send('Browser.getVersion');
  const environment = await evalJs(`({
    userAgent: navigator.userAgent,
    crossOriginIsolated,
    sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
    mediaSource: globalThis.ManagedMediaSource ? 'ManagedMediaSource' : globalThis.MediaSource ? 'MediaSource' : 'none',
    mediaSourceSupported: globalThis.matchaStreamTest.player.capability.supported,
  })`);
  const initialization = await evalJs('globalThis.matchaStreamTest.producer.initialization');
  const memoryAfterInit = await measureMemory(evalJs);

  await send('Performance.enable', {}, sessionId);
  const beforeMetrics = await send('Performance.getMetrics', {}, sessionId);
  const wallStarted = performance.now();
  const startResult = await send('Runtime.evaluate', {
    expression: 'globalThis.matchaStreamTest.start({muted: true, pronunciationProfile: "official"})',
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  }, sessionId);
  if (startResult.exceptionDetails) {
    throw new Error(startResult.exceptionDetails.exception?.description ?? startResult.exceptionDetails.text);
  }

  await waitFor(
    evalJs,
    `globalThis.matchaStreamTest.snapshot().appendCount >= ${targetAppendCount}`,
    180000,
    `${targetAppendCount} 個 MP3 append`,
  );
  const wallMs = performance.now() - wallStarted;
  const afterMetrics = await send('Performance.getMetrics', {}, sessionId);
  const mainTargetTaskMs = (metric(afterMetrics, 'TaskDuration') - metric(beforeMetrics, 'TaskDuration')) * 1000;
  const capture = await evalJs(`({
    snapshot: globalThis.matchaStreamTest.snapshot(),
    segments: globalThis.matchaStreamTest.producer.results.slice(0, globalThis.matchaStreamTest.snapshot().appendCount),
    relevantEvents: globalThis.matchaStreamTest.events
      .filter((event) => ['append 完成', 'producer 或 append 失敗', 'buffer underflow／waiting'].includes(event.message))
      .map((event) => ({
        at: event.at,
        visibility: event.visibility,
        message: event.message,
        detail: event.message === 'append 完成'
          ? {
              index: event.detail.index,
              audioSeconds: event.detail.audioSeconds,
              start: event.detail.start,
              end: event.detail.end,
              text: event.detail.meta.text,
            }
          : event.detail,
      })),
  })`);
  const memoryAfterStream = await measureMemory(evalJs);
  await evalJs('globalThis.matchaStreamTest.player.stop()');

  const {snapshot, segments} = capture;
  if (!environment.mediaSourceSupported) throw new Error('瀏覽器不支援 audio/mpeg MediaSource');
  if (segments.length < targetAppendCount) throw new Error(`只有 ${segments.length} 個有效 segment`);
  for (const [index, segment] of segments.entries()) {
    if (
      segment.waveform.finiteSamples !== segment.waveform.samples
      || segment.waveform.peak === 0
      || segment.waveform.rms === 0
      || segment.mp3Bytes === 0
    ) {
      throw new Error(`segment ${index + 1} 無效：${JSON.stringify(segment)}`);
    }
    if (/^[」』”’）》】]+$/u.test(segment.text)) {
      throw new Error(`segment ${index + 1} 只有結尾引號：${segment.text}`);
    }
  }
  if (!(snapshot.rtf > 0 && snapshot.rtf < 1)) {
    throw new Error(`端到端 RTF 未通過：${snapshot.rtf}`);
  }

  const phaseNames = ['frontendMs', 'acousticMs', 'vocoderMs', 'istftMs', 'silenceMs', 'synthesisMs', 'mp3Ms', 'totalMs'];
  const medianPhasesMs = Object.fromEntries(
    phaseNames.map((name) => [name, median(segments.map((segment) => segment.phases[name]))]),
  );
  const report = {
    generatedAt: new Date().toISOString(),
    environment: {
      browser: version.product,
      browserBinary: browser.bin,
      hostPlatform: process.platform,
      hostArchitecture: process.arch,
      osRelease: os.release(),
      node: process.version,
      ...environment,
    },
    model: {
      name: 'matcha-icefall-zh-en',
      acousticModel: 'model-steps-3.onnx',
      vocoder: 'vocos-16khz-univ.onnx',
      sampleRate: 16000,
      threads: 1,
      mp3: 'lamejs 1.2.1 / mono / 96 kbps',
    },
    frontend: initialization.frontend,
    initialization,
    protocol: {
      workerWarmups: 1,
      pronunciationProfile: 'official',
      targetAppendCount,
      measurementBoundary: 'Traditional-direct + JavaScript normalization + lexicon/token mapping + Matcha + Vocos + ISTFT + silence scaling + MP3 encode',
      transport: 'single HTMLAudioElement + single MediaSource + sequence SourceBuffer',
      waveformValidation: 'all samples finite, peak > 0, RMS > 0, MP3 bytes > 0',
      note: 'CDP TaskDuration is the main page target only and does not represent dedicated Worker CPU time',
    },
    memory: {afterInitialization: memoryAfterInit, afterStream: memoryAfterStream},
    stream: {
      ...snapshot,
      wallMsToTarget: wallMs,
      wallRtfToTarget: wallMs / 1000 / snapshot.appendedAudioSeconds,
      mainTargetTaskMs,
      mainTargetTaskRtf: mainTargetTaskMs / 1000 / snapshot.appendedAudioSeconds,
    },
    summary: {
      appendCount: snapshot.appendCount,
      appendedAudioSeconds: snapshot.appendedAudioSeconds,
      producerRtf: snapshot.rtf,
      producerRealtimeMultiplier: snapshot.realtimeMultiplier,
      underflows: snapshot.underflows,
      appendErrors: snapshot.appendErrors,
      producerErrors: snapshot.producerErrors,
      medianSegmentAudioSeconds: median(segments.map((segment) => segment.audioSeconds)),
      medianSegmentMp3Bytes: median(segments.map((segment) => segment.mp3Bytes)),
      medianPhasesMs,
    },
    segments,
    relevantEvents: capture.relevantEvents,
  };

  fs.writeFileSync(resultPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  console.log(`Wrote ${resultPath.pathname}`);
} finally {
  try {
    await browser?.close();
  } finally {
    removeProfile();
  }
}
