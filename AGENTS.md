# 專案代理指引

## Project Overview

本 repository 已選定 Matcha `matcha-icefall-zh-en` 作為目前的 iOS Safari／PWA 離線中文 TTS 模型。現行工作只聚焦 Matcha 的正式文字前端、記憶體與串流整合；除非使用者明確要求重新選型，不要下載、恢復或繼續最佳化 Piper、Kokoro、VITS 或其他模型。Piper HuaYan medium 維持 frozen 品質／效能基準 `1.00x`，既有其他方案只保留為歷史決策證據。

先閱讀 [GOAL.md](GOAL.md) 了解 Matcha 選型決策、固定配置與 release 條件。不要把含 NaN、Infinity、peak 為零或 RMS 為零的 waveform 當成有效 benchmark。

## Setup

- JavaScript 套件只使用 `pnpm` 管理；安裝命令為 `pnpm install`。
- Python 工具只透過 `uv` 執行，不要新增 pip／venv 工作流程。
- 第三方神經模型放在 `platform/models/`，非神經引擎的聲音資料、字典或規則資產放在 `platform/assets/`；這些目錄均不可提交大型下載產物。
- 已測環境與模型路徑記錄在 `platform/RESULTS.md` 及各 runner 中。

## Architecture

- `GOAL.md`：canonical 研究目標與已測方案目錄。
- `frameworks/MODEL-COMPARISON.md`：跨模型、跨語言的市場尺寸、授權與公開品質證據；不是本機 benchmark 排名。
- `frameworks/<name>/`：該框架的細節、benchmark、最佳化、限制與專屬樣本。
- `platform/`：統一 WASM harness、browser pages、runner、分析工具及機器可讀結果。
- `mobile-host/`：提供 COOP／COEP headers，讓桌面與行動裝置載入 repository 內的測試頁。
- `README.md`：只負責導覽與快速開始，不在此複製完整實驗紀錄。

Matcha 的產品配置、限制與重現步驟寫入 `frameworks/matcha/README.md`，共同量測結果寫入 `platform/RESULTS.md`。歷史框架目錄與 runner 可供查證，但不是目前開發入口；不得在未獲明確要求時恢復已移除的其他模型資產。Matcha 的核心與端到端量測仍須保留相同文字、計時邊界、量測單位、暖機次數與 waveform 驗證。

iOS 產品路徑採用「背景逐句合成、單一媒體 timeline」：使用者手勢只啟動一次長駐 `HTMLAudioElement`，Worker 產生的音訊單元經編碼後 append 到同一個 `ManagedMediaSource`／`SourceBuffer` sequence。不得預產整章、在句子或章節邊界建立新 element 或再次呼叫 `play()`。buffer 必須有界並以 media／append 事件驅動 refill，不可只依賴背景 timer；`bookworm` 的 Piper HuaYan medium 單 thread 實作是目前的產品參考。

Piper Worker、MP3 encoder 與上述播放 transport 已由 `bookworm` 驗證；不要在本 repository 重做 Piper 整合或把 fixture transport 數字當成研究結果。Matcha 必須使用 `mobile-host` 的既有 producer 契約完成整合；iPhone/PWA 實機驗收不屬於本 repository 的 release gate，既有實機紀錄僅為歷史相容性證據。

Matcha `matcha-icefall-zh-en` 是目前選定模型：相同文本盲測為 Matcha `90`、Kokoro `80`、Piper `60`，Piper 被標記有外國腔。正式文字路徑固定為「繁體直輸 → 官方 `phone/date/number` FST → Matcha」，採 `noise_scale=0.667`。目前 pilot 由獨立 kaldifst + OpenFST text-normalizer WASM 執行三個原始 FST；Matcha/Vocos 共用 ORT Web WASM，兩個 module 各自使用 linear memory。`platform/matcha-fst.js` 保留為 JavaScript golden/診斷基線，不載入固定 512 MiB heap 的 sherpa-onnx frontend bundle；修改時必須維持 phone、date、number 順序及 OpenFST tie-break。桌面 Worker／MP3／MediaSource 整合已通過有效 waveform 與零 underflow／append error 驗證，但記憶體數字仍只是快照，不得寫成真正 peak 或 iPhone 結果。前端尚未涵蓋英文 eSpeak。

## Conventions

- 文件與新註解使用繁體中文；模型、operator、API 名稱保留原文。
- Markdown 有序清單的每一項都使用 `1.`。
- 測試結果寫入 `platform/results/`，不可手工改寫原始量測 JSON。
- 大型模型、壓縮檔與下載產物不可提交；提交前檢查 `git status`。
- 保存可重現命令、合成架構、引擎版本、模型／聲音資料版本、聲線、取樣率、適用時的執行緒數與 runtime 版本。
- 預設基準為單一 WASM thread；多執行緒結果必須確認 `crossOriginIsolated` 與 `SharedArrayBuffer`，不可默默 fallback。
- `RTF` 固定表示「產生可 append 音訊的 wall time ÷ 音訊長度」；另以 `realtime multiplier = 1 / RTF` 回報速度，不可互換名稱。

- 改動後、push 或開 PR 前,先在本地跑 `pnpm test:release-gates`(模型在 `platform/models/`、kaldifst dist 已提交,全套可本地重現),全綠才推;純文字層改動可先用較快的 `pnpm test:matcha-frontend` / `pnpm test:matcha-fst`,但 gate runner、CI、依賴等 release 級改動一律全套。CI 一輪約 6 分鐘還會排隊,不要拿紅燈當本地測試(owner 要求,2026-08-10)。
- candidate/release 紅燈先看 `release-gates.json` 的 `attempts` 欄位與 console 的 `RETRY` 行(README 的 flake 吸收段):骰運只失敗一組,真退化每一組重跑都會失敗。
- `platform/models/` 是本 repo 的工作快照,owner 隨時會換檔;repo 外的實驗或 harness 不得直接讀取,應依 `platform/upstreams.yaml` 的 pin 自行下載私有副本並驗證 SHA-256(owner 要求,2026-08-15)。

## Commands

```sh
pnpm install
pnpm host:mobile
pnpm benchmark:matcha
pnpm benchmark:matcha-upstream-fst
pnpm benchmark:matcha-fst-ab
pnpm benchmark:matcha-stream
```

歷史 Piper、VITS、Kokoro 與 operator probe 命令僅供結果重現，請見 [platform/README.md](platform/README.md) 與 [platform/RESULTS.md](platform/RESULTS.md)。
