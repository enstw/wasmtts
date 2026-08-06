#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy==2.3.2", "onnx==1.18.0"]
# ///

"""Generate single-operator ONNX models for mapping ORT Web WASM profile IDs."""

from pathlib import Path

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper


OUT = Path(__file__).parent / "models" / "ort-operator-probes"
RNG = np.random.default_rng(7)


def tensor(name: str, shape: tuple[int, ...], scale: float = 0.02):
    value = (RNG.standard_normal(shape) * scale).astype(np.float32)
    return numpy_helper.from_array(value, name)


def save(name: str, nodes, inputs, outputs, initializers=()):
    graph = helper.make_graph(nodes, name, inputs, outputs, list(initializers))
    model = helper.make_model(
        graph,
        opset_imports=[helper.make_opsetid("", 17)],
        producer_name="wasmtts-operator-probe",
    )
    onnx.checker.check_model(model)
    OUT.mkdir(parents=True, exist_ok=True)
    onnx.save(model, OUT / f"{name}.onnx")


def scalar(name: str, value, dtype):
    return numpy_helper.from_array(np.asarray(value, dtype=dtype), name)


def main():
    f = TensorProto.FLOAT
    save(
        "matmul",
        [helper.make_node("MatMul", ["X", "W"], ["Y"])],
        [helper.make_tensor_value_info("X", f, [256, 256])],
        [helper.make_tensor_value_info("Y", f, [256, 256])],
        [tensor("W", (256, 256))],
    )
    save(
        "gemm",
        [helper.make_node("Gemm", ["X", "W", "B"], ["Y"])],
        [helper.make_tensor_value_info("X", f, [256, 256])],
        [helper.make_tensor_value_info("Y", f, [256, 256])],
        [tensor("W", (256, 256)), tensor("B", (256,))],
    )
    save(
        "conv",
        [helper.make_node("Conv", ["X", "W", "B"], ["Y"], pads=[1, 1], strides=[1])],
        [helper.make_tensor_value_info("X", f, [1, 128, 512])],
        [helper.make_tensor_value_info("Y", f, [1, 128, 512])],
        [tensor("W", (128, 128, 3)), tensor("B", (128,))],
    )

    # Matched audio-rate residual-convolution probes. The quantized graph keeps
    # float32 boundaries so its timing includes deployable Q/DQ overhead.
    audio_weight = (RNG.standard_normal((128, 128, 3)) * 0.02).astype(np.float32)
    weight_scale = np.float32(0.0005)
    quant_weight = np.clip(np.rint(audio_weight / weight_scale), -127, 127).astype(np.int8)
    dequant_weight = quant_weight.astype(np.float32) * weight_scale
    audio_input = [helper.make_tensor_value_info("X", f, [1, 128, 4096])]
    audio_output = [helper.make_tensor_value_info("Y", f, [1, 128, 4096])]
    save(
        "conv_audio_fp32",
        [helper.make_node("Conv", ["X", "W"], ["Y"], pads=[1, 1], strides=[1])],
        audio_input,
        audio_output,
        [numpy_helper.from_array(dequant_weight, "W")],
    )
    save(
        "qlinearconv_audio_int8",
        [
            helper.make_node("QuantizeLinear", ["X", "x_scale", "x_zero"], ["Xq"]),
            helper.make_node(
                "QLinearConv",
                ["Xq", "x_scale", "x_zero", "Wq", "w_scale", "w_zero", "y_scale", "y_zero"],
                ["Yq"],
                pads=[1, 1],
                strides=[1],
            ),
            helper.make_node("DequantizeLinear", ["Yq", "y_scale", "y_zero"], ["Y"]),
        ],
        audio_input,
        audio_output,
        [
            scalar("x_scale", 0.004, np.float32),
            scalar("x_zero", 128, np.uint8),
            numpy_helper.from_array(quant_weight, "Wq"),
            scalar("w_scale", weight_scale, np.float32),
            scalar("w_zero", 0, np.int8),
            scalar("y_scale", 0.004, np.float32),
            scalar("y_zero", 128, np.uint8),
        ],
    )
    save(
        "convtranspose",
        [helper.make_node("ConvTranspose", ["X", "W", "B"], ["Y"], pads=[1, 1], strides=[1])],
        [helper.make_tensor_value_info("X", f, [1, 128, 512])],
        [helper.make_tensor_value_info("Y", f, [1, 128, 512])],
        [tensor("W", (128, 128, 3)), tensor("B", (128,))],
    )
    save(
        "instancenorm",
        [helper.make_node("InstanceNormalization", ["X", "S", "B"], ["Y"], epsilon=1e-5)],
        [helper.make_tensor_value_info("X", f, [1, 256, 1024])],
        [helper.make_tensor_value_info("Y", f, [1, 256, 1024])],
        [numpy_helper.from_array(np.ones(256, np.float32), "S"), tensor("B", (256,))],
    )
    save(
        "layernorm",
        [helper.make_node("LayerNormalization", ["X", "S", "B"], ["Y"], axis=-1, epsilon=1e-5)],
        [helper.make_tensor_value_info("X", f, [1, 1024, 256])],
        [helper.make_tensor_value_info("Y", f, [1, 1024, 256])],
        [numpy_helper.from_array(np.ones(256, np.float32), "S"), tensor("B", (256,))],
    )
    save(
        "lstm",
        [helper.make_node("LSTM", ["X", "W", "R", "B"], ["Y"], hidden_size=256)],
        [helper.make_tensor_value_info("X", f, [128, 1, 256])],
        [helper.make_tensor_value_info("Y", f, [128, 1, 1, 256])],
        [tensor("W", (1, 1024, 256)), tensor("R", (1, 1024, 256)), tensor("B", (1, 2048))],
    )


if __name__ == "__main__":
    main()
