# WebAssembly TTS Optimization Guide (Browser & iOS Safari)

> 狀態（2026-08-07）：Kokoro 品質 gate 已通過，現列為高運算／高熱成本的次要候選。本文件保存已完成的最佳化證據；其中「優先訓練 mobile vocoder」是實驗當時的技術結論，已被目前「先尋找成本更低的現成替代方案」之產品優先序取代。

This guide focuses on **real-world optimization priorities** for running neural TTS models in **WebAssembly**, especially on **Safari/iOS**, where CPU inference is still common.

---

# 1. Profile Before Optimizing

Never assume quantization is the bottleneck.

Measure separately:

```
Model loading

↓

Session initialization

↓

Encoder

↓

Decoder

↓

Vocoder

↓

Post-processing

↓

Audio output
```

For ONNX Runtime, enable operator profiling and identify:

* MatMul/Gemm
* Conv
* LayerNorm
* Softmax
* DequantizeLinear
* QuantizeLinear
* Cast

Often you'll discover only 40–60% of runtime is actual neural computation.

---

# 2. Verify SIMD First (Highest ROI)

This is the single most important optimization.

Without SIMD:

```
Scalar FP32
```

With SIMD:

```
FP32 SIMD
```

Typical improvement:

* 2×–4× depending on operator

Before attempting quantization, verify:

* WASM SIMD build is loaded
* Browser supports SIMD
* Runtime isn't falling back to scalar implementation

If SIMD is disabled, **fix this first**.

---

# 3. Keep One Persistent Inference Session

Avoid:

```
new InferenceSession()

↓

Run

↓

Destroy
```

Instead:

```
Create once

↓

Reuse forever
```

Benefits:

* avoids repeated graph optimization
* avoids weight preparation
* reduces memory allocations
* reduces JIT overhead

This is especially important on Safari.

---

# 4. Pre-pack Weights

Matrix multiplication libraries usually transform weights into cache-friendly layouts.

Bad:

```
Every inference

↓

Pack weights

↓

MatMul
```

Good:

```
Initialization

↓

Pack once

↓

Reuse forever
```

Packing can consume milliseconds on large models.

---

# 5. Graph Fusion

Reduce operator boundaries.

Prefer:

```
MatMul
↓

Bias
↓

GELU
```

as

```
Fused MatMul + Bias + GELU
```

Similarly:

```
Conv
↓

BatchNorm
↓

Activation
```

should become a single kernel whenever possible.

Benefits:

* fewer memory writes
* fewer dispatches
* better cache locality

---

# 6. Reduce Memory Copies

A surprising amount of browser runtime is spent copying memory.

Watch for:

```
JS Array

↓

TypedArray

↓

WASM Memory

↓

Tensor

↓

Output Buffer

↓

Audio Buffer
```

Try to:

* reuse buffers
* avoid reallocations
* avoid unnecessary TypedArray creation

---

# 7. Optimize Cache Locality

Apple CPUs have excellent cache systems.

Often cache optimization beats quantization.

Examples:

* contiguous tensors
* packed matrices
* aligned allocations
* sequential access

Avoid:

```
Random memory access
```

---

# 8. Batch Small Operations

Autoregressive TTS frequently performs many tiny matrix multiplications.

Instead of:

```
1000 × tiny GEMM
```

Try:

```
100 × larger GEMM
```

Larger kernels utilize SIMD much more efficiently.

---

# 9. Quantization Strategy

## FP32

Advantages:

* mature kernels
* no conversion overhead
* usually fastest baseline

Recommended starting point.

---

## FP16

On pure WASM CPU:

Not recommended.

Reason:

Most browsers still promote FP16 computation back to FP32.

Typical path:

```
Load FP16

↓

Convert FP32

↓

Compute FP32

↓

Convert FP16
```

Little or no speedup.

---

## BF16

Useful for training.

Not useful for browser CPU inference.

---

## FP8

Currently unsuitable for WASM.

Reasons:

