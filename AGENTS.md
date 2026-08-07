# 專案代理指引

## Project Overview

本 repository 研究中文 TTS 在瀏覽器 WebAssembly，尤其是 iOS Safari 與行動 PWA 上的可行性。研究範圍不限神經網路或 ONNX，也包含統計參數式、拼接式、diphone、共振峰、規則式及混合式合成。Piper HuaYan medium 是目前的 `1.00x` 基準；所有效能結論必須同時保留合成架構、runtime 環境、音訊有效性與品質限制。

先閱讀 [GOAL.md](GOAL.md) 了解已測框架、目前結論與候選判定標準。不要把含 NaN、Infinity、peak 為零或 RMS 為零的 waveform 當成有效 benchmark。

## Setup

- JavaScript 套件只使用 `pnpm` 管理；安裝命令為 `pnpm install`。
- Python 工具只透過 `uv` 執行，不要新增 pip／venv 工作流程。
- 第三方神經模型放在 `platform/models/`，非神經引擎的聲音資料、字典或規則資產放在 `platform/assets/`；這些目錄均不可提交大型下載產物。
- 已測環境與模型路徑記錄在 `platform/RESULTS.md` 及各 runner 中。

## Architecture

- `GOAL.md`：canonical 研究目標與已測方案目錄。
- `frameworks/<name>/`：該框架的細節、benchmark、最佳化、限制與專屬樣本。
- `platform/`：統一 WASM harness、browser pages、runner、分析工具及機器可讀結果。
- `mobile-host/`：提供 COOP／COEP headers，讓桌面與行動裝置載入 repository 內的測試頁。
- `README.md`：只負責導覽與快速開始，不在此複製完整實驗紀錄。

新增方案時，先建立 `frameworks/<name>/README.md`，記錄合成架構、引擎與聲音資料，再以適合該 runtime 的 adapter 接入 `platform/`；不得要求候選轉成 ONNX。跨方案比較必須共用相同文字、計時邊界、量測單位與 waveform 驗證；需要暖機的 runtime 使用相同暖機次數，不需暖機者必須明確記錄。若環境不同，必須標為只可組內比較。

iOS 產品路徑採用「背景逐句合成、單一媒體 timeline」：使用者手勢只啟動一次長駐 `HTMLAudioElement`，Worker 產生的音訊單元經編碼後 append 到同一個 `ManagedMediaSource`／`SourceBuffer` sequence。不得預產整章、在句子或章節邊界建立新 element 或再次呼叫 `play()`。buffer 必須有界並以 media／append 事件驅動 refill，不可只依賴背景 timer；`bookworm` 的 Piper HuaYan medium 單 thread 實作是目前的產品參考。

## Conventions

- 文件與新註解使用繁體中文；模型、operator、API 名稱保留原文。
- Markdown 有序清單的每一項都使用 `1.`。
- 測試結果寫入 `platform/results/`，不可手工改寫原始量測 JSON。
- 大型模型、壓縮檔與下載產物不可提交；提交前檢查 `git status`。
- 保存可重現命令、合成架構、引擎版本、模型／聲音資料版本、聲線、取樣率、適用時的執行緒數與 runtime 版本。
- 預設基準為單一 WASM thread；多執行緒結果必須確認 `crossOriginIsolated` 與 `SharedArrayBuffer`，不可默默 fallback。
- `RTF` 固定表示「產生可 append 音訊的 wall time ÷ 音訊長度」；另以 `realtime multiplier = 1 / RTF` 回報速度，不可互換名稱。
- 鎖屏測試必須記錄 Safari tab／Home Screen PWA、iOS 版本、裝置、音訊 transport、buffer 水位、連續時長、跨章數、Media Session 控制、靜音開關、耳機中斷及重新回到前景的結果。

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
