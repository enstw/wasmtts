# 單線程 WASM TTS 本機基準

測試日期：2026-08-06 至 2026-08-07（Asia/Taipei）

## 結論

以 Piper `zh_CN-huayan-medium` 產生 10 秒音訊的 CPU 時間為 `1.00x`：

| 模型 | 10 秒音訊 CPU 時間（中位數） | 相對 HuaYan | 單線程即時性 | 解壓後資源 |
|---|---:|---:|---:|---:|
| Piper HuaYan medium | 1.576 秒 | **1.00x** | 6.35 倍即時 | 79 MiB |
| Matcha icefall zh-en | 1.467 秒 | **約 0.93x*** | 6.82 倍即時 | 約 152 MiB（其中 ONNX 123.6 MiB） |
| VITS AISHELL3（sid 66） | 0.708 秒 | **0.45x** | 14.1 倍即時 | 207 MiB（其中未載入的 `rule.far` 約 172 MiB） |
| MeloTTS zh/en | 14.427 秒 | **9.16x** | 0.69 倍即時 | 197 MiB |
| Kokoro v1.1 zh int8 | 無有效數字 | — | 輸出為非有限值／靜音 | 約 127 MiB ONNX + 51 MiB voices |
| Kokoro v1.1 zh q8 | 無有效數字 | — | 315,000/315,000 samples 非有限 | 約 127 MiB ONNX + 51 MiB voices |
| Kokoro v1.1 zh fp32 | 14.225 秒 | **9.03x** | 0.70 倍即時 | 約 339 MiB ONNX + 51 MiB voices |

Piper、VITS 與 Kokoro 使用 Chromium 149；Matcha 使用 Chromium 151。全部採 ONNX Runtime Web WASM、單一 thread 與 CDP `TaskDuration`，但星號標示的 Matcha／Piper `約 0.93x` 因瀏覽器版本不同，只能作方向性參考，不能宣稱為嚴格的 7% 加速。AISHELL3 最省 CPU；Matcha 與 HuaYan 同量級且都遠快於即時；MeloTTS 與 Kokoro fp32 都慢於即時。Kokoro int8 與 Kokoro.js sample 對應的 q8 都能完成 graph execution，但輸出全部為非有限值，不能視為有效 TTS；只有 fp32 已驗證能正常發聲。

本文件的「倍即時」是 `realtime multiplier = 音訊長度 ÷ 合成時間`，標準 `RTF = 合成時間 ÷ 音訊長度`，兩者互為倒數。Piper HuaYan medium 的 `6.35 倍即時` 對應名目 `RTF ≈ 0.158`；這裡是桌面單 thread CPU benchmark，不能取代 iPhone 上包含文字前處理與 MP3 編碼的端到端串流 RTF。

本專案另從 FP32 產生 selective INT8，保留 decoder、vocoder、STFT 與全部卷積為 FP32。它在原生 ORT 與瀏覽器 WASM 都能輸出完整有限值，不再有 NaN；但只縮小 `8.3%`，同一瀏覽器下速度比 FP32 慢約 `0.9%`。所以這一版證明「可自行做出正確的混合 INT8」，尚未證明 INT8 對單線程 WASM 有效能優勢。

產品判定與純效能排名分開：Kokoro fp32 已通過相對 Piper 的主觀品質 gate，因此保留為次要候選。它的單執行緒約 `0.70 倍即時`，未通過效能 gate；桌面雙執行緒測得 `RTF ≈ 0.79`、相對 Piper 約 `5.02x` 的運算時間，只代表可能以較高手機溫度與耗電換取即時性。實際溫度、耗電與熱降頻尚須在目標 iPhone／iPad 量測。

AISHELL3 的取樣率只有 8 kHz，而且音質、韻律與聲線選擇和 CPU 是不同維度；本次主觀實聽只有 `3/10`，且仍有明顯外國腔。若目標是修正 HuaYan「外國人中文」的聽感，AISHELL3 不構成品質升級，因此只保留為最低 CPU 的技術參考，不列入產品候選。

## Matcha zh-en 品質與正式 benchmark

2026-08-07 使用與 Piper、Kokoro 相同的五句中文做三方盲測；A 為 Piper HuaYan medium、B 為 Matcha `matcha-icefall-zh-en`、C 為 Kokoro v1.1 zh fp32 sid 45。評分為 B `90`、C `80`、A `60`，A 另被標記有外國腔。因此 Matcha 已通過品質 gate，且本輪主觀品質高於 Kokoro。