* no native FP8 SIMD
* runtime converts to FP16/FP32
* no browser kernel support

---

## FP4

Useful only as a storage format today.

Runtime generally expands it back to FP16 or FP32.

No practical CPU acceleration.

---

## INT8

Most promising quantization format.

Potential advantages:

* smaller model
* reduced bandwidth
* SIMD integer instructions

However:

Acceleration only happens if the runtime executes true INT8 kernels.

If execution becomes:

```
INT8

↓

Dequantize

↓

FP32 MatMul
```

there will be little or no speedup.

---

## Weight-only INT8

Good for:

* download size
* RAM usage

Usually provides limited compute acceleration.

---

## Full INT8

Preferred:

```
INT8 Activation

×

INT8 Weight

↓

INT32 Accumulate
```

Requires proper runtime support.

---

# 10. Check for Hidden FP32 Fallbacks

Look for excessive:

* DequantizeLinear
* QuantizeLinear
* Cast

Ideal graph:

```
QLinearMatMul

↓

QLinearConv

↓

Integer kernels
```

Not:

```
INT8

↓

FP32

↓

INT8

↓

FP32
```

---

# 11. Safari-specific Recommendations

Safari's WebAssembly implementation is now quite mature.

Current priorities:

✅ WASM SIMD

✅ Persistent sessions

✅ Packed weights

✅ Graph fusion

⚠ Threads only if SharedArrayBuffer is correctly enabled

❌ Don't expect FP16 CPU acceleration

❌ Don't expect FP8/FP4 acceleration

---

# 12. Should You Use Threads?

Only if:

* workload is large
* SharedArrayBuffer works
* COOP/COEP headers are configured

Small TTS models often gain little due to synchronization overhead.

---

# 13. Recommended Optimization Order

For browser WASM TTS:

1. Enable SIMD
2. Profile operators
3. Keep persistent inference sessions
4. Pack weights once
5. Fuse operators
6. Reduce memory copies
7. Improve cache locality
8. Batch small operations
9. Evaluate INT8
10. Verify no FP32 fallback

---

# 14. Long-term Direction

For **pure WASM CPU inference**, the practical future remains:

```
FP32 SIMD
```

or

```
True INT8 kernels
```

FP16, FP8, and FP4 currently offer little advantage unless browsers expose native execution paths.

If WebGPU is available, the optimization priorities change completely:

```
WebGPU
    ↓
FP16
    ↓
Tensor/GPU execution
```

For modern Apple devices (A17 Pro and newer), WebGPU is likely to become the preferred inference backend as browser implementations continue to mature.

---

# Project Progress: Kokoro on iOS Safari

Updated: 2026-08-07

## Target constraints

* Target runtime: iOS Safari, ONNX Runtime Web WASM backend
* WebGPU is out of scope
* WASM threads / `SharedArrayBuffer` were initially out of scope; a two-thread path was reopened and measured on 2026-08-07
* Optimization target: steady-state synthesis, with one persistent session

## Verified baseline

* Model: Kokoro FP32 ONNX, 339,369,442 bytes
* SHA-256: `94b973941b1852754f979be5d5e20be666d5c81d9bb886b88ae1dc85c9b895ca`
* Output validation: 316,200 finite, non-silent samples (13.175 seconds)
* Median steady-state inference: 13,871.14 ms per 10 seconds of audio
* Relative to the measured Piper CPU baseline: 8.80277x slower

## Completed checks

### SIMD: verified end-to-end

The Safari path loads `ort-wasm-simd-threaded.asyncify.wasm`. This ORT build rejects a browser without WASM SIMD rather than silently selecting a scalar fallback. A successful, numerically valid inference therefore proves that the inference path is executing the SIMD WASM binary.

### Persistent session and packing

The browser benchmark creates one `InferenceSession` and reuses it for warm-up and measured runs. ORT owns constant-weight preparation/prepacking during session initialization; repeated session construction is not included in the steady-state result.

### Quantization

