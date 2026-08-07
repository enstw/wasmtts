# 行動裝置測試 Host

此目錄提供一個從 repository 根目錄發布靜態檔案的 host，並加入 COOP、COEP 與 CORP headers。桌面 benchmark runner 也使用同一個 port。

`stream-test.html` 與 `continuous-stream-player.mjs` 抽出 `bookworm` 已在 iOS PWA 驗證的播放框架：單一 `HTMLAudioElement`、單一 `ManagedMediaSource`／`MediaSource` sequence timeline、事件驅動 refill、有界 ahead buffer、舊 buffer 裁切與鎖屏 flight recorder。測試頁以重複的 HuaYan MP3 fixture 驗證 transport；候選 TTS adapter 只需實作逐段回傳 `{ buffer: ArrayBuffer, meta }` 的 producer。Fixture 與 Piper 不產生本專案的 TTS benchmark，也不需要重做 Piper Worker 或 encoder 實驗。

`matcha-stream-test.html` 是目前優先候選的低記憶體實際 producer：Worker 逐句執行繁體直輸、常用數字／日期正規化、lexicon/token mapping、Matcha、Vocos、ISTFT、silence scaling 與 96 kbps MP3 encode，再交給同一個 continuous player。頁面將約 123.6 MiB ONNX 模型下載與初始化／暖機拆成獨立步驟並顯示進度；secure context 會把 acoustic、Vocos、字典與瀏覽器 runtime 寫入 CacheStorage，實機仍須確認儲存配額與 eviction 行為。此 adapter 沒有正式中文 FST，不代表最終文字前端。

## 啟動

```sh
pnpm host:mobile
```

預設監聽所有網路介面的 `8765` port。桌面可開啟 `http://127.0.0.1:8765/mobile-host/`；手機則使用電腦的區域網路 IP，例如 `http://192.168.1.20:8765/mobile-host/`。

Fixture transport 頁：`http://127.0.0.1:8765/mobile-host/stream-test.html`。

Matcha 端到端頁：`http://127.0.0.1:8765/mobile-host/matcha-stream-test.html`。以受裝置信任的 HTTPS 開啟、等待 Worker ready 後，可加入 iOS 主畫面並離線重開測試頁。

iPhone 的 `ManagedMediaSource` 依 WebKit 要求必須提供 AirPlay 替代來源或明確設定 `HTMLMediaElement.disableRemotePlayback=true`；共同播放器採後者，否則 `sourceopen` 可能不會發生。測試頁另會把 flight recorder 事件 POST 到同一個本機 host 並印在 server console，方便從後台判斷 Worker、MMS 與 append 停在哪一步。

桌面自動量測在另一個終端機執行：

```sh
pnpm benchmark:matcha-stream
```

可用環境變數調整監聽位址與 port：

```sh
WASM_TTS_HOST=0.0.0.0 WASM_TTS_PORT=9000 pnpm host:mobile
```

## iOS 注意事項

- 手機與測試電腦必須位於可互通的網路，且防火牆允許所選 port。
- 單線程 WASM 可透過區域網路 HTTP 做功能與效能測試。
- `SharedArrayBuffer` 需要 secure context；使用區域網路 IP 測雙執行緒時，僅有 COOP／COEP headers 不足，仍需受裝置信任的 HTTPS 憑證或正式 HTTPS host。
- 實機紀錄應包含 iOS／iPadOS 版本、裝置型號、Safari 版本、是否為 PWA、可用執行緒及 background／foreground 行為。

## 鎖屏播放驗收

- 在使用者點擊後建立單一長駐 `HTMLAudioElement` 與單一 `ManagedMediaSource`／`SourceBuffer` sequence；逐句背景合成、編碼並 append 到既有 timeline，不得預產整章或在片段邊界再次呼叫 `play()`。
- 分別從 Safari tab 與安裝到主畫面的 PWA 開始播放；開始出聲後鎖屏至少 2 小時並跨越 3 個章節，期間不得要求回前景補產。
- 每 10 秒記錄合成 wall time、音訊秒數、RTF、realtime multiplier、buffer ahead、待 append 佇列與 document visibility；確認 RTF 持續小於 `1` 且 buffer 沒有 underflow。
- 限制 ahead buffer 並裁切已播放區段，確認記憶體與佇列不隨小說長度持續成長。
- 驗證鎖屏的播放／暫停控制、耳機控制、其他 app 音訊中斷，以及解鎖回到前景後的狀態。
- 記錄實際是否可聽，不只記錄 `play()` Promise、media events 或 `AudioContext.state`。
- 若使用 `navigator.audioSession`，可在支援時設為 `playback`，但仍必須保留實機版本矩陣。