最新正式量測使用 Brave 所附 Chromium `151.0.7922.108`、stable ONNX Runtime Web `1.27.0`、WASM execution provider 與一個 thread。固定五句先暖機一次，再量三次；三輪 task time 為 `1.365`、`1.358`、`1.361` 秒／10 秒音訊，中位數 task `RTF 0.1361`、wall `RTF 0.1360`，約 `7.35 倍即時`。Acoustic + Vocos session 初始化為 `1.980` 秒，兩個 ONNX 合計 129,599,930 bytes（123.6 MiB）。先前 `1.26.0-dev.20260416-b7804b056c` 在 Chromium `151.0.7922.71` 的中位 task `RTF 0.1467` 保留為回退基線；因瀏覽器 patch 版本也不同，改善幅度只可作方向性參考。

三輪輸出分別有 174,821、174,764、174,688 samples，全部為有限值；peak 為 `0.8093`、`0.8306`、`0.7777`，RMS 為 `0.1336`、`0.1351`、`0.1301`。Phase 中位數是 acoustic `911.1 ms`、Vocos `549.5 ms`、JavaScript ISTFT `20.8 ms`、silence scaling `0.5 ms`，因此後續核心效能最佳化應先看 acoustic 與 Vocos，不應先花時間重寫 ISTFT。

Adapter 使用 sherpa-onnx 前端預先產生的固定 token；文字前處理排除於計時外，與既有 ORT Web 主表一致。中文 FST 在目前 Node WASM wrapper 仍會越界，正式瀏覽器結果也沒有包含 FST、MP3 編碼或 MediaSource append，因此這是核心合成 benchmark，不是 iPhone 端到端串流結果。完整紀錄與樣本位於 [Matcha 文件](../frameworks/matcha/README.md)，機器可讀結果是 [results-matcha_icefall_zh_en-browser-wasm.json](results/results-matcha_icefall_zh_en-browser-wasm.json)。

### Matcha 上游建議 FST browser 基線

另以 sherpa-onnx `1.12.20` 官方預建 browser SIMD bundle 重測完整上游配置：`model-steps-3.onnx`、16 kHz Vocos、lexicon、tokens、`espeak-ng-data`、`phone-zh.fst,date-zh.fst,number-zh.fst`、`noise_scale=0.667`、`length_scale=1`、`silence_scale=0.2`、單一 thread。這條路徑不經 ORT Web 自製 adapter，也不加入 OpenCC。

| 語料 | Task RTF 中位數 | Wall RTF 中位數 | Realtime multiplier |
|---|---:|---:|---:|
| 純小說簡體 | 0.14110 | 0.14062 | 7.09x |
| 原始日期／時間／電話／百分比 | 0.14114 | 0.14073 | 7.09x |

初始化 wall time 為 1.877 秒；WASM heap 固定 536,870,912 bytes（512 MiB），`measureUserAgentSpecificMemory()` 快照為初始化後 688,672,616 bytes（656.8 MiB）、benchmark 後 699,003,344 bytes（666.6 MiB）。三個 FST 合計只有約 208 KiB；同 runtime 的 FST on/off control 中，純小說 task RTF 為 `0.13961`／`0.13973`，差異 `-0.086%`，heap 差異為 0。因此主要成本是官方 heap 與整體預載資產，不是 FST。

不經 OpenCC 的完整繁體小說文字亦成功產生 26.7298 秒、427,676 個全為有限值的 samples，使用者已確認品質沒有問題。正式文字路徑因此定為「繁體直輸 → 官方三個中文 FST → Matcha」。官方 bundle 結果保留為上游基線；產品 producer pilot 現以獨立 kaldifst + OpenFST WASM 執行相同 tables，純 JavaScript applier 保留為診斷基線。機器可讀基線為 [上游 FST 結果](results/results-matcha_icefall_zh_en-upstream-fst-browser-wasm.json)與 [FST on/off A/B](results/results-matcha_icefall_zh_en-fst-ab-browser-wasm.json)，試聽檔與 metadata 見 [Matcha 文件](../frameworks/matcha/README.md)。