* The available upstream INT8 model produced invalid output (non-finite/silent).
* A selectively quantized model was valid, but was about 0.9% slower and only 8.3% smaller.
* FP16/BF16/FP8/FP4 do not provide a useful WASM CPU execution path for this target.

Conclusion: quantization is not currently a speedup path for this model/runtime combination.

## Native WASM CPU profile

Controlled single-operator ONNX probes were run against the exact ORT Web build used by the Kokoro benchmark. They map minified WASM function numbers to kernel families:

| WASM function | Mapped kernel family | Kokoro self time |
| --- | --- | ---: |
| `[1896]` | GEMM-family; also used by Conv and LSTM lowering | 74.3% |
| `[1377]` | MatMul-family; also used by Conv, ConvTranspose, and LSTM | 9.9% |
| `[6505]` | InstanceNormalization | 2.6% |

The two matrix kernels account for 84.2% of profiled self time. This is arithmetic inside several ONNX operator types, not necessarily two individual graph nodes. JS/WASM copies, dispatch overhead, and audio post-processing cannot be the primary steady-state bottleneck at this profile share.

## Current priority

Attribute the GEMM/MatMul time to Kokoro graph stages and operator groups (explicit Gemm/MatMul versus Conv and LSTM lowering). Use that evidence to choose between graph restructuring, architecture reduction, or a targeted runtime/kernel change. Generic buffer-reuse work is lower priority until this attribution is complete.

## Graph attribution: first pass

The exported ONNX node names retain architecture boundaries. Counting the constant parameters consumed by matrix-backed operators gives this first-pass map:

| Architecture bucket | Matrix-backed nodes | Constant weight elements |
| --- | ---: | ---: |
| Decoder / generator | 135 | 53.24M |
| Text encoder | 10 | 11.42M |
| BERT | 98 | 6.00M |
| Duration LSTMs | 2 | 3.68M |
| F0 path | 15 | 3.29M |
| Noise path | 15 | 3.29M |

The decoder contains 71 Conv, 58 Gemm, 5 ConvTranspose, and 1 MatMul node. It consumes about 65.8% of all constant elements attached to the expensive operator families. The largest subgroups are `decoder/generator` (19.65M) and four `decoder/decode.*` blocks (about 27.6M combined).

This makes the decoder/vocoder the leading optimization candidate, but parameter volume is not elapsed time. Runtime MAC count also depends on the dynamic text and generated-audio dimensions. ORT Web exposes `enableProfiling`, but this WASM wrapper discards the profile filename and does not implement `startProfiling`; native per-node results are therefore not directly retrievable through the public JS API in this build. The next experiment should measure stage variants or capture runtime intermediate shapes, rather than treating this static ranking as final timing attribution.

## Runtime shape attribution: decoder boundaries

A minimally augmented copy of the exact FP32 graph exposed one tensor at each decoder subgroup boundary. It was run through the same one-thread ORT Web WASM path and produced the same 316,200-sample waveform length.

* F0, noise, ASR residual, encoder, and `decode.0` through `decode.2` operate at 527 frames.
* `decode.3` produces 1,054 frames, the first observed 2x expansion.
* The generator produces 316,200 samples: exactly 600 output samples per input frame.
* The three early decode blocks each materialize `[1, 1024, 527]`; `decode.3` materializes `[1, 512, 1054]`.

This strengthens the decoder/generator attribution: the generator is not merely the largest decoder parameter group; it is also the only group expanding frame-rate features all the way to audio rate. The next probe records all four generator `ConvTranspose` outputs to locate the individual expansion factors and estimate their compute contribution.

### Generator upsampling detail

The refined runtime probe found these generator boundaries:

| Boundary | Runtime shape | Temporal expansion |
| --- | --- | ---: |
| Generator input region | 527 frames | 1x |
| `ups.0/ConvTranspose` | `[1, 256, 10540]` | 20x |
| `ups.1/ConvTranspose` | `[1, 128, 63240]` | 6x |
| Waveform synthesis / overlap-add | `[1, 1, 316220]` | about 5x, cropped to 316,200 |

