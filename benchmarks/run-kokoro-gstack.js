if (!window.kokoroGstackState) {
  const modelPath = '/benchmarks/models/kokoro-selective-int8/model.onnx';
  const assetsBase = '/benchmarks/models/kokoro-selective-int8/';
  const initMs = await window.bench.init(true, 'int8', modelPath, assetsBase);
  window.kokoroGstackState = { initMs, warmed: false, runs: [] };
  return { phase: 'initialized', initMs };
}

const result = await window.bench.run();
if (result.finite !== result.samples || result.peak === 0 || result.rms === 0) {
  throw new Error(`Invalid selective INT8 audio: ${JSON.stringify(result)}`);
}

const normalized = {
  ...result,
  wallMsPer10s: result.wallMs * 10 / result.audioSeconds,
};
if (!window.kokoroGstackState.warmed) {
  window.kokoroGstackState.warmed = true;
  return { phase: 'warmed', ...normalized };
}

window.kokoroGstackState.runs.push(normalized);
const values = window.kokoroGstackState.runs
  .map(item => item.wallMsPer10s)
  .sort((left, right) => left - right);
return {
  phase: 'measured',
  run: window.kokoroGstackState.runs.length,
  ...normalized,
  medianWallMsPer10s: values[Math.floor(values.length / 2)],
};
