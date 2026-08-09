# Matcha

更新日期：2026-08-07

## 目前判定

`matcha-icefall-zh-en` 是本專案目前選定的 TTS 模型。它已通過中文朗讀試聽品質 gate，也完成正式桌面瀏覽器單執行緒 benchmark；在相同五句中文文本的三方盲測中得到 `90/100`，高於 Kokoro 的 `80/100` 與 Piper HuaYan medium 的 `60/100`，Piper 另被標記有外國腔。

上游建議的 browser WASM＋中文 FST 配置中位 task `RTF` 為 `0.1411`，約 `7.09x realtime`；繁體小說原文不經 OpenCC 亦能生成，試聽品質已獲接受。選定的文字路徑為「繁體直輸 → `phone/date/number` FST → Matcha」，生成配置採 `noise_scale=0.667`，繁簡轉換不是必要前處理。目前 pilot 由獨立 kaldifst + OpenFST WASM 執行三個 FST，Matcha/Vocos 則共用 ORT Web WASM；兩者各自使用 linear memory，不再載入固定 512 MiB heap 的官方 frontend bundle。仍須驗證英文 eSpeak、真正 peak memory、目標 iPhone 熱穩態與鎖屏串流。

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

2026-08-09 升級至 stable ONNX Runtime Web `1.27.0`，使用 Brave 所附 Chromium `151.0.7922.108`、WASM execution provider 與單一 thread。固定五句先完整暖機一次，再量三次；以 CDP `Performance.TaskDuration` 為 CPU／task 指標，並另外保存頁面 wall time。先前 `1.26.0-dev.20260416-b7804b056c` 結果保留在 Git 歷史作回退基線。

| 指標 | 結果 |
|---|---:|
| Acoustic + Vocos session 初始化 | 1.980 秒 |
| 10 秒音訊 task time，中位數 | 1.361 秒 |
| Task RTF，中位數 | 0.1361 |
| Wall RTF，中位數 | 0.1360 |
| Realtime multiplier，中位數 | 7.35x |
| 音訊長度，中位數 | 10.923 秒 |
| Acoustic + Vocos ONNX | 129,599,930 bytes（123.6 MiB） |

三輪正規化 task time 為 `1.365`、`1.358`、`1.361` 秒／10 秒音訊。三輪 waveform 分別有 174,821、174,764、174,688 samples，全部為有限值；peak 為 `0.8093`、`0.8306`、`0.7777`，RMS 為 `0.1336`、`0.1351`、`0.1301`。最後另產生一輪可實聽的 16-bit PCM WAV，174,857/174,857 samples 全為有限值。

| 階段 | 三輪 wall time 中位數 | 約占總時間 |
|---|---:|---:|
| Matcha acoustic model | 911.1 ms | 61.5% |
| Vocos ONNX | 549.5 ms | 37.1% |
| JavaScript ISTFT | 20.8 ms | 1.4% |
| silence scaling | 0.5 ms | <0.1% |

瀏覽器 adapter 直接以 ORT Web 執行 acoustic model 與 Vocos，並依 sherpa-onnx／kaldi-native-fbank 的 Vocos 頻譜排列、Hann window、overlap-add、中心裁切及 `silence_scale=0.2` 重現輸出。五句 token 由 `sherpa-onnx 1.13.4` 前端預先產生，文字前處理不納入計時，與既有 ORT Web 主表邊界一致。本輪瀏覽器 adapter 使用 `noise_scale=1.0`；sherpa-onnx Matcha 預設則是 `0.667`，兩者不可當成完全相同的生成配置。

與 Chromium 149 的 Piper 舊基準相比，Matcha task time 約為 `0.93x`；由於瀏覽器版本不同，這只能支持「與 Piper 同量級、沒有明顯更慢」，不能當成嚴格的 7% 加速結論。本機目前沒有 Piper 模型資產，因此尚未在 Chromium 151 補同輪 control。

