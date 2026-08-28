# 專案代理指引

## Project Overview

`wasmtts` 是一個**引擎套件**：把 Matcha `matcha-icefall-zh-en` 打包成可在瀏覽器（含 iOS Safari／PWA）離線執行的中文 TTS 引擎，以 release tarball `wasmtts-engine.tar.gz` 發布給下游應用。下游只提供 UI、hosting 與模型下載；文字前端、字典、text-normalizer 與合成核心都由本 repo 出貨並以 gate 驗證。

本 repo 有兩種工作模式；預設是**引擎模式**：

1. **引擎模式**（預設）：維護 tarball 內容、lexicon pipeline、runtime profile、release gates 與消費端契約。工作範圍見「引擎套件」一節。
1. **研究模式**：只在使用者明確要求選型、benchmark、模型比較或重現歷史結果時進入。研究紀錄在 [GOAL.md](GOAL.md)、[platform/RESULTS.md](platform/RESULTS.md)、[frameworks/](frameworks/)；模型選型已結束（Matcha 盲測 `90`、Kokoro `80`、Piper `60`），除非使用者明確要求重新選型，不要下載、恢復或最佳化 Piper、Kokoro、VITS 或其他模型。不要把含 NaN、Infinity、peak 為零或 RMS 為零的 waveform 當成有效 benchmark。

## 引擎套件

### Tarball 內容（`scripts/release-manifest.json` 是唯一事實來源）

| 檔案 | 角色 |
|---|---|
| `matcha-engine.js` | 入口：`MatchaEngine.create({...})` 一次組好前端、normalizer 與合成 |
| `matcha-frontend.js`、`matcha-taiwan-profile.js` | 繁體直輸文字前端與臺灣讀音 profile adapter |
| `matcha-synthesis.js` | Matcha acoustic + Vocos + ISTFT + silence scaling |
| `kaldifst-normalizer.js`、`matcha-kaldifst-normalizer.{js,wasm}` | 獨立 kaldifst + OpenFST text-normalizer（`phone/date/number` FST，順序固定） |
| `matcha-lexicon.txt`、`matcha-lexicon.meta.json` | **編譯後的 wasmtts lexicon**（單一檔即完整）與其 provenance |
| `matcha-profile.runtime.json` | review 的 runtime 子集（contextual rules；phrase overrides 已烘進 lexicon） |
| `matcha-assets.json` | 語音包定義（schemaVersion 4）：模型／tokens／FST 的來源、`packName`、`bytes`、`sha256`，以及 `lexicon` 區塊 |
| `README.md`、`LICENSE` | 消費端文件與授權 |

模型權重、tokens 與 FST 不在 tarball 內，下游依 `matcha-assets.json` 自行下載；`packName` 不變量：資產 bytes 改變時 `packName` 必須跟著改變（編譯後 lexicon 的 `packName` 含內容 hash，自動滿足）。只有帶 `packName` 的條目是下游要供檔的資產；`matcha.files.lexicon.txt` 標 `role: build-input`，**下游不需要也不應看到上游 lexicon**。

### `MatchaEngine.create` 契約

`lexiconText`、`tokensText`、`profile`（`matcha-profile.runtime.json` 物件）、`fstBuffers`、`acousticModel`、`vocoderModel` 缺一即 throw；沒有任何可漏傳就靜默降級的 optional 字典參數。waveform 驗證（finite／peak／RMS）在 engine 內一處完成。`platform/matcha-engine.js` 的載入順序與參數見檔頭註解；消費端範例見 [README.md](README.md)。

### Lexicon pipeline

```text
上游 matcha-icefall-zh-en（簡體 lexicon.txt，revision 由 matcha-assets.json 釘定）
  + platform/matcha-g2p-review.json（臺灣讀音審核帳本）
  + platform/matcha-lexicon-traditional-curation.json（鏡像 curation）
  → pnpm lexicon:build（platform/build-matcha-lexicon.mjs）
  → platform/dist/{matcha-lexicon.txt, matcha-lexicon.meta.json, matcha-profile.runtime.json, matcha-assets.json}
```

1. 編譯內容：上游簡體全量原樣 ＋ **全量**繁體鏡像（OpenCC 詞組級 cn→tw）＋ review phrase overrides 烘入。鏡像讀音：base 音節修正條目取逐位合併讀音，其餘一律取現行 taiwan frontend 讀音——鏡像只補 longest-match 邊界（`道長`＋`久久` 不再被切成 `道／長久`），不引入新讀音裁決；curation `exclusions`／`charPhoneExclusions`／`guards` 生效。
1. 產物**不提交 git**（`platform/dist/` 已忽略）；CI 在 `pnpm fetch:matcha-assets` 後 `pnpm lexicon:build`，再跑 gates 並打包。`test:matcha-lexicon` gate 驗證決定性（建置兩次 sha 相同）、上游詞條完整、phones 在 tokens 內、固定正反例，且只用「編譯後 lexicon ＋ runtime profile」建前端。
1. 讀音決策只改 `matcha-g2p-review.json`（有教育部來源）與 curation 檔；**不要**手改編譯產物，也不要再建「補充詞典」這種第二層字典。
1. 上游追蹤：lexicon／tokens／FST 是模型 release 的一部分，Renovate 每週以 `git-refs` 追蹤 HF revision（`platform/upstreams.yaml`、`matcha-assets.json`），開 PR → candidate gate 重編 lexicon → 綠燈合併 → release。本機用 `pnpm lexicon:sync`（`--check` 只比對）查最新 revision、換 pin、重抓、重編並產 `platform/dist/lexicon-diff.md`。

