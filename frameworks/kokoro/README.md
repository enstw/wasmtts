# Kokoro

## 細節

已測目標為 Kokoro v1.1 zh，聲線使用 sid 45（`zf_078`），輸出取樣率為 24 kHz。測試涵蓋上游 fp32、int8、q8，以及本專案從 fp32 產生的 selective INT8。

上游 int8 與 Kokoro.js sample 對應的 q8 可完成 ONNX graph execution，但 waveform 全部為非有限值，因此其靜音輸出不是有效 TTS。Fp32 與 selective INT8 都已通過完整有限值、peak 與 RMS 驗證。

使用目標小說內容實聽後，Kokoro fp32 的語音品質已通過相對 Piper HuaYan medium 的產品門檻。因此它不是淘汰方案，而是以較高運算、溫度、耗電與資產成本換取品質的次要候選。

## Benchmark

| 變體 | 結果 | 10 秒音訊時間 | 模型大小／輸出驗證 |
|---|---|---:|---|
| fp32 | 有效 | 14.225 秒 task time | 約 323.6 MiB ONNX；單線程約 0.70 倍即時 |
| 上游 int8／q8 | 無效 | 不列入排名 | waveform 含非有限值／全為非有限值 |
| selective INT8 | 有效 | 15.182 秒 wall time | 296.7 MiB；316,800/316,800 finite |

Selective INT8 與同輪 fp32 的 A/B 為 `1.009x`，也就是慢約 0.9%；兩者與主表使用不同瀏覽器版本，不可跨組直接比較絕對時間。原始結果位於 `platform/results/results-kokoro_*.json` 與 `platform/results/profile-kokoro_*.json`。

FP32 單執行緒約為 `0.70x realtime`，不能滿足持續背景產生的效能 gate。桌面 Chromium 雙執行緒把五句測試降到 `RTF ≈ 0.79`，相對 Piper 的運算時間仍約 `5.02x`；這只證明次要候選在技術上可能即時，不代表 iPhone 鎖屏時能維持相同速度或可接受溫度。手機熱穩態、耗電與熱降頻仍是未完成的產品驗證。

## 最佳化

目前完成的工作包括 SIMD 驗證、persistent session、selective dynamic INT8、graph attribution、runtime shape probe、operator probe、句子切分、generator MAC 分析與雙執行緒測試。

現有模型的主要瓶頸在 generator／vocoder 的 dense residual convolution。Selective INT8 只縮小 8.3%，未帶來單線程 WASM 加速。訓練或蒸餾採 depthwise-separable residual blocks 的 mobile vocoder 仍是可能的長期方向，但目前研究優先序改為尋找成本更低、品質相當或更好的替代方案。Kokoro 只補做真實 iOS Safari 雙執行緒、長時間溫度、耗電與熱降頻驗證。

完整推導、實驗結果與 resume checklist 請見 [OPTIMIZATION.md](OPTIMIZATION.md)。可重現工具與 browser harness 位於 [platform](../../platform/README.md)。
