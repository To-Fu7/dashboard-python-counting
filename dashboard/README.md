# Dashboard (Next.js)

Web UI untuk manage sistem deteksi: device/kamera (`.env_<code>` + compose),
kontrol Triton (status, model, build engine), face enrollment, dan settings
global (hardware mode, PG, MQTT, defaults).

> **Dokumentasi lengkap sistem** (arsitektur, setup DB, model, face detection,
> MQTT, troubleshooting) ada di [README.md root repo](../README.md).

## Development

```bash
npm install
npm run dev        # http://localhost:3000
npx tsc --noEmit   # type-check
```

## Halaman

| Route | Isi |
|---|---|
| `/` | Overview: status Triton + metrics, ringkasan device |
| `/devices` | List kamera, add/start/stop/restart/delete |
| `/devices/[code]` | Edit semua env device: stream, MQTT topics, model, counting, additional detection (APD/fire-smoke/face) |
| `/stream` | Grid MJPEG semua kamera |
| `/faces` | Face enrollment: upload foto → augmentasi → embed via Triton → `known_faces` |
| `/logs` | Log container |
| `/settings` | Hardware mode, Triton (image tag, default model, ArcFace embed model), PG, MQTT templates, detection defaults |

## Catatan

- Skema database dibuat oleh `python-counting/init_db.py` — bukan dari sini.
- Enrollment butuh Settings → "Face Embedding Model (ArcFace)" terisi, dan
  nilainya harus sama dengan `FACE_EMBED_MODEL` di kamera.
