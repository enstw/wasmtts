# Matcha 離線中文 TTS 產品目標與選型紀錄

更新日期：2026-08-09

## 目標

將已選定的 Matcha `matcha-icefall-zh-en` 完成為可在 iOS Safari 與 Home Screen PWA 離線執行、並在鎖屏期間持續朗讀長篇小說的中文 TTS。選型階段已結束；除非產品需求或實機驗收證明 Matcha 不可行，本 repository 不再主動搜尋、下載或最佳化其他模型。

選定的合成與文字路徑是「繁體直輸 → 官方 `phone/date/number` FST → Matcha acoustic model → Vocos → ISTFT → silence scaling → MP3 encode」，Matcha 生成配置採 `noise_scale=0.667`。目前 pilot 以獨立的小型 kaldifst + OpenFST WASM 套用三個原始 FST tables；Matcha 與 Vocos 共用 ORT Web WASM，兩個 runtime 各自使用獨立 linear memory，不需固定 512 MiB heap 的 sherpa-onnx frontend bundle。

- 輸出正確性：waveform 必須全為有限值，且 peak、RMS 皆不可為零。
- 單線程效能：以產生 10 秒音訊所需的 CPU／task time 比較；產品串流另量端到端 `RTF = 產生可 append 音訊的 wall time ÷ 音訊長度`，必須小於 `1`。
- 行動端成本：引擎、聲音資料與其他資產的總下載大小、WASM heap、初始化時間及執行緒需求。
- 語音品質：普通話腔調、韻律、標點斷句與產品可接受度。
- 部署可行性：iOS Safari、PWA lifecycle、音訊解鎖、鎖屏持續播放及失敗降級。

核心產品情境是朗讀數百萬字的小說，不能預先產生整本或在章節邊界停下來補產。使用者以一次前景手勢啟動長駐的 `HTMLAudioElement` 後，TTS 必須在鎖屏期間持續逐句產生音訊、編碼成可 append 的片段，並加入同一條媒體 timeline；章節只是文字與位置資訊，不得成為音訊播放邊界。Web Audio 可以作合成／處理工具，但不得成為 iOS 鎖屏播放的唯一 transport。

`bookworm` 已在 iOS Home Screen PWA 實證這條路徑：Piper `zh_CN-huayan-medium` 以 ONNX Runtime Web WASM 單一 thread 在 Worker 中持續合成，句子單元經 MP3 編碼後 append 到單一 `ManagedMediaSource`／`SourceBuffer` sequence timeline，鎖屏期間可繼續合成與播放。這證明純 PWA 路徑是正式候選，但結果仍須連同裝置、iOS 版本、鎖屏時長、buffer 水位與中斷恢復行為保存，不可推論為所有 WebKit 版本都相同。

上述 Piper Worker、MP3 encoder 與播放 transport 視為已驗證的基礎設施，不是本專案的研究變數，也不需要在此重做效能或長時間鎖屏實驗。`mobile-host` 保存的通用播放器是 Matcha producer 的產品相容性接點；後續資源集中在 Matcha 的資產體積、記憶體與實機穩態。

本專案固定使用標準定義 `RTF = 合成 wall time ÷ 音訊長度`，越低越好；`realtime multiplier = 音訊長度 ÷ 合成 wall time = 1 / RTF`，越高越好。`RTF < 1` 是持續串流的必要條件，還必須保留足以吸收背景排程、熱降頻與單句波動的餘裕。

Piper `zh_CN-huayan-medium` 是效能基準 `1.00x`。速度較快不代表品質合格；無效或靜音 waveform 也不得列入排名。

## 選型決策

| 方案 | 架構 | 有效輸出 | 10 秒音訊時間 | 相對 Piper | 目前判定 | 詳細紀錄 |
|---|---|---:|---:|---:|---|---|
| Piper HuaYan medium | 神經網路（VITS） | 是 | 1.576 秒 | 1.00x | Frozen 歷史基準，不是現行模型 | [Piper](frameworks/piper/README.md) |
| VITS AISHELL3（sid 66） | 神經網路（VITS） | 是 | 0.708 秒 | 0.45x | 最快，但 8 kHz 與音質不足，只保留為技術參考 | [VITS](frameworks/vits/README.md) |
| VITS MeloTTS zh/en | 神經網路（VITS） | 是 | 14.427 秒 | 9.16x | 單線程慢於即時，不作為行動端主引擎 | [VITS](frameworks/vits/README.md) |
| Kokoro v1.1 zh fp32 | 神經網路（Kokoro） | 是 | 14.225 秒 | 9.03x | 品質通過但成本過高，保留為歷史品質參考 | [Kokoro](frameworks/kokoro/README.md) |
| Matcha icefall zh-en | 神經網路（Matcha + Vocos） | 是 | 1.467 秒 | 約 0.93x* | **目前選定模型**；盲測 90 分、單執行緒 RTF 0.147 | [Matcha](frameworks/matcha/README.md) |
| Kokoro 上游 int8／q8 | 神經網路（Kokoro） | 否 | — | — | waveform 含非有限值，不得作為 benchmark | [Kokoro](frameworks/kokoro/README.md) |
| Kokoro selective INT8 | 神經網路（Kokoro） | 是 | 15.182 秒 wall time | 1.009x 相對同輪 fp32 | 正確性基線；縮小 8.3%，但未加速 | [Kokoro](frameworks/kokoro/README.md) |

