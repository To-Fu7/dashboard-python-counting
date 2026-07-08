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
    meta="$model_dir/metadata.json"

    if [ "$FORCE_BUILD" != "1" ] && [ -f "$plan" ] && [ "$plan" -nt "$onnx" ]; then
        echo "[build_engine] $name: model.plan up to date, skipping (FORCE_BUILD=1 to rebuild)"
        continue
    fi

    echo "[build_engine] $name: building TensorRT engine (FP16) — this can take minutes..."

    # export_model.py writes metadata.json (imgsz, classes, ...) for every YOLO
    # export — its imgsz drives the dynamic-batch shape profile below, so a
    # face_1280 model builds against a 1280x1280 profile, not a hardcoded 640.
    # Models with NO metadata.json (e.g. a manually-placed embedding ONNX like
    # arcface_112, which has a fixed batch=1 input) get no shape profile at
    # all — trtexec rejects --min/opt/maxShapes on a network with no dynamic
    # input axes, so passing one (right numbers or not) always fails there;
    # they're expected to fall through to the "FAILED — keeping onnxruntime
    # config" branch, which is a working fallback, not a bug.
    shape_args=()
    if [ -f "$meta" ]; then
        imgsz="$(grep -o '"imgsz"[[:space:]]*:[[:space:]]*[0-9]*' "$meta" | grep -o '[0-9]*$')"
        imgsz="${imgsz:-640}"
        shape_args=(--minShapes="images:1x3x${imgsz}x${imgsz}" --optShapes="images:4x3x${imgsz}x${imgsz}" --maxShapes="images:8x3x${imgsz}x${imgsz}")
    fi

    trtexec --onnx="$onnx" --saveEngine="$plan" --fp16 "${shape_args[@]}" \
        || { echo "[build_engine] $name: FAILED — keeping onnxruntime config"; continue; }

    # max_batch_size must match what the ONNX graph actually supports: YOLO
    # exports (metadata.json present) always support dynamic batching (8);
    # anything else keeps whatever its own config.pbtxt already declared
    # (e.g. 0 for arcface_112's fixed-batch input) instead of clobbering it.
    if [ -f "$meta" ]; then
        max_batch=8
    else
        max_batch="$(grep -o 'max_batch_size:[[:space:]]*[0-9]*' "$model_dir/config.pbtxt" 2>/dev/null | grep -o '[0-9]*$')"
        max_batch="${max_batch:-8}"
    fi

    batching_block=""
    if [ "$max_batch" != "0" ]; then
        batching_block=$'dynamic_batching {\n  max_queue_delay_microseconds: 5000\n}'
    fi

    cat > "$model_dir/config.pbtxt" <<EOF
name: "$name"
platform: "tensorrt_plan"
max_batch_size: $max_batch
$batching_block
instance_group [
  { count: 1, kind: KIND_GPU }
]
EOF
    built_any=1
    echo "[build_engine] $name: engine ready -> $plan"
done

echo "[build_engine] done (built_any=$built_any)"
