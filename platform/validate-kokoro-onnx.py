#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "numpy==2.5.1",
#   "onnxruntime==1.28.0",
# ]
# ///

"""以固定中文輸入檢查 Kokoro ONNX 是否輸出有效音訊。"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import numpy as np
import onnxruntime as ort


DEFAULT_TEXT = (
    "清晨的阳光穿过窗帘。轻轻落在安静的房间里。远处传来清脆的鸟鸣。"
    "微风带着花草的清香。让崭新的一天显得格外明亮。"
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="驗證 Kokoro ONNX 的數值與音訊輸出")
    parser.add_argument("model", type=Path, help="待驗證的 ONNX 模型")
    parser.add_argument("--tokens", required=True, type=Path, help="tokens.txt")
    parser.add_argument("--lexicon", required=True, type=Path, help="lexicon-zh.txt")
    parser.add_argument("--voices", required=True, type=Path, help="voices.bin")
    parser.add_argument("--sid", type=int, default=45, help="speaker id；預設 45")
    parser.add_argument("--text", default=DEFAULT_TEXT, help="驗證文字")
    return parser.parse_args()


def load_tokens(path: Path) -> dict[str, int]:
    tokens: dict[str, int] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        token, token_id = line.rsplit(" ", 1)
        tokens[token] = int(token_id)
    return tokens


def load_lexicon(path: Path) -> dict[str, list[str]]:
    lexicon: dict[str, list[str]] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        parts = line.split()
        if parts:
            lexicon[parts[0]] = parts[1:]
    return lexicon


def prepare_input_ids(
    text: str,
    tokens: dict[str, int],
    lexicon: dict[str, list[str]],
) -> np.ndarray:
    phones: list[str] = []
    for character in text:
        if character == "。":
            phones.append(".")
        elif character in lexicon:
            phones.extend(lexicon[character])
        elif character in tokens:
            phones.append(character)
    ids = [0, *(tokens[phone] for phone in phones if phone in tokens), 0]
    return np.asarray([ids], dtype=np.int64)


def prepare_style(voices_path: Path, sid: int, token_count: int) -> np.ndarray:
    voices = np.fromfile(voices_path, dtype=np.float32)
    start = (sid * 510 + min(token_count, 509)) * 256
    style = voices[start : start + 256]
    if style.size != 256:
        raise ValueError(f"voices.bin 不含 sid {sid} 所需的 256 個 style 值")
    return style.reshape(1, 256)


def main() -> None:
    args = parse_args()
    for path in (args.model, args.tokens, args.lexicon, args.voices):
        if not path.is_file():
            raise SystemExit(f"找不到檔案：{path}")

    input_ids = prepare_input_ids(
        args.text,
        load_tokens(args.tokens),
        load_lexicon(args.lexicon),
    )
    style = prepare_style(args.voices, args.sid, input_ids.shape[1])

    options = ort.SessionOptions()
    options.intra_op_num_threads = 1
    options.inter_op_num_threads = 1
    session = ort.InferenceSession(
        args.model,
        sess_options=options,
        providers=["CPUExecutionProvider"],
    )

    started = time.perf_counter()
    output_values = session.run(
        None,
        {
            "input_ids": input_ids,
            "style": style,
            "speed": np.ones((1,), dtype=np.float32),
        },
    )
    elapsed_seconds = time.perf_counter() - started
    outputs = dict(zip((item.name for item in session.get_outputs()), output_values))
    waveform = np.asarray(outputs["waveform"], dtype=np.float32).reshape(-1)
    finite = np.isfinite(waveform)
    finite_values = waveform[finite]
    peak = float(np.max(np.abs(finite_values))) if finite_values.size else 0.0
    rms = (
        float(np.sqrt(np.mean(np.square(finite_values, dtype=np.float64))))
        if finite_values.size
        else 0.0
    )
    result = {
        "model": str(args.model),
        "provider": session.get_providers()[0],
        "threads": 1,
        "speaker": args.sid,
        "inputTokens": int(input_ids.shape[1]),
        "elapsedSeconds": elapsed_seconds,
        "samples": int(waveform.size),
        "audioSeconds": waveform.size / 24000,
        "finiteSamples": int(np.count_nonzero(finite)),
        "peak": peak,
        "rms": rms,
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))

    if not bool(np.all(finite)) or peak == 0 or rms == 0:
        raise SystemExit("驗證失敗：waveform 含非有限值或為靜音")


if __name__ == "__main__":
    main()
