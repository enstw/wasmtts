# WASM TTS 中文語音研究

在單執行緒 WebAssembly 環境比較可用於 iOS Safari 與行動 PWA 的離線中文 TTS。

本專案以 Piper HuaYan medium 產生 10 秒語音的 CPU 時間為 `1x`，在統一 Chromium／ONNX Runtime Web WASM 環境比較 HuaYan、AISHELL3、MeloTTS 與 Kokoro。除了效能，也保存可播放樣本，記錄中文腔調、標點斷句、量化模型正確性及瀏覽器相容性。

## 目前結論

- Piper HuaYan medium 是基準 `1.00x`，模型與執行成本適合資源有限的 PWA，但中文自然度有限。
- AISHELL3 約 `0.45x`，CPU footprint 最低；本次主觀實聽只有 `3/10`，且仍有明顯外國腔，因此只保留為效能參考，不列入產品候選。
- MeloTTS 約 `9.16x`，在單執行緒 WASM 上成本偏高。
- Kokoro v1.1-zh fp32 約 `9.03x`，可正常產生中文語音。
- 上游 Kokoro v1.1-zh int8／q8 在目前的 ORT Web WASM 組合輸出全部為非有限值，不能把無聲結果當成有效 benchmark。
- 本專案從 FP32 產生的 selective INT8 已能正常發聲；模型縮小 `8.3%`，但同一瀏覽器的單線程 WASM 速度比 FP32 慢約 `0.9%`，目前是正確性基線，不是效能最佳化成果。

詳細測試條件、原始數據與限制請見 [research.md](research.md) 和 [benchmarks/RESULTS.md](benchmarks/RESULTS.md)。

## 安裝

需要 Node.js 與 pnpm。瀏覽器 benchmark 另需本機 Chromium／Chrome 與相應模型檔。

```sh
pnpm install
```

第三方模型權重未收進 repository。下載模型後放入 `benchmarks/models/`，路徑配置可參考 `benchmarks/benchmark.js`、`benchmarks/vits-browser.html` 與 `benchmarks/kokoro-browser.html`。

## 執行 benchmark

```sh
pnpm exec node benchmarks/run-vits-browser.mjs
pnpm exec node benchmarks/run-kokoro-browser.mjs fp32
```

執行腳本會啟動本機 HTTP server，透過 Chromium CDP 收集 `Performance.TaskDuration`，並將結果寫入 `benchmarks/results/`。

## 從 FP32 產生 selective INT8

第一版只動態量化 decoder 以外的 `MatMul` 與 `LSTM` 權重；`/decoder/`、全部 `Conv`／`ConvTranspose`、vocoder 與 STFT 保持 FP32。這是針對上游全量 int8／q8 在 STFT phase 路徑產生 NaN 的保守修正。

```sh
uv run benchmarks/quantize-kokoro.py \
  benchmarks/models/kokoro-fp32/model.onnx \
  benchmarks/models/kokoro-selective-int8/model.onnx

uv run benchmarks/validate-kokoro-onnx.py \
  benchmarks/models/kokoro-selective-int8/model.onnx \
  --tokens benchmarks/models/kokoro-selective-int8/tokens.txt \
  --lexicon benchmarks/models/kokoro-selective-int8/lexicon-zh.txt \
  --voices benchmarks/models/kokoro-selective-int8/voices.bin
```

量化腳本會執行 ONNX checker，並修正 ONNX Runtime 量化器未考慮 control-flow implicit input 所造成的節點排序。瀏覽器驗證可先以 `uv run python -m http.server 8765` 啟動本機 server，再用 gstack browse 開啟 `benchmarks/kokoro-browser.html`；`benchmarks/run-kokoro-gstack.js` 第一次執行會初始化，第二次暖機，之後每次量一輪。

## 目錄

- `research.md`：研究結論、候選方案及 iOS Safari／PWA 評估
- `benchmarks/`：瀏覽器測試 harness、輸入處理、結果與試聽檔
- `samples/`：HuaYan 標點與斷句實驗樣本

## 重現性說明

CPU 比例只適合在相同硬體、瀏覽器、ORT Web 版本與單執行緒設定下橫向比較。文字前處理在計時前完成；不同取樣率、聲線與輸出長度均記錄在結果文件中。

## License

目前 repository 為私人研究資料，尚未指定開源授權。模型權重各自受上游授權約束，未包含在版本庫中。
