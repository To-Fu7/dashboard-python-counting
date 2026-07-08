# Detection Dashboard & Python Counting

Sistem CCTV multi-deteksi: **person counting** (line-crossing / zone), **APD/PPE
violation**, **fire & smoke**, dan **face recognition (insider/intruder)** — semua
inference berjalan di **satu NVIDIA Triton Inference Server per host** (GPU),
dengan container kamera sebagai thin client CPU-only, di-manage lewat dashboard
Next.js.

> Dokumen ini adalah dokumentasi utama end-to-end. Detail per-direktori:
> [python-counting/README.md](python-counting/README.md) (service kamera),
> [python-counting/models/README.md](python-counting/models/README.md) (model repo Triton),
> desain lengkap di [docs/superpowers/specs/](docs/superpowers/specs/).

---

## 1. Arsitektur

```
                                ┌──────────────────────────────────┐
 RTSP cam 1 ─► camera container │                                  │
 RTSP cam 2 ─► camera container │   Triton Inference Server (GPU)  │   model repo: python-counting/models/
 RTSP cam N ─► camera container │   gRPC :8001  HTTP :8000         │   (ONNX di-commit, .plan dibuild on-device)
                                │   metrics :8002                  │
        │                       └──────────────────────────────────┘
        │  per frame: letterbox (numpy) ─► gRPC infer ─► decode ─► ByteTrack (lokal)
        │
        ├─► counting state machine (line-crossing / zone)
        ├─► APD per-track dedup ──────────► apd_hourly       + MQTT (topic sendiri)
        ├─► fire/smoke cooldown ──────────► firesmoke_hourly + MQTT (topic sendiri)
        ├─► face detect ► embed ► match ──► face_hourly      + MQTT (topic sendiri)
        │                                   (cache known_faces di memori, refresh 10 mnt)
        └─► PostgreSQL/TimescaleDB + MQTT + MJPEG :809x + bbox json

 Dashboard (Next.js :3000) ── manage device (.env_<code>), compose, Triton,
                              face enrollment, settings global
```

Prinsip desain:

- **GPU-first**: semua model (YOLO person, APD, fire/smoke, YOLOv8-face, ArcFace)
  di-load SEKALI di Triton. Container kamera tanpa torch/CUDA → RAM per kamera
  turun dari beberapa GB ke ratusan MB, image dari ~15 GB ke <1 GB.
- **ONNX = artifact kanonik** (di-commit ke git). TensorRT `.plan` dibuild
  **on-device** oleh `triton-model-builder` karena engine tidak portable antar
  GPU/versi TensorRT.
- **Degraded mode**: Triton down ≠ container crash. Capture tetap hidup, MJPEG
  menampilkan "INFERENCE UNAVAILABLE", reconnect backoff 1s→30s, tracker
  di-reset saat tersambung lagi (mencegah phantom crossing dari Kalman basi).
- **Hourly aggregate, bukan per-event**: deteksi APD/fire-smoke/face di-upsert
  ke satu row per (device, jam) dengan counter JSONB — bukan satu row per
  kejadian. 24 row sehari di-pregenerate di startup + tengah malam, jadi
  konsumen selalu melihat hari yang lengkap (jam yang belum lewat berisi 0).

### Struktur repo

