# VITS 系列

## 細節

統一平台已測兩個非 Piper 的 VITS 目標：

- AISHELL3：使用 sid 66，輸出 8 kHz；CPU footprint 很低，但本次主觀實聽只有 `3/10`，且有明顯外國腔。
- MeloTTS zh/en：輸出 44.1 kHz；音訊有效，但單線程推論成本明顯高於 Piper。

兩者都以各自的 lexicon／tokens 完成文字前處理，前處理不納入推論計時。

## Benchmark

| 模型 | 10 秒音訊 task time | 相對 Piper | 判定 |
|---|---:|---:|---|
| AISHELL3（sid 66） | 0.708 秒 | 0.45x | 最低 CPU 技術參考，不列入品質候選 |
| MeloTTS zh/en | 14.427 秒 | 9.16x | 單線程慢於即時，不適合作為行動端主引擎 |

完整三輪資料在 `platform/results/results-vits-browser-wasm.json`；最後一輪 WAV 分別為 `platform/results/vits_aishell3.wav` 與 `platform/results/vits_melotts_zh_en.wav`。

## 最佳化

AISHELL3 已有充足的 CPU 餘裕，但 8 kHz 取樣率與中文音質才是主要限制，繼續微調 runtime 不會使它成為品質升級。MeloTTS 的下一步應先 profile encoder、decoder 與 vocoder 的分段成本，再決定是否值得做量化或替換 vocoder；目前沒有證據支持直接擴大量化範圍。

重跑方法與共同量測條件請見 [platform/RESULTS.md](../../platform/RESULTS.md)。