Piper、VITS 與 Kokoro 主比較採 Chromium 149；Matcha 採 Chromium 151。兩組都使用 ONNX Runtime Web WASM、單一 thread 與 CDP `TaskDuration`，但 Matcha 的 `約 0.93x*` 只可作跨版本方向性參考，不能解讀為嚴格的相對加速。Selective INT8 A/B 另使用不同瀏覽器版本，因此只可在該組內互相比較。

Kokoro fp32 已通過主觀品質門檻，但單執行緒只有約 `0.70x realtime`，且桌面雙執行緒仍需約 `5.02x` Piper 運算成本。它不在目前產品路徑；既有數據僅保留為 Matcha 選型的品質與成本對照，不再安排模型下載、量化或實機驗證。

Matcha `matcha-icefall-zh-en` 使用相同五句中文做三方盲測後得到 `90/100`，高於 Kokoro 的 `80/100` 與 Piper 的 `60/100`；Piper 另被標記有外國腔。上游 `sherpa-onnx 1.12.20` 官方 browser SIMD bundle 以建議的 `phone-zh.fst,date-zh.fst,number-zh.fst`、`noise_scale=0.667`、單一 thread 測得小說 task `RTF 0.1411`，約 `7.09x realtime`；含日期、時間、電話及百分比的原始數字語料同為 `RTF 0.1411`。繁體小說原文不經 OpenCC 亦成功產生 26.73 秒有效音訊，使用者已確認品質沒有問題；這些證據構成目前選定 Matcha 的依據。2026-08-09 的純 JavaScript FST 基線測得完整 desktop producer `RTF 0.1376`、`7.27x realtime`。同日改用獨立 kaldifst WASM 的正式重跑測得 `RTF 0.1387`、`7.21x realtime`，10 個 append、51.336 秒音訊且無 underflow 或錯誤；初始化記憶體快照為 290.5 MB，含 normalizer 的獨立 16 MiB linear memory。兩者都不承擔官方 frontend bundle 固定 512 MiB heap；快照不得解讀為真正 peak 或 iPhone 結果。

2026-08-08 的 iPhone Safari LAN HTTP 初測確認低記憶體 JavaScript lexicon adapter 可完成模型下載、初始化、繁體直輸、前景播放與鎖屏播放；`ManagedMediaSource` 必須依 WebKit 要求在長駐 media element 設定 `disableRemotePlayback=true`。本輪不是 secure context 或 standalone PWA，且未達 2 小時／3 章、熱與耗電門檻，只能視為初步相容性證據。實聽發現引號 acoustic tokens 會發音後，已改為在 tokenization 前移除中英文開閉引號並加入迴歸測試。臺灣讀音覆寫目前只有「垃圾」；完整、有來源的詞典與「堤壩」等區域讀音留待另案開發。

## Matcha 完成條件

Matcha 的選型已完成；以下證據齊全後，才可宣告 iOS／PWA 產品路徑完成：

- 統一平台保存三輪測試、環境版本、引擎／聲音資料識別、合成架構與機器可讀 JSON。
- 有效音訊檢查通過，並保存至少一個可實聽樣本。
- 使用目標小說語料完成長章節、對話、破音字、數字、日期、中英混讀、罕見字與長時間耐聽度檢查。
- 在目標 iPhone／iPad 上完成首次載入、連續合成、背景切換與低記憶體測試。
- 使用者只需一次前景手勢啟動播放；鎖屏後，方案持續合成並把片段 append 到同一條長駐媒體 timeline，不得在句子或章節邊界呼叫新的 `play()`。
- 端到端 RTF 在目標裝置上持續小於 `1`，buffer 不枯竭且有界；測試不得以預先產生完整章節或完整測試音訊規避背景合成。
- 至少完成連續鎖屏 2 小時且跨越 3 個章節的驗收，期間沒有可聽停頓、使用者回前景補產或隨時間持續成長的音訊佇列。
- Safari tab 與 Home Screen PWA 必須分開驗證；不得以 `AudioContext.state === "running"` 取代實際可聽輸出測試。
- 記錄引擎、runtime、模型或聲音資料的授權、總下載大小及峰值記憶體。
- 音質由目標語料評估，不以 CPU 數字替代主觀品質判定。

## 下一步

- 完成獨立 kaldifst WASM 與既有 JavaScript applier 的完整 golden A/B，維持 phone、date、number 固定順序；JavaScript 版本暫留作診斷基線。
- 將英文 eSpeak 接入目前的「繁體直輸 → 官方中文 FST → Matcha」producer。
- 在真實 iPhone／iPad 量測峰值記憶體、端到端 RTF、鎖屏熱穩態、耗電與降頻。
- 分別在 Safari tab 與 Home Screen PWA 完成 2 小時、跨 3 章、Media Session 與中斷恢復驗收。
- 補齊英文 eSpeak、貨幣／範圍／序號等文字正規化，以及可審核的臺灣讀音詞典。
- 在產品採用前釐清 Matcha acoustic model、Vocos、lexicon、FST 與聲音資料的授權。
