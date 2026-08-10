# Matcha

更新日期：2026-08-07

## 目前判定

`matcha-icefall-zh-en` 是本專案目前選定的 TTS 模型。它已通過中文朗讀試聽品質 gate，也完成正式桌面瀏覽器單執行緒 benchmark；在相同五句中文文本的三方盲測中得到 `90/100`，高於 Kokoro 的 `80/100` 與 Piper HuaYan medium 的 `60/100`，Piper 另被標記有外國腔。

上游建議的 browser WASM＋中文 FST 配置中位 task `RTF` 為 `0.1411`，約 `7.09x realtime`；繁體小說原文不經 OpenCC 亦能生成，試聽品質已獲接受。選定的文字路徑為「繁體直輸 → `phone/date/number` FST → Matcha」，生成配置採 `noise_scale=0.667`，繁簡轉換不是必要前處理。目前 pilot 由獨立 kaldifst + OpenFST WASM 執行三個 FST，Matcha/Vocos 則共用 ORT Web WASM；兩者各自使用 linear memory，不再載入固定 512 MiB heap 的官方 frontend bundle。Repository release gate 只涵蓋中文 frontend 與桌面 browser；eSpeak 與 iPhone 實機不在範圍內。

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

實聽發現 `「」` 被映射為 `“”` acoustic tokens 後會發音；目前已在 tokenization 前移除中英文開閉引號、保留句內其他韻律標點，並加入繁體直輸 token 迴歸測試。Taiwan profile 現含「垃圾」、37 個 phrase overrides，以及本節說明的保守 `著 → zhe5` contextual rule；official profile 保持上游結果。review schema v2 把 `confirmed`、`source-and-model-supported`、`model-supported` 證據狀態與 `profiles.taiwan` 產品啟用清單分開，260 字 allowlist 不宣稱為逐項人工確認。「關卡」逐字讀音符合臺灣 `guan1 ka3`；「堤壩」已依教育部讀音覆寫為 `ti2 ba4`。完整事件與數值保存在 [共同結果](../../platform/RESULTS.md)。

## 小說 G2P 稽核 pilot

長篇小說的讀音診斷分成兩層，不能把 ASR 聽回當成破音字的唯一判定：正式比較須先固定既有 `phone → date → number` FST，再比較 FST 後的 Matcha lexicon longest-match 與 contextual G2P。小說 ZIP 是外部測試輸入，不提交 repository；本機完整報告使用 `*.local.json` 並由 `.gitignore` 排除。

現況稽核器會逐行串流讀取 ZIP，輸出正規化文字的聚合統計、實際 lexicon match、單字 fallback 與 unknown：

```sh
pnpm audit:matcha-g2p -- ~/Downloads/jl.zip
```

2026-08-10 對 1,182 個章節、257,153 行的本機小說跑完 A 基線，共得到 11,942,487 個 Matcha token、1,026 次 unknown（29 種）與 9,318,402 次單字 fallback（5,293 種）。最明顯的系統性候選是「著」：42,758 次單字 fallback 全部使用 `zhu4`。版面清理辨識 1,615 條由常見 dash 組成的獨立分隔線，包含兩行 U+2015 `―`；修正後這些單元輸出空文字、不進合成，unknown 降為 1,018 次（28 種）。unknown 主要是正文中的半形連字號、遮字 `**`、作者附註英文與檔尾 URL，必須和真正的缺字分開分類。

contextual G2P pilot 使用 g2pW `0.1.1` 的 `G2PWModel-v2-onnx`，只作開發期比較，不接產品 Worker。官方 archive 為 589,075,404 bytes，SHA-256 `699f3c1fd7fb0e2c2d49ed2486826fd5bff233fee7759350a91c3b49aedc4ed2`；解壓後 ONNX 約 635 MB。程式碼為 Apache-2.0，但 checkpoint、BERT tokenizer 與訓練資料仍須各自完成授權查核，不能由程式碼授權推定可隨產品散布。

本機準備好已忽略的 model 與 tokenizer cache 後執行：

```sh
UV_CACHE_DIR=/tmp/wasmtts-uv-cache \
UV_TOOL_DIR=/tmp/wasmtts-uv-tools \
pnpm audit:matcha-g2pw-pilot -- ~/Downloads/jl.zip --max-sentences 500
```

首 500 句 pilot 使用 g2pW ONNX、單程序 DataLoader、batch 32；19,143 個可對齊漢字中有 17,987 個同音，1,156 個差異，表面一致率 `93.96%`。wall time 為 272.82 秒，即每秒 1.83 句，因此它適合在靜態掃描後對高風險句做第二階段判讀，不適合直接成為 iOS 即時 frontend。高頻差異包含 `著 zhu4 → zhe5` 108 次、`得 de2 → de5` 55 次、`長 zhang3 → chang2` 10 次及 `柵 shan1 → zha4` 7 次；另有「一／不」變調、輕聲與臺灣讀音差異，不能把全部 1,156 筆直接視為 Matcha 錯誤。這輪 Python pilot 尚未套 FST，只比較可逐字對齊的原文漢字；正式 B/C 必須改吃同一份 FST 後文字。報告會先按 `polyphone`、`tone_sandhi`、`neutral_tone`、`tone_disagreement` 分類，再由人工抽樣判定區域音與模型爭議。

