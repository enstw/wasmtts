# 單線程 WASM TTS 本機基準

測試日期：2026-08-06 至 2026-08-11（Asia/Taipei）

## 結論

以 Piper `zh_CN-huayan-medium` 產生 10 秒音訊的 CPU 時間為 `1.00x`：

| 模型 | 10 秒音訊 CPU 時間（中位數） | 相對 HuaYan | 單線程即時性 | 解壓後資源 |
|---|---:|---:|---:|---:|
| Piper HuaYan medium | 1.576 秒 | **1.00x** | 6.35 倍即時 | 79 MiB |
| Matcha icefall zh-en | 1.361 秒 | **約 0.86x*** | 7.35 倍即時 | 約 152 MiB（其中 ONNX 123.6 MiB） |
| VITS AISHELL3（sid 66） | 0.708 秒 | **0.45x** | 14.1 倍即時 | 207 MiB（其中未載入的 `rule.far` 約 172 MiB） |
| MeloTTS zh/en | 14.427 秒 | **9.16x** | 0.69 倍即時 | 197 MiB |
| MediaTek Breeze2-VITS | 13.617 秒 | **約 8.64x*** | 0.734 倍即時 | 117.9 MiB（模型＋lexicon＋tokens） |
| Kokoro v1.1 zh int8 | 無有效數字 | — | 輸出為非有限值／靜音 | 約 127 MiB ONNX + 51 MiB voices |
| Kokoro v1.1 zh q8 | 無有效數字 | — | 315,000/315,000 samples 非有限 | 約 127 MiB ONNX + 51 MiB voices |
| Kokoro v1.1 zh fp32 | 14.225 秒 | **9.03x** | 0.70 倍即時 | 約 339 MiB ONNX + 51 MiB voices |

Piper、AISHELL3、MeloTTS 與 Kokoro 使用 Chromium 149；Matcha 與 Breeze2 使用 Chromium 151。全部採 ONNX Runtime Web WASM、單一 thread 與 CDP `TaskDuration`，但星號標示的相對 HuaYan 數字因瀏覽器版本不同，只能作方向性參考。Breeze2 與 Matcha 則是在同一個 Chromium `151.0.7922.108`、ORT Web `1.27.0` 下量測，可作嚴格核心推論 A/B：Breeze2 的運算成本是 Matcha 的 `10.00x`。AISHELL3 最省 CPU；Matcha 與 HuaYan 同量級且都遠快於即時；Breeze2、MeloTTS 與 Kokoro fp32 都慢於即時。Kokoro int8 與 Kokoro.js sample 對應的 q8 都能完成 graph execution，但輸出全部為非有限值，不能視為有效 TTS；只有 fp32 已驗證能正常發聲。

本文件的「倍即時」是 `realtime multiplier = 音訊長度 ÷ 合成時間`，標準 `RTF = 合成時間 ÷ 音訊長度`，兩者互為倒數。Piper HuaYan medium 的 `6.35 倍即時` 對應名目 `RTF ≈ 0.158`；這裡是桌面單 thread CPU benchmark，不能取代 iPhone 上包含文字前處理與 MP3 編碼的端到端串流 RTF。

本專案另從 FP32 產生 selective INT8，保留 decoder、vocoder、STFT 與全部卷積為 FP32。它在原生 ORT 與瀏覽器 WASM 都能輸出完整有限值，不再有 NaN；但只縮小 `8.3%`，同一瀏覽器下速度比 FP32 慢約 `0.9%`。所以這一版證明「可自行做出正確的混合 INT8」，尚未證明 INT8 對單線程 WASM 有效能優勢。

產品判定與純效能排名分開：Kokoro fp32 已通過相對 Piper 的主觀品質 gate，因此保留為次要候選。它的單執行緒約 `0.70 倍即時`，未通過效能 gate；桌面雙執行緒測得 `RTF ≈ 0.79`、相對 Piper 約 `5.02x` 的運算時間，只代表可能以較高手機溫度與耗電換取即時性。實際溫度、耗電與熱降頻尚須在目標 iPhone／iPad 量測。

