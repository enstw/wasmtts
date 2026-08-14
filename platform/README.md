# 統一 WASM 測試平台

本目錄集中 Matcha 的 browser pages、runner、分析工具、資產掛載點與測試結果。Piper、VITS、Kokoro 與 operator probe 檔案只保留為選型與效能調查的歷史重現工具；目前產品開發與 benchmark 均以 Matcha 為主。Matcha 結論寫在 `frameworks/matcha/`，機器可讀結果與跨方案歷史數值保留在此處。

## 目錄內容

- `benchmark.js`：保留的 sherpa-onnx Node WASM 對照 harness。
- `vits-browser.html`、`run-vits-browser.mjs`：歷史 Piper、AISHELL3 與 MeloTTS ORT Web 路徑。
- `breeze2-vits-browser.html`、`run-breeze2-vits-browser.mjs`：MediaTek Breeze2-VITS controlled challenger 的單線程 ORT Web footprint／效能 runner；不屬於現行產品路徑。
- `../frameworks/vits/fanchen-wnj/`：Fanchen WNJ VITS controlled challenger 的 manifest、下載器、browser page 與單線程 ORT Web runner；研究工具不屬於 release artifact 或現行產品路徑。
- `kokoro-browser.html`、`run-kokoro-browser.mjs`：歷史 Kokoro ORT Web、profiling、shape probe 與 thread 測試。
- `matcha-browser.html`、`run-matcha-browser.mjs`：Matcha acoustic model、Vocos 與 JavaScript ISTFT 的單執行緒 ORT Web 路徑。
- `kaldifst-wasm/`、`kaldifst-normalizer.js`：獨立 kaldifst + OpenFST text-normalizer WASM、最小 C ABI 與 UTF-8 bridge；Matcha/Vocos 的 ORT Web memory 與此 module 的 memory 相互獨立。
- `upstreams.yaml`：Renovate 追蹤的 Matcha acoustic、Vocos、lexicon/tokens、三個 FST、sherpa browser control、kaldifst/OpenFST 與 Emscripten 上游版本；版本 PR 只是通知，資產仍須人工驗證。
- `asr-listening-gate.py`、`asr-baseline/`：以固定 revision 的 multilingual Whisper 聽回 Matcha WAV，計算正規化 CER，並同時套用絕對上限與相對正式 baseline 的退化上限。這是可懂度回歸 gate，不等同主觀自然度盲聽。
- `matcha-fst.js`：從 Bookworm 移植的純 JavaScript OpenFST reader，保留作 golden A/B 與診斷基線。
- `matcha-frontend.js`、`matcha-synthesis.js`：可供 Worker 與測試共用的繁體直輸／FST／lexicon 前端及 Matcha + Vocos 合成核心。
- `matcha-taiwan-profile.js`：正式臺灣讀音 profile adapter；集中組合 legacy「垃圾」覆寫與 `matcha-g2p-review.json` 已啟用規則，並隨 Release 獨立發布及納入 frontend tarball。
- `audit-matcha-g2p.mjs`、`run-g2pw-pilot.py`：對外部小說 ZIP 執行現況 frontend trace 與開發期 contextual G2P 差異掃描；小說、g2pW 模型與 `*.local.json` 報告皆不提交。
- `rank-matcha-g2p-roi.mjs`：把前字或後字分層 pilot 的抽樣一致性與全文相鄰字次數合併排序，並保留各樣本的 Matcha phone 以處理多讀音；`estimatedAffectedCeiling` 只是候選上限，不是已確認錯讀數。
- `generate-g2pw-webgpu-fixture.py`、`g2pw-preprocess-worker.py`、`g2pw-webgpu-benchmark.html`、`run-g2pw-webgpu-browser.mjs`：fixture 先以 Python ORT CPU 產生真實 g2pW ONNX input/golden；常駐 Python worker 只建立 tokenizer feeds、不載入 native ORT session，browser page 則可重用單一 ORT Web WebGPU session。fixture 與結果均為忽略的 `*.local.json`。
- `index-g2pw-webgpu-fixture.mjs`：WebGPU → SQLite architecture slice；以模型、lexicon、FST、profile 與 input hashes 隔離 run，transaction 寫入 agreement/difference occurrences，相同 fingerprint 完成後直接 reuse。SQLite 是本機忽略產物。
- `index-matcha-g2pw-webgpu.mjs`：正式全文 coordinator；依 ZIP archive order 切句，先跑 layout cleanup 與固定順序 `phone/date/number` FST，再套 Taiwan profile，透過常駐 tokenizer／WebGPU session 分批寫 SQLite。每批 prediction 與 checkpoint 在同一 transaction，`--max-sentences` 可安全分段續跑。
- `matcha-g2p-review.json`：schema v2 分開保存辭典來源、模型證據與產品 profile。entry 不因存在就自動生效；`profiles.taiwan` 明列啟用的 phrase overrides 與 contextual rules。contextual rule 可限制前字或後字；`著` 的前字 allowlist 標為 `model-supported`，不得寫成逐項人工確認或降級成全域單字覆寫。
- `run-matcha-upstream-fst-browser.mjs`：未修改的 sherpa-onnx 官方 browser bundle＋建議中文 FST 基線。
- `matcha-upstream-benchmark.html`、`matcha-upstream-benchmark.js`、`run-matcha-fst-ab-browser.mjs`：同 runtime 只切換 FST 的控制實驗。
- `generate-matcha-upstream-fst-traditional-sample.mjs`：繁體原文、不經 OpenCC 的官方 FST 試聽樣本產生器。
- `generate-matcha-frequency-ab.mjs`：以同一文本產生官方 PCM、產品 PCM、產品 MP3 與等響度診斷 EQ 四組試聽檔，用來區分官方／產品路徑、MP3 與頻譜平衡。
- `run-matcha-stream-browser.mjs`：量測 Worker 到 MP3 producer 與單一 MediaSource timeline 的端到端路徑。
- `cdp/`：browser-cdp 共用的 Chromium 探測與零相依 CDP client。
- `ort-operator-probe.html`、`run-ort-operator-probe.mjs`：歷史獨立 operator microbenchmark。
- `*.py`：歷史 Kokoro 量化、驗證、graph／shape／MAC 分析與 probe 產生器。
- `models/`：本機第三方模型掛載點；已由 Git 忽略。
- `assets/`：非神經引擎的聲音資料、字典、規則與其他大型本機資產掛載點。
- `results/`：機器可讀 JSON、profile 與可實聽 WAV。
- `RESULTS.md`：共同環境、比較表、原始三輪摘要及重跑命令。