原始結果位於 [results-matcha_icefall_zh_en-browser-wasm.json](../../platform/results/results-matcha_icefall_zh_en-browser-wasm.json)，正式輸出位於 [matcha_icefall_zh_en-browser-wasm.wav](../../platform/results/matcha_icefall_zh_en-browser-wasm.wav)。可重現頁面與 runner 分別是 [matcha-browser.html](../../platform/matcha-browser.html) 與 [run-matcha-browser.mjs](../../platform/run-matcha-browser.mjs)。

## kaldifst WASM 前端與 MP3 append

2026-08-09 從 Bookworm 複製 `matcha-fst.js`：它以純 JavaScript 讀取原始 OpenFST vector archives，重現 kaldifst 的拓撲 shortest-path 與 equal-cost tie-break。三個 tables 依官方固定順序 `phone → date → number` 執行，合計 212,266 bytes，不需載入 sherpa-onnx frontend bundle。無資產 fixtures 與三個真實 tables 的 32 個 kaldifst golden cases 均通過。

純 JavaScript applier 保留為 32 個 golden cases 的診斷基線。產品 Worker pilot 已改接獨立的 kaldifst `1.8.0` + OpenFST WASM、繁體直輸、68,037 詞 lexicon 最長匹配與 2,189 個 token mapping。normalizer WASM 約 338 KiB，初始 linear memory 為 16 MiB、允許成長且上限 128 MiB；它與 Matcha/Vocos 共用的 ORT Web WASM memory 相互獨立。產品前端同時保留 Bookworm 的臺灣格式修正：在進 FST 前只重整百分比、時間、日期分隔符與長位數電話，避免 tables 已知的 `%` 遺留、冒號 acoustic token 與 10 碼手機整數讀法；一般數字仍由原始 FST 決定。

最新端到端量測使用 Brave／Chromium `151.0.7922.108`、stable ORT Web `1.27.0`、WASM 單一 thread 與 `noise_scale=0.667`。Worker 完整暖機一次後，反覆合成 5 段繁體小說文字，內容包含對話、`2026年8月7日14:30`、`25.5%` 與「垃圾」；每句 PCM 以 lamejs `1.2.1` 編成 16 kHz mono、96 kbps MP3，再 append 到同一個 `audio/mpeg` sequence SourceBuffer。

| 指標 | 結果 |
|---|---:|
| 段數／SourceBuffer 音訊 | 10 段／51.228 秒 |
| Producer RTF／realtime | 0.1387／7.21x |
| 達到目標的整體 wall RTF | 0.1425 |
| 結束時 buffer ahead | 44.73 秒 |
| Underflow／append error／producer error | 0／0／0 |

同輪初始化後記憶體快照為 341,536,495 bytes（325.7 MiB），串流快照為 345,817,320 bytes（329.8 MiB）；第二次獨立重跑的初始化快照為 341,535,075 bytes，確認此水位可重現。相較 `1.26.0-dev` 初始化快照增加約 48.7 MiB，normalizer 本身仍維持 16 MiB，增量來自 ORT 1.27 路徑。這只是時間點快照，不是 peak 或 iPhone 結果；stable 1.27 已通過桌面功能與速度 gate，但 iPhone 記憶體 gate 尚未驗收。

每段中位數為 4.751 秒音訊、57,888 bytes MP3；前端 `0.580 ms`、核心合成 `607.5 ms`、MP3 encode `55.0 ms`、完整 producer `694.6 ms`。記憶體 API 只在初始化後與串流中取樣，不能宣稱為 peak。

原模型 lexicon 沒有「垃圾」整詞條目，實際使用「垃 → `la1`、圾 → `ji1`」，即中國大陸普通話 `lā jī`。測試頁提供明示的臺灣覆寫 `垃圾 → le4 se4`；真實 Worker 已驗證可產生 12,513 個全為有限值的 samples 與 10,368-byte MP3，但正式效能結果仍使用上游原詞典，不把產品覆寫冒充模型預設。

### 繁體直輸與 `noise_scale` A/B 試聽

