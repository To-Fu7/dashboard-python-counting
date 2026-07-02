# Triton Model Repository

Direktori ini adalah **model repository** untuk NVIDIA Triton Inference Server,
di-mount ke container `triton` sebagai `/models`.

## Layout

```
models/
  yolo26m_640/            # <weights-stem>_<imgsz>
    config.pbtxt          # backend config (onnxruntime default, tensorrt_plan setelah build)
    metadata.json         # imgsz, e2e flag, classes (ditulis oleh tools/export_model.py)
    1/
      model.onnx          # artifact kanonik, di-commit ke git
      model.plan          # TensorRT engine, dibuild ON-DEVICE, di-gitignore
```

## Workflow

1. **Export ONNX** (sekali, di mana saja — satu-satunya langkah yang butuh ultralytics/torch):
   ```bash
   docker build -f tools/Dockerfile.export -t yolo-export tools/
   docker run --rm -v "$(pwd):/work" yolo-export \
     --weights /work/yolo26m.pt --imgsz 640 --out-dir /work/models
   ```
2. **Build TensorRT engine** (di device target, tiap kali ganti host/GPU/versi Triton):
   ```bash
   docker compose --profile build run --rm triton-model-builder
   ```
   Mode CPU: skip langkah ini (`TRT_BACKEND=onnx`), Triton pakai onnxruntime.
3. **Start Triton**: `docker compose up -d triton`, cek `curl localhost:8000/v2/health/ready`.

## Matriks kompatibilitas JetPack ↔ Triton image

Engine TensorRT TIDAK portable antar GPU / versi TensorRT. Image `-igpu` harus
cocok dengan JetPack di device.

| Device            | JetPack | Triton image tag                          |
|-------------------|---------|-------------------------------------------|
| Jetson Orin       | 6.x     | `nvcr.io/nvidia/tritonserver:24.08-py3-igpu` (atau lebih baru yang match JP6) |
| Jetson Orin       | 5.1.x   | `nvcr.io/nvidia/tritonserver:23.12-py3-igpu` |
| Server/PC dGPU    | —       | `nvcr.io/nvidia/tritonserver:24.08-py3`    |
| CPU only          | —       | `nvcr.io/nvidia/tritonserver:24.08-py3` (onnxruntime CPU backend) |

Tag image bisa diubah dari dashboard (Settings → Triton). Setelah ganti tag atau
pindah device: jalankan ulang model-builder (`FORCE_BUILD=1`).

## Catatan format output model

- Export default = end-to-end (NMS embedded): output `[batch, max_det, 6]` =
  `x1,y1,x2,y2,conf,cls` dalam koordinat piksel input model (letterboxed).
- Kalau konversi NMS ke TRT gagal di Jetson lama, export ulang dengan `--no-nms`;
  client otomatis mendeteksi output raw `[batch, 4+nc, anchors]` dan menjalankan
  NMS numpy sendiri.