| Path | Isi |
|---|---|
| `python-counting/main.py` | Orchestrator: capture loop, wiring semua detektor, degraded mode |
| `python-counting/counting_config.py` | Parsing semua env (`TRITON_MODEL`, `APD_*`, `FIRE_SMOKE_*`, `FACE_*`, `MQTT_*_TOPIC`, …) |
| `python-counting/counting.py` | State machine line-crossing/zone (logic legacy, verbatim) |
| `python-counting/lifecycle.py` | Restore counts, midnight reset, rotasi jam, pregenerasi tabel hourly |
| `python-counting/detection/` | `apd.py`, `firesmoke.py`, `face.py` — dedup/cooldown + tulis hourly + MQTT |
| `python-counting/inference/` | `triton_client.py` (YOLO), `triton_embed_client.py` (ArcFace), preprocessing, decode+NMS |
| `python-counting/tracking/` | ByteTrack vendored dari Ultralytics (numpy/lapx, torch-free) |
| `python-counting/outputs/` | DB worker async, `hourly_aggregate_db.py`, `face_db.py` (cache+match), MQTT, MJPEG, bbox |
| `python-counting/tools/` | `export_model.py` (pt→ONNX), `build_engine.sh` (ONNX→TRT), `Dockerfile.export` |
| `python-counting/models/` | Triton model repository (lihat README-nya) |
| `python-counting/tests/` | Parity vs ultralytics, unit tests dedup/hourly/face, e2e smoke |
| `python-counting/legacy/` | main.py + dockerfile pre-Triton, untuk rollback |
| `dashboard/` | Next.js: device manager, Triton control, face enrollment, settings |
| `docs/superpowers/` | Spec & plan design (sumber kebenaran keputusan desain) |
| `.claude/skills/ssh-prod-server/` | Cara akses server produksi 10.11.0.73 |

---

## 2. Infrastruktur & Prasyarat

| Komponen | Keterangan |
|---|---|
| Docker + Compose | Semua service jalan sebagai container di network `envisions` |
| GPU + driver NVIDIA | Untuk Triton mode `server` (dGPU) / `jetson` (igpu); mode `cpu` pakai onnxruntime |
| PostgreSQL / TimescaleDB | Container `env_services_timescaledb`; di produksi di-expose ke host di port **5435** |
| MQTT broker | Port 1883 (mis. Mosquitto), kredensial per-device di `.env_<code>` |
| Node.js 20+ | Untuk dashboard (dev: `npm run dev`, port 3000) |

### Compose services (python-counting/docker-compose.yml)

| Service | Image | Port | Peran |
|---|---|---|---|
| `triton` | `nvcr.io/nvidia/tritonserver:24.08-py3` (`-py3-igpu` untuk Jetson) | 8000 HTTP / 8001 gRPC / 8002 metrics | Inference server, mount `./models:/models` |
| `triton-model-builder` | image tritonserver yang sama, `profiles: [build]` | — | One-shot: build `.plan` dari ONNX via `trtexec`, rewrite `config.pbtxt` ke `tensorrt_plan`+`KIND_GPU` |
| `counting-<CODE>` (per kamera) | `python:3.11-slim` based | MJPEG 809x | Thin client; dibuat/dihapus otomatis oleh dashboard |

### Matriks kompatibilitas JetPack ↔ Triton image

Engine TensorRT TIDAK portable antar GPU / versi TensorRT. Setelah ganti
image tag atau pindah device, jalankan ulang model-builder (`FORCE_BUILD=1`).

| Device | JetPack | Triton image tag |
|---|---|---|
| Jetson Orin | 6.x | `nvcr.io/nvidia/tritonserver:24.08-py3-igpu` |
| Jetson Orin | 5.1.x | `nvcr.io/nvidia/tritonserver:23.12-py3-igpu` |
| Server/PC dGPU | — | `nvcr.io/nvidia/tritonserver:24.08-py3` |
| CPU only | — | `nvcr.io/nvidia/tritonserver:24.08-py3` (backend onnxruntime CPU) |

Tag image & hardware mode diubah dari dashboard (Settings → Hardware Mode / Triton).

---

## 3. Setup Database

Semua tabel dibuat oleh satu script idempotent (aman diulang kapan pun):

```bash
cd python-counting
# PG_* bisa dari .env atau environment
PG_HOST=<host> PG_PORT=5435 PG_DB=postgres PG_USER=postgres PG_PASS=<pass> python init_db.py
```

### Skema

