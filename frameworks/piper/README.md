# Piper WASM、HuaYan 與 iOS Safari／Mobile PWA 研究結論

更新日期：2026-08-06

## 結論

HuaYan 是 Piper 現有的普通話單人女聲，包含 `x_low` 與 `medium` 兩個版本。若目標是呈現 HuaYan 能達到的最佳音質，應採用 `zh_CN-huayan-medium`：模型約 63 MB、約 1,500 萬參數，輸出為 22,050 Hz 單聲道音訊。`medium` 是目前公開 HuaYan 模型中最適合製作音質樣本的版本。

在本專案中，HuaYan medium 是 frozen 品質／效能基準，不是待開發或最佳化的候選。先行專案已在 iOS Home Screen PWA 實證其單 thread Worker、MP3 encoder 與跨章鎖屏播放 transport；這項結果只用來封閉播放架構問題，不列為本專案的新 benchmark。Piper 本身仍有以下限制：

- ONNX 模型、ONNX Runtime WASM、phonemizer 及 JavaScript heap 疊加後的記憶體壓力。
- iOS 可能在沒有可捕捉錯誤的情況下終止或重新載入頁面。
- WASM 多執行緒依賴 SharedArrayBuffer 與 cross-origin isolation；WebKit 曾有 shared WASM memory 的釋放問題。
- 此背景執行能力是實機驗證結果，不是所有 iOS／WebKit 版本的保證；仍須保存版本矩陣與長時間 flight recorder。
- 音訊播放必須由使用者點擊等手勢啟動。

## 本專案的研究邊界

1. 保留 HuaYan medium 的可實聽樣本、既有單 thread benchmark 與授權風險，供所有新候選比較。
1. 不在此重做 Piper Worker、MP3 encoder、鎖屏長跑、x_low／medium 產品分層或播放器最佳化。
1. 新候選的第一個 gate 是相對 HuaYan medium 的盲聽品質提升；通過後才比較 RTF、資產體積、記憶體與整合相容性。
1. 播放 transport 的參考實作位於 [`mobile-host`](../../mobile-host/)；上游實證來自先行專案的鎖屏播放實作，僅保留為歷史證據。

## HuaYan 音質與授權

- 語言標籤為 `zh_CN`，但產品不必限制輸入為簡體字；實際品質仍需用目標文本驗證。
- 中文多音字、數字、英文縮寫、罕見字及長句斷句是主要測試項目。
- 原始 HuaYan 訓練資料的模型卡將授權標為 Unknown。研究與內部原型可先驗證，但公開或商用前必須另外釐清模型權重及資料來源的使用權。
- 目前維護中的 Piper 引擎為 OHF-Voice `piper1-gpl`，採 GPL-3.0；瀏覽器封裝、引擎與模型／資料授權應分開審查。

## 最佳展示樣本

文字存於 [samples/huayan-medium-best.txt](samples/huayan-medium-best.txt)，成品為 [samples/huayan-medium-best.wav](samples/huayan-medium-best.wav)。

本樣本明確採用簡體中文與大陸普通話表達，不以 `zh_TW` 口音為目標。

合成原則：

- 使用 HuaYan medium 與模型預設 noise／duration 參數，句末靜音設為 0.28 秒，避免任意調參造成不穩定韻律。
- 使用自然、音節分布均衡的普通話短文，避免刻意塞入大量破音字、數字和中英混讀。
- 句子長度由短到中等，以逗號和句號提供清楚停頓。
- 保留 22,050 Hz、16-bit、單聲道 WAV，避免升頻偽裝成更高品質。
- 合成後僅將音量降低 1 dB，為播放與後續轉碼保留峰值餘量；不做降噪、EQ 或動態壓縮。

檔案驗證結果：時長約 20.0 秒、PCM 16-bit、22,050 Hz、單聲道、峰值 -1.0 dBFS。

## Benchmark：本機單線程 WASM CPU 實測

測試於 2026-08-06，環境為 macOS 26.5.2 arm64、Node 24.19.0、`sherpa-onnx` 1.13.4。所有成功模型使用同一 Emscripten WASM／ONNX Runtime CPU 核心，固定 `numThreads: 1`、語速 1.0。同一段約 10 秒的簡體中文文本先暖機一次，再量測三次，以實際 WAV 長度正規化並取 CPU 時間中位數。

以 Piper HuaYan medium 產生 10 秒音訊的 CPU 時間為 `1.00x`：

