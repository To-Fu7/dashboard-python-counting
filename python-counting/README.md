# Person Counting Service (Triton Edition)

Layanan hitung orang (line-crossing / zone) per kamera. Sejak migrasi Triton,
inference YOLO berjalan di **satu NVIDIA Triton Inference Server per host** dan
setiap container kamera hanyalah thin client (tanpa torch/CUDA) — RAM per
kamera turun dari beberapa GB menjadi ratusan MB.

## Arsitektur

```
                       ┌────────────────────────┐
 RTSP cam 1 ──► client │                        │
 RTSP cam 2 ──► client │  Triton (GPU/CPU)      │  model repo: ./models
 RTSP cam N ──► client │  gRPC :8001 HTTP :8000 │  (ONNX commit, .plan on-device)
                       └────────────────────────┘
      │
      └─► ByteTrack (lokal) ─► counting ─► PostgreSQL + MQTT + MJPEG :8090
```

Struktur kode:

| Path | Isi |
|---|---|
| `main.py` | Orchestrator: capture loop, degraded mode saat Triton down |
| `counting_config.py` | Parsing env (semua env lama + `TRITON_URL`, `TRITON_MODEL`) |
| `counting.py` | State machine line-crossing/zone (logic legacy, verbatim) |
| `lifecycle.py` | Restore counts, midnight reset, hourly resample |
| `inference/` | Triton gRPC client, letterbox preprocessing, decode+NMS |
| `tracking/` | ByteTrack vendored dari Ultralytics 8.3.239 (numpy/lapx, torch-free) |
| `outputs/` | DB worker async, MQTT, MJPEG server, bbox writer |
| `tools/` | Export ONNX (`export_model.py`) & build TRT engine (`build_engine.sh`) |
| `models/` | Triton model repository (lihat `models/README.md`) |
| `legacy/` | main.py + dockerfile lama (pre-Triton), untuk rollback |
| `tests/` | Parity tests vs ultralytics + e2e smoke |

## Setup

1. **Export model ke ONNX** (sekali; satu-satunya langkah yang butuh ultralytics):
   ```bash
   docker build -f tools/Dockerfile.export -t yolo-export tools/
   docker run --rm -v "$(pwd):/work" yolo-export \
     --weights /work/yolo26m.pt --imgsz 640 --out-dir /work/models
   ```
2. **Build TensorRT engine di device** (skip untuk mode CPU):
   ```bash
   docker compose --profile build run --rm triton-model-builder
   ```
3. **Start Triton + kamera**:
   ```bash
   docker compose up -d triton
   curl localhost:8000/v2/health/ready   # harus 200
   docker compose up -d
   ```

Semua langkah di atas juga bisa dari dashboard (card "Triton Inference Server").

## Env per kamera (`.env_<code>`)

Baru: `TRITON_MODEL` (mis. `yolo26m_640`), `YOLO_IOU`. `TRITON_URL` di-inject
compose (`triton:8001`).
Deprecated (di-warn lalu diabaikan): `YOLO_MODEL`, `YOLO_IMGSZ`, `ENABLE_NVDEC`,
`YOLO_DEVICE`. Env lama tetap jalan — `TRITON_MODEL` diturunkan otomatis dari
`YOLO_MODEL` (`yolo26m.pt` → `yolo26m_640`).

## Debug lokal tanpa Docker

```bash
pip install -r requirements.txt
FALLBACK_VIDEO=1.mp4 DEBUG_MODE=true python main.py   # butuh Triton reachable di TRITON_URL
```

Parity tests (butuh ultralytics+torch, hanya untuk dev):
```bash
python tests/test_parity.py     # letterbox/NMS/tracker vs ultralytics
python tests/test_e2e_smoke.py  # loop penuh di 1.mp4 tanpa Triton
```

## Perilaku saat Triton down

Container kamera TIDAK crash: capture tetap hidup, MJPEG menampilkan banner
"INFERENCE UNAVAILABLE", reconnect dengan backoff 1s→30s, dan tracker di-reset
saat tersambung lagi (mencegah phantom crossing dari state Kalman basi).

## Database

Tabel: `person_inout` (id, device_id, total_in, total_out, data, created_at)
dan `inout_resample` (device_id, hour_start unique, interval_in/out). Tidak
berubah dari versi legacy.
