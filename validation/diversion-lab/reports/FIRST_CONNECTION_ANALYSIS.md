# FIRST_CONNECTION_ANALYSIS — operasi jaringan pertama & koneksi pertama ke server terpilih

> Sumber: `evidence/c1-all-b/proxy.jsonl` + `diverter.jsonl` (run lengkap exit 0),
> `evidence/f0-all-a/` (idem ke daemon resmi), plus evidence repo
> (`EXTERNAL_FLOWS.md`, gate logs). Semua run CLI resmi 1.2.0.84 unmodified,
> diarahkan via config-proxy lab (teknik rewrite entri server — satu-satunya
> metode penargetan yang tersedia, karena CLI hanya menguji server dari daftar
> config engine-nya).

## 1. Urutan operasi jaringan absolut (run tipikal, timestamp relatif CLI start)

| # | Δt | Operasi | Tujuan | Bukti |
|---|---|---|---|---|
| 1 | +0,0 s | **Query DNS/proxy CONNECT `cli.speedtest.net:443`** — permintaan jaringan PERTAMA yang dilakukan CLI | ambil config engine (satu-satunya GET `/api/cli/config?deviceId=…&hid=…&sid=…&uname=…`) | `proxy.jsonl`: tepat SATU `config_req` per run (juga di semua evidence repo — CLI tidak pernah re-fetch config di tengah run) |
| 2 | +0,3 s | CONNECT `results.speedtest.net:443` → **DITOLAK proxy** (jaminan non-publishing) | pengiriman hasil (hanya di akhir; percobaan koneksi muncul SETELAH config) | `blocked` di proxy log |
| 3 | +~1 s | **11 koneksi zero-byte** + **11 probe seleksi terenkripsi** ke `localhost:9090` (semua entri server config diarahkan ke sana) — koneksi TCP PERTAMA ke "server" | menguji reachability + latency tiap kandidat | diverter: conn 1–22 dalam ~60 ms |
| 4 | +~1,1 s | probe pemenang: hello terenkripsi (64 B) → `HI <UUID>` → `GETIP` → `PING ×5` | menetapkan server terpilih + mengumumkan UUID sesi + latency tak berbeban | diverter conn 22 |
| 5 | +~1,2 s | koneksi loss (`HI <UUID>` + `INITPLOSS`) + monitor ping + 4 worker download | fase download dimulai | diverter conn 23–28 |
| 6 | +~13,5 s | monitor ping upload + kontrol upload (`CAPABILITIES`, `UPLOAD_STATS`) + 4 worker upload | fase upload | diverter conn 29–34 |
| 7 | +~23 s | koneksi loss menutup (PLOSS terakhir); CLI mencoba kirim hasil → diblokir → `persisted:false`; exit 0 | akhir run | proxy `blocked` + cli.json |

## 2. Jawaban pertanyaan master prompt (Eksperimen B)

- **Operasi jaringan pertama**: fetch HTTPS config engine dari
  `cli.speedtest.net` (via proxy lab). TIDAK ada operasi jaringan lain
  sebelumnya (tidak ada telemetry/NTP/version-check — proxy log bersih
  selain config dan result submission).
- **DNS pertama**: resolusi `cli.speedtest.net` (via proxy lab — resolver
  sistem tidak pernah ditanya untuk host pengukuran, karena proxy
  meng-intercept CONNECT; di mode tanpa proxy, CLI meresolve
  `cli.speedtest.net` lalu host:port setiap entri server).
- **TCP pertama ke server terpilih**: probe seleksi #1 (koneksi terenkripsi
  pertama dari burst 11+1 probe). Koneksi pertama yang MEMBAWA perintah
  NetGauge: probe yang sama setelah fallback (`HI` → `GETIP` → `PING`).
- **Perintah NetGauge pertama**: hello biner terenkripsi (jika diterima →
  sesi terenkripsi penuh, lihat F0) atau setelah `ERROR` → `HI` (fallback
  plaintext, lihat C1).
- **UDP pertama**: datagram `LOSS` pertama dikirim SETELAH fase download
  dimulai (koneksi loss + INITPLOSS sudah ada lebih dulu).

## 3. Batas diversion pada rantai koneksi pertama (temuan kunci)

1. **Config engine = domain Ookla, TIDAK dapat digantikan** — dilindungi
   licenseKey anti-tamper per-perangkat (CLI memvalidasi kunci terhadap
   deviceId/hid/sid; kunci asing/usang ditolak `InvalidLicenseKey`,
   terverifikasi eksperimen 18:52 vs 18:56 UTC 2026-11-04). Konsekuensi:
   diversion hanya bisa dilakukan SETELAH config diterima — dengan
   menimpa `servers[].host` di dalam respons asli (teknik lab).
2. **Alamat server terpilih dikunci dari config** — `host:port` entri
   server dipakai untuk SEMUA fase (TCP + UDP); CLI tidak pernah meresolve
   ulang atau meminta config lagi di tengah run (1 `config_req` per run di
   SEMUA evidence). → diversion alamat bersifat sekali-di-awal, bukan
   per-fase.
3. **Koneksi pertama yang membawa pengukuran = probe seleksi + probe
   pemenang** — 12 koneksi pendek (~60 ms total). Inilah "handshake" yang
   disebut master prompt. Setelahnya, koneksi pengukuran dibuka dengan
   `HI <UUID>` plaintext (jika fallback dipelajari) atau terenkripsi
   (jika probe diterima terenkripsi).

## 4. Perbedaan F0 vs C1 pada lapisan ini

| Aspek | F0 (semua→daemon resmi) | C1 (semua→STS) |
|---|---|---|
| Hello terenkripsi pada probe | **diterima** (sesi terenkripsi penuh) | ditolak `ERROR` → fallback plaintext |
| Koneksi pengukuran berikutnya | tetap terenkripsi | langsung plaintext `HI` |
| packetLoss | 0 | 0 |
| Durasi download/upload | 23 s total run | 22 s total run |

→ Pembelajaran enkripsi terjadi pada PROBE SELEKSI dan dipakai untuk seluruh
run — tetapi per koneksi pengukuran, fallback tetap tersedia (gate repo
membuktikan CLI pulih per koneksi). F2a menguji kombinasi silangnya.