| 模型 | 10 秒音訊 CPU 時間 | 相對 HuaYan | 結果 |
|---|---:|---:|---|
| VITS AISHELL3（sid 66） | 0.708 秒 | **0.45x** | CPU 最低，但輸出僅 8 kHz；主觀實聽 3/10 且有外國腔 |
| Piper HuaYan medium | 1.576 秒 | **1.00x** | 約 6.35 倍即時 |
| MeloTTS zh/en | 14.427 秒 | **9.16x** | 慢於即時，不適合作為行動端即時主引擎 |
| Kokoro v1.1 zh int8 | 無有效數字 | — | ORT Web 輸出非有限值，WAV 為靜音；舊數字作廢 |
| Kokoro v1.1 zh q8 | 無有效數字 | — | ORT Web 的 315,000 個 sample 全部非有限 |
| Kokoro v1.1 zh fp32 | 14.225 秒 | **9.03x** | 有效音訊；單線程約 0.70 倍即時 |

CPU footprint 結論是 AISHELL3 最小、HuaYan 居中，MeloTTS 與 Kokoro fp32 明顯過重。四款均使用 Chromium 149 + ONNX Runtime Web、單一 WASM thread 與 CDP `TaskDuration`。Kokoro fp32 三輪有效輸出的中位數為每 10 秒音訊 14.225 秒，即 HuaYan 的 `9.03x`。Kokoro int8 和 Kokoro.js sample 對應的 q8 在這套 ORT Web WASM 組合中都輸出非有限值，不能計入 CPU 排名。AISHELL3 雖為 `0.45x`，本次主觀實聽只有 3/10 且仍有明顯外國腔，不能解決 HuaYan 的主要品質問題，因此不列入產品候選。

本文件的「倍即時」是 `realtime multiplier = 音訊長度 ÷ 合成時間`；標準 `RTF = 合成時間 ÷ 音訊長度`。因此 HuaYan 的 `6.35 倍即時` 對應名目 `RTF ≈ 0.158`。產品串流驗收必須在目標 iPhone 上另量包含 phonemizer、推論與 MP3 編碼的端到端 wall-time RTF，不能直接以桌面 CPU 指標代替。

另以 FP32 自行產生保守的 selective INT8：只動態量化 decoder 以外可安全轉換的 `MatMul/LSTM`，所有卷積、vocoder 與 STFT 保留 FP32。模型由 323.6 MiB 降至 296.7 MiB，原生 ORT 與瀏覽器 WASM 的 waveform 均為完整有限值；同一個 gstack HeadlessChrome 145 A/B 中，selective INT8 為 15.182 秒／10 秒音訊，FP32 為 15.042 秒，INT8 慢約 0.9%。因此可以從 FP32 做出正確的混合 INT8，但目前沒有單線程 WASM 加速證據，且 8.3% 的體積縮減不足以改變 iOS PWA 的記憶體判斷。

Kokoro 不能使用原 sherpa-onnx 1.13.4 Node WASM binding（初始化觸發 `unreachable`），因此公平比較全部改成直接呼叫 ONNX Runtime Web。文字前處理在計時前完成：HuaYan 用 Piper 官方 eSpeak phonemizer；AISHELL3、MeloTTS、Kokoro 用模型各自的 lexicon/tokens；Kokoro 聲線為 sid 45（`zf_078`）。完整方法和原始三輪數字見 [platform/RESULTS.md](../../platform/RESULTS.md)。

`sherpa-onnx 1.13.4` Node WASM 使用上游預設 512 MiB initial memory，現有 `benchmark.js` 沒有覆寫它；先前文件使用的 `SHERPA_WASM_INITIAL_MEMORY` 環境變數不會被 wrapper 讀取，因此不得寫成已統一配置 768 MiB。本 benchmark 文本不含數字或電話，計時時不載入正規化 FST。另有 Matcha 中文 FST 在明確注入 768 MiB 與 1 GiB 後仍越界的結果，應視為待定位的 runtime／FST 相容性問題，而不是單憑 heap 大小推論。此外，所用 npm binary 是 pthread build，但推論固定單線程；runtime 仍會建立閒置 worker，因此這是「單一活躍推論執行緒」測試，不是完全移除 pthread 的特製 binary。

完整方法、三輪原始值、重跑命令與 WAV 樣本見 [platform/RESULTS.md](../../platform/RESULTS.md)；機器可讀結果位於 repository 根目錄的 `platform/results/results-*.json`。

## 主要資料來源

- Piper voice samples: https://rhasspy.github.io/piper-samples/
- HuaYan model card: https://huggingface.co/rhasspy/piper-voices/blob/main/zh/zh_CN/huayan/medium/MODEL_CARD
- Piper voices manifest: https://huggingface.co/rhasspy/piper-voices/blob/main/voices.json
- Current Piper engine: https://github.com/OHF-Voice/piper1-gpl
- ONNX Runtime Web flags: https://onnxruntime.ai/docs/tutorials/web/env-flags-and-session-options.html
- WebKit media playback policy: https://webkit.org/blog/6784/new-video-policies-for-ios/
- WebKit shared WASM memory issue: https://bugs.webkit.org/show_bug.cgi?id=281657
- WebKit WASM memory issue: https://bugs.webkit.org/show_bug.cgi?id=222097
- WebKit background AudioContext issue: https://bugs.webkit.org/show_bug.cgi?id=261554
