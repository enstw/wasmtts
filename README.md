![wasmtts](.github/banner.png)

# wasmtts

<p align="center">
  <a href="https://github.com/enstw/wasmtts/releases/latest"><img alt="release" src="https://img.shields.io/github/v/release/enstw/wasmtts?label=release&color=1f6feb"></a>
  <a href="LICENSE"><img alt="License MIT" src="https://img.shields.io/badge/License-MIT-d4a72c"></a>
  <a href="https://github.com/enstw/wasmtts/actions/workflows/release.yml"><img alt="release gates" src="https://img.shields.io/github/actions/workflow/status/enstw/wasmtts/release.yml?branch=main&label=release%20gates"></a>
  <a href="https://github.com/enstw/wasmtts/attestations"><img alt="releases attested" src="https://img.shields.io/badge/releases-attested%20(Sigstore)-2ea043"></a>
  <a href="https://github.com/enstw/wasmtts/releases/latest"><img alt="tarball" src="https://img.shields.io/badge/tarball-wasmtts--engine.tar.gz-2ea043"></a>
</p>
<p align="center">
  <a href="https://huggingface.co/csukuangfj/matcha-icefall-zh-en"><img alt="model" src="https://img.shields.io/badge/model-matcha--icefall--zh--en-1f6feb"></a>
  <a href="package.json"><img alt="ONNX Runtime Web" src="https://img.shields.io/github/package-json/dependency-version/enstw/wasmtts/onnxruntime-web?label=ONNX%20Runtime%20Web&color=1f6feb"></a>
  <img alt="text input" src="https://img.shields.io/badge/%E6%96%87%E5%AD%97-%E7%B9%81%E9%AB%94%E7%9B%B4%E8%BC%B8%20%C2%B7%20%E7%B0%A1%E9%AB%94%E4%BA%A6%E5%8F%AF-1f6feb">
  <a href="renovate.json"><img alt="upstream tracking" src="https://img.shields.io/badge/upstream-Renovate%20weekly-1f6feb"></a>
</p>
<p align="center">
  <img alt="Chromium" src="https://img.shields.io/badge/Chromium-release%20gated-8250df">
  <img alt="iOS Safari / PWA" src="https://img.shields.io/badge/iOS%20Safari%20%2F%20PWA-tested-8250df">
  <img alt="Node.js" src="https://img.shields.io/badge/Node.js-runtime%20none%20required%20%C2%B7%20build%20only-8250df">
  <img alt="WASM" src="https://img.shields.io/badge/WASM-single%20thread%20%C2%B7%20offline-8250df">
</p>

以 Matcha、Vocos 與獨立 FST WASM 打造可在瀏覽器離線執行的中文 TTS **引擎套件**。

`wasmtts` 把 `matcha-icefall-zh-en` 打包成 release tarball `wasmtts-engine.tar.gz`：繁體直輸文字前端、編譯後的 wasmtts lexicon、臺灣讀音 runtime profile、kaldifst text-normalizer WASM 與 Matcha + Vocos 合成核心，一個 `MatchaEngine.create()` 組好。下游應用只需提供 UI、hosting 與模型下載，目標場景是 Safari／PWA 以單一 WASM thread 背景逐句產生音訊、持續 append 到同一條媒體 timeline。

```text
繁體中文（簡體亦可直輸）
  → kaldifst + OpenFST text-normalizer WASM（phone/date/number FST）
  → wasmtts lexicon（單一編譯檔）＋ runtime contextual rules
  → Matcha acoustic model → Vocos + ISTFT → silence scaling
  → PCM（下游自行編碼／串流）
```

Matcha 與 Vocos 共用 ONNX Runtime Web；text normalizer 使用另一個獨立 WASM linear memory，不載入 sherpa-onnx frontend bundle 的固定 512 MiB heap。

## 使用 tarball