### Matcha Worker／MP3／MediaSource 端到端結果

2026-08-09 將 Bookworm 的 `matcha-fst.js` 移入統一平台。此實作以純 JavaScript 讀取 OpenFST vector archives，依 kaldifst `TextNormalizer::Normalize` 的拓撲 shortest-path 與 strict-improvement tie-break 套用 `phone-zh.fst,date-zh.fst,number-zh.fst`，不載入 sherpa-onnx 512 MiB frontend bundle。無資產 fixtures 全部通過，三個真實 tables 的 32 個 kaldifst golden cases 亦全部一致。產品前端另保留 Bookworm 已驗證的臺灣格式修正，避免 `%`、冒號、日期分隔符與 10 碼手機落入上游已知誤讀。

同日以 Chromium 151、stable ORT Web `1.27.0` WASM 單一 thread 與 `noise_scale=0.667` 重測完整 desktop producer。計時邊界包含繁體直輸、獨立 kaldifst WASM FST、lexicon/token mapping、Matcha acoustic、Vocos、JavaScript ISTFT、silence scaling 與 lamejs 96 kbps MP3 encode；輸出逐句 append 到單一 `audio/mpeg` sequence SourceBuffer。10 段共 append 51.228 秒音訊，producer `RTF 0.1387`、`7.21 倍即時`，到達目標的整體 wall `RTF 0.1425`。underflow、append error、producer error 全為 0；所有 segment waveform 均為有限非靜音，MP3 bytes 皆大於零。`25.5%` 正規化為「百分之二十五点五」，沒有 unknown。

本輪每段中位數前端 `0.580 ms`、核心合成 `607.5 ms`、MP3 `55.0 ms`、完整 producer `694.6 ms`。`performance.measureUserAgentSpecificMemory()` 快照為初始化後 341,536,495 bytes（325.7 MiB）、串流中 345,817,320 bytes（329.8 MiB）；第二次重跑初始化為 341,535,075 bytes，確認相較 `1.26.0-dev` 增加約 48.7 MiB。normalizer 的獨立 linear memory 仍為 16 MiB，因此增量屬 ORT 1.27 路徑。這只是時間點快照，不是 peak 或 iPhone 結果；1.27 已通過桌面功能與速度 gate，但 iPhone 記憶體、CacheStorage、鎖屏與熱穩態仍未完成。

### iPhone Safari 初步功能測試

2026-08-08 使用 iPhone、iOS `18.7`、Safari user agent `Version/26.5.2`，經區域網路 HTTP 開啟 Matcha 串流頁。環境為 `secureContext=false`、`standalone=false`，因此本輪只屬 Safari tab 功能測試，不是 Home Screen PWA、Service Worker 離線、雙執行緒或正式鎖屏耐久驗收；裝置型號、鎖屏時長、溫度、耗電與熱降頻未記錄。

頁面將約 123.6 MiB ONNX 模型下載拆成獨立步驟並顯示進度；本輪四項資產由 LAN 下載約 4.24 秒，Worker session 初始化約 1.06 秒，連同文字前端與完整暖機共 1.32 秒。暖機產生 10,793 個有效 samples、0.6746 秒音訊，peak `0.7874`、RMS `0.1638`，MP3 為 9,072 bytes。這些時間受 LAN 與特定裝置影響，只保存為功能紀錄，不納入跨方案效能排名。

第一次播放停在 `ManagedMediaSource` 的 `opening`，`sourceopen` 未發生，producer 也未被呼叫。依 WebKit 要求在單一長駐 `HTMLAudioElement` 明確設定 `disableRemotePlayback=true` 後，使用者確認前景播放與鎖屏播放皆正常，繁體原文直輸及「垃圾 → `le4 se4`」讀音覆寫亦正常。測試未達 2 小時／3 章門檻，不能寫成鎖屏驗收完成。

本輪另確認 `「」` 等引號映射為 acoustic tokens `“”` 後會發音；2026-08-08 已改為在 tokenization 前移除 `「」『』《》“”‘’"`，保留句內其他韻律標點，並加入繁體直輸 token 迴歸測試。Taiwan profile 後續加入「垃圾」、七個有來源的固定詞與保守的「著」contextual rule；official profile 保持上游詞典。繁體「關卡」目前逐字得到 `guan1 ka3`，符合臺灣讀音；「堤壩」得到 `di1 ba4`，但臺灣教育部讀音為 `ti2 ba4`，仍待獨立審核實作。

