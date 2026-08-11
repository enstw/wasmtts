# BreezyVoice 聲線轉移至 Matcha 執行計畫

更新日期：2026-08-11

## 目標與邊界

目標是把一個固定、授權允許的 BreezyVoice 臺灣華語聲線轉移到目前產品等級的 16 kHz Matcha acoustic model，部署時仍只保留「現行繁體前端 → Matcha → Vocos → ISTFT → MP3」路徑。BreezyVoice 只作離線 teacher，不進入瀏覽器、iPhone、PWA 或最終模型資產。

Pilot 不處理 zero-shot voice cloning、多聲線切換、情緒控制、runtime voice conversion 或更換文字前端。現行 Matcha 的 `phone/date/number` FST、lexicon、tokens、3-step ONNX export 與單一 thread benchmark 契約維持不變。

成功的 student 必須同時達到：

- 聲線相似度明顯接近固定 Breeze teacher reference。
- 中文可懂度、臺灣讀音與現行 Matcha 相比不退化。
- Browser WASM 核心 `RTF < 0.3`，並維持足以承受 iPhone 背景排程與熱降頻的餘裕。
- ONNX acoustic＋Vocos 不大於現行 129,599,930 bytes；初始化記憶體以不高於現行 341,536,495 bytes 為 soft target，512 MiB 為不可超過的 release hard gate。
- 輸出 waveform 全為有限值，peak 與 RMS 均大於零。

## 已知基線

| 項目 | 現行 Matcha | Breeze2-VITS challenger |
|---|---:|---:|
| 架構 | Matcha acoustic＋Vocos | VITS waveform decoder |
| 權重格式 | FP32 | FP32 |
| 模型／必要資產 | 129,599,930 bytes（兩個 ONNX） | 123,600,935 bytes（模型＋lexicon＋tokens） |
| 單 thread task RTF | 0.1361 | 1.3617 |
| Realtime multiplier | 7.35x | 0.734x |
| 初始化記憶體快照 | 341,536,495 bytes（完整 producer） | 347,015,862 bytes（核心頁面） |

Breeze2 已經約為 Matcha 尺寸，但同環境推論成本為 Matcha 的 `10.00x`。因此本計畫不再以縮小 Breeze2-VITS 為方向，而是讓 Matcha student 學習 Breeze 聲線。

## Gate 0：GPU 開機前置條件

以下任一項未完成時，不啟動 2×A10 的 12 小時計時：

- 取得 BreezyVoice／Breeze2 權重、固定 speaker prompt、teacher 合成音訊用於訓練，以及 student 權重散布的明確授權。BreezyVoice repository 的 Apache-2.0 不自動代表模型權重與合成資料具有相同權利。
- 找到與現行 `matcha-icefall-zh-en` 架構及 token inventory 相容的可訓練 PyTorch checkpoint、完整設定與資料統計。現有 `model-steps-3.onnx` 只是推論 graph，不可直接 fine-tune。
- 固定 teacher revision、speaker prompt audio、prompt transcript、生成參數與 SHA-256，並以至少 20 句人工確認聲線、發音、底噪和穩定度。
- 在 GPU box 以 `uv` 建立可重現環境，完成 BreezyVoice 單句生成、Matcha 單 batch training、checkpoint resume 與 ONNX export smoke test。

若找不到相容 checkpoint，轉入「從零訓練單聲線 Matcha」的備援路徑；這不屬於 12 小時 pilot，必須另估資料量與 GPU 時數。

## 選定路徑

### A：Pseudo-data 單聲線 adaptation（首選）

使用固定 BreezyVoice speaker prompt，為涵蓋小說產品情境的繁體文本生成 teacher WAV。將通過品質 gate 的 WAV 轉為現行 Matcha 所需的 16 kHz mel targets，從相容 checkpoint 做單聲線 adaptation。

初始實驗凍結 text token embedding、主要 pronunciation encoder 與 duration predictor，先更新 mel prior projection 與 flow decoder；若聲線相似度停滯，再以更低 learning rate 解凍整個 acoustic model。Vocos 第一輪保持 frozen，避免把聲線轉移與 vocoder 變更混在同一個實驗。

### B：Feature-level distillation（A 成功後）

在標準 Matcha mel／prior／duration／flow-matching losses 之外，逐項 A/B 加入 F0、energy、duration 與 speaker embedding perceptual loss。每次只新增一類 loss，避免無法判定品質或 CER 退化的來源。