每個 [Release](https://github.com/enstw/wasmtts/releases) 附 `wasmtts-engine.tar.gz`（內容由 [`scripts/release-manifest.json`](scripts/release-manifest.json) 定義）：

| 檔案 | 用途 |
|---|---|
| `matcha-engine.js` | 入口 `MatchaEngine.create()` |
| `matcha-worker.js`、`matcha-producer.mjs`、`continuous-stream-player.mjs` | 背景逐句合成 Worker（classic script，`configure` 訊息接收全部 URL）、頁面端 producer 封裝（含 `workerConfigFromAssets`、`splitSentences`）、單一 `ManagedMediaSource` timeline 的 streaming player |
| `matcha-frontend.js`、`matcha-taiwan-profile.js`、`matcha-synthesis.js`、`kaldifst-normalizer.js` | engine 的組成模組；以 `importScripts`／`<script>` 依序載入，或在 Node 以 `require` 取得後注入 |
| `matcha-kaldifst-normalizer.js`、`matcha-kaldifst-normalizer.wasm` | text-normalizer WASM 與 Emscripten glue |
| `matcha-lexicon.txt`、`matcha-lexicon.meta.json` | **wasmtts lexicon**：單一字典檔即完整，不需上游 `lexicon.txt`；meta 記錄上游 revision、輸入 hash 與統計 |
| `matcha-profile.runtime.json` | 臺灣讀音 runtime profile（contextual rules；phrase overrides 已烘進 lexicon） |
| `matcha-assets.json` | 語音包定義（schemaVersion 4，`stage: complete`）：acoustic／Vocos／tokens／FST 的下載來源、`packName`、`bytes`、`sha256`；`lexicon` 區塊（`packName` 含內容 hash）；`runtime` 區塊宣告 ONNX Runtime Web 與 lamejs 的 npm 版本、檔案、含版本的 `packName` 與 `sha256`（bytes 不在 tarball，下游從 npm 取並驗 hash）。只有帶 `packName` 的條目需要供檔；`matcha.files.lexicon.txt` 標 `role: build-input`，下游不需下載。**只用 tarball 內這一份**：repo 裡的 `platform/matcha-assets.source.json` 是 `stage: source`（只有 pin 與來源，沒有 `lexicon`／`runtime`），`workerConfigFromAssets` 讀到會直接 throw |

模型權重（acoustic、Vocos）、`tokens.txt` 與三個 FST 依 `matcha-assets.json` 自行下載並驗 `sha256`；資產 bytes 改變時 `packName` 必跟著改，下游可放心 cache-first。

```js
// 載入順序：matcha-frontend.js → matcha-taiwan-profile.js → kaldifst-normalizer.js
//          → matcha-synthesis.js → matcha-kaldifst-normalizer.js → matcha-engine.js
const engine = await MatchaEngine.create({
  lexiconText,                     // matcha-lexicon.txt（tarball）
  tokensText,                      // tokens.txt（依 matcha-assets.json 下載）
  profile,                         // JSON.parse(matcha-profile.runtime.json)
  fstBuffers: [phoneFst, dateFst, numberFst],   // 順序固定
  kaldifstModuleFactory: KaldifstNormalizerModule,
  wasmUrl: '/vendor/matcha-kaldifst-normalizer.wasm',
  ORT: ort,                        // onnxruntime-web；建議 numThreads 1、proxy false
  acousticModel, vocoderModel,     // Uint8Array
  synthesis: assets.synthesis,     // matcha-assets.json 的播放參數定案
  pronunciationOverrides: {'某人名': 'mou3 ren2 ming2'},   // 選用：本地暫存層，聽測修正尚未進 review 時放這裡
});
const {samples, sampleRate, audioSeconds, tokenized} = await engine.synthesize('孫道長久久不語。');
```

`lexiconText`、`tokensText`、`profile`、`fstBuffers`、模型缺一即 throw——沒有可漏傳就靜默降級的字典參數。waveform 若含 NaN／Infinity、peak 或 RMS 為零，`synthesize` 會 throw 而不是回傳無聲。

### 背景逐句合成與串流播放

長篇朗讀（含 iOS 鎖屏）走 tarball 內的 Worker ＋ producer ＋ player：使用者手勢只啟動一次長駐 `HTMLAudioElement`，Worker 逐句產生 MP3 append 到同一個 `ManagedMediaSource`／`SourceBuffer` sequence，buffer 有界並以 media／append 事件驅動 refill。下游只提供三個 base URL 與 UI：

```js
import {createMatchaProducer, workerConfigFromAssets} from './matcha-producer.mjs';
import {createContinuousStreamPlayer} from './continuous-stream-player.mjs';

const assets = await (await fetch('/engine/matcha-assets.json')).json();
const producer = createMatchaProducer({
  workerUrl: '/engine/matcha-worker.js',
  more: async ({tag}) => nextChapterSpans(tag),     // 句子用盡時要下一章（回 null 才結束），timeline 不斷
  restore: async (tag) => chapterSpans(tag),        // player 跨章重建（⏮ 回前一章、看門狗）時把那章要回來
  config: workerConfigFromAssets({
    assets,
    engineBaseUrl: '/engine/',     // tarball 檔案
    assetBaseUrl: '/assets/',      // 依 packName 供檔的模型／tokens／FST／lexicon
    runtimeBaseUrl: '/runtime/',   // 依 runtime packName 供檔的 ORT／lamejs
    // overrides: {lexicon: '/engine/matcha-lexicon.txt'}  任一 URL 可覆寫
  }),
  onEvent: (event) => console.log(event.type, event),   // progress／download-progress／download-complete／ready／error
});
const {missingBytes} = await producer.status();   // 不下載就能回答缺幾 MB——先問使用者，▶ 絕不偷偷抓 130 MB
producer.download();      // Cache API：模型、lexicon（packName 含內容 hash）與 ORT wasm 都 cache-first，profile network-first（1 s 逾時走 cache）
producer.initialize();    // ready 後 producer.initialization 有 lexiconSize、runtime 版本等
await producer.ready;
producer.setText(chapterText, {tag: chapterIndex});   // sentenceSpans 切句；每個單位 meta.start/end/tag 對回原文
producer.seekTo(offset);                               // 從含該字元位置的那句起（不重播整段）

const player = createContinuousStreamPlayer({
  audio: document.querySelector('audio'),   // 長駐、單一 element；WebKit 需 disableRemotePlayback
  producer,
  mediaSession: {                             // opt-in 鎖屏控制
    metadata: {title: '第一章', artist: '書名'},
    handlers: {previoustrack: () => player.seekToSegment(current.index - 1), nexttrack: () => player.seekToSegment(current.index + 1)},
  },
  onSegment: (segment) => {                   // 唱到哪：segment.meta.start/end/tag → 書籤、高亮、翻頁
    highlight(segment.meta.start, segment.meta.end);
    if (segment.meta.tag !== shownChapter) player.setMetadata({title: chapterTitle(segment.meta.tag)});
  },
  onStall: (event) => log(event.phase),       // 看門狗：'nudge'（推一下）→ 'rebuild'（於目前段重建）
  onUpdate: (snapshot) => render(snapshot),   // snapshot.currentSegment／userPaused／drained／stalls／nudges／rebuilds
});
await player.start();     // 唯一一次 play()；之後只 pause()／resume()
player.seekToSegment(index);   // ⏮⏭：段仍在 buffer 內就 seek，否則以該段的 {tag, index} 重建（跨章先 producer.restore(tag)）
```

Worker 的 `configure` config 由 `workerConfigFromAssets` 機械產生（所有 script／wasm／資產 URL、bytes、cache 名稱、`synthesis` 參數、版本字串），Worker 在收到後才 `importScripts`；`synthesize` 亦可直接呼叫 `producer.synthesize(text)` 取得單句 MP3（或 `format: 'pcm'`）。

**實機規矩（player 內建）**：每 `heartbeatSeconds`（10）一行 `♥ heartbeat` log（vis／playhead／ahead／appends）；`playing` 但 `currentTime` 連續兩拍未動且 buffer 充足 → 先 `currentTime += 0.01; play()` 推一下，再一拍仍卡 → 於目前段 `restartFrom`；只有 `pause()` 算使用者暫停（`snapshot().userPaused`），鎖屏／系統造成的 pause 狀態為 `suspended`，回到前景時若非使用者暫停就自動 `resume()`（`autoResumeOnVisible`）；懸而未決的 `play()` promise 會在心跳中點名（`pendingPlay`）。**producer 用盡 ≠ 播完**：producer 以數倍實時領先，回 `null` 時 element 還有整個 buffer（預設 90 s）要唸——player 只 `endOfStream()` 一次並記 `snapshot().drained`，之後不再問 producer；`status` 要到 element 真正 `ended` 才變 `ended`，位置同步以 `status === 'playing'` 判斷即可（一個單位都沒有時才直接 `ended`）。**跨章重建**：段的 `meta.index` 是「當時那一章」的句序，`restartFrom({tag, index})`（看門狗與出 buffer 的 `seekToSegment` 都走這裡）在 producer 已被 `more()` 換章時先 `producer.restore(tag)` 要回那章再 `setCursor`；沒給 `restore` hook 就 reject 且不動現有播放，絕不默默在錯章的同序句重建。這些都來自下游 iOS 實機紀錄，不要在下游重做一份。

**資產管線**：`status()`／`download()`／keep-set 清掃看的是同一份清單：lexicon、profile、tokens、三個 FST、acoustic、Vocos，以及 **ORT 的 wasm**（`config.assets.ortWasm`，`workerConfigFromAssets` 自動填入；init 時以 `ort.env.wasm.wasmBinary` 注入，ORT 不再自己按 URL 抓）——下游不必另外為它開 cache。`missingBytes` 因此含這 13 MB。

**閱讀器契約**：`sentenceSpans(text)` 回 `[{start, end, text}]`（`ENDERS = 。！？；\n`、`CLOSERS = 」』”’）)】`，空白 span 折入前一段，超長句在 `，、：` 次切），`sentenceStartFor/EndFor(text, i)` 用同一個 walk——下游畫高亮請用這組函式，「唱到哪、畫到哪」才不會漂。`next()` 的 `meta.start/end` 是該單位對應的原文區間；空句或不可讀句不佔 timeline，其區間折入下一單位（`onEvent({type: 'skipped'})`），只有 init／Worker 失敗才會讓 `ready` reject。`progress` 事件預設關（`progressEvents: true` 才送）。

**本地讀音暫存層**：`workerConfigFromAssets({..., pronunciationOverrides: {'詞': 'p1 p2'}})`（或直接給 `MatchaEngine.create`）會在 lexicon 與 review 之後以整詞 longest-match 套用；phone 不在 `tokens.txt` 或字數不符會在建立時 throw。這一層給下游聽出來、尚未進 `matcha-g2p-review.json` 的修正用；確認後請提 review／curation，讓它進下一版 lexicon。

**COOP／COEP**：tarball 的 runtime 是單一 WASM thread（`ort.env.wasm.numThreads = 1`、`proxy = false`），**不需要** `crossOriginIsolated`，一般靜態 host 即可；只有自行改成多執行緒 ORT（`SharedArrayBuffer`）才需要 `Cross-Origin-Opener-Policy: same-origin` 與 `Cross-Origin-Embedder-Policy: require-corp`。`mobile-host/server.mjs` 預設開這組 headers 是為了量測多執行緒；`WASM_TTS_ISOLATION=off` 可關掉以驗證非 isolated 路徑。

## Lexicon pipeline

wasmtts lexicon ＝ f(上游簡體 `lexicon.txt`, [`platform/matcha-g2p-review.json`](platform/matcha-g2p-review.json), [`platform/matcha-lexicon-traditional-curation.json`](platform/matcha-lexicon-traditional-curation.json))。`pnpm lexicon:build` 把上游簡體全量、全量繁體鏡像（OpenCC 詞組級 cn→tw；讀音只取現行 taiwan 讀音，補的是 longest-match 邊界）與 review phrase overrides 編成一個決定性的 `platform/dist/matcha-lexicon.txt`；產物不提交 git，由 CI 在抓上游資產後建置並隨 tarball 出貨。lexicon／tokens／FST 是 `matcha-icefall-zh-en` 模型 release 的一部分：Renovate 每週追蹤 HF revision 開 PR，candidate gate 以新版重編後才合併發版；本機可用 `pnpm lexicon:sync --check` 查最新 revision，`pnpm lexicon:sync` 換 pin、重抓、重編並產 `platform/dist/lexicon-diff.md`。讀音決策一律改 review／curation 檔（附教育部來源），不手改產物。

## 開發

需求：Node.js、`pnpm`、Emscripten（建 kaldifst WASM），以及執行 Python 工具時使用的 `uv`。

```sh
pnpm install
pnpm build:matcha-kaldifst
pnpm fetch:matcha-assets
pnpm lexicon:build
pnpm test:matcha-lexicon
pnpm test:release-gates      # 完整 gates：frontend、lexicon、profile、FST、package-smoke、browser benchmark、ASR CER
pnpm host:mobile             # 本機 COOP/COEP host；mobile-host/matcha-stream-test.html 為 Worker + player 參考頁
```

第三方模型不會提交至 repository；`platform/models/` 與 `platform/dist/` 均已忽略。

## 自動上游追蹤與發版

[Renovate](renovate.json) 追蹤 npm、ONNX Runtime Web、Matcha/Vocos 資產來源、FST、kaldifst、OpenFST、Emscripten 與固定 ASR oracle。普通 upstream 版本必須有可驗證的發布時間且發行滿 30 天；缺少 timestamp 時 fail-closed。OSV 資料庫確認的 CVE／GHSA 修補可略過這段 quarantine，但只採最低已修補版本，且不略過任何 candidate gate。每週一早上 [renovate workflow](.github/workflows/renovate.yml) 處理單一 roll-up，另每六小時拾取 security fix；只有會改變 build／test artifact 的變更才執行完整 candidate gates。candidate 必須通過 native WASM build、lexicon 重編與 gate、FST golden、有效 waveform、RTF、512 MiB 記憶體上限與 ASR CER gate，workflow 才合併並發版。`main` 也只有 artifact-sensitive paths 變更才重跑相同 gates；成功時發布正式 Release（tarball、`RELEASE.md` 含 wasmtts lexicon 段與前一版 stats 對照、gate 報告），失敗時以 pre-release 保存版本組合、原因、logs 與機器可讀報告。eSpeak 與 iPhone 實機測試不屬於 release gate。

未明確指定 `Release-Version` 時，自動版本會從所有非 draft、非 prerelease 的最高 SemVer 增加 patch。

## Repository 結構

- [`platform/`](platform/)：引擎原始碼、lexicon pipeline、gate 測試；研究模式的 runner、分析工具與結果也在此。
- [`scripts/`](scripts/)：release 打包、gates、資產抓取與上游同步。
- [`mobile-host/`](mobile-host/)：COOP／COEP host 與 Worker／長駐 MediaSource transport 參考實作。
- 研究紀錄（只在研究模式參照）：[`GOAL.md`](GOAL.md) 選型結論與完成條件、[`platform/RESULTS.md`](platform/RESULTS.md) benchmark 與稽核紀錄、[`frameworks/`](frameworks/) 各模型細節與 [`MODEL-COMPARISON.md`](frameworks/MODEL-COMPARISON.md)。

## 授權與第三方資產

本 repository 自有程式碼與文件採 [MIT License](LICENSE)。第三方模型、模型輸出、FST、字典、runtime、套件及下載資產不因本 LICENSE 而重新授權，仍分別受其上游條款約束；使用者必須在下載、散布或產品採用前自行確認授權。本 repository 不發布 Matcha 或 Vocos 模型權重；編譯後的 wasmtts lexicon 衍生自上游 `matcha-icefall-zh-en` 的 lexicon，其授權同樣以上游為準。
