# 離線中文 TTS 研究目標與方案目錄

更新日期：2026-08-07

## 目標

找出能在 iOS Safari 與行動 PWA 中離線執行的中文 TTS 方案，並用統一、可重現的瀏覽器測試方法同時評估。實作可以是純 JavaScript、JavaScript 搭配 Web Audio 原生節點、WebAssembly，或作為另外一組基線的系統 `speechSynthesis`。

本研究不預設 TTS 必須採用神經網路，也不以 WASM 或 ONNX 相容性作為候選門檻。神經網路、統計參數式、拼接式／單元選擇、diphone、共振峰、規則式及混合式合成都在範圍內；ONNX Runtime Web 只是目前已測神經模型使用的一個 adapter。系統語音若不能保證離線、固定聲線或取得 waveform，仍可作產品基線，但必須與可完全封裝的引擎分組評估。

- 輸出正確性：waveform 必須全為有限值，且 peak、RMS 皆不可為零。
- 單線程效能：以產生 10 秒音訊所需的 CPU／task time 比較；產品串流另量端到端 `RTF = 產生可 append 音訊的 wall time ÷ 音訊長度`，必須小於 `1`。
- 行動端成本：引擎、聲音資料與其他資產的總下載大小、WASM heap、初始化時間及執行緒需求。
- 語音品質：普通話腔調、韻律、標點斷句與產品可接受度。
- 部署可行性：iOS Safari、PWA lifecycle、音訊解鎖、鎖屏持續播放及失敗降級。

核心產品情境是朗讀數百萬字的小說，不能預先產生整本或在章節邊界停下來補產。使用者以一次前景手勢啟動長駐的 `HTMLAudioElement` 後，TTS 必須在鎖屏期間持續逐句產生音訊、編碼成可 append 的片段，並加入同一條媒體 timeline；章節只是文字與位置資訊，不得成為音訊播放邊界。Web Audio 可以作合成／處理工具，但不得成為 iOS 鎖屏播放的唯一 transport。

`bookworm` 已在 iOS Home Screen PWA 實證這條路徑：Piper `zh_CN-huayan-medium` 以 ONNX Runtime Web WASM 單一 thread 在 Worker 中持續合成，句子單元經 MP3 編碼後 append 到單一 `ManagedMediaSource`／`SourceBuffer` sequence timeline，鎖屏期間可繼續合成與播放。這證明純 PWA 路徑是正式候選，但結果仍須連同裝置、iOS 版本、鎖屏時長、buffer 水位與中斷恢復行為保存，不可推論為所有 WebKit 版本都相同。

本專案固定使用標準定義 `RTF = 合成 wall time ÷ 音訊長度`，越低越好；`realtime multiplier = 音訊長度 ÷ 合成 wall time = 1 / RTF`，越高越好。`RTF < 1` 是持續串流的必要條件，還必須保留足以吸收背景排程、熱降頻與單句波動的餘裕。

Piper `zh_CN-huayan-medium` 是效能基準 `1.00x`。速度較快不代表品質合格；無效或靜音 waveform 也不得列入排名。

## 已測方案目錄

| 方案 | 架構 | 有效輸出 | 10 秒音訊時間 | 相對 Piper | 目前判定 | 詳細紀錄 |
|---|---|---:|---:|---:|---|---|
| Piper HuaYan medium | 神經網路（VITS） | 是 | 1.576 秒 | 1.00x | 資源受限環境的基準與候選 | [Piper](frameworks/piper/README.md) |
| VITS AISHELL3（sid 66） | 神經網路（VITS） | 是 | 0.708 秒 | 0.45x | 最快，但 8 kHz 與音質不足，只保留為技術參考 | [VITS](frameworks/vits/README.md) |
| VITS MeloTTS zh/en | 神經網路（VITS） | 是 | 14.427 秒 | 9.16x | 單線程慢於即時，不作為行動端主引擎 | [VITS](frameworks/vits/README.md) |
| Kokoro v1.1 zh fp32 | 神經網路（Kokoro） | 是 | 14.225 秒 | 9.03x | 音訊有效，但單線程成本與模型大小過高 | [Kokoro](frameworks/kokoro/README.md) |
| Kokoro 上游 int8／q8 | 神經網路（Kokoro） | 否 | — | — | waveform 含非有限值，不得作為 benchmark | [Kokoro](frameworks/kokoro/README.md) |
| Kokoro selective INT8 | 神經網路（Kokoro） | 是 | 15.182 秒 wall time | 1.009x 相對同輪 fp32 | 正確性基線；縮小 8.3%，但未加速 | [Kokoro](frameworks/kokoro/README.md) |

主比較採 Chromium 149、ONNX Runtime Web WASM、單一 thread 與 CDP `TaskDuration`。Selective INT8 A/B 使用不同瀏覽器版本，因此只可在該組內互相比較。

目前目錄只包含神經網路方案，這是測試覆蓋缺口，不是研究範圍限制。下一批候選應刻意涵蓋至少一個可在瀏覽器離線執行的非神經方案，量化它在體積、速度、記憶體與中文自然度之間的取捨。

## 完成條件

一個方案只有在以下證據齊全後，才能從「已測」升級為「行動端候選」：

- 統一平台保存三輪測試、環境版本、引擎／聲音資料識別、合成架構與機器可讀 JSON。
- 有效音訊檢查通過，並保存至少一個可實聽樣本。
- 在目標 iPhone／iPad 上完成首次載入、連續合成、背景切換與低記憶體測試。
- 使用者只需一次前景手勢啟動播放；鎖屏後，方案持續合成並把片段 append 到同一條長駐媒體 timeline，不得在句子或章節邊界呼叫新的 `play()`。
- 端到端 RTF 在目標裝置上持續小於 `1`，buffer 不枯竭且有界；測試不得以預先產生完整章節或完整測試音訊規避背景合成。
- 至少完成連續鎖屏 2 小時且跨越 3 個章節的驗收，期間沒有可聽停頓、使用者回前景補產或隨時間持續成長的音訊佇列。
- Safari tab 與 Home Screen PWA 必須分開驗證；不得以 `AudioContext.state === "running"` 取代實際可聽輸出測試。
- 記錄引擎、runtime、模型或聲音資料的授權、總下載大小及峰值記憶體。
- 音質由目標語料評估，不以 CPU 數字替代主觀品質判定。

## 下一步

- 將 Piper Worker 與 MP3 encoder 接到 [mobile-host](mobile-host/) 已落地的通用 producer 介面，讓 fixture transport 測試升級為真實端到端 TTS RTF 測試。
- 透過 [mobile-host](mobile-host/) 在真實 iOS Safari 與 Home Screen PWA 重跑至少 2 小時的跨章背景合成、鎖屏播放、音訊中斷恢復，以及可用時的雙執行緒測試。
- 接入至少一個非神經中文 TTS，優先比較純 JavaScript／Web Audio 共振峰原型與規則式 WASM 引擎的體積、CPU 和中文品質。
- 為 Piper 補齊 x_low 與 medium 的同機 A/B、峰值記憶體及較舊 iPhone 壓力測試。
- 將 Kokoro 的下一階段集中在需重新訓練／蒸餾的輕量 vocoder，而不是繼續擴大量化範圍。
- 將新方案透過符合共同量測契約的 adapter 接入 [統一測試平台](platform/README.md)；不要求使用 ONNX，並避免另建不可比較的 ad-hoc harness。
