# VITS 系列

## 細節

統一平台已測四個非 Piper 的 VITS 目標：

- AISHELL3：使用 sid 66，輸出 8 kHz；CPU footprint 很低，但本次主觀實聽只有 `3/10`，且有明顯外國腔。
- MeloTTS zh/en：輸出 44.1 kHz；音訊有效，但單線程推論成本明顯高於 Piper。
- MediaTek Breeze2-VITS：單聲線、22.05 kHz 的 zh-TW 模型；官方說明為從 BreezyVoice 蒸餾供行動裝置使用。本輪固定 Hugging Face revision `4592eb1dc4222707c7a6482d3df4bc263c441041`。
- Fanchen WNJ VITS：單聲線、16 kHz 中文模型；使用 sherpa-onnx `tts-models` release asset，archive 以 SHA-256 `4035c68899e951ccc6e863e6088ba0898fba0ccd5a88df7f2b784a9b0da88503` 固定。

四者都以各自的 lexicon／tokens 完成文字前處理，前處理不納入推論計時。

## Benchmark

| 模型 | 10 秒音訊 task time | 相對 Piper | 判定 |
|---|---:|---:|---|
| AISHELL3（sid 66） | 0.708 秒 | 0.45x | 最低 CPU 技術參考，不列入品質候選 |
| MeloTTS zh/en | 14.427 秒 | 9.16x | 單線程慢於即時，不適合作為行動端主引擎 |
| MediaTek Breeze2-VITS | 13.617 秒 | 同輪 Matcha 的 10.00x | `RTF 1.362`，單線程慢於即時 |
| Fanchen WNJ VITS | 10.261 秒 | 同輪 Matcha 的 7.54x | `RTF 1.026`，略慢於即時且沒有背景餘裕 |

AISHELL3／MeloTTS 的完整三輪資料在 `platform/results/results-vits-browser-wasm.json`；Breeze2 與 Fanchen WNJ 的原始量測分別為 `platform/results/results-breeze2_vits-browser-wasm.json`、`platform/results/results-fanchen_vits_wnj-browser-wasm.json`。兩個 challenger runner 都會產生本機 WAV 供驗證，但在權重與合成輸出授權釐清前由 Git 忽略，不散布至 repository。

## Breeze2-VITS controlled challenger

2026-08-11 使用 Brave 所附 Chromium `151.0.7922.108`、ONNX Runtime Web `1.27.0`、WASM execution provider 與一個 thread。五句繁體中文先暖機一次，再量三次；三輪 task `RTF` 為 `1.3596`、`1.3617`、`1.3634`，中位數 `1.3617`，只達 `0.734x realtime`。輸出全為有限非靜音 samples；capture 為 22.05 kHz、12.179 秒、peak `0.0957`、RMS `0.0104`。

模型、lexicon 與 tokens 合計 123,600,935 bytes（117.9 MiB），比同輪 Matcha 的兩個 ONNX 合計 129,599,930 bytes（123.6 MiB）少 5,998,995 bytes（4.6%）。初始化後 `measureUserAgentSpecificMemory()` 快照為 347,015,862 bytes（330.9 MiB），反而比 Matcha 完整 producer 的 341,536,495 bytes（325.7 MiB）多 5.2 MiB；兩者都只是時間點快照，不是真正 peak，也不是 iPhone 結果。

相同瀏覽器、runtime、單 thread 與 CDP `TaskDuration` 下，Breeze2 `RTF 1.3617` 對 Matcha `0.1361`，運算成本為 Matcha 的 `10.00x`。因此 Breeze2 已經達到「約 Matcha 模型尺寸」，卻沒有達到 Matcha 的 CPU 效率；目前不取代 Matcha，也不進入 iPhone transport 整合。

這個差距不是 INT8／FP32 或 SIMD 條件不一致。Breeze2 有 30,035,547 個 parameters、473 個 initializer，全是 FP32；Matcha acoustic＋Vocos 合計 32,050,469 個 parameters、385 個 initializer，也全是 FP32。兩邊透過同一個 ORT Web module 載入相同的 SIMD／thread-capable WASM build，並固定 `numThreads=1`，沒有量化 operator。檔案大小接近只表示 FP32 parameters 數量接近，不代表每秒音訊執行的 MAC 或 memory traffic 接近。

Graph inspection 顯示結構是重要差異，但目前尚未完成分段成本歸因。Breeze2 graph 有 6,505 個 nodes、189 個 `Conv`，其中 neural waveform decoder 含 4 個 `ConvTranspose` 與 75 個 `Conv`；四級上採樣 stride 為 `8 × 8 × 2 × 2 = 256`，大量神經卷積會在逐步放大的時間軸上直接產生 22.05 kHz waveform。其 stochastic duration predictor／flow 另帶入 `ScatterND` 30 個、`NonZero` 21 個與 `CumSum` 7 個等動態 shape operators。Matcha acoustic graph 有 4,802 個 nodes、113 個 `Conv`，另加 Vocos 272 個 nodes、9 個 `Conv`；核心維持在 80-bin mel frame／頻譜時間軸，最後才由 JavaScript ISTFT 以 hop 256 展開成 16 kHz waveform。Breeze2 的 22.05 kHz 輸出比 Matcha 16 kHz 多 37.8% samples，但這不足以單獨解釋 10 倍。

