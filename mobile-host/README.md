# 行動裝置測試 Host

此目錄提供一個從 repository 根目錄發布靜態檔案的 host，並加入 COOP、COEP 與 CORP headers。桌面 benchmark runner 也使用同一個 port。

## 啟動

```sh
pnpm host:mobile
```

預設監聽所有網路介面的 `8765` port。桌面可開啟 `http://127.0.0.1:8765/mobile-host/`；手機則使用電腦的區域網路 IP，例如 `http://192.168.1.20:8765/mobile-host/`。

可用環境變數調整監聽位址與 port：

```sh
WASM_TTS_HOST=0.0.0.0 WASM_TTS_PORT=9000 pnpm host:mobile
```

## iOS 注意事項

- 手機與測試電腦必須位於可互通的網路，且防火牆允許所選 port。
- 單線程 WASM 可透過區域網路 HTTP 做功能與效能測試。
- `SharedArrayBuffer` 需要 secure context；使用區域網路 IP 測雙執行緒時，僅有 COOP／COEP headers 不足，仍需受裝置信任的 HTTPS 憑證或正式 HTTPS host。
- 實機紀錄應包含 iOS／iPadOS 版本、裝置型號、Safari 版本、是否為 PWA、可用執行緒及 background／foreground 行為。
