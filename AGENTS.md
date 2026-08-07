# 專案代理指引

## Project Overview

本 repository 的主要目標是尋找語音品質明顯高於 Piper HuaYan medium、且可在 iOS Safari／PWA 離線執行的中文 TTS 替代方案。研究範圍不限神經網路或 ONNX，也包含統計參數式、拼接式、diphone、共振峰、規則式及混合式合成。Piper HuaYan medium 是 frozen 品質／效能基準 `1.00x`，不是待最佳化的產品工作；所有效能結論必須同時保留合成架構、runtime 環境、音訊有效性與品質限制。

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

Piper Worker、MP3 encoder 與上述播放 transport 已由 `bookworm` 驗證；不要在本 repository 重做 Piper 整合或把 fixture transport 數字當成研究結果。新候選先通過相對 Piper 的盲聽品質門檻，再使用 `mobile-host` 的既有 producer 契約做必要的整合相容性測試。

Kokoro fp32 已通過品質門檻，但單執行緒效能不足；桌面雙執行緒只證明它可能以約 `5.02x` Piper 運算成本換取 realtime。將它視為溫度與耗電較高的次要候選，不可寫成已淘汰，也不可把尚未量測的 iPhone 熱穩態寫成既定事實。除實機雙執行緒 RTF、溫度、耗電與降頻驗證外，不再優先擴大 selective INT8 工作。

Matcha `matcha-icefall-zh-en` 已通過第一輪品質 gate：相同文本盲測為 Matcha `90`、Kokoro `80`、Piper `60`，Piper 被標記有外國腔。Matcha 是目前優先候選；Chromium 151 單執行緒核心結果為 task／wall `RTF 0.1467`，完整 Worker producer 的 20 段桌面結果為 `RTF 0.1456`、`6.87x realtime`，包含 OpenCC、JavaScript 常用數字正規化、lexicon、Matcha、Vocos、ISTFT、silence scaling 與 96 kbps MP3 encode。103.32 秒音訊 append 到單一 MediaSource timeline 時沒有 underflow 或錯誤；記憶體只量到初始化後 262.1 MiB 與串流中 262.7 MiB 快照，不得寫成真正 peak 或 iPhone 結果。前端仍未涵蓋英文 eSpeak 與完整 FST 規則；`sherpa-onnx 1.13.4` 載入中文 FST 即使明確配置 768 MiB／1 GiB 仍越界，不可只靠放大 heap。

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
pnpm benchmark:matcha
pnpm benchmark:matcha-stream
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
