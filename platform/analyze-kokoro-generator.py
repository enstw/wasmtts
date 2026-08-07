#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["onnx==1.18.0"]
# ///

"""Calculate Kokoro generator MACs from ONNX weights and measured lengths."""

from collections import defaultdict
import json
from pathlib import Path

import onnx


ROOT = Path(__file__).resolve().parent
MODEL = ROOT / "models/kokoro-fp32-download/onnx/model.onnx"
OUT = ROOT / "results/kokoro-generator-macs.json"

# Captured by generate-kokoro-shape-probe.py for the 13.175-second baseline.
LENGTHS = {
    "ups.0": 10_540,
    "stage.0": 10_540,
    "ups.1": 63_240,
    "stage.1": 63_240,
    "stft_frames": 63_237,
    "istft_frames": 63_240,
}


def attr(node, name, default):
    for item in node.attribute:
        if item.name == name:
            return onnx.helper.get_attribute_value(item)
    return default


def region(name: str) -> tuple[str, int]:
    if "/ups.0/" in name:
        return "ups.0", LENGTHS["ups.0"]
    if "/ups.1/" in name:
        return "ups.1", LENGTHS["ups.1"]
    if any(token in name for token in ("/resblocks.0/", "/resblocks.1/", "/resblocks.2/",
                                        "/noise_convs.0/", "/noise_res.0/")):
        return "stage.0", LENGTHS["stage.0"]
    if any(token in name for token in ("/resblocks.3/", "/resblocks.4/", "/resblocks.5/",
                                        "/noise_convs.1/", "/noise_res.1/", "/conv_post/")):
        return "stage.1", LENGTHS["stage.1"]
    if name.rsplit("/", 1)[-1] in {"Conv", "Conv_1", "ConvTranspose", "ConvTranspose_1"}:
        # Two analysis Convs produce frequency frames; two synthesis
        # ConvTransposes consume frames. MACs depend on those frame counts,
        # not on the final waveform length.
        frames = LENGTHS["stft_frames"] if name.rsplit("/", 1)[-1] in {"Conv", "Conv_1"} else LENGTHS["istft_frames"]
        return "stft_istft", frames
    raise ValueError(f"unmapped generator convolution: {name}")


def main() -> None:
    model = onnx.load(MODEL, load_external_data=False)
    initializers = {item.name: item for item in model.graph.initializer}
    rows = []
    totals = defaultdict(int)

    for node in model.graph.node:
        if node.op_type not in {"Conv", "ConvTranspose"} or not node.name.startswith(
            "/decoder/generator/"
        ):
            continue
        weight = initializers[node.input[1]]
        dims = list(weight.dims)
        group = int(attr(node, "group", 1))
        bucket, output_length = region(node.name)
        if node.op_type == "Conv":
            macs = output_length * dims[0] * (dims[1] // group) * dims[2]
        elif bucket == "stft_istft":
            macs = output_length * dims[0] * dims[1] * dims[2] // group
        else:
            # ConvTranspose weights are [input_channels, output_channels/group, kernel].
            input_length = 1_054 if bucket == "ups.0" else 10_540
            macs = input_length * dims[0] * dims[1] * dims[2] // group
        totals[bucket] += macs
        rows.append(
            {
                "name": node.name,
                "op": node.op_type,
                "weight_shape": dims,
                "group": group,
                "runtime_length": output_length,
                "macs": macs,
            }
        )

    total = sum(totals.values())
    report = {
        "model": str(MODEL.relative_to(ROOT.parent)),
        "baseline_output_samples": 316_200,
        "baseline_output_seconds": 13.175,
        "method": "MACs = output length * output channels * input channels/group * kernel; ConvTranspose uses input length and its ONNX weight ordering.",
        "region_macs": dict(totals),
        "total_generator_macs": total,
        "nodes": rows,
    }
    OUT.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({**report, "nodes": f"{len(rows)} entries"}, indent=2))


if __name__ == "__main__":
    main()
