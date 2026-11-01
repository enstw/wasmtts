# MOSS-TTS 評估紀錄

評估日期：2026-11-01

本文件是使用者要求的單次桌面查證紀錄，不是重新選型，也不是 harness benchmark。依專案規則沒有下載模型權重，只取得 metadata、model card、GitHub issue 與 0.45 MiB 的 `tokenizer.model`。除下方標明「本專案實測」的 tokenizer 覆蓋率外，所有數字都是上游或社群回報，未經本專案 harness 重現。

## 結論

1. 不採用，維持 Matcha `matcha-icefall-zh-en`。
1. 家族中只有 MOSS-TTS-Nano（0.1B、Apache-2.0）以 CPU／browser 為目標；1.7B–8B 版本需要 GPU，與 iOS／WASM 產品路徑無關。
1. Nano 的決定性問題是內容正確性：可能替換、遺漏或憑空產生語音，不適合無人可重試的鎖屏長篇朗讀。尺寸與速度也都不符合現行門檻。
1. 作為 server／teacher，授權可行但不是首選：zh-TW 內容錯誤與 CosyVoice3、VoxCPM2 同級，VRAM 約為兩者的兩倍。

## 查證版本

| 來源 | Revision |
|---|---|
| `OpenMOSS/MOSS-TTS`（GitHub） | `934d6826b084` |
| `OpenMOSS/MOSS-TTS-Nano`（GitHub） | `8b7bcc9341b3` |
| `OpenMOSS-Team/MOSS-TTS-Nano-100M-ONNX`（Hugging Face） | `f52645cb467506d8e18e746ddd59482685b74e58` |
| `OpenMOSS-Team/MOSS-Audio-Tokenizer-Nano-ONNX`（Hugging Face） | `ceff0d0749bfb3fa2d61149794ec6feef0d1e1ae` |
| `OpenMOSS-Team/MOSS-TTS-Nano`（Hugging Face，PyTorch） | `44502f80dbf9743528fa921cc544d662c685ebec` |
| `JacobLinCool/zh-tw-tts-comparison`（Hugging Face） | `942bcd51d1bd` |
| ONNX repo 的 `tokenizer.model` | SHA-256 `c353ee1479b536bf414c1b247f5542b6607fb8ae91320e5af1781fee200fddff` |

## 家族定位

| 模型 | 參數量 | 用途 | 與本專案的關係 |
|---|---:|---|---|
| MOSS-TTS v1.5 | 8B | multilingual cloning、長文、停頓控制 | server 級 |
| MOSS-TTS-Local-Transformer v1.5 | 4B | 語言標籤、cloning、48 kHz stereo | server 級 |
| MOSS-TTS-Local-Transformer | 1.7B | 較輕量的 MOSS-TTS 風格合成 | server 級 |
| MOSS-TTS-Realtime | 1.7B | 低延遲 voice agent | server 級 |
| MOSS-TTS-Nano | 0.1B，另加約 20M audio tokenizer | CPU 優先、cloning、48 kHz stereo | 唯一可能進入 browser 的版本 |

## Nano 與 Matcha