AISHELL3 的取樣率只有 8 kHz，而且音質、韻律與聲線選擇和 CPU 是不同維度；本次主觀實聽只有 `3/10`，且仍有明顯外國腔。若目標是修正 HuaYan「外國人中文」的聽感，AISHELL3 不構成品質升級，因此只保留為最低 CPU 的技術參考，不列入產品候選。

## Matcha zh-en 品質與正式 benchmark

2026-08-07 使用與 Piper、Kokoro 相同的五句中文做三方盲測；A 為 Piper HuaYan medium、B 為 Matcha `matcha-icefall-zh-en`、C 為 Kokoro v1.1 zh fp32 sid 45。評分為 B `90`、C `80`、A `60`，A 另被標記有外國腔。因此 Matcha 已通過品質 gate，且本輪主觀品質高於 Kokoro。

最新正式量測使用 Brave 所附 Chromium `151.0.7922.108`、stable ONNX Runtime Web `1.27.0`、WASM execution provider 與一個 thread。固定五句先暖機一次，再量三次；三輪 task time 為 `1.365`、`1.358`、`1.361` 秒／10 秒音訊，中位數 task `RTF 0.1361`、wall `RTF 0.1360`，約 `7.35 倍即時`。Acoustic + Vocos session 初始化為 `1.980` 秒，兩個 ONNX 合計 129,599,930 bytes（123.6 MiB）。先前 `1.26.0-dev.20260416-b7804b056c` 在 Chromium `151.0.7922.71` 的中位 task `RTF 0.1467` 保留為回退基線；因瀏覽器 patch 版本也不同，改善幅度只可作方向性參考。

三輪輸出分別有 174,821、174,764、174,688 samples，全部為有限值；peak 為 `0.8093`、`0.8306`、`0.7777`，RMS 為 `0.1336`、`0.1351`、`0.1301`。Phase 中位數是 acoustic `911.1 ms`、Vocos `549.5 ms`、JavaScript ISTFT `20.8 ms`、silence scaling `0.5 ms`，因此後續核心效能最佳化應先看 acoustic 與 Vocos，不應先花時間重寫 ISTFT。

Adapter 使用 sherpa-onnx 前端預先產生的固定 token；文字前處理排除於計時外，與既有 ORT Web 主表一致。中文 FST 在目前 Node WASM wrapper 仍會越界，正式瀏覽器結果也沒有包含 FST、MP3 編碼或 MediaSource append，因此這是核心合成 benchmark，不是 iPhone 端到端串流結果。完整紀錄與樣本位於 [Matcha 文件](../frameworks/matcha/README.md)，機器可讀結果是 [results-matcha_icefall_zh_en-browser-wasm.json](results/results-matcha_icefall_zh_en-browser-wasm.json)。

## MediaTek Breeze2-VITS footprint／效能試跑

2026-08-11 固定 `MediaTek-Research/Breeze2-VITS-onnx` revision `4592eb1dc4222707c7a6482d3df4bc263c441041`，使用與正式 Matcha 相同的 Chromium `151.0.7922.108`、ORT Web `1.27.0`、WASM 與單一 thread。前端採繁體逐字直輸、官方 Bopomofo lexicon、tokens 與 `add_blank=1`，排除於核心推論計時。五句先暖機一次再量三次，task `RTF` 為 `1.3596`、`1.3617`、`1.3634`；中位數為 `1.3617`，即 `0.734x realtime`，未達持續串流必要的 `RTF < 1`。

模型輸出為 22.05 kHz；capture 的 268,544 samples 全部有限，peak `0.0957`、RMS `0.0104`，不是零 waveform。ORT session 初始化為 1.308 秒；包含一次 11.088 秒音訊暖機後，初始化階段 wall time 為 16.584 秒。模型、lexicon 與 tokens 合計 123,600,935 bytes（117.9 MiB），比 Matcha acoustic＋Vocos 129,599,930 bytes（123.6 MiB）少 4.6%。Breeze2 初始化記憶體快照為 347,015,862 bytes（330.9 MiB）；Matcha 完整 producer 初始化快照為 341,536,495 bytes（325.7 MiB）。後者包含 Worker 與 16 MiB normalizer，兩個數字仍都只是不同 harness 的時間點快照，不可宣稱為真正 peak 或 iPhone 記憶體。