| Tabel | Peran | Kolom kunci |
|---|---|---|
| `person_inout` | Total harian person counting (satu row per hari per device) | `id UUID PK`, `device_id`, `total_in`, `total_out`, `data JSONB`, `created_at` |
| `inout_resample` | Person counting per jam | `device_id + hour_start UNIQUE`, `interval_in/out`; **24 row per hari di-pregenerate** |
| `apd_hourly` | Agregat pelanggaran APD per jam | `device_id + hour_start UNIQUE`, `data JSONB` mis. `{"NO-Hardhat": 10, "unique_persons": 8}` |
| `firesmoke_hourly` | Agregat fire/smoke per jam | sama, `data` mis. `{"fire": 3, "smoke": 7}` |
| `face_hourly` | Agregat face per jam | sama, `data` mis. `{"Budi": 4, "intruder": 2, "unique_persons": 6}` |
| `known_faces` | Roster wajah ter-enroll | `person_name`, `embedding REAL[]` (512 float), `variant_type` (`original`, `flip`, `rotate_±12`, `crop`, `lowres`, `brightness_*`, `contrast_*`, `desaturated`, `gamma`, `blur`, `jpeg_artifact`, `occlusion_*`) — satu orang = banyak row (satu per varian augmentasi) |

### Pola hourly aggregate (Part A)

- **Pregenerasi**: saat container start dan saat ganti hari, 24 row jam
  (00:00–23:00) dibuat sekaligus via `generate_series(0,23)` +
  `ON CONFLICT DO NOTHING` — idempotent, tidak pernah menimpa count yang ada.
  `inout_resample` selalu; `apd_hourly`/`firesmoke_hourly`/`face_hourly` hanya
  jika tipe deteksinya enabled. Fitur di-enable tengah hari? Jam-jam sebelumnya
  otomatis terisi placeholder 0.
- **Increment**: tiap event menaikkan satu key JSONB via
  `jsonb_set(... COALESCE((data->>label)::int,0)+1)`. Label selalu bound
  parameter (aman dari injection — sudah diverifikasi live dengan label
  berbentuk `'); DROP TABLE...`). Write async lewat `db_queue_write`
  (fire-and-forget), tidak menambah beban per-frame.
- `unique_persons` (APD & face): naik sekali per track_id per jam, memakai
  state dedup tracker yang sudah ada.

Tabel `detection_events` lama (per-event) **sudah dihapus** — diganti penuh
oleh tabel `*_hourly`.

---

## 4. Setup dari Nol (urutan lengkap)

```bash
# 0. Clone + branch
git clone https://github.com/To-Fu7/dashboard-python-counting.git
cd dashboard-python-counting

# 1. Database (sekali)
cd python-counting && python init_db.py   # butuh PG_* env

# 2. Build image export (sekali; satu-satunya image ber-torch/ultralytics)
docker build -f tools/Dockerfile.export -t yolo-export tools/

# 3. Export model person counting ke ONNX
docker run --rm -v "$(pwd):/work" yolo-export \
  --weights /work/yolo26m.pt --imgsz 640 --out-dir /work/models

# 4. Build TensorRT engine di device (skip untuk mode CPU)
docker compose --profile build run --rm triton-model-builder

# 5. Start Triton, cek sehat
docker compose up -d triton
curl localhost:8000/v2/health/ready          # harus 200
# Windows: iwr http://localhost:8000/v2/health/ready

# 6. Dashboard
cd ../dashboard && npm install && npm run dev   # http://localhost:3000

# 7. Tambah kamera dari dashboard (Devices → Add Camera)
#    → otomatis menulis .env_<CODE>, menambah service compose, start container
```

Semua langkah Triton (start/stop/build engine/list model) juga bisa dari
dashboard (card "Triton Inference Server").

---

## 5. Detection Types

### 5.1 Person Counting (selalu aktif)

Line-crossing atau zone (eksklusif, pilih di device page). ByteTrack lokal
(vendored, parity-tested identik dengan `model.track()` ultralytics), state
machine counting legacy verbatim. Output: `person_inout` (total harian),
`inout_resample` (per jam), MQTT event per orang + interval data per 5 menit.