## 本機資產路徑

目前 Matcha runner 使用以下資產：

```text
platform/models/
├── breeze2-vits/
├── fanchen-vits-wnj/
├── matcha-icefall-zh-en/
├── sherpa-onnx-wasm-simd-1.12.20-matcha-icefall-zh-en/
└── vocos-16khz-univ.onnx
```

模型權重、聲音資料與下載產物不可提交。若使用不同路徑，請透過 runner 參數設定，或同步更新程式與方案文件。

Breeze2-VITS 試跑固定 Hugging Face revision 與逐檔 SHA-256；下載後才可執行 benchmark：

```sh
pnpm fetch:breeze2-vits-assets
pnpm host:mobile
# 另一個終端機：
pnpm benchmark:breeze2-vits
```

上游 model card 未宣告 Breeze2-VITS 權重 license；這些資產只保存在本機 ignored 目錄，不可散布。完整量測與採用判定見 [RESULTS.md](RESULTS.md)。

Fanchen WNJ VITS 試跑以 release archive SHA-256 與逐檔 SHA-256 固定；下載後使用同一個 host 執行 benchmark：

```sh
pnpm exec node frameworks/vits/fanchen-wnj/fetch-assets.mjs
pnpm host:mobile
# 另一個終端機：
pnpm exec node frameworks/vits/fanchen-wnj/run-browser.mjs
```

上游未提供可直接套用於權重的明確 license；模型與合成 WAV 只保存在本機 ignored 路徑，不散布。完整量測與判定見 [RESULTS.md](RESULTS.md)。

g2pW WebGPU feasibility A/B 使用本機已忽略的 606 MiB ONNX 與 tokenizer cache：

