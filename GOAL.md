# Matcha 離線中文 TTS 產品目標與選型紀錄

更新日期：2026-08-12

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

上述 Piper Worker、MP3 encoder 與播放 transport 視為已驗證的基礎設施，不是本專案的研究變數，也不需要在此重做效能或長時間鎖屏實驗。`mobile-host` 保存的通用播放器是 Matcha producer 的產品相容性接點；後續資源集中在 Matcha 的資產體積、記憶體與串流整合。

本專案固定使用標準定義 `RTF = 合成 wall time ÷ 音訊長度`，越低越好；`realtime multiplier = 音訊長度 ÷ 合成 wall time = 1 / RTF`，越高越好。`RTF < 1` 是持續串流的必要條件，還必須保留足以吸收背景排程、熱降頻與單句波動的餘裕。

Piper `zh_CN-huayan-medium` 是效能基準 `1.00x`。速度較快不代表品質合格；無效或靜音 waveform 也不得列入排名。

## 選型決策

目前開放權重 TTS 的英文、zh_CN、zh_TW 尺寸、授權與公開品質證據整理於 [開放權重 neural TTS 模型比較](frameworks/MODEL-COMPARISON.md)。該文件保存市場快照與 server／teacher 候選；本節只記錄本 repository 以相同 harness 得到的可重現選型證據，兩者不可混為同一排行榜。

| 方案 | 架構 | 有效輸出 | 10 秒音訊時間 | 相對 Piper | 目前判定 | 詳細紀錄 |
|---|---|---:|---:|---:|---|---|
| Piper HuaYan medium | 神經網路（VITS） | 是 | 1.576 秒 | 1.00x | Frozen 歷史基準，不是現行模型 | [Piper](frameworks/piper/README.md) |
| VITS AISHELL3（sid 66） | 神經網路（VITS） | 是 | 0.708 秒 | 0.45x | 最快，但 8 kHz 與音質不足，只保留為技術參考 | [VITS](frameworks/vits/README.md) |
| VITS MeloTTS zh/en | 神經網路（VITS） | 是 | 14.427 秒 | 9.16x | 單線程慢於即時，不作為行動端主引擎 | [VITS](frameworks/vits/README.md) |
| MediaTek Breeze2-VITS | 神經網路（VITS） | 是 | 13.617 秒 | 約 8.64x* | 尺寸略小於 Matcha，但同輪推論慢 10.00x；不進入產品路徑 | [VITS](frameworks/vits/README.md) |
| Fanchen WNJ VITS | 神經網路（VITS） | 是 | 10.261 秒 | 約 6.51x* | 尺寸略小於 Matcha，但 `RTF 1.026` 仍慢於即時；不進入產品路徑 | [VITS](frameworks/vits/README.md) |
| Kokoro v1.1 zh fp32 | 神經網路（Kokoro） | 是 | 14.225 秒 | 9.03x | 品質通過但成本過高，保留為歷史品質參考 | [Kokoro](frameworks/kokoro/README.md) |
| Matcha icefall zh-en | 神經網路（Matcha + Vocos） | 是 | 1.361 秒 | 約 0.86x* | **目前選定模型**；盲測 90 分、單執行緒 RTF 0.136 | [Matcha](frameworks/matcha/README.md) |
| Kokoro 上游 int8／q8 | 神經網路（Kokoro） | 否 | — | — | waveform 含非有限值，不得作為 benchmark | [Kokoro](frameworks/kokoro/README.md) |
| Kokoro selective INT8 | 神經網路（Kokoro） | 是 | 15.182 秒 wall time | 1.009x 相對同輪 fp32 | 正確性基線；縮小 8.3%，但未加速 | [Kokoro](frameworks/kokoro/README.md) |

Piper、AISHELL3、MeloTTS 與 Kokoro 主比較採 Chromium 149；Matcha、Breeze2 與 Fanchen WNJ 採 Chromium 151。全部使用 ONNX Runtime Web WASM、單一 thread 與 CDP `TaskDuration`，但星號標示的相對 Piper 數字只可作跨版本方向性參考。Breeze2、Fanchen WNJ 與 Matcha 使用同一 Chromium `151.0.7922.108` 與 ORT Web `1.27.0`；前兩者的運算成本分別是 Matcha 的 `10.00x` 與 `7.54x`。Selective INT8 A/B 另使用不同瀏覽器版本，因此只可在該組內互相比較。

