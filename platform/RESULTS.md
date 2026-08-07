# 單線程 WASM TTS 本機基準

測試日期：2026-08-06 至 2026-08-07（Asia/Taipei）

## 結論

以 Piper `zh_CN-huayan-medium` 產生 10 秒音訊的 CPU 時間為 `1.00x`：

| 模型 | 10 秒音訊 CPU 時間（中位數） | 相對 HuaYan | 單線程即時性 | 解壓後資源 |
|---|---:|---:|---:|---:|
| Piper HuaYan medium | 1.576 秒 | **1.00x** | 6.35 倍即時 | 79 MiB |
| Matcha icefall zh-en | 1.467 秒 | **約 0.93x*** | 6.82 倍即時 | 約 152 MiB（其中 ONNX 123.6 MiB） |
| VITS AISHELL3（sid 66） | 0.708 秒 | **0.45x** | 14.1 倍即時 | 207 MiB（其中未載入的 `rule.far` 約 172 MiB） |
| MeloTTS zh/en | 14.427 秒 | **9.16x** | 0.69 倍即時 | 197 MiB |
| Kokoro v1.1 zh int8 | 無有效數字 | — | 輸出為非有限值／靜音 | 約 127 MiB ONNX + 51 MiB voices |
| Kokoro v1.1 zh q8 | 無有效數字 | — | 315,000/315,000 samples 非有限 | 約 127 MiB ONNX + 51 MiB voices |
| Kokoro v1.1 zh fp32 | 14.225 秒 | **9.03x** | 0.70 倍即時 | 約 339 MiB ONNX + 51 MiB voices |

Piper、VITS 與 Kokoro 使用 Chromium 149；Matcha 使用 Chromium 151。全部採 ONNX Runtime Web WASM、單一 thread 與 CDP `TaskDuration`，但星號標示的 Matcha／Piper `約 0.93x` 因瀏覽器版本不同，只能作方向性參考，不能宣稱為嚴格的 7% 加速。AISHELL3 最省 CPU；Matcha 與 HuaYan 同量級且都遠快於即時；MeloTTS 與 Kokoro fp32 都慢於即時。Kokoro int8 與 Kokoro.js sample 對應的 q8 都能完成 graph execution，但輸出全部為非有限值，不能視為有效 TTS；只有 fp32 已驗證能正常發聲。

本文件的「倍即時」是 `realtime multiplier = 音訊長度 ÷ 合成時間`，標準 `RTF = 合成時間 ÷ 音訊長度`，兩者互為倒數。Piper HuaYan medium 的 `6.35 倍即時` 對應名目 `RTF ≈ 0.158`；這裡是桌面單 thread CPU benchmark，不能取代 iPhone 上包含文字前處理與 MP3 編碼的端到端串流 RTF。

本專案另從 FP32 產生 selective INT8，保留 decoder、vocoder、STFT 與全部卷積為 FP32。它在原生 ORT 與瀏覽器 WASM 都能輸出完整有限值，不再有 NaN；但只縮小 `8.3%`，同一瀏覽器下速度比 FP32 慢約 `0.9%`。所以這一版證明「可自行做出正確的混合 INT8」，尚未證明 INT8 對單線程 WASM 有效能優勢。

產品判定與純效能排名分開：Kokoro fp32 已通過相對 Piper 的主觀品質 gate，因此保留為次要候選。它的單執行緒約 `0.70 倍即時`，未通過效能 gate；桌面雙執行緒測得 `RTF ≈ 0.79`、相對 Piper 約 `5.02x` 的運算時間，只代表可能以較高手機溫度與耗電換取即時性。實際溫度、耗電與熱降頻尚須在目標 iPhone／iPad 量測。

AISHELL3 的取樣率只有 8 kHz，而且音質、韻律與聲線選擇和 CPU 是不同維度；本次主觀實聽只有 `3/10`，且仍有明顯外國腔。若目標是修正 HuaYan「外國人中文」的聽感，AISHELL3 不構成品質升級，因此只保留為最低 CPU 的技術參考，不列入產品候選。

## Matcha zh-en 品質與正式 benchmark

