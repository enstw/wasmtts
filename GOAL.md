# WASM TTS 研究目標與框架目錄

更新日期：2026-08-07

## 目標

找出能在 iOS Safari 與行動 PWA 中離線執行的中文 TTS 方案，並用統一、可重現的 WebAssembly 測試方法同時評估：

- 輸出正確性：waveform 必須全為有限值，且 peak、RMS 皆不可為零。
- 單線程效能：以產生 10 秒音訊所需的 CPU／task time 比較。
- 行動端成本：模型大小、WASM heap、初始化時間與執行緒需求。
- 語音品質：普通話腔調、韻律、標點斷句與產品可接受度。
- 部署可行性：iOS Safari、PWA lifecycle、音訊解鎖及失敗降級。

Piper `zh_CN-huayan-medium` 是效能基準 `1.00x`。速度較快不代表品質合格；無效或靜音 waveform 也不得列入排名。

## 已測框架目錄

| 框架／模型 | 有效輸出 | 10 秒音訊時間 | 相對 Piper | 目前判定 | 詳細紀錄 |
|---|---:|---:|---:|---|---|
| Piper HuaYan medium | 是 | 1.576 秒 | 1.00x | 資源受限環境的基準與候選 | [Piper](frameworks/piper/README.md) |
| VITS AISHELL3（sid 66） | 是 | 0.708 秒 | 0.45x | 最快，但 8 kHz 與音質不足，只保留為技術參考 | [VITS](frameworks/vits/README.md) |
| VITS MeloTTS zh/en | 是 | 14.427 秒 | 9.16x | 單線程慢於即時，不作為行動端主引擎 | [VITS](frameworks/vits/README.md) |
| Kokoro v1.1 zh fp32 | 是 | 14.225 秒 | 9.03x | 音訊有效，但單線程成本與模型大小過高 | [Kokoro](frameworks/kokoro/README.md) |
| Kokoro 上游 int8／q8 | 否 | — | — | waveform 含非有限值，不得作為 benchmark | [Kokoro](frameworks/kokoro/README.md) |
| Kokoro selective INT8 | 是 | 15.182 秒 wall time | 1.009x 相對同輪 fp32 | 正確性基線；縮小 8.3%，但未加速 | [Kokoro](frameworks/kokoro/README.md) |

主比較採 Chromium 149、ONNX Runtime Web WASM、單一 thread 與 CDP `TaskDuration`。Selective INT8 A/B 使用不同瀏覽器版本，因此只可在該組內互相比較。

## 完成條件

一個框架只有在以下證據齊全後，才能從「已測」升級為「行動端候選」：

- 統一平台保存三輪測試、環境版本、模型識別與機器可讀 JSON。
- 有效音訊檢查通過，並保存至少一個可實聽樣本。
- 在目標 iPhone／iPad 上完成首次載入、連續合成、背景切換與低記憶體測試。
- 記錄模型與 runtime 的授權、下載大小及峰值記憶體。
- 音質由目標語料評估，不以 CPU 數字替代主觀品質判定。

## 下一步

- 透過 [mobile-host](mobile-host/) 在真實 iOS Safari 重跑單線程與可用時的雙執行緒測試。
- 為 Piper 補齊 x_low 與 medium 的同機 A/B、峰值記憶體及較舊 iPhone 壓力測試。
- 將 Kokoro 的下一階段集中在需重新訓練／蒸餾的輕量 vocoder，而不是繼續擴大量化範圍。
- 將新框架接入 [統一測試平台](platform/README.md)，避免另建不可比較的 ad-hoc harness。