為分離 OpenCC 與模型生成參數，另以[同一份原始繁體小說文字](samples/matcha-no-fst-novel-traditional-direct.txt)直接查詢上游 lexicon；不經繁轉簡、不載入 FST，仍保留 JavaScript 常用數字規則。完整原文直接比較時，繁體與 OpenCC 版本都是 135 個 token、0 個 unknown；實際切成五個音訊單元後共 134 個 token、0 個 unknown，差一個是段落分隔標點不進入逐句音訊。直接繁體與 OpenCC 版本的內容 token 數相同，但繁體直查會把兩個「著」標為 `zhu4`，並把「顯得」的「得」標為 `de2`；OpenCC 版本則是 `zhe5`、`de5`。這證明繁轉簡不是 acoustic model 的要求，但目前對部分詞組讀音有實際影響。

| 試聽檔 | 配置 | PCM 長度 | MP3 bytes | SHA-256 |
|---|---|---:|---:|---|
| [繁體直輸，noise 1.0](samples/matcha-no-fst-novel-traditional-direct-noise-1.mp3)／[metadata](samples/matcha-no-fst-novel-traditional-direct-noise-1.json) | 先前 Chromium 測試參數 | 25.5379 秒 | 311,904 | `5d54c4544295916af989dbae5e1cd83c15c2fa62c434737aa45cbbaff7740c14` |
| [繁體直輸，noise 0.667](samples/matcha-no-fst-novel-traditional-direct-noise-0.667.mp3)／[metadata](samples/matcha-no-fst-novel-traditional-direct-noise-0.667.json) | sherpa-onnx Matcha 預設 | 25.5664 秒 | 312,336 | `e33601f9f0b265c420cec757abfed7dbfd85a738e5b38961720bc76a5fcf4004` |

重現時先在一個終端執行 `pnpm host:mobile`，再於另一個終端執行 `WASM_TTS_BENCH_PORT=8765 pnpm sample:matcha-stream`。產生器會以隔離的 Chromium profile 跑真實 Worker、Matcha、Vocos 與 MP3 encoder，並驗證所有 waveform finite／non-zero、unknown 為空及輸出 SHA-256。

PWA runtime、Worker、兩個模型與字典均進入 CacheStorage 後，實際關閉本機 host 再重新導覽；service worker 仍能回傳頁面，Worker 以 cache source 在 1.56 秒內 ready，並離線把「第12章有一袋垃圾。」產生為 31,297 個全為有限值的 samples 與 24,624-byte MP3。這證明桌面 PWA 離線重啟路徑，不代表 iOS CacheStorage 一定不會因配額或系統政策被清除。

機器可讀結果位於 [results-matcha_icefall_zh_en-stream-browser-wasm.json](../../platform/results/results-matcha_icefall_zh_en-stream-browser-wasm.json)；頁面與 runner 分別是 [matcha-stream-test.html](../../mobile-host/matcha-stream-test.html) 與 [run-matcha-stream-browser.mjs](../../platform/run-matcha-stream-browser.mjs)。

### iPhone Safari 初步相容性

2026-08-08 在 iOS `18.7` Safari 以 LAN HTTP 測試低記憶體 JavaScript lexicon adapter。模型下載、Worker 初始化與有效 waveform 暖機皆通過；設定 WebKit 要求的 `HTMLAudioElement.disableRemotePlayback=true` 後，使用者確認繁體原文直輸、前景播放、鎖屏播放及「垃圾 → `le4 se4`」讀音覆寫正常。因本輪 `secureContext=false`、`standalone=false`，且未記錄裝置型號、鎖屏時長、溫度、耗電、降頻或 2 小時跨章結果，只能判定 transport 初步相容，不是 PWA 或熱穩態完成。

實聽發現 `「」` 被映射為 `“”` acoustic tokens 後會發音；目前已在 tokenization 前移除中英文開閉引號、保留句內其他韻律標點，並加入繁體直輸 token 迴歸測試。「臺灣覆寫」目前只有「垃圾」一詞，尚未形成有來源欄位的正式詞典；「關卡」逐字讀音符合臺灣 `guan1 ka3`，「堤壩」則需由上游 `di1 ba4` 覆寫為教育部辭典的 `ti2 ba4`。臺灣讀音詞典留待另案開發；完整事件與數值保存在 [共同結果](../../platform/RESULTS.md)。

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

