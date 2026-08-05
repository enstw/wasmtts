# 單線程 WASM TTS 本機基準

測試日期：2026-08-06（Asia/Taipei）

## 結論

以 Piper `zh_CN-huayan-medium` 產生 10 秒音訊的 CPU 時間為 `1.00x`：

| 模型 | 10 秒音訊 CPU 時間（中位數） | 相對 HuaYan | 單線程即時性 | 解壓後資源 |
|---|---:|---:|---:|---:|
| Piper HuaYan medium | 1.576 秒 | **1.00x** | 6.35 倍即時 | 79 MiB |
| VITS AISHELL3（sid 66） | 0.708 秒 | **0.45x** | 14.1 倍即時 | 207 MiB（其中未載入的 `rule.far` 約 172 MiB） |
| MeloTTS zh/en | 14.427 秒 | **9.16x** | 0.69 倍即時 | 197 MiB |
| Kokoro v1.1 zh int8 | 無有效數字 | — | 輸出為非有限值／靜音 | 約 127 MiB ONNX + 51 MiB voices |
| Kokoro v1.1 zh q8 | 無有效數字 | — | 315,000/315,000 samples 非有限 | 約 127 MiB ONNX + 51 MiB voices |
| Kokoro v1.1 zh fp32 | 14.225 秒 | **9.03x** | 0.70 倍即時 | 約 339 MiB ONNX + 51 MiB voices |

主表已統一為 Chromium 149、ONNX Runtime Web WASM、單一 thread 與 CDP `TaskDuration`。AISHELL3 最省 CPU；HuaYan 居中；MeloTTS 與 Kokoro fp32 都慢於即時。Kokoro int8 與 Kokoro.js sample 對應的 q8 都能完成 graph execution，但輸出全部為非有限值，不能視為有效 TTS；只有 fp32 已驗證能正常發聲。

但 AISHELL3 的取樣率只有 8 kHz，而且音質、韻律與聲線選擇和 CPU 是不同維度；`0.59x` 不代表整體體驗一定勝過 HuaYan。若目標是修正 HuaYan「外國人中文」的聽感，AISHELL3 值得先實機盲聽，但不能只憑 CPU 決定。

## 舊 sherpa wrapper 測試方法（保留供對照）

- 環境：macOS 26.5.2 arm64、Node 24.19.0、`sherpa-onnx` npm 1.13.4。
- 所有成功模型都走同一個 sherpa-onnx Emscripten WASM／ONNX Runtime CPU 核心。
- 模型設定固定 `numThreads: 1`、`provider: cpu`、語速 1.0。
- 同一段簡體中文、全形句號文本；內容不含數字或電話，因此計時時不載入正規化 FST。
- 每個模型先暖機一次，再量三次；用 `process.cpuUsage()` 量 process CPU，按實際 WAV 長度正規化成「產生 10 秒音訊所需 CPU 毫秒」，取三次中位數。
- WASM 初始 heap 統一設為 768 MiB。套件原始預設 512 MiB，載入中文 FST 時會越界；這項高記憶體需求本身就是 iOS Safari 的部署警訊。
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

## 可重現檔案

- 測試程式：`benchmarks/benchmark.js`
- 每輪完整 JSON：`benchmarks/results/results-*.json`
- 成功模型最後一輪 WAV：`benchmarks/results/*.wav`
- Kokoro 瀏覽器頁：`benchmarks/kokoro-browser.html`
- Kokoro Chromium/CDP runner：`benchmarks/run-kokoro-browser.mjs`
- 其他三款 ORT Web runner：`benchmarks/run-vits-browser.mjs`
- 統一三款原始結果：`benchmarks/results/results-vits-browser-wasm.json`

重跑範例：

```sh
SHERPA_WASM_INITIAL_MEMORY=805306368 node benchmarks/benchmark.js piper_huayan_medium
SHERPA_WASM_INITIAL_MEMORY=805306368 node benchmarks/benchmark.js vits_aishell3
SHERPA_WASM_INITIAL_MEMORY=805306368 node benchmarks/benchmark.js vits_melotts_zh_en
# 另一個 terminal 先執行：python3 -m http.server 8765
node benchmarks/run-kokoro-browser.mjs
node benchmarks/run-vits-browser.mjs
```