結論是 Breeze2 已經約等於、甚至略小於 Matcha 模型尺寸，但核心推論剛好約慢 `10.00x`，所以問題不是 footprint，而是 VITS graph 在單線程 WASM 的運算成本。此 challenger 不取代 Matcha，也不進入 iPhone transport 整合。若要保存 Breeze 聲線，後續研究目標應是 16 kHz 小型 Matcha student 與 `RTF < 0.3`，而不是單純把 121 MB 權重再縮到 Matcha 尺寸。詳細限制與蒸餾判定見 [VITS 文件](../frameworks/vits/README.md)；原始資料為 [results-breeze2_vits-browser-wasm.json](results/results-breeze2_vits-browser-wasm.json)。

兩邊的格式條件相同：Breeze2 的 30,035,547 個 parameters 與 Matcha acoustic＋Vocos 的 32,050,469 個 parameters 都是 FP32，且同樣使用 ORT Web 的 SIMD WASM binary、單一 thread，沒有 INT8 operator。Breeze2 的 graph 直接用 4 個 `ConvTranspose` 與 75 個 decoder `Conv` 經 `8 × 8 × 2 × 2` 上採樣產生 22.05 kHz waveform；Matcha＋Vocos 大部分計算停留在 mel frame／頻譜時間軸，最後才由 ISTFT 展開 16 kHz waveform。參數量決定下載大小，activation 的時間軸、每層重複次數與 operator 實作才決定推論時間。

### Matcha 上游建議 FST browser 基線

另以 sherpa-onnx `1.12.20` 官方預建 browser SIMD bundle 重測完整上游配置：`model-steps-3.onnx`、16 kHz Vocos、lexicon、tokens、`espeak-ng-data`、`phone-zh.fst,date-zh.fst,number-zh.fst`、`noise_scale=0.667`、`length_scale=1`、`silence_scale=0.2`、單一 thread。這條路徑不經 ORT Web 自製 adapter，也不加入 OpenCC。

| 語料 | Task RTF 中位數 | Wall RTF 中位數 | Realtime multiplier |
|---|---:|---:|---:|
| 純小說簡體 | 0.14110 | 0.14062 | 7.09x |
| 原始日期／時間／電話／百分比 | 0.14114 | 0.14073 | 7.09x |

初始化 wall time 為 1.877 秒；WASM heap 固定 536,870,912 bytes（512 MiB），`measureUserAgentSpecificMemory()` 快照為初始化後 688,672,616 bytes（656.8 MiB）、benchmark 後 699,003,344 bytes（666.6 MiB）。三個 FST 合計只有約 208 KiB；同 runtime 的 FST on/off control 中，純小說 task RTF 為 `0.13961`／`0.13973`，差異 `-0.086%`，heap 差異為 0。因此主要成本是官方 heap 與整體預載資產，不是 FST。

不經 OpenCC 的完整繁體小說文字亦成功產生 26.7298 秒、427,676 個全為有限值的 samples，使用者已確認品質沒有問題。正式文字路徑因此定為「繁體直輸 → 官方三個中文 FST → Matcha」。官方 bundle 結果保留為上游基線；產品 producer pilot 現以獨立 kaldifst + OpenFST WASM 執行相同 tables，純 JavaScript applier 保留為診斷基線。機器可讀基線為 [上游 FST 結果](results/results-matcha_icefall_zh_en-upstream-fst-browser-wasm.json)與 [FST on/off A/B](results/results-matcha_icefall_zh_en-fst-ab-browser-wasm.json)，試聽檔與 metadata 見 [Matcha 文件](../frameworks/matcha/README.md)。

### Matcha Worker／MP3／MediaSource 端到端結果

2026-08-09 將 Bookworm 的 `matcha-fst.js` 移入統一平台。此實作以純 JavaScript 讀取 OpenFST vector archives，依 kaldifst `TextNormalizer::Normalize` 的拓撲 shortest-path 與 strict-improvement tie-break 套用 `phone-zh.fst,date-zh.fst,number-zh.fst`，不載入 sherpa-onnx 512 MiB frontend bundle。無資產 fixtures 全部通過，三個真實 tables 的 32 個 kaldifst golden cases 亦全部一致。產品前端另保留 Bookworm 已驗證的臺灣格式修正，避免 `%`、冒號、日期分隔符與 10 碼手機落入上游已知誤讀。

