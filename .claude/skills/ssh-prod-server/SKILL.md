---
name: ssh-prod-server
description: SSH ke server produksi GPU 10.11.0.73 (Triton, Postgres, camera containers) untuk deploy, verifikasi DB, build engine, dan cek resource. Pakai skill ini setiap kali perlu menjalankan perintah di server itu.
---

# SSH ke Server Produksi (10.11.0.73)

Server GPU produksi yang menjalankan: Triton Inference Server, PostgreSQL/TimescaleDB,
dan container kamera `python-counting`. User: `envisions`.

## Aturan utama

1. **Hanya pakai key-based auth.** Jangan pernah menulis password ke file, env var,
   command line, atau script — classifier keamanan Claude Code akan memblokirnya,
   dan memang seharusnya begitu. Kalau key belum terpasang, minta user menjalankan
   setup one-time di bawah; jangan cari cara lain.
2. Selalu `ssh envisions@10.11.0.73` (user `envisions`, BUKAN `user` — entry lama di
   `~/.ssh/config` bisa salah memetakan user default).
3. Tambahkan `-o BatchMode=yes -o ConnectTimeout=8` supaya gagal cepat (tanpa prompt
   password yang menggantung) kalau key tidak dikenali.

## Cek koneksi

```bash
ssh -o BatchMode=yes -o ConnectTimeout=8 envisions@10.11.0.73 "echo connected && whoami"
```

- Output `connected` + `envisions` → lanjut kerja.
- `Permission denied (publickey,password)` → key belum terpasang. STOP, minta user
  menjalankan setup one-time berikut (butuh password, jadi harus user sendiri):

## Setup one-time (dijalankan USER, bukan Claude)

Dari Git Bash di laptop ini (akan diminta password sekali):

```bash
ssh-copy-id -i ~/.ssh/id_ed25519.pub envisions@10.11.0.73
```

Kalau `ssh-copy-id` tidak ada (Windows), alternatifnya:

```bash
cat ~/.ssh/id_ed25519.pub | ssh envisions@10.11.0.73 "mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
```

Disarankan juga perbaiki `~/.ssh/config` (entry `10.11.0.73` masih `User user`):

```
Host 10.11.0.73
  HostName 10.11.0.73
  User envisions
  IdentityFile ~/.ssh/id_ed25519
```

Setelah itu cek koneksi lagi; harus lolos tanpa password.

## Yang ada di server

| Apa | Di mana / cara akses |
|---|---|
| Repo project | `~/developer/python/dashboard-python-counting` (branch `feat/triton-migration`) |
| Triton | container Docker; health: `curl -s localhost:8000/v2/health/ready`, model list: `curl -s -X POST localhost:8000/v2/repository/index` |
| Build TensorRT engine | `docker compose --profile build run --rm triton-model-builder` dari direktori compose python-counting (±2-3 menit per model), lalu restart Triton — butuh sudo/user docker |
| PostgreSQL (TimescaleDB) | container `env_services_timescaledb`; di-expose ke host di **port 5435** (bukan 5432) — bisa diakses langsung dari laptop: `PG_HOST=10.11.0.73 PG_PORT=5435 PG_DB=postgres PG_USER=postgres` |
| Password Postgres | JANGAN plaintext; ambil via `export PG_PASS=$(ssh envisions@10.11.0.73 "grep '^PG_PASS=' ~/developer/python/dashboard-python-counting/python-counting/.env_T \| cut -d= -f2" \| tr -d '\r\n')` |
| Camera containers | `docker ps` butuh sudo — `envisions` belum masuk grup docker; minta user kalau perlu |
| GPU | `nvidia-smi` untuk cek utilization/memory sebelum-sesudah perubahan |

## Pola kerja umum

- **Verifikasi DB schema/query**: `ssh` → `cd` ke direktori python-counting di server →
  `python init_db.py` → query verifikasi via `psql` atau snippet Python pakai env dari
  `.env_<code>`. Selalu bersihkan row test (`DELETE ... WHERE device_code='TESTCODE'`).
- **Deploy kode**: server pull dari git (branch `feat/triton-migration`), bukan scp file
  satu-satu. Commit + push dulu dari laptop, lalu `ssh ... "cd <repo> && git pull"`.
- **Perintah panjang** (build engine, dsb): jalankan via Bash tool `run_in_background`
  supaya tidak memblokir; timeout SSH default bisa kurang.
- Multi-perintah: gabungkan dalam satu sesi `ssh host "cmd1 && cmd2"` daripada banyak
  koneksi terpisah.

## Jangan lakukan

- Jangan simpan/echo password dalam bentuk apa pun (file, env, heredoc, paramiko script).
- Jangan `docker compose down` semua service — restart hanya service yang diperlukan.
- Jangan hapus `.plan`/model repo tanpa konfirmasi; build engine lama (±163 detik per model).
- Jangan ubah `.env_<code>` produksi langsung di server tanpa persetujuan user — file itu
  di-manage dashboard.
