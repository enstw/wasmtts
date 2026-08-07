# 統一 WASM 測試平台

本目錄集中所有跨框架共用的 browser pages、runner、分析工具、模型掛載點與測試結果。框架結論應寫在 `frameworks/<name>/`，跨框架原始數值則保留在此處。

## 目錄內容

- `benchmark.js`：保留的 sherpa-onnx Node WASM 對照 harness。
- `vits-browser.html`、`run-vits-browser.mjs`：Piper、AISHELL3 與 MeloTTS 的統一 ORT Web 路徑。
- `kokoro-browser.html`、`run-kokoro-browser.mjs`：Kokoro ORT Web、profiling、shape probe 與 thread 測試。
- `ort-operator-probe.html`、`run-ort-operator-probe.mjs`：獨立 operator microbenchmark。
- `*.py`：Kokoro 量化、驗證、graph／shape／MAC 分析與 probe 產生器。
- `models/`：本機第三方模型掛載點；已由 Git 忽略。
- `results/`：機器可讀 JSON、profile 與可實聽 WAV。
- `RESULTS.md`：共同環境、比較表、原始三輪摘要及重跑命令。

## 模型路徑

目前 runner 預期以下目錄名稱：

```text
platform/models/
├── kokoro-fp32/
├── kokoro-selective-int8/
├── kokoro-int8-multi-lang-v1_1/
├── vits-icefall-zh-aishell3/
├── vits-melo-tts-zh_en/
└── vits-piper-zh_CN-huayan-medium/
```

模型權重與下載產物不可提交。若使用不同路徑，請透過 runner 參數設定，或同步更新程式與框架文件。

## 執行

先從 repository 根目錄啟動 host：

```sh
pnpm host:mobile
```

再執行 benchmark：

```sh
pnpm benchmark:vits
pnpm benchmark:kokoro -- fp32
```

Kokoro runner 支援 `--profile`、`--model-path`、`--shape-probe`、`--text`、`--output-suffix` 與 `--threads`。雙執行緒測試前必須確認頁面同時具備 `crossOriginIsolated === true` 與 `SharedArrayBuffer`。

## 結果規則

- 每個模型先暖機，再量三輪並取中位數。
- 主比較固定單一 WASM thread，CPU 指標為 Chromium CDP `Performance.TaskDuration`。
- 文字前處理不納入推論時間。
- waveform 必須全為有限值，且 peak、RMS 皆不可為零。
- 不同瀏覽器或 runtime 版本的結果只能在明確標示的 A/B 組內比較。

詳細數值請見 [RESULTS.md](RESULTS.md)。
