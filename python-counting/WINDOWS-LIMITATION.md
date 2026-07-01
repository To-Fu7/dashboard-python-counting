# Windows / Docker Desktop (WSL2) Limitations

Catatan keterbatasan saat menjalankan service `python-counting` di **Windows 11 + Docker
Desktop (WSL2 backend)** dengan GPU **NVIDIA RTX A2000 12GB**. Semua masalah di bawah
ditemukan saat deploy 9 container CCTV (`services-python-cctv-01..09`).

Ringkasan: **CUDA compute jalan, video hardware decode (NVDEC) tidak.** Akibatnya decode
H.264 jatuh ke CPU dan beban CPU + RAM tinggi.

---

## 1. NVDEC (hardware video decode) tidak tersedia

### Gejala
```
[h264_cuvid] Cannot load libnvcuvid.so.1
[h264_cuvid] Failed loading nvcuvid.
[ERROR] Could not open codec h264_cuvid, error: -1
... All NVDEC modes failed, falling back to software decoding
```

### Akar masalah
- Decoder `h264_cuvid`/`hevc_cuvid` **ada** di build FFmpeg (terbukti `hevc_cuvid`
  sempat ter-load lalu menolak stream H.264 dengan *"Codec type or id mismatches"*).
- Yang gagal adalah memuat **`libnvcuvid.so.1`** — library runtime NVIDIA Video Codec.
- Library ini **terpisah** dari `libcuda`. Di Docker Desktop / WSL2:
  - `libcuda` + NVML diteruskan ke container → **CUDA compute & TensorRT jalan**
    (GPU `RTX A2000 12GB` terdeteksi, TRT engine ke-load).
  - `libnvcuvid.so.1` (NVDEC) **sering tidak** diekspos driver Windows ke WSL2,
    walaupun `NVIDIA_DRIVER_CAPABILITIES=all` sudah di-set.

> Ini keterbatasan platform, **bukan** bug kode atau salah build image.

### Yang BUKAN penyebab (sudah disingkirkan)
- ❌ Session limit NVDEC GPU — gagal walau hanya 1 container jalan.
- ❌ Probe window terlalu pendek — sempat dicurigai (`non-existing PPS 0 referenced`),
  tapi itu cuma stream H.264 join mid-GOP dan bukan blocker sebenarnya.
- ❌ FFmpeg build tanpa cuvid — decoder cuvid terbukti ada.
- ❌ Salah codec — stream substream Hikvision (`channels/x02`, `x402`) adalah **H.264**,
  jadi pesan `hevc_cuvid mismatch` memang wajar (noise).

### Cara verifikasi di mesin lain
```powershell
docker exec <container> sh -c "ls -la /usr/lib/wsl/lib/ | grep -i cuvid; \
  find / -name 'libnvcuvid*' 2>/dev/null; ldconfig -p | grep -i cuvid"
```
- Ada di `/usr/lib/wsl/lib` tapi tak di ldconfig → cukup set `LD_LIBRARY_PATH`.
- Kosong total → driver Windows tidak expose NVDEC ke WSL2 → NVDEC tidak bisa dipakai.

### Status / workaround
- Kode (`main.py` → `initialize_video_capture`) sudah otomatis **fallback ke software
  decode** saat NVDEC gagal. Service tetap berfungsi.
- Untuk menghilangkan noise log NVDEC, set `ENABLE_NVDEC=false` di file `.env_CCTV_xx`.
- NVDEC hanya bisa diaktifkan kalau:
  - Pindah host ke **Linux native** (bukan WSL2) dengan NVIDIA Container Toolkit, atau
  - Driver Windows + WSL benar-benar mengekspos `libnvcuvid.so.1` (cek dengan command di atas).

---

## 2. Konsekuensi: CPU & RAM berat

### CPU
- Tanpa NVDEC, **9 stream H.264 di-decode penuh di CPU**.
- ⚠️ Catatan penting: `FRAME_SKIP` di kode **tidak** menghemat decode. Pada backend
  FFMPEG, `cap.grab()` tetap men-*decode* frame — yang dilewati hanya `retrieve()`
  (konversi YUV→BGR). Jadi beban decode tetap penuh per stream.
- Satu-satunya pemotong CPU decode: **NVDEC** (lihat #1) atau **kecilkan sumber stream**.

### RAM
- **9 container terpisah**, masing-masing load Python + torch + CUDA context + TRT engine
  sendiri (~1–2 GB RSS per container). Total belasan GB. Ini sifat arsitektur, bukan tweak kecil.

### Opsi penurunan beban (kalau NVDEC tetap mati)
| Opsi | Dampak | Effort |
|---|---|---|
| Turunkan resolusi/FPS substream **di kamera** (Hikvision) | Pemotong decode paling efektif | Rendah |
| `YOLO_IMGSZ` 640→480, `SCREEN_RESOLUTION` 800×600→640×480 | Turun beban inferensi & resize | Rendah |
| Batasi thread (`cv2.setNumThreads`, `OMP_NUM_THREADS=1`, ffmpeg `threads;2`) | Kurangi rebutan core antar 9 container | Sedang |
| Konsolidasi banyak kamera → 1 proses, 1 model YOLO dibagi | Hemat RAM paling besar | Tinggi (refactor) |

---

## 3. TensorRT export gagal: `BuilderFlag.FP16`

### Gejala
```
TensorRT: export failure: type object 'tensorrt_bindings.tensorrt.BuilderFlag'
has no attribute 'FP16'  → Falling back to .pt
```

### Akar masalah
Mismatch versi CUDA + API TensorRT yang berubah:
- Base image `cuda:12.5.0`, tapi `requirements.txt` pakai `tensorrt-cu13` (CUDA 13)
  dan Dockerfile install PyTorch index `cu130` (CUDA 13).
- TensorRT 10.x **menghapus** atribut `BuilderFlag.FP16` dari Python API. Versi
  `ultralytics` lama (`>=8.2.0`) belum tentu handle API baru ini.

### Fix yang sudah diterapkan
| File | Sebelum | Sesudah |
|---|---|---|
| `requirements.txt` | `tensorrt-cu13>=7.0.0,!=10.2.0` | `tensorrt-cu12>=10.0.0,<10.9.0` |
| `requirements.txt` | `ultralytics>=8.2.0` | `ultralytics>=8.3.0` |
| `dockerfile` | PyTorch `--index-url ...cu130` | `...cu121` |

> Perubahan di `requirements.txt` / `dockerfile` **butuh rebuild image** agar aktif:
> `docker compose build`. Perubahan `main.py` ikut otomatis karena di-mount volume `:/app`.

Setelah fix, TRT engine berhasil di-export & inferensi pakai TensorRT GPU
(`Model loaded: yolo11n_imgsz640_fp16_dynamic.engine`).

---

## Kesimpulan

| Komponen | Status di Windows/WSL2 |
|---|---|
| CUDA compute (PyTorch) | ✅ Jalan |
| TensorRT inference | ✅ Jalan (setelah fix #3) |
| NVDEC hardware decode | ❌ Tidak tersedia (limitasi WSL2) → fallback software |
| Beban CPU decode | ⚠️ Tinggi (akibat NVDEC mati) |
| Beban RAM | ⚠️ Tinggi (9 proses terpisah) |

Untuk performa decode maksimal, jalankan di **Linux native** dengan NVIDIA Container
Toolkit. Di Windows/WSL2, andalkan software decode + optimasi di tabel #2.
