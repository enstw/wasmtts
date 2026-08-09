# Matcha kaldifst text-normalizer WASM

這個 pilot 將 `kaldifst::TextNormalizer` 與 OpenFST 編譯成獨立的
Emscripten module。它只負責依序套用外部的 `phone-zh.fst`、
`date-zh.fst`、`number-zh.fst`；Matcha 與 Vocos 仍共用另一個 ORT Web
WASM runtime。兩個 module 各自持有獨立的 `WebAssembly.Memory`。

## 固定版本與記憶體

- kaldifst `1.8.0`，commit `ab5bdd013bdf13921e6aeee77db5722ebf9955fb`
- kaldifst 上游固定的 OpenFST `v1.8.5-2026-04-10`，下載 SHA-256
  `c3549940384cbe4fa9f18c2bcfb1bfbd0a80492fd1b0bfa27433cee395a6a199`
- Emscripten 初始 linear memory `16 MiB`，允許成長，上限 `128 MiB`
- 目前產物約為 12 KiB JavaScript glue 與 338 KiB WASM；三個 FST
  共 212,266 bytes，仍是外部模型資產，不嵌入 WASM

kaldifst 與鎖定的 OpenFST fork 均採 Apache-2.0；OpenFST archive 的
`COPYING` 另標示 Copyright 2005–2026 Google LLC。產品散佈時仍須隨附
Apache-2.0 license 與必要 notices，並分別查核模型、lexicon 與三個 FST
資產的授權。此目錄的 dist 是可重現的 pilot 產物，不包含三個 FST。

## 建置

需要 CMake、Emscripten 與網路。JavaScript 套件仍只由 pnpm 管理；此命令
只建置 C++/WASM：

```sh
pnpm build:matcha-kaldifst
pnpm vendor:mobile
```

也可用 `KALDIFST_SOURCE_DIR=/path/to/kaldifst` 指向已位於本機、且 commit
相同的 checkout。建置輸出位於 `dist/`，`vendor:mobile` 再複製到
`mobile-host/vendor/kaldifst/`。

## ABI

`normalizer.cc` 暴露 create/apply/destroy 與錯誤字串的最小 C ABI。
`../kaldifst-normalizer.js` 負責 UTF-8 encode/decode、WASM heap 複製、輸出
生命週期，以及固定的 phone → date → number 順序。
