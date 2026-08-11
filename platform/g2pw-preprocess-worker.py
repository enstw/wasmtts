#!/usr/bin/env python3
"""常駐 g2pW tokenizer worker；只建立 ONNX feeds，不載入 native ORT session。"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from g2pw.api import G2PWConverter
from g2pw.dataset import TextDataset, get_char_phoneme_labels, get_phoneme_labels
from g2pw.utils import load_config
from torch.utils.data import DataLoader
from transformers import BertTokenizer


FEED_NAMES = (
    "input_ids",
    "token_type_ids",
    "attention_mask",
    "phoneme_mask",
    "char_ids",
    "position_ids",
)


def create_preprocessor(model_dir: Path, model_source: str) -> G2PWConverter:
    """複製 upstream 初始化中與前處理有關的部分，刻意略過 InferenceSession。"""
    converter = G2PWConverter.__new__(G2PWConverter)
    converter.config = load_config(str(model_dir / "config.py"), use_default=True)
    converter.tokenizer = BertTokenizer.from_pretrained(model_source)
    converter.polyphonic_chars = [
        line.split("\t")
        for line in (model_dir / "POLYPHONIC_CHARS.txt").read_text().strip().splitlines()
    ]
    converter.monophonic_chars = [
        line.split("\t")
        for line in (model_dir / "MONOPHONIC_CHARS.txt").read_text().strip().splitlines()
    ]
    label_builder = (
        get_char_phoneme_labels if converter.config.use_char_phoneme else get_phoneme_labels
    )
    converter.labels, converter.char2phonemes = label_builder(converter.polyphonic_chars)
    converter.chars = sorted(converter.char2phonemes)
    package_dir = Path(sys.modules[G2PWConverter.__module__].__file__).parent
    converter.bopomofo_convert_dict = json.loads(
        (package_dir / "bopomofo_to_pinyin_wo_tune_dict.json").read_text()
    )
    converter.char_bopomofo_dict = json.loads(
        (package_dir / "char_bopomofo_dict.json").read_text()
    )
    converter.style_convert_func = converter._convert_bopomofo_to_pinyin
    return converter


def label_to_pinyin(converter: G2PWConverter, label: str) -> str:
    bopomofo = label.split(" ", 1)[1] if converter.config.use_char_phoneme else label
    component = converter.bopomofo_convert_dict.get(bopomofo[:-1])
    return f"{component}{bopomofo[-1]}" if component else bopomofo


def encode_batch(converter: G2PWConverter, sentences: list[dict], batch_size: int) -> dict:
    texts = [item["text"] for item in sentences]
    query_texts, query_ids, sentence_indexes, _ = converter._prepare_data(texts)
    dataset = TextDataset(
        converter.tokenizer,
        converter.labels,
        converter.char2phonemes,
        converter.chars,
        query_texts,
        query_ids,
        use_mask=converter.config.use_mask,
        use_char_phoneme=converter.config.use_char_phoneme,
        window_size=converter.config.window_size,
        for_train=False,
    )
    queries = [
        {
            "sourceSentenceId": sentences[sentence_index]["sourceSentenceId"],
            "offset": offset,
        }
        for sentence_index, offset in zip(sentence_indexes, query_ids, strict=True)
    ]
    batches = []
    cursor = 0
    loader = DataLoader(dataset, batch_size=batch_size, collate_fn=dataset.create_mini_batch)
    for batch in loader:
        count = len(batch["char_ids"])
        batches.append(
            {
                "queries": queries[cursor : cursor + count],
                "feeds": {
                    name: {
                        "type": "float32" if str(batch[name].numpy().dtype) == "float32" else "int64",
                        "dims": list(batch[name].shape),
                        "data": batch[name].numpy().reshape(-1).tolist(),
                    }
                    for name in FEED_NAMES
                },
            }
        )
        cursor += count
    return {"queryCount": len(queries), "batches": batches}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-dir", type=Path, default=Path("platform/models/g2pw/G2PWModel"))
    parser.add_argument("--model-source", default="google-bert/bert-base-chinese")
    parser.add_argument("--batch-size", type=int, default=32)
    args = parser.parse_args()
    converter = create_preprocessor(args.model_dir, args.model_source)

    # API helpers 需要的純資料資產；這裡明確補齊，但不建立 session_g2pw。
    labels = [label_to_pinyin(converter, label) for label in converter.labels]
    print(json.dumps({"ready": True, "labels": labels}, ensure_ascii=False), flush=True)
    for line in sys.stdin:
        try:
            request = json.loads(line)
            result = encode_batch(converter, request["sentences"], args.batch_size)
            print(json.dumps({"id": request.get("id"), **result}, ensure_ascii=False), flush=True)
        except Exception as error:  # 保持 worker 存活，讓 coordinator 能記錄 failed checkpoint。
            print(json.dumps({"error": str(error)}, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