第一輪人工審核已把教育部來源、版本、觀察值、目標 phones 與實作範圍寫入 [`matcha-g2p-review.json`](../../platform/matcha-g2p-review.json)。七個 `phrase-override` 對全書 dry-run 共命中 2,276 次：`記得` 1,137、`著急` 831、`長短` 124、`柵欄` 67、`著重` 57、`駐紮` 35、`執著` 25；token 總數不變、沒有新增 unknown，單字 fallback 實測減少 4,496 次。

「著」contextual rule 共做四輪各 300 句的 targeted pilot。第一輪按 archive order，只收錄同一前字至少兩筆且全部為 `zhe5` 的 49 字；後三輪排除既有 allowlist，再按前一字分層抽樣，每字最多三個不同句子，只收錄至少三筆且全部為 `zhe5` 的 90、67、54 字。四輪合計 260 個前字、908 次 `zhe5`、零反例；`見／不／有／得／餘／一／在／用／空／覺／撿／側／撈／摔` 等多讀音前字明確排除。加入下一段固定詞後，全書 contextual rule 實際命中 36,705 次，剩餘 `著 zhu4` fallback 為 4,402 次。這 4,402 是待分類 trace，不是 4,402 個已確認錯讀；其中含 `顯著／卓著／著名／著稱` 等原本就應維持 `zhu4` 的案例。規則只在 longest-match 最後仍落到單字「著」時生效，因此完整詞優先，allowlist 外也維持上游讀音。Taiwan profile 的瀏覽器產品路徑已直接確認 `帶著 → dai4 zhe5`，兩個 append 共 10.656 秒，waveform、MP3 與 MediaSource 有效且無 underflow／append／producer error；official profile 不套此規則。

第三輪另把教育部明列的 `著 zhao2` 結果助詞與 `著手 zhuo2 shou3` 落成 12 個 longest-match phrase overrides：`睡著、找著、碰著、逮著、嚇著、正著、摸不著、犯不著、睡不著、用得著、管不著、著手`。全書共命中 738 次；加入所有 phrase 與四輪 contextual rules 後，單字 fallback 為 9,275,437，token 仍為 11,942,487、unknown 仍為 1,018。`見著` 在分層 pilot 中 `zhe5/zhao2` 各有樣本，因此刻意不作固定詞。

「得」分層 pilot 另抽 300 句，共比較 19,823 個可對齊漢字，18,378 個一致、1,445 個不同，表面一致率 `92.71%`；其中 neutral-tone 候選 460 次。由於 g2pW 會把教育部與上游 lexicon 均為 `zhi2 de5` 的「值得」也列為差異，這輪仍只把模型當候選產生器。教育部詞條與 pilot 共同支持、且上游繁體 longest-match 缺詞的 `覺得、曉得、顯得、懶得、捨得` 加入 Taiwan profile；全書依序命中 8,692、1,049、558、602、367 次，共 11,268 次，單字 fallback 降至 9,253,029。`值得、使得、免得、省得、懂得` 已由上游整詞正確處理，不重複覆寫。沒有建立全域 `得 → de5` 或按前字套用的 contextual rule，以免破壞 `de2/dei3` 用法。

Taiwan profile 的指定句瀏覽器測試實際輸出五個 `de5`，71,365 個 samples 全為有限值，peak `0.7064`、RMS `0.1461`，MP3 54,432 bytes；一個 append 4.536 秒，underflow、append error、producer error 均為 0。結果只寫入 `/tmp`，不取代 official benchmark。

「長」不能作全域覆寫：長度義讀 `chang2`，生長、年長、排行與首長義讀 `zhang3`。第一批只加入有明確教育部依據的 `長城、長劍、長河、長凳、長橋`，另完成 `堤壩 → ti2 ba4`；全書依序命中 5,016、943、725、377、54、23 次，共 7,138 次，單字 fallback 降至 9,238,759。測試明列 `長輩、長大、成長、生長、長子、長女` 必須維持 `zhang3`。

第二批加入教育部有獨立詞條的 `長命、長生、長久、長遠、長袍`，全書依序命中 564、483、433、165、185 次，共 1,830 次，單字 fallback 降至 9,235,107。保護 `zhang3` 的案例改為逐詞斷言，避免測試字串本身把 `成長` 與 `生長` 無分隔串成另一個合法詞 `長生`；全文稽核另抽查候選左右文。

「地」按前字分層抽 300 句，20,709 個可比較漢字中有 19,393 個一致、1,316 個差異，表面一致率 `93.65%`。ROI 工具把 129 個有抽樣的前字分為 2 個 actionable、95 個維持目前讀音、5 個混合與 27 個樣本不足；只有 `兆` 4/4 與 `主` 3/3 全為 `de5`。產品採更窄的 `徵兆地`、`自主地` 固定結構，全文命中 75、40 次，單字 fallback 降至 9,234,885；不建立全域「地」或單前字規則。

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
- 擴充電話、貨幣、範圍、序號與其他中文文字正規化；建立可審核的臺灣區域讀音覆寫詞典。
- 在產品採用前釐清 acoustic model、Vocos、lexicon、FST 與聲音資料的授權。

## 上游資料

- 模型、API 與樣本：https://k2-fsa.github.io/sherpa/onnx/tts/all/Chinese-English/matcha-icefall-zh-en.html
- Matcha 預訓練模型總覽：https://k2-fsa.github.io/sherpa/onnx/tts/pretrained_models/matcha.html
- WASM TTS 原始碼：https://github.com/k2-fsa/sherpa-onnx/tree/master/wasm/tts
- 模型原始頁：https://modelscope.cn/models/dengcunqin/matcha_tts_zh_en_20251010
