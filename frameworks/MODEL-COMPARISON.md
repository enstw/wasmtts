# 開放權重 neural TTS 模型比較

更新日期：2026-08-20

本文件整理目前具代表性的開放權重 neural TTS，依英文、zh_CN 普通話與 zh_TW 臺灣華語區分。目的不是重新開啟本專案選型，而是保存 Matcha 決策所在的市場位置，以及未來 server teacher、聲線轉移與 edge student 的候選範圍。

## 比較口徑

- 「開放權重」表示 checkpoint 可取得，不代表 OSI 開源、可商用或訓練資料權利完整。表內分別標示 Apache／MIT／CC、OpenRAIL 或自訂限制；產品採用仍須逐一審核 code、weights、voice、dataset 與合成輸出的條款。
- 「參數量」比 repository 大小更適合比較模型級距，但不等於部署 footprint。完整系統還可能包含 tokenizer、speaker encoder、codec、vocoder、文字前端與多種重複格式。
- 未特別量化時，純權重的理論下限約為 FP32 `4 bytes/parameter`、FP16／BF16 `2 bytes/parameter`、INT8 `1 byte/parameter`。runtime memory 還要加 activation、cache、linear memory 與音訊 buffer。
- WER／CER 衡量內容錯誤，speaker similarity 衡量聲線接近程度，都不等於自然度。不同論文的語料、speaker prompt、取樣參數與評審不一致，MOS 不可直接橫向排名。
- 「品質評價」綜合官方同條件 benchmark、論文人類聽測及公開試聽／社群反饋。公開 [tts-bench](https://github.com/5uck1ess/tts-bench) 也明確暫停單一綜合品質排名，因自動分數尚不能可靠取代盲聽。

### 尺寸級距速查

| 參數量 | FP32 純權重 | FP16／BF16 純權重 | INT8 純權重 | 常見定位 |
|---:|---:|---:|---:|---|
| 15M | 約 60 MB | 約 30 MB | 約 15 MB | 固定聲線、極低成本 edge |
| 30M | 約 120 MB | 約 60 MB | 約 30 MB | VITS／Matcha 級手機模型 |
| 82–100M | 約 0.33–0.40 GB | 約 0.16–0.20 GB | 約 82–100 MB | 高品質固定聲線或小型 cloning |
| 0.3–0.6B | 約 1.2–2.4 GB | 約 0.6–1.2 GB | 約 0.3–0.6 GB | 主流 zero-shot cloning／串流 server |
| 1.5–2B | 約 6–8 GB | 約 3–4 GB | 約 1.5–2 GB | 高自然度、情緒與 voice design |
| 4–8B | 約 16–32 GB | 約 8–16 GB | 約 4–8 GB | 品質上限／長文／多說話者，通常需 GPU |

這張表只計純 weights；例如 300M lineage 的 BreezyVoice 完整 Hugging Face repository 為 3.21 GB，因為同時包含 LLM、flow、speaker encoder、speech tokenizer、HiFT 與部分重複格式。

## 英文

| 模型 | 參數量 | 聲線能力 | 授權摘要 | 品質／自然度的公開評價 |
|---|---:|---|---|---|
| Piper | 約 15M／voice | 固定聲線 | engine 與每個 voice 分開授權；`rhasspy/piper` 已轉唯讀並自 MIT 改為 GPL-3.0 | CPU 快、穩定、長文不易 hallucinate；自然度與表情通常落後 2025–2026 年模型，適合作 baseline／嵌入式產品。 |
| [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M) | 82M | 多個固定聲線 | Apache-2.0 weights | 小模型中最常被推薦的品質／速度折衷之一；音色乾淨、發音清楚，但沒有官方 zero-shot cloning，情緒與上下文控制有限。 |
| [Supertonic 3](https://github.com/supertone-inc/supertonic) | 99M | 固定聲線、expression tags | code MIT；weights OpenRAIL-M | 44.1 kHz、準確且適合 ONNX／browser／iOS；表情標籤比一般固定聲線模型豐富。官方已公告 repository 將封存並停止後續支援。 |
| [Pocket TTS](https://huggingface.co/kyutai/pocket-tts) | 100M | zero-shot cloning | code MIT；weights CC-BY-4.0、gated 使用條款 | CPU cloning 的代表；官方報告 M4 兩核心約 `6x realtime`、首段約 200 ms。聲線還原與串流性佳，但韻律上限通常低於大型 codec／flow 模型。 |
| [Chatterbox Turbo](https://huggingface.co/ResembleAI/chatterbox-turbo) | 350M | zero-shot cloning、非語言標籤 | MIT | `[laugh]`、`[cough]` 等表情自然，適合低延遲 voice agent；比固定聲線模型更像對話，但 sampling、長文一致性仍需產品端限制。 |
| [F5-TTS](https://huggingface.co/SWivid/F5-TTS) | 約 330M | zero-shot cloning、可 fine-tune | code MIT；官方 pretrained weights CC-BY-NC-4.0 | 韻律流暢、聲線貼合，是熱門 fine-tune 基底；難詞、長句與小資料 fine-tune 可能在口音強度和發音穩定度間取捨。 |
| [Qwen3-TTS](https://github.com/QwenLM/Qwen3-TTS) | 0.6B／1.7B | cloning、preset voice、voice design | Apache-2.0 | 目前多語第一梯隊；自然度、語氣控制與 cloning 都強，0.6B 已具完整能力，1.7B 提供較高的控制與品質上限。 |
| [Dia](https://huggingface.co/nari-labs/Dia-1.6B) | 1.6B | 雙人對話、cloning、非語言聲音 | Apache-2.0 | 對話輪替、笑聲、咳嗽和停頓很有真人感；純長篇朗讀與聲線一致性不是其主要優勢，官方完整版本約需 10 GB VRAM。 |
| [dots.tts](https://github.com/studio-dots-ai/dots.tts) | 2B | multilingual zero-shot cloning | Apache-2.0 | 2026 年高品質前緣之一；官方在 Seed-TTS-Eval 報告很低的中英文內容錯誤、強 speaker similarity 與 MeanFlow 低延遲版本，但部署複雜度遠高於 edge 模型。 |
| [MOSS-TTS v1.5](https://github.com/OpenMOSS/MOSS-TTS) | 8B | multilingual cloning、長文、停頓控制 | Apache-2.0 | 公開試聽與社群常把它列為高品質 cloning 候選，長文與聲線保存能力強；模型巨大，品質版與 realtime 版的能力及 transport 不可混為一談。 |

英文實用分層：edge／CPU 先看 Kokoro、Pocket 或 Supertonic；中型 GPU voice agent 先看 Chatterbox Turbo、Qwen3-TTS 0.6B；追求自然度上限才看 dots.tts、Qwen3-TTS 1.7B 或 MOSS。

## zh_CN 普通話

| 模型 | 參數量／資產 | 聲線能力 | 授權摘要 | 品質／自然度的公開評價 |
|---|---:|---|---|---|
| [Piper HuaYan medium](https://huggingface.co/rhasspy/piper-voices/blob/main/zh/zh_CN/huayan/medium/MODEL_CARD) | 約 15M；本專案模型約 63 MB | 固定單聲線 | voice dataset license 為 Unknown | 極快且穩定，但由英文 Lessac voice fine-tune；本專案盲測為 `60/100` 並標記外國腔，只保留 frozen baseline。 |
| [Matcha icefall zh-en](https://huggingface.co/csukuangfj/matcha-icefall-zh-en) | 32.05M；本專案 acoustic＋Vocos 123.6 MiB | 固定單聲線 | 上游 model card 未宣告 license | 自然度與可控性不及大型 cloning 模型，但尺寸小、清楚、穩定；本專案五句盲測 `90/100`，且單 thread WASM `RTF 0.1361`。 |
| F5-TTS | 約 0.3B | zero-shot cloning | pretrained weights CC-BY-NC-4.0 | 中文韻律自然且適合聲線 fine-tune；內容穩定度已被較新的中文大型模型超越。 |
| [CosyVoice 3](https://github.com/QwenAudio/CosyVoice) | 0.5B | cloning、方言、情緒、雙向串流 | Apache-2.0 | 中文綜合能力和工程完整度很強；官方同條件表中 RL 版本 test-zh CER `0.81%`、speaker similarity `77.4%`，並支援 18+ 中文方言／口音。 |
| Qwen3-TTS | 0.6B／1.7B | cloning、preset voice、voice design | Apache-2.0 | 中文自然度、表情與指令控制屬第一梯隊；官方 12 Hz Base 在其測試中報告中文內容錯誤 `0.92`／`0.77`，但不能與不同資料集 CER 直接橫比。 |
| [IndexTTS2](https://github.com/index-tts/index-tts) | 約 1.5B | cloning、情緒與時長控制 | Bilibili Model Use License | 情緒、聲線和 dubbing 時長控制強；公開比較中 speaker similarity 佳，但自訂授權限制大型商業使用，且禁止部分以輸出改善其他商業 AI 模型的用途。 |
| [VoxCPM2](https://github.com/OpenBMB/VoxCPM) | 2B | 30 語言 cloning、voice design | Apache-2.0 | 48 kHz、中文自然度與聲線還原強；官方稱 RTX 4090 原始 `RTF ≈ 0.3`、加速 runtime 約 `0.13`，仍屬 GPU/server 級。 |
| dots.tts | 2B | multilingual zero-shot cloning | Apache-2.0 | 官方 Seed-TTS-Eval 報告中文 WER `0.94%`、SIM `81.0`，屬目前內容穩定與 cloning 的品質前緣。 |
| [Fish Audio S2 Pro](https://huggingface.co/fishaudio/s2-pro) | 5B | 多語 cloning、inline 情緒／韻律控制 | Fish Audio Research License；非商業免費 | 中文、英文、日文為 Tier 1，細粒度表情控制很強；商用需另行取得授權，不是一般 permissive open-source model。 |

[CosyVoice 官方同條件比較](https://github.com/QwenAudio/CosyVoice#evaluation)顯示，0.5B CosyVoice3、0.5B VoxCPM、1.5B IndexTTS2 等模型的普通話內容錯誤與 speaker similarity 已進入接近區間。模型繼續放大帶來的主要差異逐漸轉向情緒、voice cloning、長文穩定性和可控性，而不只是朗讀正確率。

## zh_TW 臺灣華語

「支援 Chinese／能讀繁體」不等於原生 zh_TW。多語模型可以用臺灣 reference voice 模仿聲線，但普通話訓練分布、臺灣詞彙、多音字、輕聲及中英混讀仍須獨立驗收。臺灣華語也不得與臺語／台灣閩南語模型混為一類。

| 模型 | 參數量／資產 | 原生 zh_TW | 品質／自然度證據 |
|---|---:|---:|---|
| [MediaTek Breeze2-VITS](https://huggingface.co/MediaTek-Research/Breeze2-VITS-onnx) | 30.04M；本專案必要資產 117.9 MiB | 是 | 由 BreezyVoice 蒸餾的固定單聲線 mobile model。上游缺少公開 MOS、完整 blind ranking 與權重 license；本專案只完成有效 waveform、footprint 與速度驗證，未作聲線品質排名。 |
| Matcha icefall zh-en | 32.05M；123.6 MiB | 否 | 繁體直輸及 Taiwan pronunciation profile 可用，但不是臺灣語料專用 voice。本專案盲測與 WASM 效率構成目前 edge 選擇。 |
| [BreezyVoice](https://huggingface.co/MediaTek-Research/BreezyVoice) | 300M CosyVoice lineage；完整 repo 3.21 GB | 是 | 公開權重中 zh_TW 證據較完整：論文的三位評審、10 句、30 組 pairwise 比較優於四個匿名商業服務；另報告 PER `0.8%`、臺灣資料 SSL-MOS `4.46`、平均 speaker similarity `92.29%`。長尾 speaker 仍可能插詞、口吃或 hallucinate，英文地名類 code-switch 較弱。 |
| CosyVoice 3 | 0.5B | 否，可用臺灣 reference | 自然度與 cloning 強，但基礎 Chinese 分布不等同臺灣華語；需要臺灣文字前端、多音字與本地聽測。 |
| Qwen3-TTS | 0.6B／1.7B | 否，可 cloning | 表情與聲線上限高；臺灣 reference 可以轉移部分口音，不能因此推定臺灣用字及多音字完全正確。 |
| VoxCPM2／dots.tts | 2B | 否，可 cloning | server 級自然度和 cloning 很強，但目前缺乏足量、公開且固定 protocol 的 zh_TW 人類排名。 |

[BreezyVoice 論文](https://arxiv.org/html/2501.17790v1)同時揭露優點與失敗尾端，現階段比單純官方 demo 更有判斷價值。另有一份涵蓋 BreezyVoice、CosyVoice3、Qwen3-TTS、VoxCPM2、Chatterbox 等系統的 [zh-TW 公開比較資料集](https://huggingface.co/datasets/JacobLinCool/zh-tw-tts-comparison)，保存 600 段臺灣華語／中英混讀音訊及 ASR、RTF、VRAM metadata；其 blind arena 仍應累積更多票數後再引用固定排名。

## 能力與可訓練性矩陣

前面三張表比較「合成品質」，這張表比較「能不能拿來做事」。本專案要的是 teacher／student 管線，因此 cloning 的最短參考長度、有沒有可續訓的 checkpoint，以及輸出與蒸餾的授權，比 MOS 排名更早成為 go／no-go 條件。

「可訓練」分三級：`recipe` 表示官方釋出訓練或 fine-tune code 且有可續訓 checkpoint；`推論` 表示只有推論權重；`—` 表示不適用。授權欄分開記錄 code 與 weights，兩者經常不同。

| 模型 | 聲音克隆 | 可訓練 | 授權（code／weights） | 輸出與蒸餾權利 |
|---|---|---|---|---|
| Matcha icefall zh-en | 無，固定單聲線 | 推論。只有 `model-steps-3.onnx`、`vocos-16khz-univ.onnx`、`tokens.txt`、`lexicon.txt`，無 PyTorch checkpoint，上游註明檔案來自 ModelScope | 未宣告 | 未宣告 |
| [matcha-icefall-zh-baker](https://k2-fsa.github.io/sherpa/onnx/tts/all/Chinese/matcha-icefall-zh-baker.html)（同架構參考） | 無，固定單聲線 | recipe。由公開的 [icefall `egs/baker_zh/TTS/matcha`](https://github.com/k2-fsa/icefall/tree/master/egs/baker_zh/TTS/matcha) 訓練 | icefall Apache-2.0；Baker 資料集另有條款 | 依資料集條款 |
| Breeze2-VITS | 無，固定單聲線 | 推論。只有 ONNX，由 BreezyVoice 蒸餾而來 | model card 未宣告 weights license | 未宣告 |
| Piper | 無，固定單聲線 | recipe。`piper_train` 以 `--resume_from_checkpoint` 續訓，官方 checkpoints 在 [`rhasspy/piper-checkpoints`](https://huggingface.co/datasets/rhasspy/piper-checkpoints) | `rhasspy/piper` 於 2025-10 轉為唯讀並自 MIT 改為 GPL-3.0，維護移至 [OHF-Voice/piper1-gpl](https://github.com/OHF-Voice/piper1-gpl)；每個 voice dataset 另行授權 | 依 voice dataset 條款 |
| Kokoro | 無，固定聲線 | 推論。官方 repository 只有推論 library，未釋出訓練 code | Apache-2.0 weights | 無額外限制 |
| Supertonic 3 | 無，固定聲線＋expression tags | 推論 | code MIT；weights OpenRAIL-M | OpenRAIL-M 的 use-based 限制與標示義務 |
| Pocket TTS | zero-shot，約 20 秒 | 支援 fine-tune 至自訂聲線 | CC-BY-4.0＋acceptable-use；cloning 權重另行 gated，非 cloning 權重在 [`pocket-tts-without-voice-cloning`](https://huggingface.co/kyutai/pocket-tts-without-voice-cloning) | 需標示 Kyutai Labs；不得未經當事人同意複製其聲音 |
| BreezyVoice | zero-shot＋注音控制 | recipe。CosyVoice lineage | model card 宣告 Apache-2.0 | 訓練資料來源與 speaker prompt 權利仍須個別確認 |
| F5-TTS | zero-shot | recipe | code MIT；weights CC-BY-NC-4.0（源自 Emilia 資料集），fine-tune 後仍不可商用 | 非商業；另有 Apache-2.0 重製版 [`OpenF5-TTS-Base`](https://huggingface.co/mrfakename/OpenF5-TTS-Base) |
| Chatterbox Turbo | zero-shot，約 5 秒 | 有官方 code | MIT（code 與 weights） | 無額外限制 |
| CosyVoice 3 | zero-shot，3–10 秒，跨語言與方言 | recipe。官方提供 training／inference／deployment 全端 | Apache-2.0 | 無額外限制 |
| Qwen3-TTS | zero-shot cloning＋voice design | recipe。官方 [`finetuning/`](https://github.com/QwenLM/Qwen3-TTS/tree/main/finetuning)，Base 系列支援單聲線 fine-tune | Apache-2.0（weights 與 inference code） | 無額外限制 |
| IndexTTS2 | zero-shot＋情緒與時長控制 | recipe。fine-tune、LoRA、量化均被明文列為 Derivative Work | code Apache-2.0，但另受 bilibili Model Use License 限制，商用需另行取得 | 明文禁止以本模型或其 Derivative Work 改善其他 AI 模型，僅 indextts2 本身、其 Derivative Works 與非商業 AI 模型除外 |
| Dia | zero-shot | 支援 fine-tune | Apache-2.0 | 使用條款禁止未經同意的 cloning |
| VoxCPM2 | cloning＋voice design，三種模式 | recipe。官方 SFT 與 LoRA script，5–10 分鐘音訊即可 | Apache-2.0 | 無額外限制 |
| dots.tts | zero-shot 多語 | recipe。`scripts/train_dots_tts.py`，含 MeanFlow distillation 入口 | Apache-2.0（weights 與 code） | 無額外限制 |
| Fish Audio S2 Pro | zero-shot，約 15 秒＋inline 情緒標籤 | recipe。官方釋出 fine-tune code 與 SGLang 推論引擎 | Fish Audio Research License：研究與非商業免費、商用另議、授權可撤銷，散布需標示 "Built with Fish Audio" | outputs 明文不屬於 Derivative Work；但以 outputs 訓練出的模型屬於，並繼承本授權。另禁止用於改善任何 foundational generative AI model |
| MOSS-TTS v1.5 | zero-shot | recipe。官方 LoRA fine-tune scripts | Apache-2.0 | 無額外限制 |

Fish Audio S2 Pro 的 5B 由 Dual-AR 架構拆成時間軸的 Slow AR 4B 與聲學維度的 Fast AR 400M；官方報告 RTF `0.195`、time-to-first-audio 低於 100 ms，並以 RVQ 壓縮 44.1 kHz 音訊。這些是 GPU 推論引擎的數字，與本專案的單一 WASM thread `RTF` 不可同表比較。

### 對本專案的意義

1. 現行 `matcha-icefall-zh-en` 沒有可續訓的 PyTorch checkpoint 也未宣告 license，[BreezyVoice 聲線轉移計畫](vits/BREEZYVOICE-MATCHA-PLAN.md)的 Gate 0 因此仍然成立。但同架構的 `matcha-icefall-zh-baker` 由公開 icefall recipe 訓練，是目前最接近的可訓練起點；還沒驗證的是它的 token inventory 與現行前端的 `tokens.txt`、`lexicon.txt` 是否相容，這應該排在任何 GPU 支出之前。
1. teacher 的授權分成三群：Apache-2.0 群（CosyVoice 3、Qwen3-TTS、VoxCPM2、dots.tts、MOSS-TTS、BreezyVoice）對蒸餾沒有額外限制；Fish Audio S2 Pro 在非商業前提下可用，但 student 權重會繼承其可撤銷授權且需標示；IndexTTS2 明文禁止以其輸出改善其他 AI 模型，不適合作 teacher。
1. 只有 cloning 模型能把使用者自己的聲音帶進管線。Piper、Kokoro、Supertonic 3、Breeze2-VITS 與現行 Matcha 都是固定聲線，新聲線只能靠訓練取得；這是「錄 30 秒就換聲線」與本專案 edge 模型之間的結構差異，不是品質差異。
1. 表列的 cloning 能力與 speaker similarity 都是上游宣稱或論文數字，未經本專案 harness 重現。採用任何一項前仍須依既有慣例保存可重現命令、模型 revision、SHA-256 與量測邊界。

## 本專案的可採用結論

| 需求 | 目前較合理的候選 | 與本專案的關係 |
|---|---|---|
| 英文 edge／CPU | Kokoro、Pocket TTS、Supertonic 3 | 可作未來英文支線研究，不取代目前中文 Matcha 路徑。 |
| zh_CN GPU/server | CosyVoice3 0.5B、Qwen3-TTS 0.6B | 適合作上限／teacher 對照，不適合直接放進 iPhone Safari。 |
| zh_CN 高品質上限 | dots.tts、Qwen3-TTS 1.7B、VoxCPM2 | 適合 server 或合成資料研究。 |
| zh_TW GPU/server | BreezyVoice | 原生臺灣華語證據最完整，適合作聲線／發音 teacher。 |
| zh_TW iPhone／WASM | 現行 Matcha＋Taiwan profile | 已有本專案盲測、有效 waveform、速度與串流證據。 |
| zh_TW 小模型新聲線 | 合法資料下的 BreezyVoice／Breeze2 → Matcha student | 目標是保留臺灣聲線且維持 Matcha graph 的 edge 效率。 |

大型模型的網路評價較好，不構成重新選型的充分理由。對本專案而言，`32M` Matcha 的 `RTF 0.1361` 與可用瀏覽器 transport，和 0.5–8B GPU 模型處在不同的 Pareto 前緣；自然度上限與 iPhone 離線可部署性必須分開比較。

## Breeze2 與 Matcha 的 10 倍差距：證據界線

本專案實測的是 Breeze2 一次完整 ONNX `session.run()`，涵蓋 text encoder、duration／flow 與 neural waveform decoder；沒有把三階段切成獨立模型，也沒有保存逐 operator profile。因此可重現結論只有：

- 相同 Chromium、ORT Web、FP32、SIMD WASM 與單一 thread 下，Breeze2 完整 VITS graph 的 `RTF 1.3617`，Matcha＋Vocos 為 `0.1361`，前者成本為 `10.00x`。
- Breeze2 的 waveform decoder 是神經網路：以訓練得到的 `ConvTranspose` 和 residual `Conv` 將 latent representation 逐級上採樣成 22.05 kHz waveform。
- Graph inspection 顯示 waveform decoder 的 4 個 `ConvTranspose`、75 個 decoder `Conv` 與 `256x` 時間軸上採樣是主要嫌疑之一；stochastic duration predictor／flow 的動態 shape operators 也可能占顯著成本。
- 尚未分段 profiling，不能聲稱 waveform decoder 單獨造成全部 10 倍，也不能給出 decoder／flow／encoder 的百分比。

若未來真的要定位成本，應先輸出 encoder＋duration、flow、waveform decoder 三段 ONNX，以相同音素、latent、音訊長度和 ORT Web 設定分別計時；在完成前，文件一律使用「完整 VITS graph 慢 10 倍」的表述。