上游 lexicon 將「垃圾」讀成 `la1 ji1`；臺灣 `le4 se4` 只作明示的可選覆寫。正式效能結果使用上游原詞典。原始結果為 [results-matcha_icefall_zh_en-stream-browser-wasm.json](results/results-matcha_icefall_zh_en-stream-browser-wasm.json)。

### 小說 frontend／g2pW 稽核

2026-08-10 對外部繁體小說 ZIP 的 1,182 個章節、257,153 行執行現況 A 基線；小說與本機 `*.local.json` 報告均未提交。固定產品的版面清理、`phone → date → number` FST 與 Matcha lexicon longest-match 後，共產生 11,942,487 個 token、1,026 次 unknown（29 種）及 9,318,402 次單字 fallback（5,293 種）。「著」有 42,758 次單字 fallback，全部使用 `zhu4`，顯示錯讀是前端的系統性問題而非少數 acoustic 偶發錯誤。

另以 g2pW `0.1.1`／`G2PWModel-v2-onnx` 對 archive-order 首 500 句作開發期 A/B。19,143 個可逐字對齊漢字中，17,987 個一致、1,156 個不同，表面一致率 `93.96%`；wall time 272.82 秒，吞吐每秒 1.83 句。高頻差異包含 `著 zhu4 → zhe5` 108 次與 `得 de2 → de5` 55 次，但「一／不」變調、輕聲及臺灣區域讀音也計入差異，不能把 1,156 筆全算成 Matcha 錯誤。g2pW archive 為 589,075,404 bytes、解壓 ONNX 約 635 MB，SHA-256 `699f3c1fd7fb0e2c2d49ed2486826fd5bff233fee7759350a91c3b49aedc4ed2`；其體積與速度只適合作離線候選判讀，不是 iOS runtime frontend 候選。

Python pilot 目前直接比較原文漢字的 Matcha lexicon 與 g2pW，沒有套用 FST；數字與非漢字不進逐字一致率。正式 B/C 評測仍須讓兩個 G2P 都消費相同 FST 後文字。g2pW 程式碼、checkpoint、BERT tokenizer 與訓練資料的授權也必須分開查核，現階段不散布任何下載資產。

第一輪以教育部辭典確認 `記得 ji4 de5`、`柵欄 zha4 lan2`、`駐紮 zhu4 zha2`、`長短 chang2 duan3`、`著急 zhao1 ji2`、`著重 zhuo2 zhong4`、`執著 zhi2 zhuo2`；C 候選把這七筆作 phrase override，全書 dry-run 依序命中 1,137、67、35、124、831、57、25 次，合計 2,276 次。加入 U+2015 分隔線清理後，C 的 token 總數仍為 11,942,487，unknown 為 1,018 次（28 種），單字 fallback 從 A 的 9,318,402 降至 9,313,906，實測減少 4,496 次。這七詞只載入可選 Taiwan profile，official profile 不變。`著` 的教育部條目確認持續助詞讀輕聲 `zhe5`，但它另有 `zhu4/zhuo2/zhao2/zhao1`，因此只列 contextual-rule 候選，不做全域單字覆寫。

「著」targeted pilot 共跑四輪、各 300 句。第一輪按 archive order，以「同一前字至少兩筆且全部為 `zhe5`」得到 49 字、254 次；後三輪排除既有 allowlist，按前一字分層抽樣，以「至少三筆且全部為 `zhe5`」再得到 90 字／285 次、67 字／206 次與 54 字／163 次。合計 260 個前字、908 次且零反例；多讀音前字排除。產品只在 longest-match 仍落到單字「著」時套用 allowlist；加入固定詞後全書實際 contextual 命中 36,705 次，剩餘 `著 zhu4` trace 為 4,402 次。後者包含正確的 `zhu4` 案例，不可解讀成已確認錯誤數。這不是全域覆寫，長詞仍先行。