The learned upsamplers therefore perform the main 120x temporal expansion before waveform synthesis. Their activation volumes are 2.70M and 8.09M FP32 elements respectively. This makes `decoder/generator/ups.0`, `ups.1`, and the convolutional residual blocks operating after them the highest-value targets for the next compute estimate. Any optimization that only touches the 148-token BERT front end cannot address this audio-rate workload.

The initializer dimensions and runtime lengths allow exact MAC counts for the transposed convolutions:

| Operation | Weight shape | Input length | Approximate MACs |
| --- | --- | ---: | ---: |
| `ups.0` | `[512, 256, 20]`, stride 10 | 1,054 | 2.763G |
| `ups.1` | `[256, 128, 12]`, stride 6 | 10,540 | 4.144G |
| Inverse-STFT real + imaginary pair | two `[11, 1, 20]`, stride 5 | 63,240 | 0.028G |

The two learned upsamplers alone account for about 6.91G MACs for this 13.175-second output. `ups.1` costs about 50% more than `ups.0` despite having fewer channels because it runs after the first temporal expansion. The final inverse-STFT overlap-add is arithmetically negligible by comparison. This does not yet include the generator residual convolutions, so 6.91G is a lower bound for generator work, not its total.

Current conclusion: an exact-output graph cleanup is unlikely to produce a large speedup. The dominant cost is useful model arithmetic in the learned vocoder. The next practical experiment should isolate quantization to `decoder/generator/ups.*` and its audio-rate residual convolutions, while leaving the numerically fragile front end and inverse-STFT in FP32. If that remains slower in ORT WASM, a material improvement will require a smaller/distilled generator or a lower output sample rate rather than buffer-level tuning.

### INT8 convolution viability check

Before producing another large quantized Kokoro file, a controlled ORT Web probe compared the exact WASM backend's FP32 `Conv` path with an explicit `QuantizeLinear -> QLinearConv -> DequantizeLinear` path. Both probes used the same quantized/dequantized weights, float input/output boundaries, shape `[1, 128, 4096]`, 128 output channels, and kernel size 3. The session was persistent, warmed up, single-threaded, SIMD-enabled, and graph optimization was set to `all`.

| Probe | 50 sequential runs | Per run | Relative |
| --- | ---: | ---: | ---: |
| FP32 `Conv` | 520.1 ms | 10.402 ms | 1.000x |
| INT8 `QLinearConv` with Q/DQ | 565.6 ms | 11.312 ms | 1.0875x |

The explicit INT8 path is 8.75% slower at a representative audio-rate residual-convolution shape. The earlier end-to-end selective INT8 model was also 0.9% slower, so two independent measurements now reject INT8 as a speed path in this ORT Web WASM build. In addition, ONNX has no standard `QLinearConvTranspose`; the two learned transposed convolutions responsible for at least 6.91G MACs would remain FP32 anyway.

Decision: do not spend time building a generator-static-INT8 model for this target. Retain the probe as a regression test in case a later ORT Web build adds a faster integer kernel. The optimization search now moves to structural reductions: fewer generator channels/blocks, fewer generated samples, or a separately trained/distilled mobile vocoder.

### Duration scaling and sentence chunking

The exact FP32 model was rerun with only the first sentence, using the same persistent, warmed-up session:

| Input | Output duration | Median CPU time | CPU time normalized to 10 s audio |
| --- | ---: | ---: | ---: |
| One sentence | 4.150 s | 5,696.7 ms | 13,727.1 ms |
| Five-sentence baseline | 13.175 s | about 18,274 ms | 13,871.1 ms |

Normalized throughput differs by only about 1.0%. Inference cost is therefore effectively proportional to generated audio duration over this range, with little measurable fixed front-end overhead. Sentence chunking can reduce time-to-first-audio from roughly 18.3 seconds to 5.7 seconds on this benchmark machine and cap peak activation lifetime, but it does **not** materially improve real-time factor or total compute. It is a responsiveness technique, not the core speedup.

