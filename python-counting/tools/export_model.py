"""Export a YOLO .pt checkpoint to ONNX for the Triton model repository.

This is the ONLY place ultralytics/torch is needed. Run it inside the export
container (see Dockerfile.export) or any environment with ultralytics installed:

    python export_model.py --weights yolo26m.pt --imgsz 640 --out-dir ../models

Produces:
    models/<name>_<imgsz>/1/model.onnx
    models/<name>_<imgsz>/metadata.json     (imgsz, e2e flag, classes)
    models/<name>_<imgsz>/config.pbtxt      (onnxruntime CPU config; the
                                             model-builder rewrites it for TensorRT)

YOLO26 models are natively end-to-end (NMS-free). For YOLO11 and older we export
with nms=True so NMS is embedded in the graph and the client never needs it.
Export conf is set low (0.01) so the client-side YOLO_CONFIDENCE filter stays
the single source of truth, and iou matches main.py's tracker call (0.3).
"""

import argparse
import json
import shutil
from pathlib import Path


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--weights', required=True, help='Path to .pt weights (e.g. yolo26m.pt)')
    ap.add_argument('--imgsz', type=int, default=640)
    ap.add_argument('--out-dir', default='../models', help='Triton model repository root')
    ap.add_argument('--name', default=None, help='Model repo name (default: <stem>_<imgsz>)')
    ap.add_argument('--iou', type=float, default=0.3, help='NMS IoU baked into e2e export (matches main.py iou=0.3)')
    ap.add_argument('--conf', type=float, default=0.01, help='Min conf baked into e2e export (keep low; client filters)')
    ap.add_argument('--max-det', type=int, default=300)
    ap.add_argument('--no-nms', action='store_true', help='Export raw head output (client does NMS)')
    args = ap.parse_args()

    from ultralytics import YOLO

    weights = Path(args.weights)
    name = args.name or f"{weights.stem}_{args.imgsz}"
    model_dir = Path(args.out_dir) / name
    version_dir = model_dir / '1'
    version_dir.mkdir(parents=True, exist_ok=True)

    model = YOLO(str(weights))
    is_e2e = getattr(model.model, 'end2end', False)
    use_nms = not args.no_nms

    print(f"Exporting {weights} -> {version_dir / 'model.onnx'} (e2e={is_e2e}, nms={use_nms})")
    onnx_path = model.export(
        format='onnx',
        imgsz=args.imgsz,
        nms=use_nms,
        conf=args.conf,
        iou=args.iou,
        max_det=args.max_det,
        simplify=True,
        dynamic=True,    # dynamic batch axis: required for Triton dynamic batching (max_batch_size 8)
    )
    shutil.move(onnx_path, version_dir / 'model.onnx')

    metadata = {
        'source_weights': weights.name,
        'imgsz': args.imgsz,
        'end_to_end': is_e2e or use_nms,   # output is [1, max_det, 6] xyxy+conf+cls
        'max_det': args.max_det,
        'export_conf': args.conf,
        'export_iou': args.iou,
        'classes': model.names,
    }
    (model_dir / 'metadata.json').write_text(json.dumps(metadata, indent=2))

    # Default config: onnxruntime CPU. build_engine.sh rewrites this to
    # tensorrt_plan after building model.plan on the target device.
    config = f'''name: "{name}"
platform: "onnxruntime_onnx"
max_batch_size: 8
dynamic_batching {{
  max_queue_delay_microseconds: 5000
}}
instance_group [
  {{ count: 1, kind: KIND_CPU }}
]
'''
    (model_dir / 'config.pbtxt').write_text(config)
    print(f"Done. Model repository entry: {model_dir}")
    print("Run tools/build_engine.sh on the target device to build a TensorRT plan (GPU modes).")


if __name__ == '__main__':
    main()
