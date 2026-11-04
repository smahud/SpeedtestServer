# NETGAUGE_SESSION_MAP — peta siklus hidup koneksi NetGauge CLI resmi

> Sumber evidence utama: `evidence/c1-all-b/` (CLI resmi 1.2.0.84 → diverter all:B,
> 2026-11-04, exit 0, loss 0) — dianalisis dengan `harness/analyze-run.mjs`;
> dikonfirmasi silang dengan evidence repo `validation/evidence/gate-cli2-sts-evidence.jsonl`
> (pola identik) dan `evidence/f0-all-a/` (sama, ke daemon resmi).

## 1. Inventaris koneksi per run (C1, 34 koneksi TCP + 3 endpoint UDP)

| # koneksi | Fase | Perintah teramati | Byte c→s / s→c | Umur | Catatan |
|---|---|---|---|---|---|
| 1,3,5,7,9,11,13,15,16,18,21 (11 koneksi) | **zero-byte** | — (tidak ada data) | 0 / 0 | 0–4 ms | koneksi dibuka-lalu-ditutup tanpa byte; berselang-seling dengan probe (perilaku CLI, bukan artefak diverter — pola `?:?` yang sama ada di evidence repo) |
| 2,4,6,8,10,12,14,17,19,20 (10) | **probe seleksi (terenkripsi)** | hello biner terenkripsi → `ERROR` → `HI` → `GETIP` → `PING ×3` → close | ~80–95 / 124 | 3–10 ms | satu per entri server kandidat (semua entri diarahkan ke target yang sama oleh proxy) |
| 22 (1) | **probe pemenang (terenkripsi)** | hello biner (64 B) → `ERROR` → `HI <UUID-sesi>` → `GETIP` → `PING ×5` → close | 202 / 162 | 2 ms | mengumumkan UUID sesi ke server terpilih; PING×5 = pengukuran latency tak berbeban (pingCount=5 dari config) |
| 23 (1) | **koneksi loss (long-lived)** | `HI <UUID>` → `INITPLOSS` → `PLOSS` setiap ~500 ms | 56 / 63 | 12,8 s (seluruh run) | dibuka plaintext TANPA percobaan terenkripsi |
| 24 (1) | **monitor ping fase download** | `HI <UUID>` → `PING` berulang (~setiap 0,5–1,5 s) | 3,9 KB / 4,7 KB | 15,3 s | loaded-latency selama download |
| 25–28 (4) | **worker download** | `HI <UUID>` → `DOWNLOAD 32000000` berulang (~setiap 100 ms) | ~1,8 KB / **3,88 + 2,77 + 3,01 + 2,46 GB** | 12,3 s | threadCount=4 dari config engine |
| 29 (1) | **monitor ping fase upload** | `HI <UUID>` → `PING` berulang | 3,0 KB / 3,6 KB | 9,5 s | |
| 30 (1) | **kontrol upload** | `HI <UUID>` → `CAPABILITIES` → `UPLOAD_STATS 15000 16 0` (→ `ERROR`, ditoleransi) | 77 / 93 | 9,5 s | |
| 31–34 (4) | **worker upload** | `HI <UUID>` → `UPLOAD 32000000 15000 16` + payload 31.999.975 B, berulang | **2,16 + 1,86 + 2,53 + 1,76 GB** / ~1,6 KB | 9,5 s | payload acak (non-printable → ter-log «BIN») |
| UDP ×3 endpoint | **stream loss / loaded-latency** | `LOSS <timer> <seq> <UUID> [<timer>]` | 244 + 245 + 188 datagram → backend; 244 + 0 + 188 RECV kembali | seluruh run | 3 soket UDP klien dengan UUID berbeda; endpoint tengah (UUID = result-id) 245 datagram tanpa RECV (bentuk init — memang tidak dibalas; akuntansi via PLOSS) |

## 2. Model state yang dipakai CLI (disintesis dari C1 + gate-cli2)

1. **UUID sesi tunggal** diumumkan pada probe pemenang (`HI <UUID>`) dan dipakai
   ulang oleh SEMUA koneksi pasca-seleksi (loss, monitor ping, worker) dan oleh
   datagram UDP. Backend mana pun yang menerima `HI <UUID>` mengenal sesi itu —
   **tidak ada state lintas-koneksi wajib di server** di luar UUID (diverter
   memanfaatkan ini untuk replay prefix antar-backend).
2. **Pembelajaran fallback enkripsi per server**: probe seleksi mencoba hello
   terenkripsi → dijawab `ERROR` oleh STS → seluruh koneksi pasca-seleksi langsung
   plaintext `HI` (tanpa percobaan terenkripsi lagi) — pada C1 (all→B) dan
   gate-cli2 (direct→STS). Pada F0 (all→daemon resmi) hello terenkripsi
   DITERIMA (daemon bisa terenkripsi) — koneksi pengukuran kemudian juga
   terenkripsi (lihat `evidence/f0-all-a/analysis.json`).
3. **Koneksi zero-byte**: 11 koneksi buka-tutup tanpa data, berselang dengan
   probe — kemungkinan mekanisme warm-up/cepat-connect engine. Tidak membawa
   perintah apa pun → tidak relevan bagi routing, tetapi MUNCUL di semua run
   (harus dihitung dalam kebijakan firstN!).
4. **Durasi fase** (loopback, stableStop aktif): seleksi ~60 ms; download
   ~12,3 s; upload ~9,5 s; koneksi loss hidup 12,8 s (menutup setelah PLOSS
   terakhir).
5. **Volume**: download 12,12 GB (4 worker × ~198×32 MB, dihentikan stableStop);
   upload 8,3 GB. Angka CLI (12,09/8,16 GB) cocok dengan byte counter diverter
   dalam toleransi framing protokol.

## 3. Implikasi diversion (jawaban Eksperimen C master prompt)

- **Satu koneksi = satu fase** (murni): tidak ada koneksi yang mencampur
  DOWNLOAD dan UPLOAD, tidak ada yang membawa PING sekaligus DOWNLOAD.
  Pengecualian: prefix `HI`(+`GETIP`) ada di semua koneksi pasca-seleksi.
  → **diversion level-koneksi per fase layak** tanpa menyentuh koneksi yang
  sedang aktif.
- **Objek diversion yang tersedia** (granularitas naik):
  1. per koneksi (firstN / berdasar urutan)
  2. per fase (phase-aware: seleksi / loss / ping-monitor / download / upload /
     kontrol-upload)
  3. per perintah (cmd-aware — memecah HI/GETIP/PING/DOWNLOAD/UPLOAD antar backend)
- **Titik kritis lintas-backend**: (a) akuntansi loss — `INITPLOSS`/`PLOSS`
  (TCP) dan datagram `LOSS` (UDP) harus berakhir di backend yang sama;
  (b) fallback enkripsi dipelajari dari probe seleksi → memengaruhi apakah
  koneksi pengukuran mencoba enkripsi (dibuktikan F0 vs C1);
  (c) UUID sesi membuat backend mana pun dapat melayani koneksi apa pun
  tanpa sinkronisasi.

## 4. Bukti silang

- `evidence/c1-all-b/diverter.jsonl` (34 conn_open/close + conn_cmd per baris)
- `evidence/c1-all-b/analysis.json` (tabel di atas, mesin terbaca)
- `../../evidence/gate-cli2-sts-evidence.jsonl` (repo; 23 conn — tanpa diverter)
- `evidence/f0-all-a/` (ke daemon resmi; struktur fase identik)
