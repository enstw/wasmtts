import {createHash} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {launch} from './cdp/cdp-client.mjs';

const host = process.env.WASM_TTS_BENCH_HOST ?? '127.0.0.1';
const serverPort = Number(process.env.WASM_TTS_BENCH_PORT ?? 8765);
const cdpPort = Number(process.env.WASM_TTS_CDP_PORT ?? 9396);
const url = `http://${host}:${serverPort}/mobile-host/matcha-stream-test.html`;
const profile = path.join(os.tmpdir(), `wasmtts-matcha-frequency-ab-cdp-${process.pid}`);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sampleRoot = path.join(repositoryRoot, 'frameworks', 'matcha', 'samples');
const outputRoot = path.join(sampleRoot, 'frequency-ab');
const sourcePath = path.join(sampleRoot, 'matcha-no-fst-novel-traditional-direct.txt');
const upstreamPath = path.join(
  sampleRoot,
  'matcha-upstream-fst-recommended-traditional-direct.wav',
);
const text = fs.readFileSync(sourcePath, 'utf8').trim();

const outputPaths = {
  upstream: path.join(outputRoot, 'A.wav'),
  productPcm: path.join(outputRoot, 'B.wav'),
  productMp3: path.join(outputRoot, 'C.mp3'),
  productEq: path.join(outputRoot, 'D.wav'),
  report: path.join(outputRoot, 'frequency-ab.json'),
};

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function waveformStats(samples) {
  let finiteSamples = 0;
  let peak = 0;
  let squares = 0;
  let activeSamples = 0;
  let activeSquares = 0;
  for (const sample of samples) {
    if (Number.isFinite(sample)) finiteSamples += 1;
    const absolute = Math.abs(sample);
    peak = Math.max(peak, absolute);
    squares += sample * sample;
    if (absolute > 0.01) {
      activeSamples += 1;
      activeSquares += sample * sample;
    }
  }
  return {
    samples: samples.length,
    finiteSamples,
    peak,
    rms: Math.sqrt(squares / samples.length),
    activeThreshold: 0.01,
    activeSamples,
    activeRms: activeSamples ? Math.sqrt(activeSquares / activeSamples) : 0,
  };
}

function validateWaveform(label, samples) {
  const stats = waveformStats(samples);
  if (
    stats.finiteSamples !== stats.samples
    || stats.peak === 0
    || stats.rms === 0
    || stats.activeRms === 0
  ) {
    throw new Error(`${label} waveform 無效：${JSON.stringify(stats)}`);
  }
  return stats;
}

function decodePcm16Wav(buffer) {
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('上游樣本不是 RIFF/WAVE');
  }
  let format = null;
  let data = null;
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size > buffer.length) throw new Error(`WAV ${id} chunk 越界`);
    if (id === 'fmt ') {
      format = {
        audioFormat: buffer.readUInt16LE(start),
        channels: buffer.readUInt16LE(start + 2),
        sampleRate: buffer.readUInt32LE(start + 4),
        bitsPerSample: buffer.readUInt16LE(start + 14),
      };
    }
    if (id === 'data') data = buffer.subarray(start, start + size);
    offset = start + size + (size % 2);
  }
  if (!format || !data) throw new Error('WAV 缺少 fmt 或 data chunk');
  if (format.audioFormat !== 1 || format.channels !== 1 || format.bitsPerSample !== 16) {
    throw new Error(`只支援 mono PCM16 WAV：${JSON.stringify(format)}`);
  }
  const samples = new Float32Array(data.length / 2);
  for (let index = 0; index < samples.length; index += 1) {
    const value = data.readInt16LE(index * 2);
    samples[index] = value < 0 ? value / 32768 : value / 32767;
  }
  return {sampleRate: format.sampleRate, samples};
}