Teacher 與 student 的內部表示不同，不做 BreezyVoice speech-token 對 Matcha flow state 的直接 logits distillation。Teacher waveform 轉成 mel、F0、energy、duration 與 speaker embedding 後才作共同監督訊號。

### C：Multi-speaker Matcha（不納入首輪）

只有產品確定需要多聲線時，才增加 speaker ID／embedding conditioning。固定單聲線產品不攜帶 runtime speaker encoder；若日後採多聲線架構，最終選定 embedding 應在 export 時固化或以小型 sid table 表示。

### 不採用的產品路徑

- Matcha 後串接 runtime voice conversion：能快速驗證聲線，但會增加第二個模型、記憶體、RTF 與失敗面。
- 只微調 Vocos：可能改變聲音質感，但不足以穩定轉移 F0、formant、節奏和說話人特徵。
- 對現有 ONNX 反向訓練或從 ONNX 回建 optimizer state：不可重現且風險過高。
- 直接量化 Breeze2-VITS 當成 Matcha student：下載尺寸不是失敗點，ConvTranspose／waveform decoder 的 WASM 成本仍未解決。

## Teacher 資料規格

Pilot 目標為通過過濾後 2–5 小時音訊；實際上限依開始時量到的 BreezyVoice GPU RTF 決定，不用降低品質來追求小時數。

語料必須涵蓋：

- 小說旁白、短句、長句、對話與引號。
- 日期、時間、電話、百分比、貨幣、範圍和序號。
- 臺灣讀音覆寫、破音字、專有名詞與罕見字。
- 中文、英文縮寫、英文單字與 code-switching。
- 不同標點、停頓、情緒強度與句長分布。

每筆 manifest 至少保存：sample ID、原文、正規化後文字、student token／phone 序列、teacher revision、prompt ID、prompt SHA-256、seed、生成參數、原始與轉換後 sample rate、音訊 SHA-256、duration、CER、speaker similarity、F0／energy 摘要及過濾結果。

Train／validation／test 必須按文字內容切分，避免同一句的不同 teacher sample 跨 split。所有音訊轉為 mono 16 kHz；只做可重現的 resample、首尾 silence 規則與必要的 clipping 防護，不以強制 loudness normalization 抹除 teacher 的 energy／prosody 差異。

## 自動資料 gate

每筆 teacher sample 依序通過：

- Waveform 全 finite，peak、RMS、duration 均大於零，沒有 clipping 或異常長 silence。
- Teacher ASR 正規化 CER 通過門檻；數字與專有名詞另以正規化後文字人工抽查。
- Duration-per-character、F0、energy 與 silence ratio 不屬於資料集離群值。
- Speaker embedding 與固定 reference 的 cosine similarity 通過 pilot 分布決定的門檻。
- 每個語料 bucket 至少抽聽 20 筆；所有失敗樣本保留 metadata 與原因，不進入 training set。

## 2×A10／12 小時 pilot

| 時段 | GPU 0 | GPU 1 | 交付物／決策 |
|---|---|---|---|
| 0:00–1:00 | Teacher throughput 與品質 smoke | Matcha resume／單 batch／export smoke | 若 checkpoint 或環境不相容，立即停止 |
| 1:00–3:00 | 生成第一批多樣語料 | 生成第二批多樣語料 | 第一批 manifest、RTF、失敗率與 20 句抽聽 |
| 3:00–4:00 | 繼續補足缺少 bucket | 過濾、16 kHz 轉換、mel stats | 凍結 dataset v0 與 train／valid／test splits |
| 4:00–7:00 | DDP adaptation A | DDP adaptation A | Decoder／mel-prior 優先 checkpoint；固定間隔保存 |
| 7:00–9:00 | DDP adaptation B | DDP adaptation B | 低 LR 全 acoustic 解凍或 duration A/B |
| 9:00–10:00 | 最佳 checkpoint ONNX export | 原生 validation 與試聽樣本 | 3-step ONNX、有效 waveform、CER／speaker 指標 |
| 10:00–11:00 | Browser WASM benchmark | 盲測包與長句測試 | RTF、記憶體、asset bytes、固定 A/B WAV |
| 11:00–12:00 | 失敗重跑或最佳 checkpoint 確認 | 結果彙整 | go／no-go、下一輪資料或 loss 建議 |