Kokoro fp32 已通過主觀品質門檻，但單執行緒只有約 `0.70x realtime`，且桌面雙執行緒仍需約 `5.02x` Piper 運算成本。它不在目前產品路徑；既有數據僅保留為 Matcha 選型的品質與成本對照，不再安排模型下載、量化或實機驗證。

依使用者明確要求，2026-08-11 將 MediaTek `Breeze2-VITS-onnx` 作為 controlled challenger 試跑。模型、lexicon 與 tokens 合計 123,600,935 bytes（117.9 MiB），比 Matcha acoustic＋Vocos 129,599,930 bytes（123.6 MiB）小 4.6%；初始化記憶體快照 347,015,862 bytes（330.9 MiB）則沒有優於 Matcha 完整 producer 的 341,536,495 bytes（325.7 MiB）。同環境單 thread task `RTF` 為 `1.3617`，對 Matcha `0.1361`，完整 VITS graph 慢 `10.00x` 且未達即時。這次只量整個 `session.run()`，尚未將 encoder／duration、flow 與 neural waveform decoder 分段，因此 graph inspection 雖指出直接 waveform decoder 是主要嫌疑之一，不能宣稱它單獨造成全部差距。Breeze2 已經做到約 Matcha 尺寸，失敗點是 CPU 而不是模型下載；因此不更換現行選型。若未來要保存 Breeze 聲線，研究目標應改為以授權允許的合成資料微調 16 kHz 小型 Matcha student，並以 `RTF < 0.3`、記憶體不高於 Matcha、ASR CER 與盲聽共同驗收。官方未公開可直接重現的 Breeze2 專用蒸餾 recipe，且 model card 未宣告權重 license；在授權與可訓練 checkpoint 釐清前，不投入兩張 A10 的正式蒸餾。完整執行順序、資料規格、GPU 時程、驗收與停止條件見 [BreezyVoice 聲線轉移至 Matcha 執行計畫](frameworks/vits/BREEZYVOICE-MATCHA-PLAN.md)。

依使用者明確要求，2026-08-12 再以 `vits-zh-hf-fanchen-wnj` 測試另一個約 Matcha footprint 的中文單聲線 VITS。模型、lexicon 與 tokens 合計 123,534,359 bytes（117.8 MiB），比 Matcha 小 4.7%；初始化記憶體快照為 346,636,910 bytes（330.6 MiB），仍比 Matcha 完整 producer 多約 4.9 MiB。相同 Chromium、ORT Web 與單 thread 下，三輪 task `RTF` 為 `1.0072`、`1.0332`、`1.0261`，中位數 `1.0261`，只達 `0.975x realtime`，運算成本是 Matcha 的 `7.54x`。waveform 全為有限非靜音 samples，但本輪依要求停在核心 benchmark，沒有完成 ASR 或主觀盲聽；因此只可判定 footprint／速度，不作聲線品質排名。結果再次確認接近 118 MiB 的完整 VITS graph 仍缺乏 iOS 背景串流所需的即時餘裕，不更換現行 Matcha 選型。

Matcha `matcha-icefall-zh-en` 使用相同五句中文做三方盲測後得到 `90/100`，高於 Kokoro 的 `80/100` 與 Piper 的 `60/100`；Piper 另被標記有外國腔。上游 `sherpa-onnx 1.12.20` 官方 browser SIMD bundle 以建議的 `phone-zh.fst,date-zh.fst,number-zh.fst`、`noise_scale=0.667`、單一 thread 測得小說 task `RTF 0.1411`，約 `7.09x realtime`；含日期、時間、電話及百分比的原始數字語料同為 `RTF 0.1411`。繁體小說原文不經 OpenCC 亦成功產生 26.73 秒有效音訊，使用者已確認品質沒有問題；這些證據構成目前選定 Matcha 的依據。2026-08-09 升級至 stable ORT Web `1.27.0` 後，獨立 kaldifst WASM 的完整 desktop producer 測得 `RTF 0.1387`、`7.21x realtime`，10 個 append、51.228 秒音訊且無 underflow 或錯誤。初始化記憶體快照為 341,536,495 bytes（325.7 MiB），較 `1.26.0-dev` 增加約 48.7 MiB；其中 normalizer 的獨立 linear memory 仍為 16 MiB。此路徑不承擔官方 frontend bundle 固定 512 MiB heap；所有桌面記憶體數字只是快照，不是真正 peak，iPhone 上的記憶體行為未在本 repository 驗證。

