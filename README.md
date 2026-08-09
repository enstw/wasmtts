# Matcha 離線中文 TTS

本專案目前選定 Matcha `matcha-icefall-zh-en` 作為 iOS Safari／行動 PWA 離線中文朗讀的 TTS 模型。產品路徑以 Worker 在背景逐句執行 Matcha acoustic model、Vocos 與必要的音訊編碼，再把片段 append 到單一長駐 `ManagedMediaSource` timeline；不得預產整章或在句子、章節邊界重新建立播放器。

Matcha 在相同文本盲測得到 90 分，高於 Kokoro 的 80 分與 Piper HuaYan medium 的 60 分；上游建議的單執行緒 browser WASM＋中文 FST 配置為 `RTF 0.1411`，繁體小說原文不經 OpenCC 也能正確生成。固定文字路徑是「繁體直輸 → phone/date/number FST → Matcha」，生成配置採 `noise_scale=0.667`。目前 pilot 使用「ORT Web WASM（Matcha + Vocos）＋獨立 kaldifst/OpenFST text-normalizer WASM」，兩者各自使用 linear memory，不再載入固定 512 MiB heap 的 sherpa-onnx frontend bundle。目前工作集中在真實 iPhone 的峰值記憶體、鎖屏、溫度與長時間穩態驗證。Piper、Kokoro 與 VITS 文件只保留為模型選擇的歷史證據，不再是現行產品候選。

## 專案入口

- [GOAL.md](GOAL.md)：Matcha 選型決策、產品目標、驗收條件與下一步
- [frameworks/](frameworks/)：各框架的細節、benchmark 與最佳化紀錄
- [platform/](platform/)：統一 WASM 測試平台、runner、模型掛載點與原始結果
- [mobile-host/](mobile-host/)：供手機與平板實機連線的測試 host，以及 bookworm-derived 長篇鎖屏串流框架
- [AGENTS.md](AGENTS.md)：專案架構、慣例與代理操作命令

## 快速開始

安裝 JavaScript 相依套件：

```sh
pnpm install
```

Matcha 第三方模型權重不會提交至 repository。請將 acoustic model、Vocos 與所需 browser bundle 放在 `platform/models/`；實際路徑請參考 [平台說明](platform/README.md)。

首次使用先建置小型 kaldifst normalizer，再啟動具備 COOP／COEP headers 的測試 host：

```sh
pnpm build:matcha-kaldifst
pnpm host:mobile
```

在另一個終端機執行統一瀏覽器 benchmark：

```sh
pnpm benchmark:matcha
pnpm benchmark:matcha-upstream-fst
pnpm benchmark:matcha-stream
```

完整測試條件、原始數值與限制請見 [platform/RESULTS.md](platform/RESULTS.md)。

## 重現性

CPU 比例只適合在相同硬體、瀏覽器、量測邊界與執行緒設定下橫向比較；使用相同 runtime 時還必須固定其版本。文字前處理是否納入計時必須一致；不同取樣率、聲線、合成架構與輸出長度均記錄在結果文件中。標準 `RTF` 是產生可 append 音訊的 wall time 除以音訊長度，`realtime multiplier` 則是其倒數。任何輸出若含非有限值、peak 為零或 RMS 為零，均不得列入有效效能比較。

## License

目前 repository 為私人研究資料，尚未指定開源授權。模型權重各自受上游授權約束，未包含在版本庫中。
