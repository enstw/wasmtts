# Matcha

更新日期：2026-08-07

## 目前判定

`matcha-icefall-zh-en` 已通過第一輪中文朗讀試聽品質 gate，也完成正式桌面瀏覽器單執行緒 benchmark，目前是優先候選。它在相同五句中文文本的三方盲測中得到 `90/100`，高於 Kokoro 的 `80/100` 與 Piper HuaYan medium 的 `60/100`；Piper 另被標記有外國腔。

正式結果的中位數 `RTF` 為 `0.1467` wall time／`0.1467` task time，約 `6.82x realtime`，輸出 waveform 有效。這表示核心合成在測試用 Apple Silicon 桌機上有充足即時餘裕，但不等於 iOS PWA 部署已通過；完整文字正規化、FST 相容性、峰值記憶體、MP3 編碼、目標 iPhone 熱穩態與鎖屏串流仍待驗證。

## 模型與資產

- Acoustic model：`matcha-icefall-zh-en/model-steps-3.onnx`，單一聲線，約 72 MB。
- Vocoder：`vocos-16khz-univ.onnx`，約 51 MB。
- 輸出：16 kHz、單聲道。
- 模型包另含 lexicon、tokens、中文 FST 與 `espeak-ng-data`；本次本機解壓後 acoustic model 目錄約 100 MiB，Vocos 約 52 MiB。
- Acoustic model SHA-256：`524286bf6cf11be74329ae1c682ac69e34d6860c2ea9fd1290319d561540b16a`。
- Vocos SHA-256：`b599142a1fb8ff03de3e84ac35ff537c619e56f4267a6fe894851a42844acf9e`。
- 上游 README 沒有提供可直接採用的模型授權聲明；商用前必須另外釐清，不能因為程式碼可下載就推定權重可商用。

第三方模型與下載壓縮檔只放在被忽略的 `platform/models/`，不納入 repository。

## 盲測結果

固定文字位於 [samples/quality.txt](samples/quality.txt)，Matcha 成品位於 [samples/matcha-icefall-zh-en-quality.wav](samples/matcha-icefall-zh-en-quality.wav)。三個未做後處理的 PCM WAV 以中性檔名同時提供，映射在評分後才揭曉：

| 盲測代號 | 實際模型 | 分數 | 主觀備註 |
|---|---|---:|---|
| A | Piper `zh_CN-huayan-medium` | 60 | 有外國腔 |
| B | Matcha `matcha-icefall-zh-en` | 90 | 本輪最佳，通過品質 gate |
| C | Kokoro v1.1 zh fp32，sid 45（`zf_078`） | 80 | 品質通過，但低於 Matcha |

本輪只使用一段自然中文短文，尚未覆蓋長章節、對話、破音字、數字、日期、中英混讀、罕見字與長時間耐聽度。正式品質測試仍須擴充上述情境，但不需要再以 Piper 作為 Matcha 是否值得 benchmark 的前置阻擋。

## 正式瀏覽器 benchmark

2026-08-07 使用 Brave 所附 Chromium `151.0.7922.71`、ONNX Runtime Web `1.26.0-dev.20260416-b7804b056c`、WASM execution provider 與單一 thread。固定五句先完整暖機一次，再量三次；以 CDP `Performance.TaskDuration` 為 CPU／task 指標，並另外保存頁面 wall time。

| 指標 | 結果 |
|---|---:|
| Acoustic + Vocos session 初始化 | 2.208 秒 |
| 10 秒音訊 task time，中位數 | 1.467 秒 |
| Task RTF，中位數 | 0.1467 |
| Wall RTF，中位數 | 0.1467 |
| Realtime multiplier，中位數 | 6.82x |
| 音訊長度，中位數 | 10.923 秒 |
| Acoustic + Vocos ONNX | 129,599,930 bytes（123.6 MiB） |

三輪正規化 task time 為 `1.467`、`1.469`、`1.462` 秒／10 秒音訊。三輪 waveform 分別有 174,764、174,656、174,854 samples，全部為有限值；peak 為 `0.7750`、`0.7800`、`0.8170`，RMS 為 `0.1340`、`0.1327`、`0.1328`。最後另產生一輪可實聽的 16-bit PCM WAV，174,776/174,776 samples 全為有限值。

| 階段 | 三輪 wall time 中位數 | 約占總時間 |
|---|---:|---:|
| Matcha acoustic model | 982.7 ms | 61.3% |
| Vocos ONNX | 593.0 ms | 37.0% |
| JavaScript ISTFT | 22.3 ms | 1.4% |
| silence scaling | 0.6 ms | <0.1% |