2026-08-08 的 iPhone Safari LAN HTTP 初測確認低記憶體 JavaScript lexicon adapter 可完成模型下載、初始化、繁體直輸、前景播放與鎖屏播放；`ManagedMediaSource` 必須依 WebKit 要求在長駐 media element 設定 `disableRemotePlayback=true`。本輪不是 secure context 或 standalone PWA，且未達 2 小時／3 章、熱與耗電門檻，只能視為初步相容性證據。實聽發現引號 acoustic tokens 會發音後，已改為在 tokenization 前移除中英文開閉引號並加入迴歸測試。臺灣讀音覆寫目前只有「垃圾」；完整、有來源的詞典與「堤壩」等區域讀音留待另案開發。

## Matcha repository release 條件

Matcha 的選型已完成；本 repository 的自動 Release 只採可由免費 GitHub runner 重現的桌面 browser gates：

- 統一平台保存三輪測試、環境版本、引擎／聲音資料識別、合成架構與機器可讀 JSON。
- 有效音訊檢查通過，並保存至少一個可實聽樣本。
- 使用目標小說語料完成長章節、對話、破音字、數字、日期、中英混讀、罕見字與長時間耐聽度檢查。
- 桌面 Chromium 單一 WASM thread 的核心與完整 producer `RTF < 1`。
- 初始化與串流記憶體快照均不得超過 512 MiB。
- 串流 underflow、append error 與 producer error 均為零。
- 固定 Whisper ASR 聽回同時通過絕對 CER 與相對正式 baseline 的退化上限。
- 記錄引擎、runtime、模型/FST revision、逐檔 SHA-256、下載大小及測試報告。
- eSpeak 與 iPhone/PWA 實機驗收均不屬於本 repository 的 release gate；既有 iPhone 紀錄只保存為歷史產品相容性證據。

## 下一步

- 所有 Renovate 管理的普通 upstream 版本必須在 datasource 可驗證的發布時間滿 30 天後，才可進入 weekly roll-up；缺少 release timestamp 時採 fail-closed，不得建立 candidate branch／PR。GitHub Dependabot alert 確認的 CVE／GHSA 修補是唯一例外：只略過 30 天 quarantine、採最低已修補版本，仍須通過完整 candidate gate 才可合併與 Release。ONNX Runtime Web 另依穩定版規則排除 dev、alpha、beta 與 RC。
- 上游更新採全自動 candidate gate：桌面 WASM、FST golden、有效 waveform、RTF、512 MiB 記憶體上限與固定 Whisper ASR 聽回全部通過才可合併並發布正式 Release；失敗 candidate 不合併，另以 pre-release 保存版本組合、逐項失敗原因、log 與機器可讀 JSON。
- 完成獨立 kaldifst WASM 與既有 JavaScript applier 的完整 golden A/B，維持 phone、date、number 固定順序；JavaScript 版本暫留作診斷基線。
- 補齊貨幣／範圍／序號等中文文字正規化，以及可審核的臺灣讀音詞典。
- 在產品採用前釐清 Matcha acoustic model、Vocos、lexicon、FST 與聲音資料的授權。
- 評估把合成 producer(雙 ORT session 編排、kaldifst 實例化、mp3 unit 產出)整包以 gated artifact 出貨,讓下游消費者只保留播放、快取與 UI 殼——frontend/synthesis 已隨 release 出貨,編排層是僅存的漂移面。