收斂後的 review schema v2 將證據與部署分離：260 字 contextual allowlist 標為 `model-supported`，辭典與 pilot 共同支持的固定詞標為 `source-and-model-supported`，有獨立辭典條目的固定詞維持 `confirmed`；只有 `profiles.taiwan` 明列的 pattern 會進產品。release gates 新增真實 Matcha lexicon/tokens 的 Taiwan profile 測試，固定 `帶著、找著、著手、看著急、垃圾` 的 phones 與 longest-match precedence。小型 review manifest 改採 network-first／離線 cache fallback，大型模型、FST 與字典維持 cache-first。

教育部《國語辭典簡編本》明列 `著 zhao2` 可作結果助詞並以 `找著、睡著` 為例，另有 `睡著、摸不著、犯不著、睡不著` 與 `著手 zhuo2 shou3` 獨立條目。依該規則及分層 pilot，新增 12 個 longest-match overrides：`睡著、找著、碰著、逮著、嚇著、正著、摸不著、犯不著、睡不著、用得著、管不著、著手`，全書命中 738 次。最終單字 fallback 為 9,275,437；token 仍為 11,942,487、unknown 仍為 1,018。`見著` 的 pilot 同時出現 `zhe5/zhao2`，未自動處理。

Taiwan profile 另以指定文字跑一個完整瀏覽器 append，實際得到 `找著 zhao3 zhao2`、`睡著 shui4 zhao2`、`著手 zhuo2 shou3`。該段 3.9538 秒、63,260 samples 全為有限值，peak `0.7911`、RMS `0.1380`，MP3 48,384 bytes；underflow、append error、producer error 均為 0。結果只寫入 `/tmp`，不取代 official benchmark。

「得」分層 pilot 抽 300 句，比較 19,823 個可對齊漢字：18,378 個一致、1,445 個不同，表面一致率 `92.71%`，其中 neutral-tone 候選 460 次。依教育部詞條與 pilot，新增 `覺得、曉得、顯得、懶得、捨得 → de5` 五個固定詞；全書依序命中 8,692、1,049、558、602、367 次，共 11,268 次，單字 fallback 由上一輪 9,275,437 降至 9,253,029，token 仍為 11,942,487、unknown 仍為 1,018。上游已正確整詞處理的 `值得、使得、免得、省得、懂得` 不加覆寫。g2pW 對「值得」的候選與教育部及 Matcha lexicon 相反，證明差異不可直接自動部署；本輪不建立任何全域「得」規則。

新增五詞另以 Taiwan profile 跑實際瀏覽器串流指定句，phones 中五個「得」皆為 `de5`。waveform 71,365 samples 全為有限值，peak `0.7064`、RMS `0.1461`，MP3 54,432 bytes；一個 append 為 4.536 秒，三類串流錯誤均為 0。結果只保存於 `/tmp`。

下一輪針對「長」的 `chang2/zhang3` 分流，不作全域單字或下一字 contextual rule。依教育部固定詞與長度義條目加入 `長城、長劍、長河、長凳、長橋`，並完成待審的 `堤壩 → ti2 ba4`；全書依序命中 5,016、943、725、377、54、23 次，共 7,138 次，單字 fallback 由 9,253,029 降至 9,238,759，token 與 unknown 不變。反向迴歸測試固定 `長輩、長大、成長、生長、長子、長女 → zhang3`，避免長度義修正污染其他詞義。

「長」第二批加入有教育部獨立詞條的 `長命、長生、長久、長遠、長袍`，全書依序命中 564、483、433、165、185 次，共 1,830 次，單字 fallback 再降至 9,235,107，token 與 unknown 仍不變。測試同時避免把 `成長`、`生長` 無分隔拼成跨測試案例的 `長生`，保留逐詞 `zhang3` 反向 gate。

「地」分層 pilot 抽 300 句，20,709 個可比較漢字有 19,393 個一致、1,316 個差異，表面一致率 `93.65%`。新 ROI 排名把分層抽樣一致性與全文同前字次數合併，但明列 estimated ceiling 不是已確認錯讀數；129 個候選中只有 `兆` 4/4 與 `主` 3/3 穩定指向 `de5`，另有 95 個維持 `di4`、5 個混合、27 個樣本不足。依教育部結構助詞條目，產品只加入 `徵兆地` 75 次與 `自主地` 40 次兩個固定結構；fallback 降至 9,234,885，token 與 unknown 不變，不建立全域「地」規則。