2026-08-07 使用與 Piper、Kokoro 相同的五句中文做三方盲測；A 為 Piper HuaYan medium、B 為 Matcha `matcha-icefall-zh-en`、C 為 Kokoro v1.1 zh fp32 sid 45。評分為 B `90`、C `80`、A `60`，A 另被標記有外國腔。因此 Matcha 已通過品質 gate，且本輪主觀品質高於 Kokoro。

正式量測使用 Brave 所附 Chromium `151.0.7922.71`、ONNX Runtime Web `1.26.0-dev.20260416-b7804b056c`、WASM execution provider 與一個 thread。固定五句先暖機一次，再量三次；三輪 task time 為 `1.467`、`1.469`、`1.462` 秒／10 秒音訊，中位數 task `RTF 0.1467`、wall `RTF 0.1467`，約 `6.82 倍即時`。Acoustic + Vocos session 初始化為 `2.208` 秒，兩個 ONNX 合計 129,599,930 bytes（123.6 MiB）。

三輪輸出分別有 174,764、174,656、174,854 samples，全部為有限值；peak 為 `0.7750`、`0.7800`、`0.8170`，RMS 為 `0.1340`、`0.1327`、`0.1328`。Phase 中位數是 acoustic `982.7 ms`、Vocos `593.0 ms`、JavaScript ISTFT `22.3 ms`、silence scaling `0.6 ms`，因此後續核心效能最佳化應先看 acoustic 與 Vocos，不應先花時間重寫 ISTFT。

Adapter 使用 sherpa-onnx 前端預先產生的固定 token；文字前處理排除於計時外，與既有 ORT Web 主表一致。中文 FST 在目前 Node WASM wrapper 仍會越界，正式瀏覽器結果也沒有包含 FST、MP3 編碼或 MediaSource append，因此這是核心合成 benchmark，不是 iPhone 端到端串流結果。完整紀錄與樣本位於 [Matcha 文件](../frameworks/matcha/README.md)，機器可讀結果是 [results-matcha_icefall_zh_en-browser-wasm.json](results/results-matcha_icefall_zh_en-browser-wasm.json)。

## Kokoro selective INT8 修正實驗

這組 A/B 使用同一個 gstack HeadlessChrome 145.0.7632.6、ONNX Runtime Web WASM、單一 thread 與 `performance.now()` wall time。因瀏覽器版本與主表不同，數字只在本節內互相比較。

| 模型 | ONNX 大小 | 10 秒音訊 wall time 中位數 | 相對 FP32 | waveform 驗證 |
|---|---:|---:|---:|---:|
| FP32 | 323.6 MiB | 15.042 秒 | 1.000x | 316,200/316,200 finite |
| selective INT8 | 296.7 MiB | 15.182 秒 | 1.009x | 316,800/316,800 finite |

Selective INT8 三輪為 `15.148`、`15.182`、`15.197` 秒／10 秒音訊；FP32 三輪為 `15.042`、`15.043`、`15.029` 秒。原生 ONNX Runtime CPU 另驗證 selective INT8 的 317,400/317,400 samples 全為有限值，peak `0.325`、RMS `0.0389`。

量化範圍是 decoder 以外的 `MatMul/Gemm/LSTM` 候選；ONNX Runtime 1.28 實際轉換成 9 個 `MatMulInteger` 與 6 個 `DynamicQuantizeLSTM`。`/decoder/`、90 個 `Conv`、7 個 `ConvTranspose`、vocoder 與 STFT 均保留 FP32。這個保守範圍避免了已定位到 STFT Fourier kernel／phase 除法的 NaN 傳播，但也只減少 28.2 MB 權重，無法帶來明顯 WASM 加速。

## 舊 sherpa wrapper 測試方法（保留供對照）

- 環境：macOS 26.5.2 arm64、Node 24.19.0、`sherpa-onnx` npm 1.13.4。
- 所有成功模型都走同一個 sherpa-onnx Emscripten WASM／ONNX Runtime CPU 核心。
- 模型設定固定 `numThreads: 1`、`provider: cpu`、語速 1.0。
- 同一段簡體中文、全形句號文本；內容不含數字或電話，因此計時時不載入正規化 FST。
- 每個模型先暖機一次，再量三次；用 `process.cpuUsage()` 量 process CPU，按實際 WAV 長度正規化成「產生 10 秒音訊所需 CPU 毫秒」，取三次中位數。
- `sherpa-onnx 1.13.4` Node WASM 使用上游預設 512 MiB initial memory；現有 `benchmark.js` 沒有覆寫它。舊文件使用的 `SHERPA_WASM_INITIAL_MEMORY` 環境變數不會被此 wrapper 讀取，不能作為 768 MiB 已生效的證據。這組 benchmark 不載入正規化 FST。
- 這個 npm WASM binary 是 pthread build，runtime 會建立閒置 worker；推論本身固定 `numThreads: 1`。CPU 時間接近 wall time，符合只有一個活躍推論執行緒，但不等於「binary 完全沒有 pthread 支援」。