```sh
pnpm fixture:matcha-g2pw-webgpu -- --batch-size 32
pnpm host:mobile
pnpm benchmark:matcha-g2pw-webgpu
pnpm index:matcha-g2pw-webgpu-fixture
pnpm index:matcha-g2pw-webgpu -- ~/Downloads/jl.zip --max-sentences 100 --g2pw-batch-size 128
pnpm index:matcha-g2pw-webgpu -- ~/Downloads/jl.zip --sentence-batch-size 100 --g2pw-batch-size 128 --total-sentences 315593
```

長時間掃描可改由背景管理 CLI 執行：

```sh
pnpm g2pw-index run ~/Downloads/jl.zip --sentence-batch-size 100 --g2pw-batch-size 128 --total-sentences 315593
pnpm g2pw-index run
pnpm g2pw-index status
pnpm g2pw-index logs 20
pnpm g2pw-index stop
pnpm report:matcha-g2pw-sqlite-roi
pnpm g2pw-review sync-profile
pnpm g2pw-review status
```

第一次 `run` 會保存參數並在背景啟動；之後不帶參數的 `run` 會使用相同 fingerprint 與 SQLite checkpoint 接續。啟動前會同時檢查管理 PID 與既有 index PID，若掃描已在執行便拒絕建立第二份。必要時它會一併啟動 `mobile-host`。`stop` 會對管理程序或既有 index 程序送出 `SIGINT`，runner 完成目前 batch 後落盤並清理。PID、設定與 log 位於 `platform/results/matcha-g2pw-manager.local.*`，均由 Git 忽略。

第二個命令需留在另一個 terminal；benchmark 與兩種 index command 都透過該 host 執行。固定 benchmark 只涵蓋 ONNX inference，不含 BERT tokenizer、句子切分、FST、SQLite 或跨程序傳輸。`g2pw-preprocess-worker.py` 已把 tokenizer／`TextDataset` 拆成 JSONL 常駐程序，並以 `G2PWConverter.__new__` 加載 upstream 設定與字典，刻意不建立 606 MiB native ORT session；browser page 的 `initialize`／`inferFeeds` 也重用單一 WebGPU session。fixture slice 本身尚未真正通過 FST；全文 command 才是正式 pipeline。`--max-sentences` 表示本次最多新增幾句，不是全文範圍；再次執行相同輸入、模型、FST 與 profile 會從 `last_sentence_id` 接續。移除上限才會掃到 EOF 並把 run 標成 `complete`。

全文 command 每十秒向 stderr 輸出 checkpoint、當次句數、query 數與吞吐；若提供可重現的 `--total-sentences`，也會輸出剩餘句數與 ETA。最終 JSON 仍獨立寫到 stdout，另回報 `identityMs`、browser／preprocessor 初始化、frontend、preprocessing、WebGPU round trip／純 inference、SQLite 與 `totalMs`。`queriesPerSecond` 包含本次冷啟動；`steadyQueriesPerSecond` 只以 frontend、preprocessing、WebGPU round trip 與 SQLite 計算，不含 input／model hashing 與兩個 runtime 初始化。兩者都只代表 g2pW index throughput，不是 TTS `RTF`。`SIGINT`／`SIGTERM` 會在目前 batch 完成後保留 `building` 狀態與 checkpoint，並關閉 Python worker、CDP WebSocket 與 Chromium。

`--g2pw-batch-size` 控制送入 ONNX 的 query batch，預設 32。相同開頭 100 句的 A/B 中，32／64／128 分別為 112.58／114.99／116.24 steady queries/s，因此目前桌機全文掃描可用 128，但收益只有約 3.3%。同一 ORT Web runtime 建立兩個 session 後並行 `session.run()` 會觸發 WebGPU `getBindGroupLayout` 錯誤，不作為支援配置。兩個獨立 Chrome process 可避開該錯誤，合計 steady throughput 約 137.35 queries/s，較單 process 快約 22%；每個 process 則降至 67.72–69.63 queries/s，顯示共用 GPU 已明顯競爭。若採多 process，必須先把 source sentence 範圍分 shard，不能讓兩個 coordinator 重複掃描同一段。