This scaling also predicts the ceiling of sample-rate reduction if the vocoder is retrained or replaced: moving from 24 kHz to 16 kHz removes one third of duration-proportional audio-rate work, so an ideal upper bound is about 1.5x faster. Actual gain will be lower because the 527-frame decoder front end is unchanged. Achieving the roughly 8.7x gap to Piper cannot come from sample rate alone; it requires a substantially narrower/shallower mobile generator or a different vocoder architecture.

### Exact generator convolution budget

All 57 `Conv` and `ConvTranspose` nodes under `decoder/generator` were combined with the measured runtime lengths. The calculation accounts for kernel width and ONNX `group`; all of these model convolutions use `group=1`. For the 13.175-second baseline, the generator executes approximately 324.08G MACs:

| Generator component | MACs | Share |
| --- | ---: | ---: |
| Main residual branches | 217.59G | 67.1% |
| Noise residual paths | 97.40G | 30.1% |
| Learned upsamplers | 6.91G | 2.1% |
| Noise projections | 0.89G | 0.3% |
| Output convolution | 1.25G | 0.4% |
| STFT / inverse-STFT convolutions | 0.056G | below 0.1% |

The residual convolutions account for 314.98G MACs, or 97.2% of generator convolution work. This corrects the earlier lower-bound emphasis on the two learned upsamplers: their activation expansion is large, but the repeated dense residual convolutions after expansion dominate arithmetic by about 45.6x. The second audio-rate stage costs 200.36G MACs versus 116.76G in the first stage.

The three parallel main residual kernel branches contribute:

| Kernel branch | MACs |
| --- | ---: |
| 3 | 31.08G |
| 7 | 72.53G |
| 11 | 113.97G |

These are architecture changes and require training or distillation; deleting branches from the existing FP32 graph will change quality. Still, they define useful mobile-design targets:

| Structural design | Projected generator MACs | Generator-only ideal gain | Optimistic end-to-end ceiling* |
| --- | ---: | ---: | ---: |
| 75% internal channel width | 182.72G | 1.77x | 1.58x |
| 50% internal channel width | 81.60G | 3.97x | 2.70x |
| Depthwise-separable residual convolutions, same widths/blocks | 52.55G | 6.17x | 3.40x |

\*The end-to-end ceiling assumes the entire measured 84.2% matrix-kernel share scales with the generator reduction, although that profile share also includes non-generator work. It is intentionally optimistic; actual gains will be lower.

當時的技術判定是另行訓練 mobile vocoder，以 depthwise-separable 或其他輕量 block 取代 dense residual stacks；只縮減 channel 不太可能消除與 Piper 的差距。這仍是有效的長期方向，但已不再是目前產品研究的優先工作。計算可用 `platform/analyze-kokoro-generator.py` 重現，node-level 報告位於 `platform/results/kokoro-generator-macs.json`。

### Depthwise-separable convolution viability

A matched single-thread ORT Web WASM probe tested the proposed mobile-vocoder primitive at an audio-rate residual shape. Both variants map `[1, 128, 4096]` to the same shape with an 11-sample receptive field. The dense graph uses one `128 -> 128`, kernel-11 `Conv`; the separable graph uses a 128-group kernel-11 depthwise `Conv` followed by a `128 -> 128`, kernel-1 pointwise `Conv`. Sessions were persistent, warmed up, SIMD-enabled, and graph optimization was set to `all`.

| Probe | 200 sequential runs | Per run | Relative |
| --- | ---: | ---: | ---: |
| Dense kernel-11 Conv | 7,360.88 ms | 36.804 ms | 1.000x |
| Depthwise + pointwise Conv | 888.96 ms | 4.445 ms | 0.1208x |