「和」pilot 新增按後一字分層與多 current-phone ROI，避免把 `附和 he4` 等完整詞混入單字 `he2` 候選。300 句共比較 20,077 字，18,616 字一致、1,461 字不同，表面一致率 `92.72%`；120 個後字桶中 86 個 actionable、5 個維持目前讀音、11 個混合、18 個樣本不足。86 個 actionable 桶共 270 筆皆為 `he2 → han4`；排除 tokenization 前會移除的引號後，產品採 85 字、267 筆的後字 allowlist。依教育部連詞語音條目，規則只在 longest-match 落到單字「和」時生效。全文新增命中 8,014 次，contextual 總命中 44,719，fallback 降至 9,226,871；token 11,942,487、unknown 1,018 不變。`和平、和氣、附和` 及混合桶均有負向迴歸保護；`摻和` 的繁體 lexicon 缺口仍維持現況，不在本輪擴張處理。

「為」按前字分層的 300 句 pilot 比較 19,624 字，18,309 字一致、1,315 字不同，表面一致率 `93.30%`。ROI 將 123 個前字桶分為 50 個 actionable、24 個維持目前讀音、30 個混合、19 個樣本不足；高頻 `因為` 12/12 維持 `wei4`，`以為` 6/7 為 `wei2` 但仍按 mixed 排除。依教育部 `wei2/wei4` 詞義與「作為」獨立詞條，只加入 `作為、成為、名為、修為、極為、身為、視為、最為、譽為、淪為` 十個固定結構。ROI 上限 11,715 次，全文實際依序命中 2,838、2,420、1,286、1,136、905、794、726、620、467、459 次，合計 11,651；fallback 由 9,226,871 降至 9,203,569，token 11,942,487、unknown 1,018、contextual 44,719 不變。負向測試固定 `因為、為了、為何、為此 → wei4`。

完整 SQLite run 已掃描 315,593 句與 4,646,998 筆 occurrence；`polyphone` 73,447、`neutral_tone` 118,019、`tone_disagreement` 111,299，三類合計 302,765 筆待審核差異。第一輪完整 ROI 的 11 個固定詞約覆蓋 9,400 筆舊 profile 差異；後兩輪兒化固定詞實際再排除 5,565 筆 `er1` 詞綴語境，合計約 14,965 筆。`個 ge4` 依臺灣讀音維持目前結果；`兒童、嬰兒、女兒` 等名詞仍維持 `er2`；`勁兒` 保留前字讀音分歧待審；`誰 shui2 → shei2` 已確認但 acoustic tokens 缺少 `shei2`，不啟用未支援 phone。

g2pW WebGPU feasibility 使用同一個 Python 產生的真實 ONNX feed 與 CPU golden，模型 `g2pw.onnx` 為 635,212,732 bytes、SHA-256 `bb40c8c7b5baa755b2acd317c6bc5a65e4af7b80c40a569247fbd76989299999`。Apple Silicon、macOS kernel 25.5.0、Headless Chrome 151、ORT Web 1.27.0、batch 32、一次暖機與五次量測下，WebGPU session 初始化 2,381.84 ms，五輪為 197.04、207.19、208.27、206.91、200.28 queries/s，中位 206.91。相同 feed 的 Python ORT 1.28.0 CPU 為 49.77、49.86、50.25、50.13、48.24 queries/s，中位 49.86，WebGPU inference speedup 為 4.15×。32 個 argmax 零差異，最大 probability 差 `1.19e-7`。fixture、完整輸出與模型皆為本機忽略產物；本數字排除 tokenizer、句子切分、FST、SQLite 與 IPC，僅證明 WebGPU graph 可用且值得整合。

同一 fixture 的 WebGPU → SQLite slice 使用 WAL、foreign keys、transaction 與 `(run_id, source_sentence_id, character_offset)` primary key；run fingerprint 納入 input/model/lexicon/FST/profile/backend/runtime。修正 agreement 優先分類後，run 2 寫入 5 句、32 個多音字 occurrence、12 個 difference；SQL 聚合為 `為 wei4→wei2` 7、`長 zhang3→chang2` 2、`和 he2→han4`、`得 de2→de5`、`著 zhu4→zhe5` 各 1。立即重跑回報 `reused: true`，occurrence 仍為 32。此結果只驗證 architecture slice；fixture 未真正套用 FST，全文正式 index 必須補上相同 frontend、串流 tokenizer feeder、batch checkpoint 與中斷續跑。