### 5.2 APD / PPE Violation

- **Model**: YOLO PPE detection (produksi memakai VoxDroid Construction-Site-Safety,
  MIT) → `models/apd_640/`.
- **Logika**: tracker ByteTrack sendiri; satu track_id memicu maksimal satu
  event per label pelanggaran seumur track (dedup `state.apd_alerted_tracks`).
- **Output**: increment `apd_hourly` (label + `unique_persons`), MQTT ke
  `MQTT_APD_TOPIC` dengan crop pelanggar.
- **Env**: `APD_ENABLED`, `APD_MODEL`, `APD_CONFIDENCE`, `APD_TAG`.

### 5.3 Fire & Smoke

- **Model**: YOLO fire/smoke (produksi memakai luminous0219, AGPL-3.0) →
  `models/fire_smoke_640/`.
- **Logika**: tanpa tracker; cooldown per label (`FIRE_SMOKE_COOLDOWN_MINUTES`,
  default 5 menit). Saat tidak ada penonton MJPEG, inference di-sample
  (1 fps) bukan tiap frame.
- **Output**: increment `firesmoke_hourly`, MQTT ke `MQTT_FIRESMOKE_TOPIC`
  dengan full frame.
- **Env**: `FIRE_SMOKE_ENABLED`, `FIRE_SMOKE_MODEL`, `FIRE_SMOKE_CONFIDENCE`,
  `FIRE_TAG`, `SMOKE_TAG`, `FIRE_SMOKE_COOLDOWN_MINUTES`.

Setup model APD + fire/smoke di server (sudah dilakukan di produksi):

```bash
cd ~/developer/python/dashboard-python-counting/python-counting

# download weights
curl -sL -o apd_best.pt \
  "https://raw.githubusercontent.com/VoxDroid/Construction-Site-Safety-PPE-Detection/main/Model-Training/Outputs/runs/detect/yolov8s_ppe_css_200_epochs/weights/best.pt"
curl -sL -o firesmoke_best.pt \
  "https://raw.githubusercontent.com/luminous0219/fire-and-smoke-detection-yolov8/main/weights/best.pt"

# export ONNX
docker run --rm -v "$(pwd):/work" yolo-export \
  --weights /work/apd_best.pt --imgsz 640 --name apd_640 --out-dir /work/models
docker run --rm -v "$(pwd):/work" yolo-export \
  --weights /work/firesmoke_best.pt --imgsz 640 --name fire_smoke_640 --out-dir /work/models

# build engine + reload  ← WAJIB, tanpa ini model jalan di CPU (onnxruntime)!
docker compose --profile build run --rm triton-model-builder
docker compose restart triton
curl -s -X POST localhost:8000/v2/repository/index   # semua model harus READY
```

### 5.4 Face Recognition (Insider / Intruder)

Pipeline runtime (semua inference di Triton, per-track sekali saja):

```
frame ─► [Triton: YOLOv8-face] ─► ByteTrack (instance sendiri) ─► dedup per track_id
      ─► crop wajah ─► [Triton: ArcFace] ─► embedding 512-d
      ─► cosine similarity vs cache known_faces (in-memory, refresh tiap FACE_CACHE_REFRESH_MINUTES)
      ─► similarity ≥ FACE_MATCH_THRESHOLD → label = nama orang, tag = INSIDER_TAG
      ─► di bawah threshold             → label = "intruder",  tag = INTRUDER_TAG
      ─► increment face_hourly + MQTT ke MQTT_FACE_TOPIC (crop wajah)
```

Satu track = satu verdict seumur track (bukan per frame, bukan per jam).
Dedup di-reset bersama tracker saat Triton reconnect.

**Setup model face (2 model, langkah sama seperti APD):**

