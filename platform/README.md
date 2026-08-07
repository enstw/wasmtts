# 統一 WASM 測試平台

本目錄集中所有跨方案共用的 browser pages、runner、分析工具、資產掛載點與測試結果。平台的共同量測契約不限定神經網路、ONNX 或 ONNX Runtime；現有檔案是已測神經模型的 ORT Web adapter，後續非神經方案可用自己的 JavaScript／WASM adapter 回傳同一組結果欄位。方案結論應寫在 `frameworks/<name>/`，跨方案原始數值則保留在此處。

## 目錄內容

- `benchmark.js`：保留的 sherpa-onnx Node WASM 對照 harness。
- `vits-browser.html`、`run-vits-browser.mjs`：Piper、AISHELL3 與 MeloTTS 的統一 ORT Web 路徑。
- `kokoro-browser.html`、`run-kokoro-browser.mjs`：Kokoro ORT Web、profiling、shape probe 與 thread 測試。
- `matcha-browser.html`、`run-matcha-browser.mjs`：Matcha acoustic model、Vocos 與 JavaScript ISTFT 的單執行緒 ORT Web 路徑。
- `cdp/`：browser-cdp 共用的 Chromium 探測與零相依 CDP client。
- `ort-operator-probe.html`、`run-ort-operator-probe.mjs`：獨立 operator microbenchmark。
- `*.py`：Kokoro 量化、驗證、graph／shape／MAC 分析與 probe 產生器。
- `models/`：本機第三方模型掛載點；已由 Git 忽略。
- `assets/`：非神經引擎的聲音資料、字典、規則與其他大型本機資產掛載點。
- `results/`：機器可讀 JSON、profile 與可實聽 WAV。
- `RESULTS.md`：共同環境、比較表、原始三輪摘要及重跑命令。

## 本機資產路徑

目前 runner 預期以下目錄名稱：

```text
platform/models/
├── kokoro-fp32/
├── kokoro-selective-int8/
├── kokoro-int8-multi-lang-v1_1/
├── matcha-icefall-zh-en/
├── vocos-16khz-univ.onnx
├── vits-icefall-zh-aishell3/
├── vits-melo-tts-zh_en/
└── vits-piper-zh_CN-huayan-medium/
```

非神經方案使用 `platform/assets/<engine>/` 保存本機聲音資料、字典或規則；adapter 不應假設所有候選都具有 ONNX 模型。

模型權重、聲音資料與下載產物不可提交。若使用不同路徑，請透過 runner 參數設定，或同步更新程式與方案文件。

## Adapter 契約

不論合成架構，每個 adapter 都應提供可比較的紀錄：

- 冷啟動與可選的暖機階段；不需要暖機時明確標記。
- 使用共同文本合成完整 waveform，至少回報文字輸入到 waveform 完成的端到端 wall time；可拆分時另回報文字前處理與核心合成時間，以及 CPU／task time。
- 回報取樣率、sample 數、音訊秒數、finite sample 數、peak 與 RMS。
- 記錄文字正規化、斷詞、音素化的計時邊界；不可因某個引擎無法拆分內部階段而排除它。
- 記錄合成架構、引擎、runtime、聲音／資產版本、下載大小與執行緒數。
- 另回報產品端到端 `RTF = 產生可 append 音訊的 wall time ÷ 音訊長度` 及其倒數 `realtime multiplier`；端到端範圍包含文字前處理、合成與必要的音訊編碼。
- 長篇模式逐句輸出可 append 的編碼片段，並以單一長駐 `HTMLAudioElement`、單一 `ManagedMediaSource`／`SourceBuffer` sequence timeline 跨越句子及章節；不得為每段建立新 element 或再次呼叫 `play()`。
- 串流 adapter 必須回報 buffer ahead 秒數、最高／最低水位、underflow 次數、append 錯誤、已裁切音訊與佇列大小；buffer 必須有界，refill 不可只依賴背景 timer。

播放 transport 的參考實作位於 [`mobile-host/continuous-stream-player.mjs`](../mobile-host/continuous-stream-player.mjs)，立即可用的 fixture 頁面為 [`mobile-host/stream-test.html`](../mobile-host/stream-test.html)。新的 TTS adapter 應實作相同 producer 契約，不要各自複製 MediaSource 狀態機。

Fixture 與 Piper transport 只驗證共同播放基礎設施，不產生可排名的 TTS 結果。新候選先通過相對 Piper 的語音品質 gate；只有通過者才需要量端到端 RTF 並接入鎖屏 transport。

## 執行

先從 repository 根目錄啟動 host：

```sh
pnpm host:mobile
```

再執行 benchmark：

```sh
pnpm benchmark:vits
pnpm benchmark:kokoro -- fp32
pnpm benchmark:matcha
```

Kokoro runner 支援 `--profile`、`--model-path`、`--shape-probe`、`--text`、`--output-suffix` 與 `--threads`。雙執行緒測試前必須確認頁面同時具備 `crossOriginIsolated === true` 與 `SharedArrayBuffer`。

## 結果規則

- 需要 JIT、weight packing 或 cache 的方案先暖機；不需要暖機的方案直接量測，兩者都量三輪並取中位數。
- 主比較在適用時固定單一 WASM thread；CPU 指標優先採 Chromium CDP `Performance.TaskDuration`。
- 現有 ORT 主表不含文字前處理；新的跨 runtime 比較至少保存端到端時間，可拆分時再提供核心合成時間。
- waveform 必須全為有限值，且 peak、RMS 皆不可為零。
- 不同瀏覽器或 runtime 版本的結果只能在明確標示的 A/B 組內比較。
- 核心合成 benchmark 與鎖屏 transport 可分開診斷，但候選資格必須另通過整合測試：鎖屏期間持續合成並 append，跨章播放不中斷且端到端 RTF 持續小於 `1`。

詳細數值請見 [RESULTS.md](RESULTS.md)。