同日以 Chromium 151、stable ORT Web `1.27.0` WASM 單一 thread 與 `noise_scale=0.667` 重測完整 desktop producer。計時邊界包含繁體直輸、獨立 kaldifst WASM FST、lexicon/token mapping、Matcha acoustic、Vocos、JavaScript ISTFT、silence scaling 與 lamejs 96 kbps MP3 encode；輸出逐句 append 到單一 `audio/mpeg` sequence SourceBuffer。10 段共 append 51.228 秒音訊，producer `RTF 0.1387`、`7.21 倍即時`，到達目標的整體 wall `RTF 0.1425`。underflow、append error、producer error 全為 0；所有 segment waveform 均為有限非靜音，MP3 bytes 皆大於零。`25.5%` 正規化為「百分之二十五点五」，沒有 unknown。

本輪每段中位數前端 `0.580 ms`、核心合成 `607.5 ms`、MP3 `55.0 ms`、完整 producer `694.6 ms`。`performance.measureUserAgentSpecificMemory()` 快照為初始化後 341,536,495 bytes（325.7 MiB）、串流中 345,817,320 bytes（329.8 MiB）；第二次重跑初始化為 341,535,075 bytes，確認相較 `1.26.0-dev` 增加約 48.7 MiB。normalizer 的獨立 linear memory 仍為 16 MiB，因此增量屬 ORT 1.27 路徑。這只是時間點快照，不是 peak 或 iPhone 結果；1.27 已通過桌面功能與速度 gate，但 iPhone 記憶體、CacheStorage、鎖屏與熱穩態仍未完成。

### iPhone Safari 初步功能測試

2026-08-08 使用 iPhone、iOS `18.7`、Safari user agent `Version/26.5.2`，經區域網路 HTTP 開啟 Matcha 串流頁。環境為 `secureContext=false`、`standalone=false`，因此本輪只屬 Safari tab 功能測試，不是 Home Screen PWA、Service Worker 離線、雙執行緒或正式鎖屏耐久驗收；裝置型號、鎖屏時長、溫度、耗電與熱降頻未記錄。

頁面將約 123.6 MiB ONNX 模型下載拆成獨立步驟並顯示進度；本輪四項資產由 LAN 下載約 4.24 秒，Worker session 初始化約 1.06 秒，連同文字前端與完整暖機共 1.32 秒。暖機產生 10,793 個有效 samples、0.6746 秒音訊，peak `0.7874`、RMS `0.1638`，MP3 為 9,072 bytes。這些時間受 LAN 與特定裝置影響，只保存為功能紀錄，不納入跨方案效能排名。

第一次播放停在 `ManagedMediaSource` 的 `opening`，`sourceopen` 未發生，producer 也未被呼叫。依 WebKit 要求在單一長駐 `HTMLAudioElement` 明確設定 `disableRemotePlayback=true` 後，使用者確認前景播放與鎖屏播放皆正常，繁體原文直輸及「垃圾 → `le4 se4`」讀音覆寫亦正常。測試未達 2 小時／3 章門檻，不能寫成鎖屏驗收完成。

本輪另確認 `「」` 等引號映射為 acoustic tokens `“”` 後會發音；2026-08-08 已改為在 tokenization 前移除 `「」『』《》“”‘’"`，保留句內其他韻律標點，並加入繁體直輸 token 迴歸測試。所謂「臺灣覆寫」目前只有手工加入且與教育部辭典一致的「垃圾 → `le4 se4`」，尚非完整、有來源欄位的臺灣讀音詞典。繁體「關卡」目前逐字得到 `guan1 ka3`，符合臺灣讀音；「堤壩」得到 `di1 ba4`，但臺灣教育部讀音為 `ti2 ba4`。臺灣讀音詞典留待獨立開發，不納入本次引號修正。