瀏覽器 adapter 直接以 ORT Web 執行 acoustic model 與 Vocos，並依 sherpa-onnx／kaldi-native-fbank 的 Vocos 頻譜排列、Hann window、overlap-add、中心裁切及 `silence_scale=0.2` 重現輸出。五句 token 由 `sherpa-onnx 1.13.4` 前端預先產生，文字前處理不納入計時，與既有 ORT Web 主表邊界一致。

與 Chromium 149 的 Piper 舊基準相比，Matcha task time 約為 `0.93x`；由於瀏覽器版本不同，這只能支持「與 Piper 同量級、沒有明顯更慢」，不能當成嚴格的 7% 加速結論。本機目前沒有 Piper 模型資產，因此尚未在 Chromium 151 補同輪 control。

原始結果位於 [results-matcha_icefall_zh_en-browser-wasm.json](../../platform/results/results-matcha_icefall_zh_en-browser-wasm.json)，正式輸出位於 [matcha_icefall_zh_en-browser-wasm.wav](../../platform/results/matcha_icefall_zh_en-browser-wasm.wav)。可重現頁面與 runner 分別是 [matcha-browser.html](../../platform/matcha-browser.html) 與 [run-matcha-browser.mjs](../../platform/run-matcha-browser.mjs)。

## 一次性效能初測

使用 `sherpa-onnx 1.13.4` Node WASM、單一推論 thread、語速 1.0，在沒有暖機與重複取中位數的情況下得到：

| 指標 | 結果 |
|---|---:|
| 初始化 wall time | 4.828 秒 |
| 生成 wall time | 1.770 秒 |
| 音訊長度 | 10.922 秒 |
| 一次性名目 RTF | 0.162 |
| 輸出 | 174,745 samples、16 kHz、PCM 16-bit |
| Waveform 驗證 | 174,745/174,745 finite、peak 0.9101、RMS 0.1518 |

這個 `RTF 0.162` 是建立正式 adapter 前的 feasibility 結果；正式效能判定應使用上一節的 Chromium/CDP 三輪中位數。一次性樣本仍保留作為 sherpa-onnx wrapper 的輸出對照。兩組結果都沒有包含 MP3 編碼與 append transport。

## FST 與記憶體限制

`sherpa-onnx 1.13.4` Node WASM wrapper 未讀取先前文件使用的 `SHERPA_WASM_INITIAL_MEMORY` 環境變數；不額外注入 `Module.INITIAL_MEMORY` 時，Emscripten binary 使用上游預設 512 MiB。

本次載入 `phone-zh.fst,date-zh.fst,number-zh.fst` 時發生 `memory access out of bounds`。明確注入 768 MiB 與 1 GiB 後仍失敗，因此目前證據不支持把問題簡化為「512 MiB 不夠」。省略 FST 後，同一 acoustic model、Vocos、lexicon 與 tokens 可以正常產生本輪純中文無數字樣本。這足以評估該段文字的聲線與韻律，但沒有驗證數字、日期、電話及完整文字正規化。

目前正式 adapter 以固定 token 繞過前端，因此沒有解決 FST 問題。下一步仍須確認問題是 `sherpa-onnx 1.13.4` runtime、FST 格式或 WASM wrapper 路徑造成；不得以永久配置 1 GiB heap 當成解法。

## 下一步

- 在 Chromium 151 補一輪 Piper control，消除目前跨瀏覽器版本比較的誤差。
- 量測完整前端與峰值記憶體，並把文字正規化、MP3 編碼及 append 納入產品端到端 RTF。
- 更新或替換 runtime 路徑以恢復 FST，加入數字、日期、中英混讀及長篇小說文本。
- 接到 `mobile-host` producer 契約，測試 iPhone Safari／Home Screen PWA 的背景合成、溫度、記憶體與鎖屏串流。
- 在產品採用前釐清 acoustic model、Vocos、lexicon、FST 與聲音資料的授權。

## 上游資料

- 模型、API 與樣本：https://k2-fsa.github.io/sherpa/onnx/tts/all/Chinese-English/matcha-icefall-zh-en.html
- Matcha 預訓練模型總覽：https://k2-fsa.github.io/sherpa/onnx/tts/pretrained_models/matcha.html
- WASM TTS 原始碼：https://github.com/k2-fsa/sherpa-onnx/tree/master/wasm/tts
- 模型原始頁：https://modelscope.cn/models/dengcunqin/matcha_tts_zh_en_20251010
