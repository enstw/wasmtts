#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "onnx==1.22.0",
#   "onnxruntime==1.28.0",
# ]
# ///

"""從 Kokoro FP32 ONNX 產生保守的 selective INT8 模型。"""

from __future__ import annotations

import argparse
from collections import Counter
import heapq
from pathlib import Path

import onnx
from onnxruntime.quantization import QuantType, quantize_dynamic


QUANTIZABLE_OPS = ("MatMul", "Gemm", "LSTM")
PROTECTED_PREFIXES = ("/decoder/",)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "動態量化 Kokoro 的文字編碼與預測路徑；decoder、vocoder、STFT "
            "及所有卷積維持 FP32。"
        )
    )
    parser.add_argument("input", type=Path, help="上游 FP32 model.onnx")
    parser.add_argument("output", type=Path, help="輸出的 selective INT8 ONNX")
    parser.add_argument(
        "--force",
        action="store_true",
        help="允許覆寫既有輸出檔",
    )
    return parser.parse_args()


def tensor_bytes(tensor: onnx.TensorProto) -> int:
    if tensor.raw_data:
        return len(tensor.raw_data)
    element_size = {
        onnx.TensorProto.FLOAT: 4,
        onnx.TensorProto.FLOAT16: 2,
        onnx.TensorProto.DOUBLE: 8,
        onnx.TensorProto.INT64: 8,
        onnx.TensorProto.INT32: 4,
        onnx.TensorProto.INT16: 2,
        onnx.TensorProto.INT8: 1,
        onnx.TensorProto.UINT64: 8,
        onnx.TensorProto.UINT32: 4,
        onnx.TensorProto.UINT16: 2,
        onnx.TensorProto.UINT8: 1,
    }.get(tensor.data_type, 0)
    count = 1
    for dim in tensor.dims:
        count *= dim
    return count * element_size


def select_nodes(model: onnx.ModelProto) -> tuple[list[str], int]:
    initializers = {tensor.name: tensor for tensor in model.graph.initializer}
    selected = [
        node
        for node in model.graph.node
        if node.name
        and node.op_type in QUANTIZABLE_OPS
        and not node.name.startswith(PROTECTED_PREFIXES)
    ]

    weight_names = {
        input_name
        for node in selected
        for input_name in node.input
        if input_name in initializers
    }
    weight_bytes = sum(tensor_bytes(initializers[name]) for name in weight_names)
    return [node.name for node in selected], weight_bytes


def count_quantized_ops(path: Path) -> Counter[str]:
    model = onnx.load(path, load_external_data=False)
    interesting = {
        "DynamicQuantizeLinear",
        "DynamicQuantizeLSTM",
        "MatMulInteger",
        "QLinearMatMul",
    }
    return Counter(node.op_type for node in model.graph.node if node.op_type in interesting)


def nested_graphs(node: onnx.NodeProto) -> list[onnx.GraphProto]:
    graphs: list[onnx.GraphProto] = []
    for attribute in node.attribute:
        if attribute.type == onnx.AttributeProto.GRAPH:
            graphs.append(attribute.g)
        elif attribute.type == onnx.AttributeProto.GRAPHS:
            graphs.extend(attribute.graphs)
    return graphs


def external_inputs(graph: onnx.GraphProto) -> set[str]:
    local_names = {value.name for value in graph.input}
    local_names.update(tensor.name for tensor in graph.initializer)
    local_names.update(
        output_name
        for node in graph.node
        for output_name in node.output
        if output_name
    )

    used_names = {
        input_name
        for node in graph.node
        for input_name in node.input
        if input_name
    }
    for node in graph.node:
        for child_graph in nested_graphs(node):
            used_names.update(external_inputs(child_graph))
    return used_names - local_names


def sort_graph(graph: onnx.GraphProto) -> None:
    """修正量化器忽略 control-flow implicit input 所造成的節點順序。"""

    for node in graph.node:
        for child_graph in nested_graphs(node):
            sort_graph(child_graph)

    nodes = list(graph.node)
    producer = {
        output_name: index
        for index, node in enumerate(nodes)
        for output_name in node.output
        if output_name
    }
    successors = [set() for _ in nodes]
    indegrees = [0] * len(nodes)

    for consumer_index, node in enumerate(nodes):
        dependencies = {name for name in node.input if name}
        for child_graph in nested_graphs(node):
            dependencies.update(external_inputs(child_graph))
        for dependency in dependencies:
            producer_index = producer.get(dependency)
            if producer_index is None or producer_index == consumer_index:
                continue
            if consumer_index not in successors[producer_index]:
                successors[producer_index].add(consumer_index)
                indegrees[consumer_index] += 1

    ready = [index for index, degree in enumerate(indegrees) if degree == 0]
    heapq.heapify(ready)
    sorted_indexes: list[int] = []
    while ready:
        index = heapq.heappop(ready)
        sorted_indexes.append(index)
        for successor in sorted(successors[index]):
            indegrees[successor] -= 1
            if indegrees[successor] == 0:
                heapq.heappush(ready, successor)

    if len(sorted_indexes) != len(nodes):
        raise RuntimeError(f"graph {graph.name!r} 無法完成拓撲排序")
    del graph.node[:]
    graph.node.extend(nodes[index] for index in sorted_indexes)


def repair_control_flow_order(path: Path) -> None:
    model = onnx.load(path, load_external_data=False)
    sort_graph(model.graph)
    onnx.save_model(model, path)


def main() -> None:
    args = parse_args()
    if not args.input.is_file():
        raise SystemExit(f"找不到輸入模型：{args.input}")
    if args.output.exists() and not args.force:
        raise SystemExit(f"輸出已存在：{args.output}；需要覆寫時加上 --force")

    model = onnx.load(args.input, load_external_data=False)
    node_names, weight_bytes = select_nodes(model)
    if not node_names:
        raise SystemExit("沒有找到可量化節點，請確認輸入是 Kokoro FP32 graph")

    args.output.parent.mkdir(parents=True, exist_ok=True)
    print(f"選取 {len(node_names)} 個 MatMul/Gemm/LSTM 節點")
    print(f"相關 FP32 initializer：約 {weight_bytes / 1024 / 1024:.1f} MiB")
    print("保護範圍：/decoder/ 與全部 Conv/ConvTranspose")

    quantize_dynamic(
        model_input=args.input,
        model_output=args.output,
        op_types_to_quantize=list(QUANTIZABLE_OPS),
        nodes_to_quantize=node_names,
        per_channel=False,
        reduce_range=False,
        weight_type=QuantType.QInt8,
        use_external_data_format=False,
        extra_options={"MatMulConstBOnly": True},
    )

    repair_control_flow_order(args.output)
    onnx.checker.check_model(str(args.output))
    input_mib = args.input.stat().st_size / 1024 / 1024
    output_mib = args.output.stat().st_size / 1024 / 1024
    print(f"完成：{input_mib:.1f} MiB -> {output_mib:.1f} MiB")
    print(f"量化節點統計：{dict(count_quantized_ops(args.output))}")


if __name__ == "__main__":
    main()
