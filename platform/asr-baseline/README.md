# ASR 聽回 baseline

正式 Release 必須附帶由目前 Matcha 版本產生的 `asr-listening-report.json`。Candidate gate 從正式 Release 下載該報告，不信任 PR branch 內的 baseline，並同時套用絕對 CER 上限與相對退化上限。

ASR 固定使用 `Systran/faster-whisper-small@2ec96c5472da50d38d40c0cfe0602af2e94b4c8a`、CPU `int8`、中文轉錄。比較前對兩側執行 Unicode NFKC、轉小寫並移除非英數字元。

目前的 bootstrap 音訊與預期文字為：

- `platform/results/matcha_icefall_zh_en-browser-wasm.wav`
- `frameworks/matcha/samples/quality.txt`

建立報告：

```sh
uv run platform/asr-listening-gate.py \
  --audio platform/results/matcha_icefall_zh_en-browser-wasm.wav \
  --expected-file frameworks/matcha/samples/quality.txt \
  --absolute-cer-limit 0.08 \
  --output platform/results/asr-listening-report.json
```

現行 Matcha bootstrap 結果為 49 字中 1 次 substitution，CER `0.020408`；絕對上限固定為 `0.08`，相對正式 baseline 的退化容許值為 `0.02`。兩項必須同時通過。ASR gate 只代表可懂度回歸，不等同主觀自然度盲聽。
