# WASM TTS 中文語音研究

在單執行緒 WebAssembly 環境比較可用於 iOS Safari 與行動 PWA 的離線中文 TTS。

本專案以 Piper HuaYan medium 產生 10 秒語音的 CPU 時間為 `1x`，在統一 Chromium／ONNX Runtime Web WASM 環境比較 HuaYan、AISHELL3、MeloTTS 與 Kokoro。除了效能，也保存可播放樣本，記錄中文腔調、標點斷句、量化模型正確性及瀏覽器相容性。

## 目前結論

- Piper HuaYan medium 是基準 `1.00x`，模型與執行成本適合資源有限的 PWA，但中文自然度有限。
- AISHELL3 約 `0.45x`，CPU footprint 最低；試聽仍有明顯非母語感。
- MeloTTS 約 `9.16x`，在單執行緒 WASM 上成本偏高。
- Kokoro v1.1-zh fp32 約 `9.03x`，可正常產生中文語音。
- Kokoro v1.1-zh q8 在目前的 ORT Web WASM 組合輸出全部為非有限值，不能把無聲結果當成有效 benchmark。

詳細測試條件、原始數據與限制請見 [research.md](research.md) 和 [benchmarks/RESULTS.md](benchmarks/RESULTS.md)。

## 安裝

需要 Node.js 與 pnpm。瀏覽器 benchmark 另需本機 Chromium／Chrome 與相應模型檔。

```sh
pnpm install
```

第三方模型權重未收進 repository。下載模型後放入 `benchmarks/models/`，路徑配置可參考 `benchmarks/benchmark.js`、`benchmarks/vits-browser.html` 與 `benchmarks/kokoro-browser.html`。

## 執行 benchmark

```sh
node benchmarks/run-vits-browser.mjs
node benchmarks/run-kokoro-browser.mjs --dtype fp32
```

執行腳本會啟動本機 HTTP server，透過 Chromium CDP 收集 `Performance.TaskDuration`，並將結果寫入 `benchmarks/results/`。

## 目錄

- `research.md`：研究結論、候選方案及 iOS Safari／PWA 評估
- `benchmarks/`：瀏覽器測試 harness、輸入處理、結果與試聽檔
- `samples/`：HuaYan 標點與斷句實驗樣本

## 重現性說明

CPU 比例只適合在相同硬體、瀏覽器、ORT Web 版本與單執行緒設定下橫向比較。文字前處理在計時前完成；不同取樣率、聲線與輸出長度均記錄在結果文件中。

## License

目前 repository 為私人研究資料，尚未指定開源授權。模型權重各自受上游授權約束，未包含在版本庫中。
