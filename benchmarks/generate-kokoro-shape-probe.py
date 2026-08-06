#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["onnx==1.18.0"]
# ///

"""Add one runtime-visible tensor at each Kokoro decoder subgroup boundary."""

from collections import defaultdict
from pathlib import Path
import json

import onnx
from onnx import TensorProto, helper


ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / "models/kokoro-fp32-download/onnx/model.onnx"
DESTINATION = ROOT / "models/kokoro-fp32-shape-probe.onnx"
MANIFEST = ROOT / "results/kokoro-shape-probe-manifest.json"
TARGET_OPS = {"Gemm", "MatMul", "Conv", "ConvTranspose", "LSTM"}


def subgroup(name: str) -> str | None:
    parts = name.strip("/").split("/")
    if not parts or parts[0] != "decoder":
        return None
    return "/".join(parts[:2]) if len(parts) > 1 else "decoder"


def main() -> None:
    model = onnx.load(SOURCE, load_external_data=False)
    initializers = {item.name: item for item in model.graph.initializer}
    candidates = defaultdict(list)
    for index, node in enumerate(model.graph.node):
        group = subgroup(node.name)
        if group and node.op_type in TARGET_OPS and node.output:
            candidates[group].append((index, node))

    existing_outputs = {item.name for item in model.graph.output}
    probes = []
    for group, nodes in sorted(candidates.items()):
        selected = [nodes[-1]]
        if group == "decoder/generator":
            # The four upsamplers reveal where work crosses from frame-rate to
            # audio-rate. Keep the final matrix-backed node as a boundary too.
            selected = [(index, node) for index, node in nodes if node.op_type == "ConvTranspose"]
            if nodes[-1] not in selected:
                selected.append(nodes[-1])
        for ordinal, (index, node) in enumerate(selected):
            output = node.output[0]
            if output not in existing_outputs:
                # Decoder matrix-backed operators emit floating-point activations. An
                # unknown shape is intentional: ORT supplies the concrete runtime dims.
                model.graph.output.append(helper.make_tensor_value_info(output, TensorProto.FLOAT, None))
                existing_outputs.add(output)
            probes.append({
                "group": group,
                "ordinal": ordinal,
                "node_index": index,
                "node": node.name,
                "op": node.op_type,
                "output": output,
                "matrix_backed_nodes": len(nodes),
                "initializer_dims": {
                    name: list(initializers[name].dims)
                    for name in node.input
                    if name in initializers
                },
                "attributes": {
                    attribute.name: helper.get_attribute_value(attribute)
                    for attribute in node.attribute
                },
            })

    onnx.save(model, DESTINATION)
    report = {
        "source": str(SOURCE.relative_to(ROOT.parent)),
        "model": str(DESTINATION.relative_to(ROOT.parent)),
        "strategy": "last matrix-backed node output in each decoder subgroup",
        "probes": probes,
    }
    MANIFEST.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