## 上游建議 FST 配置試聽

[WAV 試聽檔](samples/matcha-upstream-fst-recommended-normalization.wav)／[metadata](samples/matcha-upstream-fst-recommended-normalization.json)由 sherpa-onnx `1.12.20` 官方 browser SIMD bundle 直接產生，配置包含 `phone-zh.fst`、`date-zh.fst`、`number-zh.fst`、`noise_scale=0.667`、`length_scale=1`、`silence_scale=0.2` 與單一 thread。輸入保留原始阿拉伯數字、日期、時間、百分比及電話，方便直接聽出 FST 的正規化結果；音訊為 16 kHz mono PCM WAV，長 14.565 秒。

另以[完整繁體小說文字直接輸入](samples/matcha-upstream-fst-recommended-traditional-direct.wav)／[metadata](samples/matcha-upstream-fst-recommended-traditional-direct.json)，不經 OpenCC，維持相同官方 FST 與生成配置。Chromium 成功產生 26.7298 秒音訊，427,676 個 samples 全部 finite、peak `0.9243`、RMS `0.1491`。使用者已確認試聽品質沒有問題，因此選定配置不做繁簡轉換；OpenCC 路徑僅保留作歷史對照。

## FST 與記憶體限制

`sherpa-onnx 1.13.4` Node WASM wrapper 未讀取先前文件使用的 `SHERPA_WASM_INITIAL_MEMORY` 環境變數；不額外注入 `Module.INITIAL_MEMORY` 時，Emscripten binary 使用上游預設 512 MiB。該 Node 路徑載入三個中文 FST 時會發生 `memory access out of bounds`，即使注入 768 MiB 與 1 GiB 仍失敗。

官方 `1.12.20` browser SIMD bundle 則能以三個 FST 正常初始化與生成，因此先前錯誤已縮小為 Node WASM 路徑／runtime 問題，不能歸因於 FST 本身或單純記憶體不足。同一 browser runtime 的 FST on/off control 中，純小說文字 task RTF 分別為 `0.13961`／`0.13973`，差異 `-0.086%`；兩者 heap 都是 512 MiB。移除 FST 沒有實質效能或 heap 優勢。

核心定時 benchmark 仍以固定 token 排除文字前端，但產品 Worker 已改由獨立 kaldifst WASM 套用原始三個 FST。A/B 的原始數字語料在無 FST 時由約 14.57 秒變成 19.56 秒，已證明讀法不同；因此不得移除 FST 或退回一般 JavaScript 數字規則。

## 下一步

- 以「繁體直輸＋三個官方中文 FST＋`noise_scale=0.667`」作後續固定配置；不再投入 OpenCC 或繁簡轉換最佳化。
- 完成 kaldifst WASM 與 JavaScript 診斷 applier 的完整 golden A/B，維持 phone、date、number 固定順序。
- 在目標 iPhone／iPad 量測真正峰值記憶體、單一 thread RTF、溫度、耗電與熱降頻。
- 分別從 Safari tab 與 Home Screen PWA 完成 2 小時鎖屏、3 章、Media Session 與中斷恢復驗收。
- 接入英文 eSpeak，擴充電話、貨幣、範圍、序號與其他完整文字正規化；建立可審核的臺灣區域讀音覆寫詞典。
- 在產品採用前釐清 acoustic model、Vocos、lexicon、FST 與聲音資料的授權。

## 上游資料

- 模型、API 與樣本：https://k2-fsa.github.io/sherpa/onnx/tts/all/Chinese-English/matcha-icefall-zh-en.html
- Matcha 預訓練模型總覽：https://k2-fsa.github.io/sherpa/onnx/tts/pretrained_models/matcha.html
- WASM TTS 原始碼：https://github.com/k2-fsa/sherpa-onnx/tree/master/wasm/tts
- 模型原始頁：https://modelscope.cn/models/dengcunqin/matcha_tts_zh_en_20251010