上游 lexicon 將「垃圾」讀成 `la1 ji1`；臺灣 `le4 se4` 只作明示的可選覆寫。正式效能結果使用上游原詞典。原始結果為 [results-matcha_icefall_zh_en-stream-browser-wasm.json](results/results-matcha_icefall_zh_en-stream-browser-wasm.json)。

## Kokoro selective INT8 修正實驗

這組 A/B 使用同一個 gstack HeadlessChrome 145.0.7632.6、ONNX Runtime Web WASM、單一 thread 與 `performance.now()` wall time。因瀏覽器版本與主表不同，數字只在本節內互相比較。

| 模型 | ONNX 大小 | 10 秒音訊 wall time 中位數 | 相對 FP32 | waveform 驗證 |
|---|---:|---:|---:|---:|
| FP32 | 323.6 MiB | 15.042 秒 | 1.000x | 316,200/316,200 finite |
| selective INT8 | 296.7 MiB | 15.182 秒 | 1.009x | 316,800/316,800 finite |

Selective INT8 三輪為 `15.148`、`15.182`、`15.197` 秒／10 秒音訊；FP32 三輪為 `15.042`、`15.043`、`15.029` 秒。原生 ONNX Runtime CPU 另驗證 selective INT8 的 317,400/317,400 samples 全為有限值，peak `0.325`、RMS `0.0389`。

量化範圍是 decoder 以外的 `MatMul/Gemm/LSTM` 候選；ONNX Runtime 1.28 實際轉換成 9 個 `MatMulInteger` 與 6 個 `DynamicQuantizeLSTM`。`/decoder/`、90 個 `Conv`、7 個 `ConvTranspose`、vocoder 與 STFT 均保留 FP32。這個保守範圍避免了已定位到 STFT Fourier kernel／phase 除法的 NaN 傳播，但也只減少 28.2 MB 權重，無法帶來明顯 WASM 加速。

## 舊 sherpa wrapper 測試方法（保留供對照）

- 環境：macOS 26.5.2 arm64、Node 24.19.0、`sherpa-onnx` npm 1.13.4。
- 所有成功模型都走同一個 sherpa-onnx Emscripten WASM／ONNX Runtime CPU 核心。
- 模型設定固定 `numThreads: 1`、`provider: cpu`、語速 1.0。
- 同一段簡體中文、全形句號文本；內容不含數字或電話，因此計時時不載入正規化 FST。
- 每個模型先暖機一次，再量三次；用 `process.cpuUsage()` 量 process CPU，按實際 WAV 長度正規化成「產生 10 秒音訊所需 CPU 毫秒」，取三次中位數。
- `sherpa-onnx 1.13.4` Node WASM 使用上游預設 512 MiB initial memory；現有 `benchmark.js` 沒有覆寫它。舊文件使用的 `SHERPA_WASM_INITIAL_MEMORY` 環境變數不會被此 wrapper 讀取，不能作為 768 MiB 已生效的證據。這組 benchmark 不載入正規化 FST。
- 這個 npm WASM binary 是 pthread build，runtime 會建立閒置 worker；推論本身固定 `numThreads: 1`。CPU 時間接近 wall time，符合只有一個活躍推論執行緒，但不等於「binary 完全沒有 pthread 支援」。

### 統一瀏覽器 WASM 路徑

- 瀏覽器：Chrome for Testing 149.0.7827.55 arm64；Transformers.js 4.2.0；ONNX Runtime Web 1.26 dev；execution provider 固定 `wasm`，`numThreads = 1`、`proxy = false`。
- 模型：`onnx-community/Kokoro-82M-v1.1-zh-ONNX` 的 int8 graph；聲線為 sid 45（`zf_078`）。
- 四款都直接使用 ONNX Runtime Web `wasm` provider。HuaYan 用 Piper 官方 eSpeak phonemizer；AISHELL3、MeloTTS、Kokoro 使用各自的 lexicon/tokens。Kokoro 另從 `voices.bin` 取得 sid 45（`zf_078`）style。文字前處理不納入推論計時。
- CPU 指標統一採 Chromium CDP `Performance.TaskDuration`；單線程下 task time 幾乎等於 wall time。

## 三輪原始摘要

