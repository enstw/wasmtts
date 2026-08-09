![wasmtts](.github/banner.png)

# wasmtts

以 Matcha、Vocos 與獨立 FST WASM 打造可在瀏覽器離線執行的中文 TTS。

`wasmtts` 研究並實作不依賴伺服器的中文語音合成路徑，目標是在 Safari／PWA 以單一 WASM thread 背景逐句產生音訊，持續 append 到同一條媒體 timeline。現行選定模型是 `matcha-icefall-zh-en`；Piper HuaYan medium 是 frozen 基準，Kokoro 與其他歷史方案只保留作選型證據。

目前的 frontend pilot 為：

```text
繁體中文
  → kaldifst + OpenFST text-normalizer WASM
  → phone/date/number FST
  → lexicon/tokens
  → Matcha acoustic model
  → Vocos + ISTFT
  → MP3 segments
  → 單一 MediaSource timeline
```

Matcha 與 Vocos 共用 ONNX Runtime Web；text normalizer 使用另一個獨立 WASM linear memory，不載入 sherpa-onnx frontend bundle 的固定 512 MiB heap。

## 目前結果

- 相同文本盲測：Matcha `90`、Kokoro `80`、Piper `60`。
- Chromium 單執行緒完整 producer：RTF `0.1387`，約 `7.21x realtime`。
- 10 個 MP3 append、51.228 秒音訊，無 underflow、append error 或 producer error。
- 固定 Whisper small 聽回 baseline：49 字錯 1 字，CER `2.04%`。
- ORT Web `1.27.0` 初始化後記憶體為快照而非真正 peak；release gate 採桌面 browser 的 512 MiB 上限。

測試硬體、瀏覽器版本、量測邊界與限制請以 [GOAL.md](GOAL.md) 和 [platform/RESULTS.md](platform/RESULTS.md) 為準。

## 快速開始

需求：Node.js、`pnpm`、Emscripten，以及執行 Python 工具時使用的 `uv`。

```sh
pnpm install
pnpm build:matcha-kaldifst
pnpm host:mobile
```

另開終端機執行：

```sh
pnpm test:matcha-frontend
pnpm test:matcha-fst
pnpm test:matcha-fst:tables
pnpm test:matcha-kaldifst-wasm
pnpm benchmark:matcha
pnpm benchmark:matcha-stream
pnpm test:matcha-asr
```

第三方模型不會提交至 repository。請依 [platform/README.md](platform/README.md) 將 Matcha acoustic model、Vocos、lexicon、tokens 與 FST 放入已忽略的 `platform/models/`。

## 自動上游追蹤

[Renovate](renovate.json) 追蹤 npm、ONNX Runtime Web、Matcha/Vocos 資產來源、FST、kaldifst、OpenFST、Emscripten 與固定 ASR oracle。每週一早上 [renovate workflow](.github/workflows/renovate.yml) 啟動,所有更新併成單一 roll-up PR;candidate 必須通過 native WASM build、FST golden、有效 waveform、RTF、512 MiB 記憶體上限與 ASR CER gate,workflow 才合併並發版 — 一週一次。`main` 會重跑相同 gates；成功時發布正式 Release，失敗時以 pre-release 保存版本組合、原因、logs 與機器可讀報告。eSpeak 與 iPhone 測試不屬於本 repository 的 release gate。

```sh
pnpm fetch:matcha-assets
pnpm test:release-gates
```

兩類已證實與程式碼無關的基建噪音由 gate runner 吸收：瀏覽器 CDP 啟動逾時（單項重試一次）與 Matcha 合成抽樣導致的 ASR 聽回壓線（`matcha-core`＋`asr-listening` 成對重跑、取第一組全綠、至多三組）。真正的退化每一組都會失敗；重試次數記錄在 `release-gates.json` 的 `attempts` 欄位。

## Repository 結構

- [`GOAL.md`](GOAL.md)：canonical 產品目標、選型結論與完成條件。
- [`frameworks/matcha/`](frameworks/matcha/)：Matcha 架構、品質與限制。
- [`platform/`](platform/)：WASM harness、browser runners、分析工具及結果。
- [`mobile-host/`](mobile-host/)：COOP／COEP host 與長駐 MediaSource transport。
- [`platform/upstreams.yaml`](platform/upstreams.yaml)：非 npm 上游版本 manifest。

## 授權與第三方資產

本 repository 自有程式碼與文件採 [MIT License](LICENSE)。第三方模型、模型輸出、FST、字典、runtime、套件及下載資產不因本 LICENSE 而重新授權，仍分別受其上游條款約束；使用者必須在下載、散布或產品採用前自行確認授權。本 repository 不發布 Matcha 或 Vocos 模型權重。
