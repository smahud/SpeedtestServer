# Quirk perilaku server OoklaServer :8080 (verifikasi langsung 2026-11-26)

Diukur dari sandbox Alibaba HK (egress 8.212.10.159 / 47.57.232.232, RTT Surabaya ~60–140 ms)
terhadap 10 server target Surabaya. Data mentah: `07_server_probes_surabaya.json`.

## 1. Method HEAD ditolak 500; User-Agent wajib

- `HEAD /apa/saja` → **500 Internal Server Error** (semua path, semua server hidup).
- `GET` tanpa header `User-Agent` → **500** juga. Dengan `User-Agent` (apa pun, termasuk `probe/1.0`) → 200.
- Implikasi: probing/monitoring harus pakai GET + UA.

## 2. `GET /` mengembalikan halaman OoklaServer 109 byte

```html
<html><head><title>OoklaServer</title></...
```

## 3. Dua kelas konfigurasi TLS/redirect (penting untuk klien web https)

| Kelas | Contoh (Surabaya) | HTTP polos :8080 | TLS :8080 (SNI host sponsor) | host API |
|---|---|---|---|---|
| A — sertifikat sponsor, tanpa redirect | xl.co.id (`*.xl.co.id`), patas.id, era.net.id, faznet (`*.faznet.co.id`) | **200 langsung** | **OK** (cert sponsor) | `<sponsor-host>:8080` |
| B — sertifikat Ookla prod-host, 307 | tuxsnet, atharva, lintasmediasolusindo, ring.net.id | **307 → `https://server-<id>.prod.hosts.ooklaserver.net:8080/<path+query>`** (GET/POST); **WS upgrade polos tetap 101** | **GAGAL** (cert hanya untuk `server-<id>.prod.hosts.ooklaserver.net`) | `<sponsor>.prod.hosts.ooklaserver.net:8080` |
| C — sertifikat self-signed | somedigit (74964) | 200 | **GAGAL verifikasi** — cert `CN=localhost, O=OoklaServer` self-signed (dibuat otomatis saat boot; notBefore = waktu restart server) — `https_functional=1` di API tidak sesuai kenyataan | `speedtest.somedigit.net:8080` |
| D — mati | BLiP (72945) | TCP :8080 **timeout** (DNS `ookla-sby.blip.co.id` → 43.252.159.5 hidup) | — | `ookla-sby.blip.co.id:8080` |

- Kelas B: browser web (halaman https) selalu connect ke `*.prod.hosts.ooklaserver.net`
  (terbukti di capture: `wss://speedtest.tuxsnet.id.prod.hosts.ooklaserver.net:8080/ws`).
  Cert SAN berisi DUA nama: `server-<id>.prod.hosts.ooklaserver.net` dan `<sponsor>.prod.hosts.ooklaserver.net`.
- Kelas C (somedigit) tidak bisa dipakai penuh dari halaman https speedtest.net (wss gagal
  verifikasi sertifikat). Konsisten dengan observasi popup "Change Server" yang tidak
  menampilkan somedigit.

## 4. Method routing path upload

- `POST /upload` (protokol baru) → `200`, body `size=<N>\n` (= jumlah byte yang diterima).
- `POST /speedtest/upload.php` (legacy) → **200** `size=<N>\n` juga (keduanya hidup).
- `GET /speedtest/upload.php` → **404** (routing berbasis method — GET tidak diimplementasi).

## 5. File legacy "random jpg" masih dilayani (ukuran deterministik, isi acak)

| Path | Status | Content-Length | Content-Type |
|---|---|---|---|
| `/speedtest/random350x350.jpg` | 200 | 245.388 (sama di semua server) | image/jpeg |
| `/speedtest/random1000x1000.jpg` | 200 | 1.986.284 | image/jpeg |
| `/speedtest/random4000x4000x4.jpg` | **404** | — | — |
| `/speedtest/latency.txt` | 200 | 9 (`test=test\n`) | text/plain |
| `/speedtest/crossdomain.xml` | 200 | XML policy (`to-ports="5060,8080"`) | text/xml |

Isi file random berbeda per permintaan (data acak, ukuran tetap).

## 6. `GET /upload-stats` tanpa sesi → 400 Bad Request

Statistik upload (HTTP variant) memerlukan konteks sesi upload; jalur yang dipakai web client
adalah `UPLOAD_STATS <durasi> <interval> <index>` via WebSocket dengan balasan JSON stream.

## 7. Protokol di port 8080 polos vs TLS

- WS plain (`ws://host:8080/ws`) diizinkan di semua server hidup (101 + protokol penuh) —
  termasuk kelas B yang men-307 HTTP GET (WS upgrade dievaluasi sebelum logika 307).
- 5060 (protokol native TCP CLI) dan 443/80: lihat `07_server_probes_surabaya.json` → `ports`.

## 8. Egress IP klien berbeda per tujuan/protokol

Teramati dari sandbox yang sama:
- HTTP GET `/getip` via somedigit → `8.212.10.159`
- WS `YOURIP` via somedigit → `47.57.232.232`
- WS `YOURIP` via server lain (HK) → `47.57.242.119`

NAT egress penyedia cloud klien dapat menghasilkan IP publik berbeda — penting saat
mencocokkan log server dengan "IP klien".
