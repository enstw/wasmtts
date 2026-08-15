#!/usr/bin/env node

import {readFileSync} from 'node:fs';

const read = (file) => JSON.parse(readFileSync(file, 'utf8'));
const core = read('platform/results/results-matcha_icefall_zh_en-browser-wasm.json');
const product = read('platform/results/results-matcha_icefall_zh_en-product-browser-wasm.json');
const stream = read('platform/results/results-matcha_icefall_zh_en-stream-browser-wasm.json');
const asr = read('platform/results/asr-listening-report.json');
const asrProduct = read('platform/results/asr-listening-product-report.json');
const failures = [];

for (const [index, run] of core.runs.entries()) {
  if (run.waveform.finiteSamples !== run.waveform.samples || run.waveform.peak <= 0 || run.waveform.rms <= 0) {
    failures.push(`core run ${index + 1}: invalid waveform`);
  }
}
if (!(core.summary.medianWallRtf > 0 && core.summary.medianWallRtf < 1)) {
  failures.push(`core median wall RTF ${core.summary.medianWallRtf} is not in (0, 1)`);
}
// product 腿:silenceScale 1 使音訊較長、RTF 天然偏低,(0,1) 只是 sanity
// 上限,數字不得與研究序列(core)並排比較。
if (product.model.synthesisProfile !== 'product') {
  failures.push(`product report synthesisProfile is ${product.model.synthesisProfile}, expected product`);
}
for (const [index, run] of product.runs.entries()) {
  if (run.waveform.finiteSamples !== run.waveform.samples || run.waveform.peak <= 0 || run.waveform.rms <= 0) {
    failures.push(`product run ${index + 1}: invalid waveform`);
  }
}
if (!(product.summary.medianWallRtf > 0 && product.summary.medianWallRtf < 1)) {
  failures.push(`product median wall RTF ${product.summary.medianWallRtf} is not in (0, 1)`);
}
if (!(stream.summary.producerRtf > 0 && stream.summary.producerRtf < 1)) {
  failures.push(`stream producer RTF ${stream.summary.producerRtf} is not in (0, 1)`);
}
for (const name of ['underflows', 'appendErrors', 'producerErrors']) {
  if (stream.summary[name] !== 0) failures.push(`stream ${name} = ${stream.summary[name]}`);
}
for (const [name, snapshot] of Object.entries(stream.memory)) {
  if (!snapshot.supported || !(snapshot.bytes > 0)) failures.push(`memory ${name}: measurement unavailable`);
  if (snapshot.bytes > 512 * 1024 * 1024) failures.push(`memory ${name}: ${snapshot.bytes} exceeds 512 MiB`);
}
if (asr.status !== 'passed') failures.push(`ASR listening gate failed: ${JSON.stringify(asr.failures)}`);
if (asrProduct.status !== 'passed') failures.push(`product ASR listening gate failed: ${JSON.stringify(asrProduct.failures)}`);

const report = {
  status: failures.length ? 'failed' : 'passed',
  thresholds: {rtfMaximum: 1, memoryMaximumMiB: 512, asrAbsoluteCerMaximum: 0.08},
  metrics: {
    coreMedianWallRtf: core.summary.medianWallRtf,
    productMedianWallRtf: product.summary.medianWallRtf,
    asrProductCer: asrProduct.metrics.cer,
    streamProducerRtf: stream.summary.producerRtf,
    streamRealtimeMultiplier: stream.summary.producerRealtimeMultiplier,
    memoryAfterInitializationBytes: stream.memory.afterInitialization.bytes,
    memoryAfterStreamBytes: stream.memory.afterStream.bytes,
    asrCer: asr.metrics.cer,
  },
  failures,
};
console.log(JSON.stringify(report, null, 2));
if (failures.length) process.exit(1);
