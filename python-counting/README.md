# Person Counting Service (Triton Edition)

Layanan multi-deteksi per kamera: person counting (line-crossing / zone), APD,
fire/smoke, dan face recognition. Inference berjalan di satu NVIDIA Triton
Inference Server per host; container ini hanyalah thin client (tanpa torch/CUDA).

> **Dokumentasi lengkap** (arsitektur, setup DB, setup semua model termasuk
> face, MQTT, env reference, troubleshooting) ada di
> [README.md root repo](../README.md). Model repository Triton dijelaskan di
> [models/README.md](models/README.md).

## Quick start

```bash
# export model → build engine → start (detail di README root)
docker build -f tools/Dockerfile.export -t yolo-export tools/
docker run --rm -v "$(pwd):/work" yolo-export --weights /work/yolo26m.pt --imgsz 640 --out-dir /work/models
docker compose --profile build run --rm triton-model-builder
docker compose up -d triton && curl localhost:8000/v2/health/ready
docker compose up -d
```

## Debug lokal tanpa Docker

```bash
pip install -r requirements.txt
FALLBACK_VIDEO=1.mp4 DEBUG_MODE=true python main.py
```

`DEBUG_MODE=true` = semua operasi DB/MQTT no-op (log saja).

## Tests

```bash
python tests/test_parity.py            # vs ultralytics (butuh torch, dev only)
python tests/test_image_utils.py
python tests/test_detection_events.py  # dedup APD, cooldown fire/smoke, topic MQTT
python tests/test_hourly_aggregate.py
python tests/test_face_detection.py
python tests/test_e2e_smoke.py         # loop penuh 150 frame di 1.mp4
```
