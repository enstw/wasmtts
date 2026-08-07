# WASM TTS 中文語音研究

本專案比較可在 iOS Safari 與行動 PWA 離線執行、並能在鎖屏期間持續朗讀長篇小說的中文 TTS，並以技術中立的瀏覽器量測契約保存效能、正確性與音質證據。候選可以採純 JavaScript、Web Audio、WebAssembly 或系統語音，不限神經網路或 ONNX；目前的 ONNX Runtime Web harness 是第一個已實作的 adapter。鎖屏產品路徑不是預產章節，而是讓 RTF 小於 `1` 的引擎在背景逐句合成，再把編碼片段 append 到單一長駐 `ManagedMediaSource` timeline。

目前的核心結論是：Piper HuaYan medium 是 frozen 品質／效能基準，其 Worker、MP3 encoder 與鎖屏 transport 已由 `bookworm` 驗證，不是本專案要重做的研究。Matcha zh-en 在相同文本盲測得到 90 分，高於 Kokoro 的 80 分與 Piper 的 60 分；正式桌面瀏覽器單執行緒 `RTF` 約 `0.146`，已成為優先候選。下一步是完整前端／FST、峰值記憶體、MP3 append 與 iPhone 鎖屏熱穩態驗證。Kokoro fp32 品質通過但運算成本仍約為 Piper 的 `5.02x`，因此列為手機溫度與耗電較高的次要候選。AISHELL3 雖然最快，但音質不足。

## 專案入口

- [GOAL.md](GOAL.md)：研究目標、已測方案目錄、判定標準與下一步
- [frameworks/](frameworks/)：各框架的細節、benchmark 與最佳化紀錄
- [platform/](platform/)：統一 WASM 測試平台、runner、模型掛載點與原始結果
- [mobile-host/](mobile-host/)：供手機與平板實機連線的測試 host，以及 bookworm-derived 長篇鎖屏串流框架
- [AGENTS.md](AGENTS.md)：專案架構、慣例與代理操作命令

## 快速開始

安裝 JavaScript 相依套件：

```sh
pnpm install
```

第三方模型權重不會提交至 repository。請將模型放在 `platform/models/`，實際路徑可參考 [平台說明](platform/README.md)。

啟動具備 COOP／COEP headers 的測試 host：

```sh
pnpm host:mobile
```

在另一個終端機執行統一瀏覽器 benchmark：

```sh
pnpm benchmark:vits
pnpm benchmark:kokoro -- fp32
pnpm benchmark:matcha
```

完整測試條件、原始數值與限制請見 [platform/RESULTS.md](platform/RESULTS.md)。

## 重現性

CPU 比例只適合在相同硬體、瀏覽器、量測邊界與執行緒設定下橫向比較；使用相同 runtime 時還必須固定其版本。文字前處理是否納入計時必須一致；不同取樣率、聲線、合成架構與輸出長度均記錄在結果文件中。標準 `RTF` 是產生可 append 音訊的 wall time 除以音訊長度，`realtime multiplier` 則是其倒數。任何輸出若含非有限值、peak 為零或 RMS 為零，均不得列入有效效能比較。

## License

目前 repository 為私人研究資料，尚未指定開源授權。模型權重各自受上游授權約束，未包含在版本庫中。
