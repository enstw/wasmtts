# WASM TTS 中文語音研究

本專案比較可在 iOS Safari 與行動 PWA 離線執行的中文 TTS，並以同一套 ONNX Runtime Web WASM 測試平台保存效能、正確性與音質證據。

目前的核心結論是：Piper HuaYan medium 仍是資源受限環境的實用基準；Kokoro fp32 可正常發聲但單線程成本過高；自行產生的 Kokoro selective INT8 修正了 NaN，卻沒有帶來速度優勢；AISHELL3 雖然最快，但音質不足以成為產品候選。

## 專案入口

- [GOAL.md](GOAL.md)：研究目標、已測框架目錄、判定標準與下一步
- [frameworks/](frameworks/)：各框架的細節、benchmark 與最佳化紀錄
- [platform/](platform/)：統一 WASM 測試平台、runner、模型掛載點與原始結果
- [mobile-host/](mobile-host/)：供手機與平板實機連線的測試 host
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
```

完整測試條件、原始數值與限制請見 [platform/RESULTS.md](platform/RESULTS.md)。

## 重現性

CPU 比例只適合在相同硬體、瀏覽器、ONNX Runtime Web 版本與執行緒設定下橫向比較。文字前處理在計時前完成；不同取樣率、聲線與輸出長度均記錄在結果文件中。任何輸出若含非有限值、peak 為零或 RMS 為零，均不得列入有效效能比較。

## License

目前 repository 為私人研究資料，尚未指定開源授權。模型權重各自受上游授權約束，未包含在版本庫中。
