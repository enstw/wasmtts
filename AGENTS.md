# 專案代理指引

## Project Overview

本 repository 研究中文 TTS 在瀏覽器 WebAssembly，尤其是 iOS Safari 與行動 PWA 上的可行性。Piper HuaYan medium 是 `1.00x` 基準；所有效能結論必須同時保留 runtime 環境、音訊有效性與品質限制。

先閱讀 [GOAL.md](GOAL.md) 了解已測框架、目前結論與候選判定標準。不要把含 NaN、Infinity、peak 為零或 RMS 為零的 waveform 當成有效 benchmark。

## Setup

- JavaScript 套件只使用 `pnpm` 管理；安裝命令為 `pnpm install`。
- Python 工具只透過 `uv` 執行，不要新增 pip／venv 工作流程。
- 第三方模型放在 `platform/models/`；此目錄已忽略，不可提交模型權重。
- 已測環境與模型路徑記錄在 `platform/RESULTS.md` 及各 runner 中。

## Architecture

- `GOAL.md`：canonical 研究目標與已測框架目錄。
- `frameworks/<name>/`：該框架的細節、benchmark、最佳化、限制與專屬樣本。
- `platform/`：統一 WASM harness、browser pages、runner、分析工具及機器可讀結果。
- `mobile-host/`：提供 COOP／COEP headers，讓桌面與行動裝置載入 repository 內的測試頁。
- `README.md`：只負責導覽與快速開始，不在此複製完整實驗紀錄。

新增框架時，先建立 `frameworks/<name>/README.md`，再接入 `platform/`。跨框架比較必須共用相同文字、暖機次數、量測單位與 waveform 驗證；若環境不同，必須明確標為只可組內比較。

## Conventions

- 文件與新註解使用繁體中文；模型、operator、API 名稱保留原文。
- Markdown 有序清單的每一項都使用 `1.`。
- 測試結果寫入 `platform/results/`，不可手工改寫原始量測 JSON。
- 大型模型、壓縮檔與下載產物不可提交；提交前檢查 `git status`。
- 保存可重現命令、模型版本、聲線、取樣率、執行緒數與 runtime 版本。
- 預設基準為單一 WASM thread；多執行緒結果必須確認 `crossOriginIsolated` 與 `SharedArrayBuffer`，不可默默 fallback。

## Commands

```sh
pnpm install
pnpm host:mobile
pnpm benchmark:vits
pnpm benchmark:kokoro -- fp32
```

Kokoro selective INT8：

```sh
uv run platform/quantize-kokoro.py \
  platform/models/kokoro-fp32/model.onnx \
  platform/models/kokoro-selective-int8/model.onnx

uv run platform/validate-kokoro-onnx.py \
  platform/models/kokoro-selective-int8/model.onnx \
  --tokens platform/models/kokoro-selective-int8/tokens.txt \
  --lexicon platform/models/kokoro-selective-int8/lexicon-zh.txt \
  --voices platform/models/kokoro-selective-int8/voices.bin
```

完整的 legacy sherpa 與 operator probe 命令請見 [platform/README.md](platform/README.md) 與 [platform/RESULTS.md](platform/RESULTS.md)。