### 發版

`push main`（artifact-sensitive paths）或 Renovate roll-up 觸發 `release.yml`：native WASM build → fetch 上游資產 → `lexicon:build` → `test:release-gates`（frontend／lexicon／profile／FST／package-smoke／browser benchmark／ASR CER）→ `scripts/package-release.mjs` 打包 → attest → 發布 `wasmtts-engine.tar.gz` 與 `RELEASE.md`（含 wasmtts lexicon 段與前一版 stats 對照）。破壞下游契約（`matcha-assets.json` schema、tarball 檔名、engine 參數）時必須在 RELEASE.md 與 README 明講。

## Setup

- JavaScript 套件只使用 `pnpm` 管理；安裝命令為 `pnpm install`。
- Python 工具只透過 `uv` 執行，不要新增 pip／venv 工作流程。
- 第三方神經模型放在 `platform/models/`（`pnpm fetch:matcha-assets`），非神經引擎的聲音資料、字典或規則資產放在 `platform/assets/`；這些目錄與 `platform/dist/` 均不可提交。
- 已測環境與模型路徑記錄在 `platform/RESULTS.md` 及各 runner 中。

## Architecture

- `platform/`：引擎原始碼（`matcha-engine.js`、`matcha-frontend.js`、`matcha-taiwan-profile.js`、`matcha-synthesis.js`、`kaldifst-normalizer.js`、`kaldifst-wasm/`）、lexicon pipeline（`build-matcha-lexicon.mjs`、review／curation）、gate 測試，以及研究模式的 runner、分析工具與機器可讀結果。
- `scripts/`：release 流程（`release-manifest.json`、`package-release.mjs`、`run-release-gates.mjs`、`test-package-smoke.mjs`、`generate-release-md.mjs`）、資產抓取（`fetch-matcha-assets.mjs`）與上游同步（`sync-matcha-upstream.mjs`）。
- `mobile-host/`：提供 COOP／COEP headers 的測試 host、Worker 與 streaming player 參考實作（背景逐句合成、單一媒體 timeline）；階段二會把 Worker／player 參數化後併入 tarball。Worker 的 `taiwan` profile 走編譯後 lexicon，`official` 只保留給研究 A/B 讀上游原檔。
- `GOAL.md`、`frameworks/`、`platform/RESULTS.md`、`frameworks/MODEL-COMPARISON.md`：研究模式文件；`README.md` 是消費端導覽，不在此複製實驗紀錄。

正式文字路徑固定為「繁體直輸 → 官方 `phone/date/number` FST → wasmtts lexicon → Matcha」；`platform/matcha-fst.js` 保留為 JavaScript golden／診斷基線，修改時必須維持 phone、date、number 順序及 OpenFST tie-break。Matcha/Vocos 共用 ORT Web WASM，text normalizer 是另一個獨立 linear memory 的小型 WASM，不載入固定 512 MiB heap 的 sherpa-onnx frontend bundle。前端尚未涵蓋英文 eSpeak。

iOS 產品路徑採用「背景逐句合成、單一媒體 timeline」：使用者手勢只啟動一次長駐 `HTMLAudioElement`，Worker 產生的音訊單元經編碼後 append 到同一個 `ManagedMediaSource`／`SourceBuffer` sequence。不得預產整章、在句子或章節邊界建立新 element 或再次呼叫 `play()`；buffer 必須有界並以 media／append 事件驅動 refill，不可只依賴背景 timer。

## Conventions

- 文件與新註解使用繁體中文；模型、operator、API 名稱保留原文。
- Markdown 有序清單的每一項都使用 `1.`。
- 本 repo 服務多個下游；文件、註解與 commit 訊息不得以任何特定下游專案為例或提及其名稱。
- 測試結果寫入 `platform/results/`，不可手工改寫原始量測 JSON。
- 大型模型、壓縮檔、下載產物與 `platform/dist/` 建置產物不可提交；提交前檢查 `git status`。
- 保存可重現命令、合成架構、引擎版本、模型／聲音資料版本、聲線、取樣率、適用時的執行緒數與 runtime 版本。
- 預設基準為單一 WASM thread；多執行緒結果必須確認 `crossOriginIsolated` 與 `SharedArrayBuffer`，不可默默 fallback。
- `RTF` 固定表示「產生可 append 音訊的 wall time ÷ 音訊長度」；另以 `realtime multiplier = 1 / RTF` 回報速度，不可互換名稱。
- 鎖屏測試必須記錄 Safari tab／Home Screen PWA、iOS 版本、裝置、音訊 transport、buffer 水位、連續時長、跨章數、Media Session 控制、靜音開關、耳機中斷及重新回到前景的結果。

## Commands

```sh
pnpm install
pnpm fetch:matcha-assets     # 下載釘定 revision 的上游資產到 platform/models/
pnpm lexicon:build           # 編譯 wasmtts lexicon 到 platform/dist/
pnpm lexicon:sync --check    # 查上游是否有新 revision（不帶 --check 則換 pin、重抓、重編、產 diff 報告）
pnpm test:matcha-lexicon
pnpm test:release-gates      # 完整 release gates（含打包 smoke 與 browser benchmark）
pnpm host:mobile             # 本機 COOP/COEP host；mobile-host/matcha-stream-test.html
```

研究模式命令（`benchmark:matcha*`、g2pW 稽核、歷史 Piper／VITS／Kokoro runner）見 [platform/README.md](platform/README.md) 與 [platform/RESULTS.md](platform/RESULTS.md)。
