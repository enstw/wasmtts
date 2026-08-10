#!/usr/bin/env python3
"""產生 g2pW ONNX 的固定真實 input batch 與 Python ORT CPU golden。"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
from pathlib import Path

import numpy as np
import onnxruntime
from g2pw import G2PWConverter
from g2pw.dataset import TextDataset
from torch.utils.data import DataLoader


SENTENCES = [
    "他作為掌門，終於成為眾人敬仰的劍仙。",
    "她帶著長劍走過長橋，覺得此地極為安靜。",
    "因為天色已晚，他和朋友決定留下。",
    "這座山名為青城，被視為修行聖地。",
    "少年身為弟子，修為卻比長輩更高。",
    "眾人譽為奇蹟的寶物，最後淪為廢鐵。",
    "為了查明真相，他不以為意地繼續前行。",
    "和平與和氣都是好事，附和別人卻未必妥當。",
]


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-dir", type=Path, default=Path("platform/models/g2pw/G2PWModel"))
    parser.add_argument("--model-source", default="google-bert/bert-base-chinese")
    parser.add_argument("--batch-size", type=int, default=16)
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("platform/results/g2pw-webgpu-fixture.local.json"),
    )
    argv = sys.argv[1:]
    if argv and argv[0] == "--":
        argv = argv[1:]
    args = parser.parse_args(argv)

    initialized_at = time.perf_counter()
    converter = G2PWConverter(
        model_dir=str(args.model_dir),
        model_source=args.model_source,
        style="pinyin",
        batch_size=args.batch_size,
        num_workers=0,
        enable_non_tradional_chinese=True,
    )
    initialization_seconds = time.perf_counter() - initialized_at
    converter.num_workers = 0
    translated = [converter._convert_s2t(sentence) for sentence in SENTENCES]
    texts, query_ids, _, _ = converter._prepare_data(translated)
    dataset = TextDataset(
        converter.tokenizer,
        converter.labels,
        converter.char2phonemes,
        converter.chars,
        texts,
        query_ids,
        use_mask=converter.config.use_mask,
        use_char_phoneme=converter.config.use_char_phoneme,
        window_size=converter.config.window_size,
        for_train=False,
    )
    batch = next(iter(DataLoader(dataset, batch_size=args.batch_size, collate_fn=dataset.create_mini_batch)))
    names = ("input_ids", "token_type_ids", "attention_mask", "phoneme_mask", "char_ids", "position_ids")
    feed = {name: batch[name].numpy() for name in names}
    converter.session_g2pw.run([], feed)
    cpu_runs_ms = []
    probabilities = None
    for _ in range(5):
        started = time.perf_counter()
        probabilities = converter.session_g2pw.run([], feed)[0]
        cpu_runs_ms.append((time.perf_counter() - started) * 1000)
    assert probabilities is not None
    expected = np.argmax(probabilities, axis=-1)
    report = {
        "schemaVersion": 1,
        "model": {
            "path": "/platform/models/g2pw/G2PWModel/g2pw.onnx",
            "bytes": (args.model_dir / "g2pw.onnx").stat().st_size,
            "sha256": sha256(args.model_dir / "g2pw.onnx"),
        },
        "sentences": SENTENCES,
        "queries": len(texts),
        "batchSize": len(expected),
        "cpuBaseline": {
            "onnxruntime": onnxruntime.__version__,
            "converterInitializationMs": initialization_seconds * 1000,
            "warmups": 1,
            "runs": [
                {"wallMs": wall_ms, "queriesPerSecond": len(expected) * 1000 / wall_ms}
                for wall_ms in cpu_runs_ms
            ],
        },
        "expectedArgmax": expected.tolist(),
        "expectedMaxProbability": probabilities[np.arange(len(expected)), expected].tolist(),
        "feeds": {
            name: {
                "type": "float32" if value.dtype == np.float32 else "int64",
                "dims": list(value.shape),
                "data": value.reshape(-1).tolist(),
            }
            for name, value in feed.items()
        },
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps({"output": str(args.output), "queries": len(texts), "batchSize": len(expected)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