同日以 Chromium 151 對 Taiwan profile 跑完整 Worker、Matcha/Vocos、MP3 與單一 MediaSource sequence。五個 append 共 25.416 秒，producer `RTF 0.1466`、`6.82 倍即時`，underflow、append error、producer error 均為 0；含「垃圾」的 segment 實際輸出 `le4 se4`，waveform 81,682 samples 全為有限值、peak `0.9377`、RMS `0.1380`，MP3 62,208 bytes。結果只寫入 `/tmp` 作功能驗證，不取代 official profile 的正式 benchmark JSON；七個新審核詞的 token mapping 另由 manifest 與 frontend 測試覆蓋。

加入 contextual rule 後另跑兩個 append、10.656 秒的 Taiwan profile smoke test；含「帶著」的 segment 實際輸出 `dai4 zhe5`，103,825 samples 全為有限值、peak `0.8463`、RMS `0.1419`，MP3 79,056 bytes，三類串流錯誤仍為 0。結果同樣只寫入 `/tmp`。

## Kokoro selective INT8 修正實驗

這組 A/B 使用同一個 gstack HeadlessChrome 145.0.7632.6、ONNX Runtime Web WASM、單一 thread 與 `performance.now()` wall time。因瀏覽器版本與主表不同，數字只在本節內互相比較。

| 模型 | ONNX 大小 | 10 秒音訊 wall time 中位數 | 相對 FP32 | waveform 驗證 |
|---|---:|---:|---:|---:|
| FP32 | 323.6 MiB | 15.042 秒 | 1.000x | 316,200/316,200 finite |
| selective INT8 | 296.7 MiB | 15.182 秒 | 1.009x | 316,800/316,800 finite |

Selective INT8 三輪為 `15.148`、`15.182`、`15.197` 秒／10 秒音訊；FP32 三輪為 `15.042`、`15.043`、`15.029` 秒。原生 ONNX Runtime CPU 另驗證 selective INT8 的 317,400/317,400 samples 全為有限值，peak `0.325`、RMS `0.0389`。

量化範圍是 decoder 以外的 `MatMul/Gemm/LSTM` 候選；ONNX Runtime 1.28 實際轉換成 9 個 `MatMulInteger` 與 6 個 `DynamicQuantizeLSTM`。`/decoder/`、90 個 `Conv`、7 個 `ConvTranspose`、vocoder 與 STFT 均保留 FP32。這個保守範圍避免了已定位到 STFT Fourier kernel／phase 除法的 NaN 傳播，但也只減少 28.2 MB 權重，無法帶來明顯 WASM 加速。

## 舊 sherpa wrapper 測試方法（保留供對照）

- 環境：macOS 26.5.2 arm64、Node 24.19.0、`sherpa-onnx` npm 1.13.4。
- 所有成功模型都走同一個 sherpa-onnx Emscripten WASM／ONNX Runtime CPU 核心。
- 模型設定固定 `numThreads: 1`、`provider: cpu`、語速 1.0。
- 同一段簡體中文、全形句號文本；內容不含數字或電話，因此計時時不載入正規化 FST。
- 每個模型先暖機一次，再量三次；用 `process.cpuUsage()` 量 process CPU，按實際 WAV 長度正規化成「產生 10 秒音訊所需 CPU 毫秒」，取三次中位數。
- `sherpa-onnx 1.13.4` Node WASM 使用上游預設 512 MiB initial memory；現有 `benchmark.js` 沒有覆寫它。舊文件使用的 `SHERPA_WASM_INITIAL_MEMORY` 環境變數不會被此 wrapper 讀取，不能作為 768 MiB 已生效的證據。這組 benchmark 不載入正規化 FST。
- 這個 npm WASM binary 是 pthread build，runtime 會建立閒置 worker；推論本身固定 `numThreads: 1`。CPU 時間接近 wall time，符合只有一個活躍推論執行緒，但不等於「binary 完全沒有 pthread 支援」。

### 統一瀏覽器 WASM 路徑

