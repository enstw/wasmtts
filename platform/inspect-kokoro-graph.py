#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["onnx==1.18.0"]
# ///

"""Summarize expensive Kokoro operators by exported module path and weight size."""

from collections import Counter, defaultdict
from pathlib import Path
import json

import onnx


ROOT = Path(__file__).resolve().parent
MODEL = ROOT / "models/kokoro-fp32-download/onnx/model.onnx"
OUT = ROOT / "results/kokoro-graph-attribution.json"
TARGET_OPS = {"Gemm", "MatMul", "Conv", "ConvTranspose", "LSTM"}


def stage(name: str) -> str:
    """Extract the first meaningful exported PyTorch module path."""
    clean = name.strip("/")
    if not clean:
        return "(unnamed)"
    parts = clean.split("/")
    # ONNX exports commonly begin with model or an operator-scoped prefix.
    while parts and (parts[0] in {"model", "module"} or parts[0].startswith("onnx::")):
        parts.pop(0)
    return "/".join(parts[:2]) if parts else "(unnamed)"


def numel(dims) -> int:
    result = 1
    for dim in dims:
        result *= dim
    return result


def architecture_bucket(name: str) -> str:
    first = name.strip("/").split("/", 1)[0]
    if first in {"bert", "bert_encoder"}:
        return "bert"
    if first == "text_encoder":
        return "text_encoder"
    if first == "decoder":
        return "decoder"
    if first in {"F0.0", "F0.1", "F0.2", "F0_proj"}:
        return "prosody_f0"
    if first in {"N.0", "N.1", "N.2", "N_proj"}:
        return "prosody_noise"
    if first in {"lstm", "shared"}:
        return "duration_lstm"
    if first == "duration_proj":
        return "duration_projection"
    return first or "(unnamed)"


def main() -> None:
    model = onnx.load(MODEL, load_external_data=False)
    initializers = {item.name: item for item in model.graph.initializer}
    groups = defaultdict(lambda: {"nodes": Counter(), "weight_elements": Counter(), "examples": []})
    overall_nodes = Counter()
    overall_weights = Counter()
    buckets = defaultdict(lambda: {"nodes": Counter(), "weight_elements": Counter()})

    for node in model.graph.node:
        if node.op_type not in TARGET_OPS:
            continue
        group = stage(node.name)
        weight_elements = sum(
            numel(initializers[name].dims) for name in node.input[1:] if name in initializers
        )
        groups[group]["nodes"][node.op_type] += 1
        groups[group]["weight_elements"][node.op_type] += weight_elements
        overall_nodes[node.op_type] += 1
        overall_weights[node.op_type] += weight_elements
        bucket = architecture_bucket(node.name)
        buckets[bucket]["nodes"][node.op_type] += 1
        buckets[bucket]["weight_elements"][node.op_type] += weight_elements
        if len(groups[group]["examples"]) < 3:
            groups[group]["examples"].append(
                {"name": node.name, "op": node.op_type, "weight_elements": weight_elements}
            )

    rows = []
    for name, data in groups.items():
        rows.append(
            {
                "stage": name,
                "nodes": dict(data["nodes"]),
                "weight_elements": dict(data["weight_elements"]),
                "total_weight_elements": sum(data["weight_elements"].values()),
                "examples": data["examples"],
            }
        )
    rows.sort(key=lambda row: row["total_weight_elements"], reverse=True)

    report = {
        "model": str(MODEL.relative_to(ROOT.parent)),
        "note": "Weight elements indicate parameter volume, not runtime MACs; dynamic sequence shapes prevent static runtime attribution.",
        "overall_nodes": dict(overall_nodes),
        "overall_weight_elements": dict(overall_weights),
        "architecture_buckets": sorted(
            (
                {
                    "bucket": name,
                    "nodes": dict(data["nodes"]),
                    "weight_elements": dict(data["weight_elements"]),
                    "total_weight_elements": sum(data["weight_elements"].values()),
                }
                for name, data in buckets.items()
            ),
            key=lambda row: row["total_weight_elements"],
            reverse=True,
        ),
        "stages": rows,
    }
    OUT.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