function encodePcm16Wav(samples, sampleRate) {
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

function applyGain(samples, gain) {
  return Float32Array.from(samples, (sample) => sample * gain);
}

function matchActiveRms(samples, targetActiveRms, peakLimit = 0.98) {
  const before = validateWaveform('等響度來源', samples);
  const requestedGain = targetActiveRms / before.activeRms;
  const peakLimitedGain = peakLimit / before.peak;
  const gain = Math.min(requestedGain, peakLimitedGain);
  const output = applyGain(samples, gain);
  return {
    samples: output,
    gain,
    requestedGain,
    peakLimited: gain < requestedGain,
    stats: validateWaveform('等響度結果', output),
  };
}

function normalizeCoefficients({b0, b1, b2, a0, a1, a2}) {
  return {
    b0: b0 / a0,
    b1: b1 / a0,
    b2: b2 / a0,
    a1: a1 / a0,
    a2: a2 / a0,
  };
}

function peakingEq({sampleRate, frequency, q, gainDb}) {
  const amplitude = 10 ** (gainDb / 40);
  const omega = 2 * Math.PI * frequency / sampleRate;
  const alpha = Math.sin(omega) / (2 * q);
  const cosine = Math.cos(omega);
  return normalizeCoefficients({
    b0: 1 + alpha * amplitude,
    b1: -2 * cosine,
    b2: 1 - alpha * amplitude,
    a0: 1 + alpha / amplitude,
    a1: -2 * cosine,
    a2: 1 - alpha / amplitude,
  });
}

function highShelf({sampleRate, frequency, slope, gainDb}) {
  const amplitude = 10 ** (gainDb / 40);
  const omega = 2 * Math.PI * frequency / sampleRate;
  const cosine = Math.cos(omega);
  const sine = Math.sin(omega);
  const alpha = sine / 2 * Math.sqrt(
    (amplitude + 1 / amplitude) * (1 / slope - 1) + 2,
  );
  const twoSqrtAmplitudeAlpha = 2 * Math.sqrt(amplitude) * alpha;
  return normalizeCoefficients({
    b0: amplitude * (
      (amplitude + 1) + (amplitude - 1) * cosine + twoSqrtAmplitudeAlpha
    ),
    b1: -2 * amplitude * ((amplitude - 1) + (amplitude + 1) * cosine),
    b2: amplitude * (
      (amplitude + 1) + (amplitude - 1) * cosine - twoSqrtAmplitudeAlpha
    ),
    a0: (amplitude + 1) - (amplitude - 1) * cosine + twoSqrtAmplitudeAlpha,
    a1: 2 * ((amplitude - 1) - (amplitude + 1) * cosine),
    a2: (amplitude + 1) - (amplitude - 1) * cosine - twoSqrtAmplitudeAlpha,
  });
}

function applyBiquad(samples, coefficients) {
  const output = new Float32Array(samples.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const x0 = samples[index];
    const y0 = coefficients.b0 * x0
      + coefficients.b1 * x1
      + coefficients.b2 * x2
      - coefficients.a1 * y1
      - coefficients.a2 * y2;
    output[index] = y0;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
  }
  return output;
}

function diagnosticEq(samples, sampleRate) {
  const filters = [
    {
      type: 'peaking',
      frequency: 350,
      q: 0.9,
      gainDb: -3,
    },
    {
      type: 'high-shelf',
      frequency: 3500,
      slope: 1,
      gainDb: 3,
    },
  ];
  let output = Float32Array.from(samples);
  output = applyBiquad(output, peakingEq({sampleRate, ...filters[0]}));
  output = applyBiquad(output, highShelf({sampleRate, ...filters[1]}));
  return {samples: output, filters};
}

async function waitFor(evalJs, expression, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (!(await evalJs(expression))) {
    if (Date.now() > deadline) throw new Error(`等待逾時：${label}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const removeProfile = () => fs.rmSync(profile, {
  recursive: true,
  force: true,
  maxRetries: 8,
  retryDelay: 250,
});

if (!fs.existsSync(upstreamPath)) {
  throw new Error(
    `缺少上游 PCM：${upstreamPath}。請先執行 pnpm sample:matcha-upstream-fst-traditional。`,
  );
}

let browser;
removeProfile();
try {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`mobile host returned HTTP ${response.status}`);

  browser = await launch({port: cdpPort, profile});
  const {send, evalJs, sessionId} = browser;
  await send('Page.navigate', {url}, sessionId);
  await waitFor(evalJs, 'Boolean(globalThis.matchaStreamTest)', 30000, '測試頁載入');
  await evalJs('globalThis.matchaStreamTest.producer.download()');
  await waitFor(evalJs, 'globalThis.matchaStreamTest.producer.downloaded', 180000, '模型下載');
  await evalJs('globalThis.matchaStreamTest.producer.initialize()');
  await waitFor(
    evalJs,
    'Boolean(globalThis.matchaStreamTest?.producer?.initialization)',
    180000,
    '模型初始化與暖機',
  );

  const version = await send('Browser.getVersion');
  const initialization = await evalJs('globalThis.matchaStreamTest.producer.initialization');
  const generated = await evalJs(`(async () => {
    const text = ${JSON.stringify(text)};
    const producer = globalThis.matchaStreamTest.producer;
    const sentences = globalThis.matchaStreamTest.splitNovelText(text);
    const signal = new AbortController().signal;
    producer.reset({
      text,
      pronunciationProfile: 'official',
      inputNormalization: 'traditional-direct',
      noiseScale: 0.667,
    });
    const units = [];
    for (let index = 0; index < sentences.length; index += 1) {
      units.push(await producer.next({index, signal, capturePcm: true}));
    }
    if (units.some((unit) => !(unit.pcmBuffer instanceof ArrayBuffer))) {
      throw new Error('Worker 沒有回傳診斷 PCM');
    }
    const pcmLength = units.reduce(
      (sum, unit) => sum + new Float32Array(unit.pcmBuffer).length,
      0,
    );
    const pcm = new Float32Array(pcmLength);
    let pcmOffset = 0;
    for (const unit of units) {
      const samples = new Float32Array(unit.pcmBuffer);
      pcm.set(samples, pcmOffset);
      pcmOffset += samples.length;
    }
    const mp3Length = units.reduce((sum, unit) => sum + unit.buffer.byteLength, 0);
    const mp3 = new Uint8Array(mp3Length);
    let mp3Offset = 0;
    for (const unit of units) {
      const bytes = new Uint8Array(unit.buffer);
      mp3.set(bytes, mp3Offset);
      mp3Offset += bytes.length;
    }
    return {
      pcm: Array.from(pcm),
      mp3: Array.from(mp3),
      segments: units.map((unit) => unit.meta),
      sentenceCount: sentences.length,
    };
  })()`);

  if (!generated.pcm.length || !generated.mp3.length) {
    throw new Error('產品 PCM 或 MP3 是空的');
  }
  if (generated.sentenceCount !== generated.segments.length) {
    throw new Error('產品樣本沒有完整產生所有句子');
  }
  for (const [index, segment] of generated.segments.entries()) {
    if (
      segment.waveform.finiteSamples !== segment.waveform.samples
      || segment.waveform.peak === 0
      || segment.waveform.rms === 0
      || segment.mp3Bytes === 0
      || segment.unknown.length
      || segment.noiseScale !== 0.667
    ) {
      throw new Error(`產品 segment ${index + 1} 無效：${JSON.stringify(segment)}`);
    }
  }

  const sampleRate = generated.segments[0].sampleRate;
  if (sampleRate !== 16000 || generated.segments.some((segment) => segment.sampleRate !== sampleRate)) {
    throw new Error(`產品取樣率不一致：${generated.segments.map((segment) => segment.sampleRate)}`);
  }

  const productPcm = Float32Array.from(generated.pcm);
  const productStats = validateWaveform('產品 PCM', productPcm);
  const upstream = decodePcm16Wav(fs.readFileSync(upstreamPath));
  if (upstream.sampleRate !== sampleRate) {
    throw new Error(`上游 ${upstream.sampleRate} Hz 與產品 ${sampleRate} Hz 不一致`);
  }
  const upstreamMatched = matchActiveRms(upstream.samples, productStats.activeRms);
  const equalized = diagnosticEq(productPcm, sampleRate);
  const equalizedMatched = matchActiveRms(equalized.samples, productStats.activeRms);

  const wavs = {
    upstream: encodePcm16Wav(upstreamMatched.samples, sampleRate),
    productPcm: encodePcm16Wav(productPcm, sampleRate),
    productEq: encodePcm16Wav(equalizedMatched.samples, sampleRate),
  };
  const productMp3 = Buffer.from(generated.mp3);
  fs.mkdirSync(outputRoot, {recursive: true});
  fs.writeFileSync(outputPaths.upstream, wavs.upstream);
  fs.writeFileSync(outputPaths.productPcm, wavs.productPcm);
  fs.writeFileSync(outputPaths.productMp3, productMp3);
  fs.writeFileSync(outputPaths.productEq, wavs.productEq);

  const report = {
    generatedAt: new Date().toISOString(),
    browser: version.product,
    model: 'matcha-icefall-zh-en / model-steps-6.onnx + vocos-16khz-univ.onnx',
    text,
    sampleRate,
    channels: 1,
    noiseScale: 0.667,
    targetActiveRms: productStats.activeRms,
    activeRmsDefinition: 'RMS of finite samples with absolute amplitude > 0.01',
    variants: {
      A: {
        path: path.relative(repositoryRoot, outputPaths.upstream),
        label: '上游官方 browser bundle PCM（等響度）',
        source: path.relative(repositoryRoot, upstreamPath),
        boundary: '官方 frontend + Matcha + Vocos + 官方 ISTFT；單一完整輸入',
        gain: upstreamMatched.gain,
        requestedGain: upstreamMatched.requestedGain,
        peakLimited: upstreamMatched.peakLimited,
        waveform: upstreamMatched.stats,
        bytes: wavs.upstream.length,
        sha256: sha256(wavs.upstream),
      },
      B: {
        path: path.relative(repositoryRoot, outputPaths.productPcm),
        label: '產品 Worker PCM',
        boundary: '獨立 kaldifst frontend + Matcha + Vocos + JavaScript ISTFT；逐句合成',
        gain: 1,
        waveform: productStats,
        bytes: wavs.productPcm.length,
        sha256: sha256(wavs.productPcm),
      },
      C: {
        path: path.relative(repositoryRoot, outputPaths.productMp3),
        label: '產品 Worker MP3',
        source: '與 B 同一次 PCM；lamejs 1.2.1，mono，96 kbps，逐句 MP3 unit 串接',
        bytes: productMp3.length,
        sha256: sha256(productMp3),
      },
      D: {
        path: path.relative(repositoryRoot, outputPaths.productEq),
        label: '產品 Worker PCM + 診斷 EQ（等響度）',
        source: '由 B 衍生',
        filters: equalized.filters,
        gain: equalizedMatched.gain,
        requestedGain: equalizedMatched.requestedGain,
        peakLimited: equalizedMatched.peakLimited,
        waveform: equalizedMatched.stats,
        bytes: wavs.productEq.length,
        sha256: sha256(wavs.productEq),
      },
    },
    protocol: {
      order: ['A', 'B', 'C', 'D'],
      strictSingleVariableComparison: 'B vs C；C 由 B 同一次合成 PCM 編碼',
      upstreamComparisonLimit: 'A 採官方單一完整輸入；B 採產品逐句切分，因此 A vs B 不只包含 ISTFT 變因',
      eqStatus: 'D 只供診斷，不是正式產品調音',
      frontend: initialization.frontend,
      segments: generated.segments,
    },
  };
  fs.writeFileSync(outputPaths.report, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  console.log(`Wrote ${Object.values(outputPaths).join(', ')}`);
} finally {
  try {
    await browser?.close();
  } finally {
    removeProfile();
  }
}