資料生成完成前，可先用已通過 gate 的第一批資料啟動單 GPU adaptation；正式比較仍只使用凍結的 dataset v0。任何 checkpoint 都要能從紀錄的 config、dataset manifest 與 seed 重現。

## Pilot 驗收

| Gate | 通過條件 |
|---|---|
| Waveform | 所有 benchmark samples finite，peak > 0，RMS > 0 |
| 可懂度 | 固定 Whisper gate 通過；相對現行 Matcha 的正規化 CER 退化不超過 2 個百分點 |
| 聲線 | 以 `(candidate - baseline) / (teacher - baseline)` 正規化 speaker-similarity improvement；pilot 目標至少取得 50% 的可達差距 |
| 主觀盲測 | 至少 20 個固定 prompts；聲線相似度 70% 以上偏好 candidate，自然度不得比現行 Matcha 低 5/100 以上 |
| 核心效能 | Chromium、ORT Web、單一 WASM thread、相同文字下 task 與 wall `RTF < 0.3` |
| Footprint | acoustic＋Vocos ≤ 129,599,930 bytes；初始化記憶體 soft target ≤ 341,536,495 bytes，release hard gate < 512 MiB |
| 前端 | 現行繁體直輸、FST golden、臺灣讀音覆寫與 unknown-token gates 全部通過 |
| 串流 | 進入產品候選後才執行 MP3／MediaSource 完整 producer；underflow、append error、producer error 必須為零 |

Speaker metric 只作同一 embedding model、同一 references 的相對 A/B，不宣稱跨模型絕對可比。主觀聲線、自然度與發音分開評分，避免高相似度掩蓋可懂度退化。

## 停止條件

- 授權、可訓練 checkpoint 或完整 config 未取得：不消耗 GPU 額度。
- Teacher 前 20 句即出現不穩定聲線、明顯 hallucination 或無法靠注音控制的發音：先修 teacher prompt／frontend，不產生大量資料。
- Dataset v0 過濾後不足 2 小時或任一關鍵 bucket 缺資料：本輪只作 pipeline smoke，不宣稱 adaptation 結果。
- Candidate CER 超出退化門檻：停止追求 speaker similarity，回復凍結 encoder／duration 或降低 learning rate。
- Candidate 在原生推論通過、ONNX／WASM 卻失敗：視為 export/runtime 問題，不進入主觀產品盲測。
- 12 小時結束時未通過全部 pilot gates：保存 checkpoint、manifest、logs 與失敗原因，判定 no-go；不可因額度即將結束而降低門檻。

## Repository 交付物

允許提交：

- 固定 revision、SHA-256、資料 schema、generation／filter／train／export／benchmark scripts。
- 不含受限內容的設定、原始量測 JSON、logs 摘要、ASR／speaker metrics 與少量授權允許的 A/B samples。
- `frameworks/vits/` 的實驗結論、`platform/RESULTS.md` 的共同量測與 `GOAL.md` 的選型判定。

不可提交：teacher／student 大型 weights、完整 synthetic corpus、speaker prompt、來源不明的聲音資料或授權未確認的產物。這些資產只放在 ignored 的 `platform/models/`、`platform/assets/` 或 GPU box 專用工作目錄。

## 決策順序

1. 取得書面授權與相容的 trainable Matcha checkpoint。
1. 固定 Breeze teacher 聲線與 20 句品質基線。
1. 在 2×A10／12 小時內完成 pseudo-data adaptation A／B。
1. 通過 CER、speaker similarity、盲測、ONNX 與 WASM gates 後，才考慮 feature-level distillation。
1. Pilot 全部通過後，才將 candidate 接入既有 MP3／MediaSource transport 並安排 iPhone 實機驗收。

## 上游依據

- [BreezyVoice](https://github.com/mtkresearch/BreezyVoice)：固定 speaker prompt、繁體中文與注音控制 teacher。
- [Matcha-TTS](https://github.com/shivammehta25/Matcha-TTS)：自訂資料訓練、多 GPU 與 ONNX export。
- [Matcha-TTS paper](https://arxiv.org/abs/2309.03199)：以 acoustic frames 訓練的 OT-CFM student 與少步數合成。
- [matcha-icefall-zh-en](https://huggingface.co/csukuangfj/matcha-icefall-zh-en)：現行單聲線、16 kHz、3 ODE steps inference model 的來源與 metadata。
