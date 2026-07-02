#!/usr/bin/env bash
# Build TensorRT engines (model.plan) for every ONNX model in the repository,
# on the device that will run Triton. Runs inside the tritonserver image so the
# TensorRT version always matches the server (engines are NOT portable across
# GPUs or TRT versions).
#
# Usage (via compose):  docker compose --profile build run --rm triton-model-builder
# Env:
#   MODEL_REPO   model repository root (default /models)
#   FORCE_BUILD  set to 1 to rebuild even if model.plan is newer than model.onnx
#   TRT_BACKEND  set to "onnx" to skip TRT and keep onnxruntime configs (cpu mode)
set -euo pipefail

MODEL_REPO="${MODEL_REPO:-/models}"
FORCE_BUILD="${FORCE_BUILD:-0}"
TRT_BACKEND="${TRT_BACKEND:-trt}"

if [ "$TRT_BACKEND" = "onnx" ]; then
    echo "[build_engine] TRT_BACKEND=onnx — leaving onnxruntime configs as-is (cpu mode)."
    exit 0
fi

if ! command -v trtexec >/dev/null 2>&1; then
    # tritonserver images ship trtexec under /usr/src/tensorrt/bin
    export PATH="$PATH:/usr/src/tensorrt/bin"
fi

shopt -s nullglob
built_any=0
for onnx in "$MODEL_REPO"/*/1/model.onnx; do
    model_dir="$(dirname "$(dirname "$onnx")")"
    name="$(basename "$model_dir")"
    plan="$(dirname "$onnx")/model.plan"

    if [ "$FORCE_BUILD" != "1" ] && [ -f "$plan" ] && [ "$plan" -nt "$onnx" ]; then
        echo "[build_engine] $name: model.plan up to date, skipping (FORCE_BUILD=1 to rebuild)"
        continue
    fi

    echo "[build_engine] $name: building TensorRT engine (FP16) — this can take minutes..."
    trtexec --onnx="$onnx" --saveEngine="$plan" --fp16 \
        --minShapes=images:1x3x640x640 --optShapes=images:4x3x640x640 --maxShapes=images:8x3x640x640 \
        || { echo "[build_engine] $name: FAILED — keeping onnxruntime config"; continue; }

    cat > "$model_dir/config.pbtxt" <<EOF
name: "$name"
platform: "tensorrt_plan"
max_batch_size: 8
dynamic_batching {
  max_queue_delay_microseconds: 5000
}
instance_group [
  { count: 1, kind: KIND_GPU }
]
EOF
    built_any=1
    echo "[build_engine] $name: engine ready -> $plan"
done

echo "[build_engine] done (built_any=$built_any)"
