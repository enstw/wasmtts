#!/usr/bin/env python3
"""以 g2pW 對外部繁體小說做小規模 Matcha G2P 差異掃描。"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import time
import zipfile
from collections import Counter
from pathlib import Path

import g2pw
import onnxruntime
import torch
import transformers
from g2pw import G2PWConverter


SEPARATOR_LINE = re.compile(r"^[\s　]*[-－—–―─]{2,}[\s　]*$")
SENTENCE_BOUNDARY = re.compile(r"(?<=[。！？!?])")
HAN = re.compile(r"[\u3400-\u9fff\uf900-\ufaff]")
MAX_CONTEXT_LENGTH = 80
MAX_EXAMPLES = 3


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path, help="外部 UTF-8 小說 ZIP")
    parser.add_argument(
        "--model-dir",
        type=Path,
        default=Path("platform/models/g2pw/G2PWModel"),
    )
    parser.add_argument("--model-source", default="google-bert/bert-base-chinese")
    parser.add_argument("--max-sentences", type=int, default=1000)
    parser.add_argument("--contains", help="只保留包含此字串的句子")
    parser.add_argument("--stratify-previous", help="依此字的前一字分層抽樣")
    parser.add_argument("--per-previous", type=int, default=3)
    parser.add_argument("--review", type=Path, help="排除 review 中已確認的前字 allowlist")
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("platform/results/matcha-g2pw-pilot.local.json"),
    )
    argv = sys.argv[1:]
    if argv and argv[0] == "--":
        argv = argv[1:]
    return parser.parse_args(argv)


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


def novel_sentences(path: Path, limit: int, contains: str | None = None) -> list[str]:
    output: list[str] = []
    with zipfile.ZipFile(path) as archive:
        for name in archive.namelist():
            if not name.lower().endswith(".txt"):
                continue
            with archive.open(name) as source:
                for raw in source:
                    line = raw.decode("utf-8").strip()
                    if not line or SEPARATOR_LINE.fullmatch(line):
                        continue
                    for sentence in SENTENCE_BOUNDARY.split(line):
                        sentence = sentence.strip()
                        if HAN.search(sentence) and (contains is None or contains in sentence):
                            # BERT 的實際上限還需扣掉 special tokens。
                            output.append(sentence[:500])
                            if len(output) >= limit:
                                return output
    return output


def stratified_sentences(
    path: Path,
    character: str,
    limit: int,
    per_previous: int,
    excluded_previous: set[str],
) -> tuple[list[str], dict[str, int]]:
    occurrences = Counter()
    samples: dict[str, list[str]] = {}
    with zipfile.ZipFile(path) as archive:
        for name in archive.namelist():
            if not name.lower().endswith(".txt"):
                continue
            with archive.open(name) as source:
                for raw in source:
                    line = raw.decode("utf-8").strip()
                    if not line or SEPARATOR_LINE.fullmatch(line):
                        continue
                    for sentence in SENTENCE_BOUNDARY.split(line):
                        sentence = sentence.strip()[:500]
                        if not sentence:
                            continue
                        previous_in_sentence: set[str] = set()
                        for index, current in enumerate(sentence):
                            if current != character or index == 0:
                                continue
                            previous = sentence[index - 1]
                            if previous in excluded_previous:
                                continue
                            occurrences[previous] += 1
                            previous_in_sentence.add(previous)
                        for previous in previous_in_sentence:
                            bucket = samples.setdefault(previous, [])
                            if len(bucket) < per_previous and sentence not in bucket:
                                bucket.append(sentence)
    selected: list[str] = []
    for previous, _ in occurrences.most_common():
        for sentence in samples.get(previous, []):
            if sentence not in selected:
                selected.append(sentence)
                if len(selected) >= limit:
                    return selected, dict(occurrences)
    return selected, dict(occurrences)


def matcha_character_readings(
    sentence: str,
    lexicon: dict[str, list[str]],
    max_length: int,
) -> list[str | None]:
    readings: list[str | None] = [None] * len(sentence)
    offset = 0
    while offset < len(sentence):
        match: tuple[str, list[str]] | None = None
        for length in range(min(max_length, len(sentence) - offset), 0, -1):
            word = sentence[offset : offset + length]
            phones = lexicon.get(word)
            if phones:
                match = word, phones
                break
        if match is None:
            offset += 1
            continue
        word, phones = match
        # 中文詞條通常每字一個帶聲調 syllable；無法一對一的條目不猜對齊。
        if len(word) == len(phones):
            readings[offset : offset + len(word)] = phones
        offset += len(word)
    return readings


def short_context(sentence: str) -> str:
    return "".join(sentence.split())[:MAX_CONTEXT_LENGTH]


def phone_parts(phone: str) -> tuple[str, str | None]:
    match = re.fullmatch(r"(.+?)([1-5])", phone)
    return (match.group(1), match.group(2)) if match else (phone, None)


def difference_category(character: str, matcha_phone: str, g2pw_phone: str) -> str:
    matcha_base, matcha_tone = phone_parts(matcha_phone)
    g2pw_base, g2pw_tone = phone_parts(g2pw_phone)
    if matcha_base != g2pw_base:
        return "polyphone"
    if character in {"一", "不"}:
        return "tone_sandhi"
    if "5" in {matcha_tone, g2pw_tone}:
        return "neutral_tone"
    return "tone_disagreement"


def add_difference(
    differences: dict[tuple[str, str, str], dict[str, object]],
    character: str,
    matcha_phone: str,
    g2pw_phone: str,
    sentence_number: int,
    sentence: str,
    character_index: int,
) -> None:
    key = character, matcha_phone, g2pw_phone
    entry = differences.setdefault(
        key,
        {
            "character": character,
            "matcha": matcha_phone,
            "g2pw": g2pw_phone,
            "category": difference_category(character, matcha_phone, g2pw_phone),
            "count": 0,
            "examples": [],
            "windows": {},
        },
    )
    entry["count"] = int(entry["count"]) + 1
    windows = entry["windows"]
    assert isinstance(windows, dict)
    window = sentence[max(0, character_index - 2) : character_index + 3]
    windows[window] = int(windows.get(window, 0)) + 1
    examples = entry["examples"]
    assert isinstance(examples, list)
    context = short_context(sentence)
    if len(examples) < MAX_EXAMPLES and not any(
        example["context"] == context for example in examples
    ):
        examples.append({"sentence": sentence_number, "context": context})


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    args = arguments()
    if args.max_sentences < 1:
        raise ValueError("--max-sentences 必須大於零")

    lexicon, max_length = load_lexicon(
        Path("platform/models/matcha-icefall-zh-en/lexicon.txt")
    )
    excluded_previous: set[str] = set()
    if args.review:
        review = json.loads(args.review.read_text(encoding="utf-8"))
        for entry in review.get("entries", []):
            if entry.get("pattern") == args.stratify_previous:
                excluded_previous.update(entry.get("previousCharacters", ""))
    stratified_occurrences: dict[str, int] | None = None
    if args.stratify_previous:
        sentences, stratified_occurrences = stratified_sentences(
            args.input,
            args.stratify_previous,
            args.max_sentences,
            args.per_previous,
            excluded_previous,
        )
    else:
        sentences = novel_sentences(args.input, args.max_sentences, args.contains)
    converter = G2PWConverter(
        model_dir=str(args.model_dir),
        model_source=args.model_source,
        style="pinyin",
        batch_size=32,
        enable_non_tradional_chinese=True,
    )
    # g2pw 0.1.1 把建構子的 0 當成 falsy 並退回 config 預設值，因此必須在
    # 初始化後明確覆寫，避免 DataLoader 啟動 shared-memory worker。
    converter.num_workers = 0

    started = time.perf_counter()
    predictions = converter(sentences)
    elapsed = time.perf_counter() - started
    differences: dict[tuple[str, str, str], dict[str, object]] = {}
    comparable = 0
    agreement = 0
    g2pw_missing = Counter()
    focus_contexts = Counter()
    focus_character = args.stratify_previous or (
        args.contains if args.contains and len(args.contains) == 1 else None
    )

    for sentence_number, (sentence, predicted) in enumerate(
        zip(sentences, predictions, strict=True), start=1
    ):
        matcha = matcha_character_readings(sentence, lexicon, max_length)
        for character_index, (character, matcha_phone, g2pw_phone) in enumerate(
            zip(sentence, matcha, predicted, strict=True)
        ):
            if not HAN.fullmatch(character) or matcha_phone is None:
                continue
            if g2pw_phone is None:
                g2pw_missing[character] += 1
                continue
            if focus_character and character == focus_character:
                previous = sentence[character_index - 1] if character_index > 0 else ""
                following = sentence[character_index + 1] if character_index + 1 < len(sentence) else ""
                focus_contexts[(previous, following, g2pw_phone)] += 1
            comparable += 1
            if matcha_phone == g2pw_phone:
                agreement += 1
            else:
                add_difference(
                    differences,
                    character,
                    matcha_phone,
                    g2pw_phone,
                    sentence_number,
                    sentence,
                    character_index,
                )

    model_zip = args.model_dir.parent / "G2PWModel-v2-onnx.zip"
    category_occurrences = Counter()
    category_groups = Counter()
    for entry in differences.values():
        category = str(entry["category"])
        category_occurrences[category] += int(entry["count"])
        category_groups[category] += 1
        windows = entry["windows"]
        assert isinstance(windows, dict)
        entry["windows"] = [
            {"text": text, "count": count}
            for text, count in sorted(
                windows.items(), key=lambda item: (-int(item[1]), str(item[0]))
            )[:10]
        ]
    report = {
        "schemaVersion": 2,
        "input": {
            "type": "zip",
            "sentences": len(sentences),
            "selection": "previous-character stratified" if args.stratify_previous else "archive-order head",
            "contains": args.contains,
            "stratifyPrevious": args.stratify_previous,
            "perPrevious": args.per_previous if args.stratify_previous else None,
            "excludedPreviousCharacters": "".join(sorted(excluded_previous)),
            "stratifiedOccurrences": stratified_occurrences,
        },
        "measurementBoundary": {
            "layoutSeparatorsRemoved": True,
            "fstApplied": False,
            "note": "pilot 只比較可逐字對齊的漢字；正式 B/C 必須接 FST 後文字",
        },
        "model": {
            "name": "G2PWModel-v2-onnx",
            "modelDir": str(args.model_dir),
            "archiveSha256": sha256(model_zip) if model_zip.exists() else None,
            "g2pw": getattr(g2pw, "__version__", "0.1.1"),
            "onnxruntime": onnxruntime.__version__,
            "transformers": transformers.__version__,
            "torch": torch.__version__,
        },
        "timing": {
            "wallSeconds": elapsed,
            "sentencesPerSecond": len(sentences) / elapsed,
        },
        "comparison": {
            "comparableCharacters": comparable,
            "agreement": agreement,
            "differences": comparable - agreement,
            "agreementRate": agreement / comparable if comparable else None,
            "categoryOccurrences": dict(category_occurrences),
            "categoryGroups": dict(category_groups),
        },
        "g2pwMissing": dict(g2pw_missing.most_common()),
        "focusContexts": [
            {
                "previous": previous,
                "following": following,
                "g2pw": phone,
                "count": count,
            }
            for (previous, following, phone), count in focus_contexts.most_common()
        ],
        "differenceGroups": sorted(
            differences.values(),
            key=lambda item: (-int(item["count"]), str(item["character"])),
        ),
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(
        json.dumps(
            {
                "output": str(args.output),
                **report["timing"],
                **report["comparison"],
                "differenceGroups": len(differences),
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