| 模型 | 三輪 CPU ms / 10 秒音訊 | 中位數 wall ms / 10 秒音訊 |
|---|---|---:|
| HuaYan | 2172.36、2177.27、2187.66 | 2158.36 |
| AISHELL3 | 1281.37、1339.17、1280.12 | 1260.90 |
| MeloTTS | 15624.49、15901.59、15898.00 | 15876.41 |
| Kokoro int8（ORT Web；TaskDuration） | 42338.35、42327.36、42336.76 | 42336.76 |
| HuaYan（ORT Web；TaskDuration） | 1582.61、1566.66、1575.77 | 1575.77 |
| AISHELL3（ORT Web；TaskDuration） | 717.67、703.04、707.96 | 707.96 |
| MeloTTS（ORT Web；TaskDuration） | 14441.27、14427.35、14403.69 | 14427.35 |
| Kokoro fp32（ORT Web；TaskDuration） | 14225.42、14205.52、14256.83 | 14225.42 |
| Matcha zh-en（ORT Web 1.27；TaskDuration） | 1365.03、1357.54、1361.20 | 1361.20 |
| Breeze2-VITS（ORT Web 1.27；TaskDuration） | 13596.19、13616.94、13634.35 | 13616.94 |

## 可重現檔案

- 測試程式：`platform/benchmark.js`
- 每輪完整 JSON：`platform/results/results-*.json`
- 成功模型最後一輪 WAV：`platform/results/*.wav`
- Kokoro 瀏覽器頁：`platform/kokoro-browser.html`
- Kokoro Chromium/CDP runner：`platform/run-kokoro-browser.mjs`
- Kokoro selective INT8 量化器：`platform/quantize-kokoro.py`
- Kokoro 原生數值驗證器：`platform/validate-kokoro-onnx.py`
- Kokoro gstack browse 單輪 runner：`platform/run-kokoro-gstack.js`
- 其他三款 ORT Web runner：`platform/run-vits-browser.mjs`
- Matcha ORT Web 頁面／runner：`platform/matcha-browser.html`、`platform/run-matcha-browser.mjs`
- Matcha 正式 JSON／WAV：`platform/results/results-matcha_icefall_zh_en-browser-wasm.json`、`platform/results/matcha_icefall_zh_en-browser-wasm.wav`
- Matcha 上游 FST runner／A/B：`platform/run-matcha-upstream-fst-browser.mjs`、`platform/run-matcha-fst-ab-browser.mjs`
- Matcha 上游 FST JSON／WAV：`platform/results/results-matcha_icefall_zh_en-upstream-fst-browser-wasm.json`、`platform/results/matcha_icefall_zh_en-upstream-fst-browser-wasm.wav`
- Matcha 端到端頁面／runner：`mobile-host/matcha-stream-test.html`、`platform/run-matcha-stream-browser.mjs`
- Matcha 端到端 JSON：`platform/results/results-matcha_icefall_zh_en-stream-browser-wasm.json`
- Breeze2 頁面／runner：`platform/breeze2-vits-browser.html`、`platform/run-breeze2-vits-browser.mjs`
- Breeze2 manifest／正式 JSON：`platform/breeze2-vits-assets.json`、`platform/results/results-breeze2_vits-browser-wasm.json`；本機 WAV 因授權未釐清不提交
- 統一三款原始結果：`platform/results/results-vits-browser-wasm.json`
- Selective INT8 與同瀏覽器 FP32 A/B：`platform/results/results-kokoro_v1_1_zh_selective-int8-browser-wasm.json`

重跑範例：

```sh
pnpm exec node platform/benchmark.js piper_huayan_medium
pnpm exec node platform/benchmark.js vits_aishell3
pnpm exec node platform/benchmark.js vits_melotts_zh_en
# 另一個終端機先執行：pnpm host:mobile
pnpm exec node platform/run-kokoro-browser.mjs fp32
pnpm exec node platform/run-vits-browser.mjs
pnpm fetch:breeze2-vits-assets
pnpm benchmark:breeze2-vits
pnpm benchmark:matcha
pnpm benchmark:matcha-upstream-fst
pnpm benchmark:matcha-fst-ab
pnpm sample:matcha-upstream-fst-traditional
pnpm benchmark:matcha-stream
```