| 項目 | Matcha（本專案量測） | MOSS-TTS-Nano（上游或社群回報） |
|---|---|---|
| 資產 | 123.6 MiB | 內建聲線約 685 MiB；含 cloning encoder 約 728 MiB |
| 速度 | 單一 WASM thread `RTF 0.1361` | native、4 threads：Mac mini `RTF` 約 0.6、i5-9500 約 1.13（[#26](https://github.com/OpenMOSS/MOSS-TTS-Nano/issues/26)） |
| Browser | 桌面 pipeline 已驗證，另有 iPhone 初測紀錄 | [Reader](https://github.com/OpenMOSS/MOSS-TTS-Nano-Reader) 將 browser inference 標為 PoC，只列 Chrome／Edge；未找到 WASM `RTF` 或 iOS 證據 |
| 文字前端 | FST＋wasmtts lexicon | SentencePiece 直接處理文字，無 G2P，臺灣讀音覆寫沒有接點 |
| 授權 | 上游未宣告 | Apache-2.0 |
| 新聲線 | 固定聲線 | cloning 與官方 [fine-tuning](https://github.com/OpenMOSS/MOSS-TTS-Nano/blob/main/finetuning/README.md) |

- 速度差至少 `4.4x`（`0.6 ÷ 0.1361`），且這是 native 多執行緒對單一 WASM thread，尚未計入 WASM 的額外成本。上游稱 MacBook Air M4 單核心可順暢執行，但沒有提供數字。
- 上游 ONNX 權重（`moss_tts_global_shared.data` 420.39 MiB、`moss_tts_local_shared.data` 219.04 MiB）本身已超過 512 MiB 記憶體門檻。
- ONNX 權重 639 MiB 遠大於 PyTorch checkpoint 的 224 MiB，原因未查明，重新匯出可能縮小。以 224 MiB＋42 MiB decoder，再加 Matcha 觀察到的約 200 MiB 額外開銷粗估，仍約 470 MiB，尚未計入 KV cache。這只是外推，不是量測。
- `moss_tts_prefill.onnx` 與 `moss_tts_decode_step.onnx` 共用 420 MiB 權重檔，若建立獨立 ORT session 可能各載入一份；未測試。

## 內容正確性證據

Nano 是純 autoregressive 架構，內容與停止時機都由模型生成。

| Issue | 回報內容 |
|---|---|
| [#87](https://github.com/OpenMOSS/MOSS-TTS-Nano/issues/87) | 官方 runtime、Whisper large-v3-turbo 聽回：`午安` 在 6／6 seeds 被換成重複的 `晚安`，追查結果指向生成階段而非文字管線 |
| [#96](https://github.com/OpenMOSS/MOSS-TTS-Nano/issues/96) | `你好啊` 產生 26 秒音訊，後段憑空生成；fine-tune 聲線也有回報短句後追加無意義語音 |
| [#101](https://github.com/OpenMOSS/MOSS-TTS-Nano/issues/101) | 同一段文字出現 5.72 秒內部低能量區間，不同 seed 與設定的長度為 9.76–19.92 秒 |
| [#102](https://github.com/OpenMOSS/MOSS-TTS-Nano/issues/102) | 中英混讀不穩定、短句尾端吞音或出現怪音 |

反面證據同樣保留：部分結尾截斷來自可調整的 30 秒 `Max New Frames` 上限（[#58](https://github.com/OpenMOSS/MOSS-TTS-Nano/issues/58)），#87 的其他測試句 CER 為 0.00–0.14。

## Tokenizer 繁體覆蓋率（本專案實測）

在 `frameworks/matcha/samples/matcha-no-fst-novel-traditional-direct.txt` 的 98 個漢字中，10 個（10.20%）退回 raw byte token：`嶄燈窪簾繞繼續顯鳥鳴`。語料外的 `銀`、`讀` 也會退回 byte，簡體 `银行` 則是單一 token。上游兩個文字正規化檔未出現 OpenCC 或繁簡轉換。

這只代表風險，樣本也很小，不等於模型實際讀錯；本次沒有產生任何音訊。

```sh
# sentencepiece 0.2.2、uv 0.13.6；tokenizer.model 先以上方 SHA-256 驗證
uv run --no-project --with sentencepiece python -I - tokenizer.model \
  frameworks/matcha/samples/matcha-no-fst-novel-traditional-direct.txt <<'EOF'
import sys, sentencepiece as spm
sp = spm.SentencePieceProcessor(model_file=sys.argv[1])
han = [c for c in open(sys.argv[2], encoding='utf-8').read() if '一' <= c <= '鿿']
fallback = {c for c in han if any(p.startswith('<0x') for p in sp.encode(c, out_type=str))}
print(len(han), sum(c in fallback for c in han), ''.join(sorted(fallback)))
EOF
```

## Server／teacher 比較

| 模型 | Seed-TTS-eval ZH CER／SIM | zh-TW raw MER（兩組 ASR） | zh-TW `RTF` | 峰值 VRAM |
|---|---:|---:|---:|---:|
| MOSS 8B | 1.37／76.98 | — | — | — |
| MOSS Local 1.7B | 1.44／79.62 | — | — | — |
| MOSS（資料集未標明版本） | — | 0.044／0.067 | 0.94 | 13.7 GB |
| CosyVoice3 0.5B | 1.16／78 | 0.035／0.064 | 0.48 | 5.9 GB |
| VoxCPM 0.5B（zh-TW 欄為 VoxCPM2） | 0.93／77.2 | 0.043／0.065 | 1.11 | 7.0 GB |
| BreezyVoice | — | 0.178／0.182 | 1.57 | 12.6 GB |

- Seed-TTS-eval 取自 [MOSS 官方表格](https://github.com/OpenMOSS/MOSS-TTS)，沒有 v1.5 數字。
- zh-TW 欄是本次由[比較資料集](https://huggingface.co/datasets/JacobLinCool/zh-tw-tts-comparison)的 `clips.jsonl` 計算 `raw` 條件 25 句的中位數，衡量 ASR 錯誤而非聽感。各模型 GPU `RTF` 與本專案單一 WASM thread `RTF` 不可同表比較。
- MOSS 的實際優勢是 Local 1.7B 的 speaker similarity。
- 臺灣聲線與發音 teacher 仍以原生 zh-TW 的 BreezyVoice 為首選；它在此資料集的 ASR 錯誤較高，採用前仍須實際聽測。

## 能力矩陣查證附記

PR #28 的能力矩陣將 MOSS-TTS v1.5 記為「官方 LoRA fine-tune scripts」。查證結果：官方 `moss_tts_delay/finetuning` 與 `moss_tts_local/finetuning` 教學沒有 LoRA；repository 內的 LoRA 只有 `community/norwegian-lora`。`recipe` 分級正確，但 LoRA 不是官方能力。

## 重新評估條件

只有 Nano 級的新版本（例如上游預告的 MOSS-TTS 2.0）同時滿足以下條件才值得重測：

1. 以 ASR 驗證小說語料沒有遺漏或憑空產生文字。
1. 單一 WASM thread `RTF < 0.3`。
1. 記憶體低於 512 MiB 門檻。

Matcha 上游未宣告 license 仍是待解問題；Nano 的 Apache-2.0 只有在通過上述測試後才構成替代方案。
