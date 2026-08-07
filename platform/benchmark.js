const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const sherpa = require('sherpa-onnx');

const root = path.resolve(__dirname, 'models');
const text = '清晨的阳光穿过窗帘。轻轻落在安静的房间里。远处传来清脆的鸟鸣。微风带着花草的清香。让崭新的一天显得格外明亮。';

function emptyVits() {
  return { model: '', lexicon: '', tokens: '', dataDir: '', noiseScale: 0.667, noiseScaleW: 0.8, lengthScale: 1 };
}

function emptyKokoro() {
  return { model: '', voices: '', tokens: '', dataDir: '', dictDir: '', lengthScale: 1, lexicon: '', lang: '' };
}

function config({ vits = emptyVits(), kokoro = emptyKokoro(), ruleFsts = '', ruleFars = '' }) {
  return {
    offlineTtsModelConfig: {
      offlineTtsVitsModelConfig: vits,
      offlineTtsMatchaModelConfig: { acousticModel: '', vocoder: '', lexicon: '', tokens: '', dataDir: '', noiseScale: 0.667, lengthScale: 1 },
      offlineTtsKokoroModelConfig: kokoro,
      offlineTtsKittenModelConfig: { model: '', voices: '', tokens: '', dataDir: '', lengthScale: 1 },
      offlineTtsZipVoiceModelConfig: { tokens: '', encoder: '', decoder: '', vocoder: '', dataDir: '', lexicon: '', featScale: 0.1, tShift: 0.5, targetRMS: 0.1, guidanceScale: 1 },
      offlineTtsPocketModelConfig: { lmFlow: '', lmMain: '', encoder: '', decoder: '', textConditioner: '', vocabJson: '', tokenScoresJson: '', voiceEmbeddingCacheCapacity: 0 },
      offlineTtsSupertonicModelConfig: { durationPredictor: '', textEncoder: '', vectorEstimator: '', vocoder: '', ttsJson: '', unicodeIndexer: '', voiceStyle: '' },
      numThreads: 1,
      debug: Number(process.env.SHERPA_DEBUG || 0),
      provider: 'cpu',
    },
    ruleFsts,
    ruleFars,
    maxNumSentences: 1,
  };
}

const models = {
  piper_huayan_medium: config({
    vits: {
      model: path.join(root, 'vits-piper-zh_CN-huayan-medium/zh_CN-huayan-medium.onnx'),
      lexicon: '',
      tokens: path.join(root, 'vits-piper-zh_CN-huayan-medium/tokens.txt'),
      dataDir: path.join(root, 'vits-piper-zh_CN-huayan-medium/espeak-ng-data'),
      noiseScale: 0.667,
      noiseScaleW: 0.8,
      lengthScale: 1,
    },
  }),
  vits_aishell3: config({
    vits: {
      model: path.join(root, 'vits-icefall-zh-aishell3/model.onnx'),
      lexicon: path.join(root, 'vits-icefall-zh-aishell3/lexicon.txt'),
      tokens: path.join(root, 'vits-icefall-zh-aishell3/tokens.txt'),
      dataDir: '',
      noiseScale: 0.667,
      noiseScaleW: 0.8,
      lengthScale: 1,
    },
    // The benchmark text contains no numbers/phone patterns, so text
    // normalization FSTs are intentionally omitted from timed synthesis.
  }),
  vits_melotts_zh_en: config({
    vits: {
      model: path.join(root, 'vits-melo-tts-zh_en/model.onnx'),
      lexicon: path.join(root, 'vits-melo-tts-zh_en/lexicon.txt'),
      tokens: path.join(root, 'vits-melo-tts-zh_en/tokens.txt'),
      dataDir: '',
      noiseScale: 0.667,
      noiseScaleW: 0.8,
      lengthScale: 1,
    },
  }),
  kokoro_v1_1_zh_int8: config({
    kokoro: {
      model: path.join(root, 'kokoro-int8-multi-lang-v1_1/model.int8.onnx'),
      voices: path.join(root, 'kokoro-int8-multi-lang-v1_1/voices.bin'),
      tokens: path.join(root, 'kokoro-int8-multi-lang-v1_1/tokens.txt'),
      dataDir: process.env.KOKORO_NO_DATA ? '' : path.join(root, 'kokoro-int8-multi-lang-v1_1/espeak-ng-data'),
      dictDir: process.env.KOKORO_NO_DICT ? '' : path.join(root, 'kokoro-int8-multi-lang-v1_1/dict'),
      lengthScale: 1,
      lexicon: process.env.KOKORO_NO_LEXICON ? '' : [
        'lexicon-us-en.txt', 'lexicon-zh.txt'
      ].map(x => path.join(root, 'kokoro-int8-multi-lang-v1_1', x)).join(','),
      lang: '',
    },
  }),
};

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function runOne(name, cfg) {
  const initStart = performance.now();
  const tts = sherpa.createOfflineTts(cfg);
  const initMs = performance.now() - initStart;
  const sid = name === 'vits_aishell3' ? 66 : name.startsWith('kokoro') ? 45 : 0;

  // Untimed warm-up makes the comparison steady-state rather than first-run JIT.
  tts.generate({ text, sid, speed: 1 });
  const runs = [];
  let lastAudio;
  for (let i = 0; i < 3; i++) {
    const cpuStart = process.cpuUsage();
    const wallStart = performance.now();
    const audio = tts.generate({ text, sid, speed: 1 });
    const wallMs = performance.now() - wallStart;
    const cpu = process.cpuUsage(cpuStart);
    const cpuMs = (cpu.user + cpu.system) / 1000;
    const audioSeconds = audio.samples.length / audio.sampleRate;
    runs.push({ wallMs, cpuMs, audioSeconds, cpuMsPer10s: cpuMs * 10 / audioSeconds, wallMsPer10s: wallMs * 10 / audioSeconds });
    lastAudio = audio;
  }
  tts.save(path.resolve(__dirname, 'results', `${name}.wav`), lastAudio);
  tts.free();
  return {
    name,
    initMs,
    sampleRate: lastAudio.sampleRate,
    runs,
    medianCpuMsPer10s: median(runs.map(x => x.cpuMsPer10s)),
    medianWallMsPer10s: median(runs.map(x => x.wallMsPer10s)),
  };
}

const selected = process.argv[2] ? [process.argv[2]] : Object.keys(models);
const results = selected.map(name => runOne(name, models[name]));
const baseline = results.find(x => x.name === 'piper_huayan_medium')?.medianCpuMsPer10s;
for (const result of results) {
  if (baseline) result.cpuRelativeToPiper = result.medianCpuMsPer10s / baseline;
}
const resultFile = process.argv[2] ? `results-${process.argv[2]}.json` : 'results.json';
fs.writeFileSync(path.resolve(__dirname, 'results', resultFile), JSON.stringify({
  environment: { node: process.version, sherpaOnnx: sherpa.version, arch: process.arch, platform: process.platform, numThreads: 1 },
  text,
  results,
}, null, 2));
console.log(JSON.stringify(results, null, 2));
