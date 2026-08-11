# 16 kHz 箱音診斷試聽

這組樣本使用相同繁體小說文字與 `noise_scale=0.667`，用來區分官方／產品合成路徑、MP3 編碼及頻譜平衡。請依 A、B、C、D 的順序盲聽，先不要看下方映射。

## 試聽方式

所有版本都是 16 kHz、單聲道。A 與 D 會以 B 的 active RMS 為目標做等響度調整；若避免 clipping，實際 active RMS 可能略低。C 直接由 B 同一次 Worker 合成的 PCM 編碼，因此 B／C 是這組最嚴格的單一變因比較。

1. `A.wav`
1. `B.wav`
1. `C.mp3`
1. `D.wav`

建議先記錄每個版本的「箱音／鼓聲、清晰度、齒音、金屬感、自然度」再揭曉映射。

## 映射與判讀

1. A：sherpa-onnx `1.12.20` 官方 browser bundle 的既有 PCM，包含官方 frontend、Matcha、Vocos 與 ISTFT；它採單一完整輸入，和產品的逐句切分不完全相同。
1. B：產品 Worker 的獨立 kaldifst frontend、Matcha、Vocos、JavaScript ISTFT 與 silence scaling，保存 MP3 encode 前的 PCM。
1. C：由 B 同一次合成的 PCM 經產品 `lamejs 1.2.1`、96 kbps 編碼，每句 MP3 unit 依產品順序串接。
1. D：由 B 套用診斷 EQ：350 Hz、Q 0.9、-3 dB peaking，加上 3.5 kHz、+3 dB high shelf；這不是正式產品調音。

- A、B 都有箱音：優先調查 acoustic model／Vocos，而不是 MP3 或自製 ISTFT。
- A 明顯較好：調查產品切句、frontend 或 JavaScript ISTFT。
- B 明顯比 C 好：調查 MP3 encoder／分段串接。
- D 明顯較好：先考慮低成本 DSP；不必因 16 kHz 直接增加神經升頻模型。
- D 仍無改善：再做離線 bandwidth-extension A/B，判斷高於 8 kHz 的生成頻譜是否值得行動端成本。

`frequency-ab.json` 保存來源、hash、waveform、active RMS、調整 gain 與 EQ 參數。重新產生前先啟動 `pnpm host:mobile`，再執行 `pnpm sample:matcha-frequency-ab`。