### 統一瀏覽器 WASM 路徑

- 瀏覽器：Chrome for Testing 149.0.7827.55 arm64；Transformers.js 4.2.0；ONNX Runtime Web 1.26 dev；execution provider 固定 `wasm`，`numThreads = 1`、`proxy = false`。
- 模型：`onnx-community/Kokoro-82M-v1.1-zh-ONNX` 的 int8 graph；聲線為 sid 45（`zf_078`）。
- 四款都直接使用 ONNX Runtime Web `wasm` provider。HuaYan 用 Piper 官方 eSpeak phonemizer；AISHELL3、MeloTTS、Kokoro 使用各自的 lexicon/tokens。Kokoro 另從 `voices.bin` 取得 sid 45（`zf_078`）style。文字前處理不納入推論計時。
- CPU 指標統一採 Chromium CDP `Performance.TaskDuration`；單線程下 task time 幾乎等於 wall time。

## 三輪原始摘要

| 模型 | 三輪 CPU ms / 10 秒音訊 | 中位數 wall ms / 10 秒音訊 |
|---|---|---:|
| HuaYan | 2172.36、2177.27、2187.66 | 2158.36 |
| AISHELL3 | 1281.37、1339.17、1280.12 | 1260.90 |
| MeloTTS | 15624.49、15901.59、15898.00 | 15876.41 |
| Kokoro int8（ORT Web；TaskDuration） | 42338.35、42327.36、42336.76 | 42336.76 |
| HuaYan（ORT Web；TaskDuration） | 1582.61、1566.66、1575.77 | 1575.77 |
| AISHELL3（ORT Web；TaskDuration） | 717.67、703.04、707.96 | 707.96 |
| MeloTTS（ORT Web；TaskDuration） | 14441.27、14427.35、14403.69 | 14427.35 |
| Kokoro fp32（ORT Web；TaskDuration） | 14225.42、14205.52、14256.83 | 14225.42 |
| Matcha zh-en（ORT Web；TaskDuration） | 1467.48、1468.58、1462.34 | 1467.27 |

## 可重現檔案

- 測試程式：`platform/benchmark.js`
- 每輪完整 JSON：`platform/results/results-*.json`
- 成功模型最後一輪 WAV：`platform/results/*.wav`
- Kokoro 瀏覽器頁：`platform/kokoro-browser.html`
- Kokoro Chromium/CDP runner：`platform/run-kokoro-browser.mjs`
- Kokoro selective INT8 量化器：`platform/quantize-kokoro.py`
- Kokoro 原生數值驗證器：`platform/validate-kokoro-onnx.py`
- Kokoro gstack browse 單輪 runner：`platform/run-kokoro-gstack.js`
- 其他三款 ORT Web runner：`platform/run-vits-browser.mjs`
- Matcha ORT Web 頁面／runner：`platform/matcha-browser.html`、`platform/run-matcha-browser.mjs`
- Matcha 正式 JSON／WAV：`platform/results/results-matcha_icefall_zh_en-browser-wasm.json`、`platform/results/matcha_icefall_zh_en-browser-wasm.wav`
- 統一三款原始結果：`platform/results/results-vits-browser-wasm.json`
- Selective INT8 與同瀏覽器 FP32 A/B：`platform/results/results-kokoro_v1_1_zh_selective-int8-browser-wasm.json`

重跑範例：

```sh
pnpm exec node platform/benchmark.js piper_huayan_medium
pnpm exec node platform/benchmark.js vits_aishell3
pnpm exec node platform/benchmark.js vits_melotts_zh_en
# 另一個終端機先執行：pnpm host:mobile
pnpm exec node platform/run-kokoro-browser.mjs fp32
pnpm exec node platform/run-vits-browser.mjs
pnpm benchmark:matcha
```
