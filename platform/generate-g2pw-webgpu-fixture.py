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


def load_lexicon(path: Path) -> tuple[dict[str, list[str]], int]:
    lexicon: dict[str, list[str]] = {}
    max_length = 1
    with path.open(encoding="utf-8") as source:
        for raw in source:
            parts = raw.strip().split()
            if len(parts) < 2:
                continue
            lexicon[parts[0]] = parts[1:]
            max_length = max(max_length, len(parts[0]))
    return lexicon, max_length


def matcha_character_readings(
    sentence: str, lexicon: dict[str, list[str]], max_length: int
) -> list[str | None]:
    readings: list[str | None] = [None] * len(sentence)
    offset = 0
    while offset < len(sentence):
        match: tuple[str, list[str]] | None = None
        for length in range(min(max_length, len(sentence) - offset), 0, -1):
            word = sentence[offset : offset + length]
            if word in lexicon:
                match = word, lexicon[word]
                break
        if match is None:
            offset += 1
            continue
        word, phones = match
        if len(word) == len(phones):
            readings[offset : offset + len(word)] = phones
        offset += len(word)
    return readings


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
    parser.add_argument(
        "--lexicon",
        type=Path,
        default=Path("platform/models/matcha-icefall-zh-en/lexicon.txt"),
    )
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
    texts, query_ids, sentence_ids, _ = converter._prepare_data(translated)
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
    def label_to_pinyin(label: str) -> str:
        bopomofo = label.split(" ", 1)[1] if converter.config.use_char_phoneme else label
        component = converter.bopomofo_convert_dict.get(bopomofo[:-1])
        return f"{component}{bopomofo[-1]}" if component else bopomofo

    lexicon, max_lexicon_length = load_lexicon(args.lexicon)
    matcha_readings = [
        matcha_character_readings(sentence, lexicon, max_lexicon_length)
        for sentence in SENTENCES
    ]
    query_metadata = []
    for sentence_id, query_id, label_id in zip(
        sentence_ids[: len(expected)], query_ids[: len(expected)], expected.tolist(), strict=True
    ):
        label = converter.labels[label_id]
        query_metadata.append(
            {
                "sentenceId": sentence_id,
                "offset": query_id,
                "character": SENTENCES[sentence_id][query_id],
                "previous": SENTENCES[sentence_id][query_id - 1] if query_id > 0 else "",
                "following": SENTENCES[sentence_id][query_id + 1] if query_id + 1 < len(SENTENCES[sentence_id]) else "",
                "matcha": matcha_readings[sentence_id][query_id],
                "expectedG2pw": label_to_pinyin(label),
            }
        )
    identity_payload = {
        "modelSha256": sha256(args.model_dir / "g2pw.onnx"),
        "lexiconSha256": sha256(args.lexicon),
        "sentences": SENTENCES,
        "feeds": {name: value.tolist() for name, value in feed.items()},
        "queries": query_metadata,
    }
    report = {
        "schemaVersion": 1,
        "model": {
            "path": "/platform/models/g2pw/G2PWModel/g2pw.onnx",
            "bytes": (args.model_dir / "g2pw.onnx").stat().st_size,
            "sha256": sha256(args.model_dir / "g2pw.onnx"),
        },
        "lexicon": {"path": str(args.lexicon), "sha256": sha256(args.lexicon)},
        "inputSha256": hashlib.sha256(
            json.dumps(identity_payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest(),
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
        "labels": [label_to_pinyin(label) for label in converter.labels],
        "queryMetadata": query_metadata,
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