本 runner 的 `modelMs` 與 CDP `TaskDuration` 都量測一次完整 ONNX `session.run()`，沒有把 encoder＋duration、flow、waveform decoder 切成獨立 session，也沒有保存逐 operator profile。因此直接 waveform decoder 是根據 graph 結構得到的主要嫌疑之一，flow／duration graph 也可能占顯著成本；現有證據不能聲稱 decoder 單獨造成全部 `10.00x`，更不能分配各階段百分比。若要回答成本占比，必須在相同輸入與 runtime 下輸出三段 ONNX 分別計時。

本 runner 的前端採「繁體逐字直輸 → 官方 lexicon Bopomofo → tokens」，並依 ONNX metadata 設定 `add_blank=1`；前端排除於核心推論計時。這足以回答 footprint／推論速度，但還不是官方 sherpa Android frontend 的品質等價驗證，因此本輪不作聲線品質排名。

官方 [Breeze2-VITS model card](https://huggingface.co/MediaTek-Research/Breeze2-VITS-onnx) 沒有宣告 YAML license，也沒有附權重 LICENSE；上游 [BreezyVoice repository](https://github.com/mtkresearch/BreezyVoice) 的 Apache-2.0 不可直接推定涵蓋蒸餾權重。任何再訓練、散布或產品採用前，都必須先向 MediaTek 釐清 Breeze2-VITS 權重與合成資料的授權。

### 是否再蒸餾成 Matcha 尺寸

不用把「Matcha 尺寸」當下一個目標，因為 Breeze2 資產已經更小。若要保留 Breeze 聲線，合理目標應改為「維持聲線與 zh-TW 發音，同時把單 thread WASM `RTF` 壓到至少 `< 0.3`，並維持記憶體不高於 Matcha」。可行實驗是用 BreezyVoice／Breeze2 產生授權允許的繁體語音，再以 ASR CER、waveform 與主觀聽測過濾，微調現有小型 16 kHz Matcha student；這比再訓練另一個 22.05 kHz 121 MB VITS 更貼近產品限制。

目前官方公開內容能證明「Breeze2-VITS 是 BreezyVoice 的蒸餾結果」，但未提供可直接重現的 Breeze2 teacher-to-student 專用 recipe、訓練資料清單或 checkpoint 對應。兩張 A10、12 小時適合做小規模 synthetic-data／fine-tuning pilot 與驗證 16 kHz student 是否能學到聲線，不足以承諾從零完成可產品化的蒸餾。開始 GPU pilot 前必須先解決權重／合成資料授權，並取得可訓練的 Matcha checkpoint 與設定。

具體的資料規格、2×A10 時程、訓練路徑、驗收 gate 與停止條件見 [BreezyVoice 聲線轉移至 Matcha 執行計畫](BREEZYVOICE-MATCHA-PLAN.md)。

## Fanchen WNJ VITS controlled challenger

2026-08-12 使用 Brave 所附 Chromium `151.0.7922.108`、ONNX Runtime Web `1.27.0`、WASM execution provider 與一個 thread，對相同五句繁體中文先暖機一次再量三次。前端採逐字直輸、release Bopomofo lexicon、tokens 與 ONNX metadata 指定的 `add_blank=1`，排除於核心推論計時；模型輸出為 16 kHz。

三輪 task `RTF` 為 `1.0072`、`1.0332`、`1.0261`，中位數 `1.0261`，即 `0.975x realtime`；每 10 秒音訊需 `10.261` 秒 task time。這是臨界線外的結果，不符合 `RTF < 1`，也沒有吸收 iOS 背景排程、熱降頻或單句波動的餘裕。相同 runtime 的 Matcha task `RTF` 為 `0.1361`，因此 Fanchen WNJ 的核心運算成本為 Matcha 的 `7.54x`。

模型、lexicon 與 tokens 合計 123,534,359 bytes（117.8 MiB），比 Matcha acoustic＋Vocos 的 123.6 MiB 小 4.7%。ORT session 初始化為 1.285 秒；包含一次 11.504 秒音訊暖機後，初始化階段 wall time 為 12.996 秒。初始化與 benchmark 後的 `measureUserAgentSpecificMemory()` 快照分別為 346,636,910 bytes（330.6 MiB）與 346,741,746 bytes（330.7 MiB），前者仍比 Matcha 完整 producer 多約 4.9 MiB；這些都只是桌面時間點快照，不是真正 peak 或 iPhone 結果。

三輪輸出皆通過有限值與非靜音檢查。獨立 capture 的 177,664 samples 全部有限，peak `0.6841`、RMS `0.1002`。本輪依要求停在核心 benchmark，沒有完成 Whisper ASR、主觀盲聽、MP3／MediaSource 或 iPhone 測試，因此不得據此宣稱品質合格。上游 release 與原始 checkpoint 頁面也沒有提供可直接套用於權重的明確 license；模型與合成 WAV 不提交。結論是此模型符合約 Matcha 下載 footprint，卻仍略慢於即時，不取代 Matcha，也不進入產品 transport 整合。

## 最佳化

AISHELL3 已有充足的 CPU 餘裕，但 8 kHz 取樣率與中文音質才是主要限制，繼續微調 runtime 不會使它成為品質升級。MeloTTS 的下一步應先 profile encoder、decoder 與 vocoder 的分段成本，再決定是否值得做量化或替換 vocoder；目前沒有證據支持直接擴大量化範圍。Breeze2 與 Fanchen WNJ 的主要限制同樣是 CPU，不是下載尺寸；在沒有 profile、品質證據與授權之前，不展開產品整合或大規模蒸餾。

重跑方法與共同量測條件請見 [platform/RESULTS.md](../../platform/RESULTS.md)。