- 瀏覽器：Chrome for Testing 149.0.7827.55 arm64；Transformers.js 4.2.0；ONNX Runtime Web 1.26 dev；execution provider 固定 `wasm`，`numThreads = 1`、`proxy = false`。
- 模型：`onnx-community/Kokoro-82M-v1.1-zh-ONNX` 的 int8 graph；聲線為 sid 45（`zf_078`）。
- 四款都直接使用 ONNX Runtime Web `wasm` provider。HuaYan 用 Piper 官方 eSpeak phonemizer；AISHELL3、MeloTTS、Kokoro 使用各自的 lexicon/tokens。Kokoro 另從 `voices.bin` 取得 sid 45（`zf_078`）style。文字前處理不納入推論計時。
- CPU 指標統一採 Chromium CDP `Performance.TaskDuration`；單線程下 task time 幾乎等於 wall time。

## 三輪原始摘要

| 模型 | 三輪 CPU ms / 10 秒音訊 | 中位數 wall ms / 10 秒音訊 |
|---|---|---:|
| HuaYan | 2172.36、2177.27、2187.66 | 2158.36 |
| AISHELL3 | 1281.37、1339.17、1280.12 | 1260.90 |
| MeloTTS | 15624.49、15901.59、15898.00 | 15876.41 |
| Kokoro int8（ORT Web；TaskDuration） | 42338.35、42327.36、42336.76 | 42336.76 |
| HuaYan（ORT Web；TaskDuration） | 1582.61、1566.66、1575.77 | 1575.77 |
| AISHELL3（ORT Web；TaskDuration） | 717.67、703.04、707.96 | 707.96 |
| MeloTTS（ORT Web；TaskDuration） | 14441.27、14427.35、14403.69 | 14427.35 |
| Kokoro fp32（ORT Web；TaskDuration） | 14225.42、14205.52、14256.83 | 14225.42 |
| Matcha zh-en（ORT Web 1.27；TaskDuration） | 1365.03、1357.54、1361.20 | 1361.20 |

## 可重現檔案

- 測試程式：`platform/benchmark.js`
- 每輪完整 JSON：`platform/results/results-*.json`
- 成功模型最後一輪 WAV：`platform/results/*.wav`
- Kokoro 瀏覽器頁：`platform/kokoro-browser.html`
- Kokoro Chromium/CDP runner：`platform/run-kokoro-browser.mjs`
- Kokoro selective INT8 量化器：`platform/quantize-kokoro.py`
- Kokoro 原生數值驗證器：`platform/validate-kokoro-onnx.py`
- Kokoro gstack browse 單輪 runner：`platform/run-kokoro-gstack.js`
- 其他三款 ORT Web runner：`platform/run-vits-browser.mjs`
- Matcha ORT Web 頁面／runner：`platform/matcha-browser.html`、`platform/run-matcha-browser.mjs`
- Matcha 正式 JSON／WAV：`platform/results/results-matcha_icefall_zh_en-browser-wasm.json`、`platform/results/matcha_icefall_zh_en-browser-wasm.wav`
- Matcha 上游 FST runner／A/B：`platform/run-matcha-upstream-fst-browser.mjs`、`platform/run-matcha-fst-ab-browser.mjs`
- Matcha 上游 FST JSON／WAV：`platform/results/results-matcha_icefall_zh_en-upstream-fst-browser-wasm.json`、`platform/results/matcha_icefall_zh_en-upstream-fst-browser-wasm.wav`
- Matcha 端到端頁面／runner：`mobile-host/matcha-stream-test.html`、`platform/run-matcha-stream-browser.mjs`
- Matcha 端到端 JSON：`platform/results/results-matcha_icefall_zh_en-stream-browser-wasm.json`
- 統一三款原始結果：`platform/results/results-vits-browser-wasm.json`
- Selective INT8 與同瀏覽器 FP32 A/B：`platform/results/results-kokoro_v1_1_zh_selective-int8-browser-wasm.json`

重跑範例：

```sh
pnpm exec node platform/benchmark.js piper_huayan_medium
pnpm exec node platform/benchmark.js vits_aishell3
pnpm exec node platform/benchmark.js vits_melotts_zh_en
# 另一個終端機先執行：pnpm host:mobile
pnpm exec node platform/run-kokoro-browser.mjs fp32
pnpm exec node platform/run-vits-browser.mjs
pnpm benchmark:matcha
pnpm benchmark:matcha-upstream-fst
pnpm benchmark:matcha-fst-ab
pnpm sample:matcha-upstream-fst-traditional
pnpm benchmark:matcha-stream
```