1. **YOLOv8-face** (detektor, fine-tuned WIDERFACE, single class `face`;
   sumber: [akanametov/yolo-face](https://github.com/akanametov/yolo-face),
   GPL-3.0 — tersedia juga varian s/m/l dan YOLOv11-face di releases yang sama):
   ```bash
   curl -sL -o yolov8n-face.pt \
     "https://github.com/akanametov/yolo-face/releases/download/1.0.0/yolov8n-face.pt"

   docker run --rm -v "$(pwd):/work" yolo-export \
     --weights /work/yolov8n-face.pt --imgsz 640 --name face_640 --out-dir /work/models
   ```
2. **ArcFace** (embedder, output 512-d, input 112×112) — pakai `w600k_r50.onnx`
   dari paket buffalo_l InsightFace ([deepinsight/insightface](https://github.com/deepinsight/insightface),
   bobot untuk riset/non-komersial). Bukan model ultralytics, jadi TIDAK lewat
   `export_model.py` — ONNX-nya ditaruh langsung:
   ```bash
   curl -sL -o buffalo_l.zip \
     "https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_l.zip"
   unzip -o buffalo_l.zip w600k_r50.onnx

   mkdir -p models/arcface_112/1
   mv w600k_r50.onnx models/arcface_112/1/model.onnx
   cat > models/arcface_112/config.pbtxt <<'EOF'
   platform: "onnxruntime_onnx"
   max_batch_size: 0
   EOF
   # max_batch_size WAJIB 0: w600k_r50.onnx punya dimensi batch fixed [1,3,112,112],
   # nilai >0 membuat Triton gagal load ("model does not support batching").
   # (input/output tensor di-autocomplete onnxruntime; client discover via metadata)
   ```
3. Build engine + restart Triton (perintah sama seperti di atas).
4. Di **Settings dashboard** → "Face Embedding Model (ArcFace)" isi `arcface_112`
   — dipakai halaman enrollment; HARUS sama dengan `FACE_EMBED_MODEL` kamera
   (embedding enrollment & runtime harus satu vector space).
5. Di **device page** → Additional Detection → aktifkan Face Detection, pilih
   `FACE_MODEL=face_640`, `FACE_EMBED_MODEL=arcface_112`.

**Enrollment (dashboard → Face Enrollment):**

Upload satu foto wajah (idealnya sudah ter-crop rapat) + nama → server
otomatis membuat ~16 varian augmentasi lalu meng-embed tiap varian via Triton,
satu row `known_faces` per varian:

- **Geometric**: flip horizontal, rotasi kecil ±12° (lebih besar merusak
  struktur wajah), center crop 85%, low-res round-trip (simulasi wajah kecil)
- **Photometric**: brightness naik/turun, contrast naik/turun, desaturasi,
  gamma — penting untuk variasi lighting siang/malam CCTV
- **Noise/blur**: gaussian blur (pengganti motion blur), JPEG quality 25
  (simulasi artefak kompresi stream RTSP)
- **Occlusion**: patch hitam di bawah wajah (mirip masker) dan di area mata
  (mirip topi/kacamata)

Yang sengaja TIDAK dipakai: 3DMM pose synthesis (butuh pipeline 3D terpisah)
dan Mixup/CutMix (merusak identitas untuk face recognition). Matching runtime
mengambil similarity TERBAIK across semua varian seseorang (bukan rata-rata).

Di sisi kamera, sebelum embedding wajah di-"zoom" dulu (`crop_face`): bbox
diperluas margin 25% (ArcFace butuh konteks sekitar wajah) dan crop kecil
di-upscale bicubic minimal 112px — wajah CCTV yang jauh/kecil match jauh
lebih baik daripada crop mentah.
Hapus orang = semua row-nya dihapus → dia jadi "intruder" lagi. Kamera
menyerap perubahan roster maksimal `FACE_CACHE_REFRESH_MINUTES` (default 10)
kemudian.

**Env**: `FACE_ENABLED`, `FACE_MODEL`, `FACE_EMBED_MODEL`, `FACE_CONFIDENCE`
(default 0.5), `FACE_MATCH_THRESHOLD` (default 0.5), `FACE_CACHE_REFRESH_MINUTES`
(default 10), `INSIDER_TAG` (info), `INTRUDER_TAG` (alarm).

> `python-counting/face-comparison.py` (FastAPI + facenet-pytorch) adalah
> implementasi referensi lama — TIDAK dipakai pipeline baru, dibiarkan sebagai
> arsip.

### 5.5 APD / Face Restriction Zone

APD dan Face masing-masing bisa dibatasi ke area tertentu di frame,
independen dari `DETECTION_MODE` yang dipakai person counting (mis. tetap
`line_crossing`, tapi APD hanya aktif di dalam area konstruksi). Digambar di
device page → tab **Line Configuration**, muncul di bawah gambar
line/zone utama saat APD atau Face Detection diaktifkan.

**Cara resolusi zone** (di `counting_config.py`, `APD_EFFECTIVE_ZONES` /
`FACE_EFFECTIVE_ZONES`):

1. Kalau `apdZoneA..`/`faceZoneA..` digambar sendiri → dipakai, apa pun
   `DETECTION_MODE`-nya.
2. Kalau tidak digambar DAN `DETECTION_MODE=zone` → ikut zone person-counting
   yang sudah ada (`zoneA..`) — tidak perlu gambar ulang.
3. Kalau tidak digambar DAN `DETECTION_MODE=line_crossing` → **tidak ada
   zone default untuk di-inherit** → detektor jalan tanpa batasan (seluruh
   crop area). Kalau mau membatasi APD/Face sementara mode utama tetap
   `line_crossing`, zone-nya **wajib** digambar sendiri di section masing-masing.

Deteksi yang titik tengahnya di luar semua zone efektif langsung di-skip
(tidak masuk hitungan `apd_hourly`/`face_hourly`, tidak MQTT, dan untuk Face —
tidak sampai memanggil ArcFace sama sekali, jadi tidak ada biaya inference
sia-sia di luar zone).

**Env**: `apdZoneA`, `apdZoneB`, ... / `faceZoneA`, `faceZoneB`, ... — format
polygon sama seperti `zoneA` (`[(x1,y1),(x2,y2),(x3,y3),...]`, ≥3 titik).

---

## 6. MQTT

Tiap tipe deteksi punya topic sendiri (Part C), default diturunkan dari base
topic device dan bisa diedit per device (device page → MQTT Topics):

| Env | Default | Payload |
|---|---|---|
| `MQTT_TOPIC` | template settings, mis. `/person_in/{code}` | event person in/out + crop |
| `MQTT_INTERVAL_TOPIC` | `/resampling_person/{code}` | interval data 5-menit |
| `MQTT_APD_TOPIC` | `{MQTT_TOPIC}/apd` | event APD + crop pelanggar |
| `MQTT_FIRESMOKE_TOPIC` | `{MQTT_TOPIC}/firesmoke` | event fire/smoke + full frame |
| `MQTT_FACE_TOPIC` | `{MQTT_TOPIC}/face` | verdict insider/intruder + crop wajah |

Payload event seragam: `device_id/code/name`, `timestamp`, `event`, `type`,
`tag` (`info`/`alarm`), `label`, `confidence`, `track_id`, `image` (JPEG base64).

---

## 7. Env per Kamera (`.env_<code>`)

Di-manage dashboard; ditulis ulang tiap save device. Kelompok penting:

- **Identitas**: `DEVICE_ID/NAME/CODE`
- **DB**: `PG_HOST/PORT/DB/USER/PASS`
- **MQTT**: broker/port/user/pass + 5 topic di atas
- **Stream**: `RTSP_URL`, `SCREEN_RESOLUTION`, `CROP_AREA`, `ANNOTATED_STREAM`, `STREAM_PORT`
- **Inference**: `TRITON_MODEL` (mis. `yolo26m_640`), `YOLO_CONFIDENCE`, `YOLO_IOU` — `TRITON_URL` di-inject compose (`triton:8001`)
- **Counting**: `DETECTION_MODE` (`line_crossing`/`zone`), `lineA..`/`zoneA..`, `POINT_AXIS`, `SWAP_IN_OUT`, `MERGE_GATES`
- **Additional detection**: blok `APD_*`, `FIRE_SMOKE_*`/`FIRE_TAG`/`SMOKE_TAG`, `FACE_*`/`INSIDER_TAG`/`INTRUDER_TAG`
- **APD/Face restriction zone**: `apdZoneA..`/`faceZoneA..` (polygon, format sama seperti `zoneA`) — lihat §5.5
- **Deprecated** (warn lalu diabaikan): `YOLO_MODEL` (dipetakan otomatis ke `TRITON_MODEL`), `YOLO_IMGSZ`, `ENABLE_NVDEC`, `YOLO_DEVICE`

---

## 8. Development & Testing

```bash
# jalan lokal tanpa docker (butuh Triton reachable, atau DEBUG_MODE)
cd python-counting
pip install -r requirements.txt
FALLBACK_VIDEO=1.mp4 DEBUG_MODE=true python main.py

# unit tests (plain script, exit code 0 = hijau)
python tests/test_parity.py            # letterbox/NMS/ByteTrack vs ultralytics (butuh torch, dev only)
python tests/test_image_utils.py       # crop util
python tests/test_detection_events.py  # dedup APD, cooldown fire/smoke, routing topic MQTT
python tests/test_hourly_aggregate.py  # SQL shape increment/pregenerate
python tests/test_face_detection.py    # dedup face + cosine matching
python tests/test_e2e_smoke.py         # loop main.py penuh di 1.mp4 (150 frame, tanpa Triton)

# dashboard
cd dashboard && npx tsc --noEmit && npm run dev
```

`DEBUG_MODE=true` membuat semua operasi DB/MQTT jadi no-op (log saja) — aman
untuk dev tanpa infra.

---

## 9. Operasional

### Server produksi

Lihat `.claude/skills/ssh-prod-server/SKILL.md`. Ringkas: `ssh envisions@10.11.0.73`
(key-based only), repo di `~/developer/python/dashboard-python-counting`,
Postgres di host port **5435**. Deploy = commit+push dari laptop → `git pull`
di server → restart container terkait.

### Troubleshooting

| Gejala | Penyebab & solusi |
|---|---|
| Model jalan di CPU, GPU idle | `config.pbtxt` masih `onnxruntime_onnx`+`KIND_CPU` karena model-builder belum dijalankan setelah menambah model. Jalankan `docker compose --profile build run --rm triton-model-builder` lalu `docker compose restart triton`. Verifikasi dengan `nvidia-smi`. |
| `OCI runtime create failed ... Symlinking /usr/bin/nvidia-smi` | NVIDIA di-mount dua kali (WSL). Comment baris `- /usr/bin/nvidia-smi:/usr/bin/nvidia-smi:ro` di docker-compose dashboard. |
| `invalid option nameh: line 12: set: pipefail` | `tools/build_engine.sh` ter-checkout CRLF. Ubah line ending ke LF. |
| Konversi NMS gagal di TRT Jetson lama | Export ulang dengan `--no-nms`; client otomatis fallback decode raw + NMS numpy. |
| Kamera log "INFERENCE UNAVAILABLE" | Triton down — container TIDAK crash, backoff 1s→30s. Cek `curl :8000/v2/health/ready`. |
| Enrollment error "No Face Embedding Model configured" | Isi Settings → Triton → Face Embedding Model dulu. |
| Wajah ter-enroll tapi masih "intruder" | (1) tunggu refresh cache ≤10 menit / restart container; (2) cek `FACE_MATCH_THRESHOLD` tidak terlalu tinggi; (3) pastikan model embed enrollment == `FACE_EMBED_MODEL` kamera. |

### Rollback

Image pre-Triton di-tag `python-counting:legacy-nvdec`; kode lama utuh di
`python-counting/legacy/`.
