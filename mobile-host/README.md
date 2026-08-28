# 行動裝置測試 Host

此目錄提供一個從 repository 根目錄發布靜態檔案的 host，並加入 COOP、COEP 與 CORP headers。桌面 benchmark runner 也使用同一個 port。

`stream-test.html` 與 tarball 出貨的 `platform/continuous-stream-player.mjs` 是已在 iOS PWA 驗證的播放框架：單一 `HTMLAudioElement`、單一 `ManagedMediaSource`／`MediaSource` sequence timeline、事件驅動 refill、有界 ahead buffer、舊 buffer 裁切與鎖屏 flight recorder。測試頁以重複的 HuaYan MP3 fixture 驗證 transport；選定的 Matcha adapter 以相同契約逐段回傳 `{ buffer: ArrayBuffer, meta }`。Fixture 與 Piper 不產生本專案的 TTS benchmark，也不需要重做 Piper Worker 或 encoder 實驗。

`matcha-stream-test.html` 是 engine tarball 元件的消費者示範：`platform/matcha-producer.mjs` 以 `workerConfigFromAssets` 從 `platform/dist/matcha-assets.json` 組出 config（本 host 覆寫為 `/platform/`、`/platform/dist/`、`/platform/models/`、`/mobile-host/vendor/runtime/` 路徑），`platform/matcha-worker.js` 逐句執行繁體直輸、獨立 kaldifst WASM `phone/date/number` FST、wasmtts lexicon、Matcha、Vocos、ISTFT、silence scaling 與 96 kbps MP3 encode，再交給同一個 continuous player；頁面只負責 DOM、telemetry、flight recorder 與 CDP hook。Matcha/Vocos 共用 ORT Web WASM；text normalizer 是另一個初始 16 MiB linear memory 的小型 WASM。三個原始 sherpa tables 合計約 208 KiB，不載入 512 MiB sherpa-onnx frontend bundle。「產品」選項是產品路徑：讀 `pnpm lexicon:build` 編出的 `platform/dist/matcha-lexicon.txt`（phrase overrides 已烘入）與 `matcha-profile.runtime.json`（contextual rules），兩者採 network-first、離線時才 cache fallback，因此字典更新不需輪替大型 asset cache。「研究對照」以第二個 Worker 覆寫 `lexicon`／`profile` URL 讀上游原始 lexicon、空 profile（engine 仍套 `matcha-taiwan-profile.js` 的 `垃圾` base override，故 lexiconSize 為 68,038），只供 A/B。contextual rule 只在 longest-match 仍落到單字「著」時生效，不是全域覆寫。模型、tokens 與 FST 採 cache-first。

`reader-demo.html`（＋ `reader-demo.mjs`）是給下游照抄的閱讀器示範：三章內建短文，開頁先 `packStatus(config)` 不開 Worker 就列出每個資產缺不缺（`labels` 給中文顯示名），▶ 前 `producer.prime({offset})` 先合成含書籤那句，`more`／`restore` 供章，`onSegment` 以 `meta.start/end/tag` 高亮、寫書籤、換 Media Session 章名，⏮⏭ 先在 `player.segments()` 找目標（跨章的段還在 buffer 就直接 seek）不在才 `restartFrom({tag, index})`，`onLog` 以 `code` 勾選過濾，`minUnitChars` 可在頁上切換（opt-in）。它不進任何 gate 也不進 tarball（`scripts/ci-scope.mjs` 排除），改它不會觸發發版。

`frequency-ab-score.html` 是 16 kHz 箱音診斷的匿名評分頁。每位受試者看到隨機排序的四段音訊，頁面收集箱音／鼓聲、清晰度、自然度、整體偏好與播放設備；草稿保存在瀏覽器 localStorage，提交後由 host 驗證並追加至 `.cache/frequency-ab-scores.jsonl`。受試者資料不加入 Git，音訊版本的 SHA-256 會隨每筆評分保存。

## 啟動

```sh
pnpm host:mobile
```

預設監聽所有網路介面的 `8765` port。桌面可開啟 `http://127.0.0.1:8765/mobile-host/`；手機則使用電腦的區域網路 IP，例如 `http://192.168.1.20:8765/mobile-host/`。

Fixture transport 頁：`http://127.0.0.1:8765/mobile-host/stream-test.html`。

Matcha 端到端頁：`http://127.0.0.1:8765/mobile-host/matcha-stream-test.html`。以受裝置信任的 HTTPS 開啟、等待 Worker ready 後，可加入 iOS 主畫面並離線重開測試頁。

閱讀器示範頁：`http://127.0.0.1:8765/mobile-host/reader-demo.html`（需先 `pnpm fetch:matcha-assets && pnpm lexicon:build`）。

匿名評分頁：`http://127.0.0.1:8765/mobile-host/frequency-ab-score.html`。若從區域網路邀請其他裝置評分，請只在信任的網路短暫啟動 host；預設 `0.0.0.0` 會發布 repository 根目錄。

只提供匿名評分頁及四段音訊、不發布 repository 其他檔案時，使用評分頁專用模式；建議將 `WASM_TTS_HOST` 指定為實際 LAN 介面 IP，而非 `0.0.0.0`：

```sh
WASM_TTS_HOST=192.168.1.20 pnpm host:score
```

iPhone 的 `ManagedMediaSource` 依 WebKit 要求必須提供 AirPlay 替代來源或明確設定 `HTMLMediaElement.disableRemotePlayback=true`；共同播放器採後者，否則 `sourceopen` 可能不會發生。測試頁另會把 flight recorder 事件 POST 到同一個本機 host 並印在 server console，方便從後台判斷 Worker、MMS 與 append 停在哪一步。

桌面自動量測在另一個終端機執行：

```sh
pnpm benchmark:matcha-stream
```

可用環境變數調整監聽位址與 port：

```sh
WASM_TTS_HOST=0.0.0.0 WASM_TTS_PORT=9000 pnpm host:mobile
```

評分檔可另行指定，適合測試或分開保存不同批次：

```sh
WASM_TTS_SCORE_FILE=/tmp/matcha-frequency-ab-scores.jsonl pnpm host:mobile
```

## iOS 注意事項

- 手機與測試電腦必須位於可互通的網路，且防火牆允許所選 port。
- 單線程 WASM 可透過區域網路 HTTP 做功能與效能測試。
- `SharedArrayBuffer` 需要 secure context；使用區域網路 IP 測雙執行緒時，僅有 COOP／COEP headers 不足，仍需受裝置信任的 HTTPS 憑證或正式 HTTPS host。