The separable block is **8.28x faster** in the exact target runtime. Its theoretical MAC reduction at this shape is 10.13x, so ORT Web WASM realizes most of the arithmetic saving despite the extra node and intermediate activation. The profile also removes the dense probe's dominant GEMM-family kernel `[1896]`; the separable pair is dominated by the MatMul-family kernel `[1377]`.

技術判定是 depthwise-separable FP32 convolution 在此 runtime 可行，與已測 INT8 convolution 不同；但不能直接替換既有 Kokoro graph，必須重新訓練或蒸餾 weights，並重做音質評估。實驗當時建議從高成本 kernel-11 branch 開始做 mobile-vocoder training；目前將這項工作降為長期方向，主線先尋找品質相當而成本較低的現成方案。可重現 probes 由 `platform/generate-ort-operator-probes.py` 產生，raw profiles 位於 `platform/results/operator-probes/`。

### Two-thread WASM result

The exact FP32 model was rerun with `numThreads=2`. The benchmark server supplied `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`; the harness asserted both `crossOriginIsolated === true` and availability of `SharedArrayBuffer` before creating the ORT session. This prevents a requested two-thread run from silently falling back to an unavailable configuration.

| Configuration | Median time per 10 s audio | Relative to one thread | Relative to Piper |
| --- | ---: | ---: | ---: |
| One WASM thread | 13,871.14 ms | 1.000x | 8.803x |
| Two WASM threads | 7,905.31 ms | 0.570x | 5.017x |

The three two-thread runs generated the full 316,200 finite, non-silent samples in 10.404-10.425 seconds each. Two threads are therefore 1.754x faster and reduce normalized latency by 43.0% on the benchmark machine. The output duration is 13.175 seconds, so this configuration is faster than real time on that machine (RTF about 0.790).

This result was measured in headless Chromium on Apple Silicon with the exact ORT Web WASM build, not on iOS Safari. It proves that the model and runtime benefit materially when two WASM workers are available; deployment feasibility and the gain on iPhone/iPad still require a real-device Safari run with production COOP/COEP headers. The result is stored in `platform/results/results-kokoro_v1_1_zh_fp32-browser-wasm-2threads.json`.

## 次要候選實機檢查清單

Kokoro fp32 已通過主觀品質 gate，因此保留為次要候選；它不是目前尋找低成本替代方案的研究主線。未修改 FP32 模型的最佳實測設定為兩個 WASM threads：在 Apple Silicon Chromium 上加速 `1.754x`，`RTF ≈ 0.790`，相對 Piper 的運算成本約 `5.02x`。這項成本預期會反映為較高的手機溫度與耗電，但尚未完成 iPhone／iPad 熱穩態量測，不可把預期寫成實測結論。

若要驗證這個次要候選，在目標 iPhone／iPad 以 COOP／COEP headers 提供頁面，確認 `crossOriginIsolated` 與 `SharedArrayBuffer`，並在建立 ORT session 前設定 `numThreads=2`。同一裝置分別跑一個與兩個 thread，另記錄長時間 RTF、機身溫度、耗電、熱降頻及鎖屏 buffer 水位；不可把桌面時間直接當作 iOS 結果。

本機重現時先執行 `pnpm host:mobile`，再執行：

```sh
pnpm exec node platform/run-kokoro-browser.mjs fp32 \
  --model-path /platform/models/kokoro-fp32-download/onnx/model.onnx \
  --threads 2
```

323 MB 模型刻意不納入 repository。請還原至 `platform/models/kokoro-fp32-download/onnx/model.onnx`，並驗證 SHA-256 `94b973941b1852754f979be5d5e20be666d5c81d9bb886b88ae1dc85c9b895ca`。若 iOS Safari 無法穩定提供兩個 workers，或熱穩態下 `RTF >= 1`，Kokoro 仍保留為品質參考但不進入主要產品路徑。Depthwise-separable mobile vocoder 的訓練／蒸餾結果保留為長期可能性；現階段不再優先投入，先尋找品質相當而成本較低的現成方案。