全文完成後，`report:matcha-g2pw-sqlite-roi` 會讀取最新的 complete run，依高信心出現次數排列 `polyphone`、`neutral_tone` 與 `tone_disagreement`，並保存前後字桶及原句樣本至忽略的 `platform/results/matcha-g2pw-sqlite-roi.local.json`。沒有持久化決策的候選為 `unreviewed`；g2pW 信心不是發音真值，必須另經辭典與語境審核才能加入 Taiwan profile。可用 `--limit`、`--min-occurrences`、`--high-confidence`、`--context-limit`、`--sample-limit` 與 `--output` 調整報告。

`g2pw-review sync-profile` 會把 Taiwan profile 已啟用的 phrase override 同步成 SQLite `review_decisions`，並以句子 offset 讓後續 ROI 排除已覆蓋 occurrence。群組決策可用 `set-group` 寫入 `needs_context`、`accepted`、`implemented`、`rejected_current_correct`、`rejected_model_error`、`rejected_regional_difference`、`deferred` 或 `superseded`；報告只保留尚無決策及仍需工作的 `needs_context`／`accepted`，不改寫原始 occurrence。

`--wasm-threads` 可在建立 WebGPU session 前覆寫 `ORT.env.wasm.numThreads`，只供診斷。相同 100 句、batch 128 的 1／2／4／8 threads 分別為 117.08／117.08／116.58／116.93 steady queries/s，落差在約 0.4% 內，沒有可採用的加速；正式掃描維持 ORT auto。

上游 FST runner 使用 sherpa-onnx `v1.12.20` 官方 release asset；壓縮檔 SHA-256 為 `a09b2b2c5d5aab156650ea3da270ea8d7f358e6f315732f481b731f87dec6d88`：

```sh
curl -L -o platform/models/sherpa-onnx-wasm-simd-1.12.20-matcha-icefall-zh-en.tar.bz2 https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.12.20/sherpa-onnx-wasm-simd-1.12.20-matcha-icefall-zh-en.tar.bz2
shasum -a 256 platform/models/sherpa-onnx-wasm-simd-1.12.20-matcha-icefall-zh-en.tar.bz2
tar xjf platform/models/sherpa-onnx-wasm-simd-1.12.20-matcha-icefall-zh-en.tar.bz2 -C platform/models
```

## Adapter 契約

不論合成架構，每個 adapter 都應提供可比較的紀錄：

- 冷啟動與可選的暖機階段；不需要暖機時明確標記。
- 使用共同文本合成完整 waveform，至少回報文字輸入到 waveform 完成的端到端 wall time；可拆分時另回報文字前處理與核心合成時間，以及 CPU／task time。
- 回報取樣率、sample 數、音訊秒數、finite sample 數、peak 與 RMS。
- 記錄文字正規化、斷詞、音素化的計時邊界；不可因某個引擎無法拆分內部階段而排除它。
- 記錄合成架構、引擎、runtime、聲音／資產版本、下載大小與執行緒數。
- 另回報產品端到端 `RTF = 產生可 append 音訊的 wall time ÷ 音訊長度` 及其倒數 `realtime multiplier`；端到端範圍包含文字前處理、合成與必要的音訊編碼。
- 長篇模式逐句輸出可 append 的編碼片段，並以單一長駐 `HTMLAudioElement`、單一 `ManagedMediaSource`／`SourceBuffer` sequence timeline 跨越句子及章節；不得為每段建立新 element 或再次呼叫 `play()`。
- 串流 adapter 必須回報 buffer ahead 秒數、最高／最低水位、underflow 次數、append 錯誤、已裁切音訊與佇列大小；buffer 必須有界，refill 不可只依賴背景 timer。

播放 transport 的參考實作位於 [`mobile-host/continuous-stream-player.mjs`](../mobile-host/continuous-stream-player.mjs)，立即可用的 fixture 頁面為 [`mobile-host/stream-test.html`](../mobile-host/stream-test.html)。新的 TTS adapter 應實作相同 producer 契約，不要各自複製 MediaSource 狀態機。

Fixture 與 Piper transport 只驗證共同播放基礎設施，不產生可排名的 TTS 結果。Matcha producer 使用相同 transport 契約完成端到端 RTF 量測；鎖屏與實機行為不屬於本 repository 的 release gate。

