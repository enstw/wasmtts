# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "faster-whisper==1.2.1",
#   "huggingface-hub==0.34.4",
# ]
# ///

"""以固定 Whisper 模型聽回合成音訊，輸出可供 CI 判定的 CER 報告。"""

from __future__ import annotations

import argparse
import json
import sys
import unicodedata
from pathlib import Path

from faster_whisper import WhisperModel
from huggingface_hub import snapshot_download


MODEL_REPOSITORY = "Systran/faster-whisper-small"
MODEL_REVISION = "2ec96c5472da50d38d40c0cfe0602af2e94b4c8a"


def normalize(text: str) -> str:
    text = unicodedata.normalize("NFKC", text).lower()
    return "".join(character for character in text if character.isalnum())


def edit_distance(left: str, right: str) -> int:
    previous = list(range(len(right) + 1))
    for left_index, left_character in enumerate(left, start=1):
        current = [left_index]
        for right_index, right_character in enumerate(right, start=1):
            current.append(
                min(
                    current[-1] + 1,
                    previous[right_index] + 1,
                    previous[right_index - 1] + (left_character != right_character),
                )
            )
        previous = current
    return previous[-1]


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio", required=True, type=Path)
    parser.add_argument("--expected-file", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--absolute-cer-limit", required=True, type=float)
    parser.add_argument("--baseline-report", type=Path)
    parser.add_argument("--regression-tolerance", type=float, default=0.01)
    parser.add_argument("--model-cache", type=Path, default=Path(".cache/asr"))
    return parser.parse_args()


def main() -> int:
    arguments = parse_arguments()
    expected = arguments.expected_file.read_text(encoding="utf-8").strip()
    model_path = snapshot_download(
        repo_id=MODEL_REPOSITORY,
        revision=MODEL_REVISION,
        cache_dir=arguments.model_cache,
    )
    model = WhisperModel(model_path, device="cpu", compute_type="int8")
    segments, information = model.transcribe(
        str(arguments.audio),
        language="zh",
        beam_size=5,
        condition_on_previous_text=False,
        vad_filter=False,
    )
    recognized = "".join(segment.text for segment in segments).strip()
    normalized_expected = normalize(expected)
    normalized_recognized = normalize(recognized)
    edits = edit_distance(normalized_expected, normalized_recognized)
    cer = edits / len(normalized_expected) if normalized_expected else 1.0

    failures: list[dict[str, object]] = []
    if not normalized_recognized:
        failures.append({"reason": "ASR 未辨識出任何文字"})
    if cer > arguments.absolute_cer_limit:
        failures.append(
            {
                "reason": "CER 超過絕對上限",
                "actual": cer,
                "limit": arguments.absolute_cer_limit,
            }
        )

    baseline_cer = None
    regression_limit = None
    if arguments.baseline_report:
        baseline = json.loads(arguments.baseline_report.read_text(encoding="utf-8"))
        baseline_cer = float(baseline["metrics"]["cer"])
        regression_limit = baseline_cer + arguments.regression_tolerance
        if cer > regression_limit:
            failures.append(
                {
                    "reason": "CER 相對正式 baseline 退化",
                    "actual": cer,
                    "limit": regression_limit,
                    "baseline": baseline_cer,
                }
            )

    report = {
        "schemaVersion": 1,
        "status": "passed" if not failures else "failed",
        "model": {"repository": MODEL_REPOSITORY, "revision": MODEL_REVISION},
        "audio": str(arguments.audio),
        "language": information.language,
        "languageProbability": information.language_probability,
        "expected": expected,
        "recognized": recognized,
        "normalizedExpected": normalized_expected,
        "normalizedRecognized": normalized_recognized,
        "metrics": {
            "characters": len(normalized_expected),
            "editDistance": edits,
            "cer": cer,
            "absoluteCerLimit": arguments.absolute_cer_limit,
            "baselineCer": baseline_cer,
            "regressionLimit": regression_limit,
        },
        "failures": failures,
    }
    arguments.output.parent.mkdir(parents=True, exist_ok=True)
    arguments.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(main())