## 執行

先從 repository 根目錄啟動 host：

```sh
pnpm build:matcha-kaldifst
pnpm host:mobile
```

再執行 Matcha benchmark：

```sh
pnpm benchmark:matcha
pnpm benchmark:matcha-upstream-fst
pnpm benchmark:matcha-fst-ab
pnpm sample:matcha-upstream-fst-traditional
pnpm sample:matcha-frequency-ab
pnpm benchmark:matcha-stream
pnpm audit:matcha-g2p -- ~/Downloads/novel.zip
```

首次使用先執行 `pnpm build:matcha-kaldifst` 產生小型 normalizer dist；`pnpm host:mobile` 會將它與 ORT Web 一起複製到本機 vendor 目錄。`benchmark:matcha-stream` 使用另一個終端機已啟動的 host，採單一 thread，量測 kaldifst WASM FST、lexicon、推論、ISTFT、silence scaling 與 MP3 encode。eSpeak 不屬於本 repository 範圍。

要單獨驗證可選 Taiwan pronunciation profile，請把結果寫到未追蹤路徑，避免覆蓋 official benchmark：

```sh
WASM_TTS_PRONUNCIATION_PROFILE=taiwan \
WASM_TTS_STREAM_RESULT=/tmp/matcha-stream-taiwan.json \
pnpm benchmark:matcha-stream
```

可用 `WASM_TTS_STREAM_TEXT` 指定單次 smoke-test 語料；runner 會在開始播放前寫入測試頁 textarea。

FST applier 的無資產 fixture 與真實 tables golden 測試：

```sh
pnpm test:matcha-fst
pnpm test:matcha-g2p-review
pnpm test:matcha-fst:tables
pnpm test:matcha-kaldifst-wasm
pnpm test:matcha-asr
```

歷史 Piper、VITS、Kokoro runner 不屬於日常流程；若要重現舊結果，需另行取得已移除的模型資產，且不得把跨瀏覽器版本數字當成嚴格 A/B。

g2pW pilot 另需把官方 `G2PWModel-v2-onnx` 解壓至 `platform/models/g2pw/G2PWModel/`，並將 `google-bert/bert-base-chinese` tokenizer cache 放在 `platform/models/g2pw/hf/`；兩者均由 Git 忽略。確認 archive SHA-256 為 `699f3c1fd7fb0e2c2d49ed2486826fd5bff233fee7759350a91c3b49aedc4ed2` 後執行：

```sh
UV_CACHE_DIR=/tmp/wasmtts-uv-cache \
UV_TOOL_DIR=/tmp/wasmtts-uv-tools \
pnpm audit:matcha-g2pw-pilot -- ~/Downloads/novel.zip --max-sentences 500
pnpm report:matcha-g2p-roi -- platform/results/matcha-g2pw-di-stratified.local.json --output platform/results/matcha-g2p-roi-di.local.json
```

pilot 報告把差異分為 `polyphone`、`tone_sandhi`、`neutral_tone` 與 `tone_disagreement`，並保存差異字附近的短詞窗。這些是人工審核候選，不是可直接匯入產品的正確答案；目前 Python pilot 沒有套 FST，只比較可逐字對齊的漢字，正式 B/C 前端必須改吃 FST 後文字。

## 結果規則

- 需要 JIT、weight packing 或 cache 的方案先暖機；不需要暖機的方案直接量測，兩者都量三輪並取中位數。
- 主比較在適用時固定單一 WASM thread；CPU 指標優先採 Chromium CDP `Performance.TaskDuration`。
- 現有 ORT 主表不含文字前處理；新的跨 runtime 比較至少保存端到端時間，可拆分時再提供核心合成時間。
- waveform 必須全為有限值，且 peak、RMS 皆不可為零。
- 不同瀏覽器或 runtime 版本的結果只能在明確標示的 A/B 組內比較。
- 核心合成 benchmark 與鎖屏 transport 可分開診斷，但 Matcha 的產品完成資格必須另通過整合測試：鎖屏期間持續合成並 append，跨章播放不中斷且端到端 RTF 持續小於 `1`。

詳細數值請見 [RESULTS.md](RESULTS.md)。
