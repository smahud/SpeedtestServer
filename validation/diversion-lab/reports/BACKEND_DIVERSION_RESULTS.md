# BACKEND_DIVERSION_RESULTS — hasil matriks diversion backend (F0–F8, G)

> Format: setiap baris = satu skenario, dengan bukti per-run dan label status
> master prompt §12 (VERIFIED / PARTIALLY VERIFIED / FAILED / INCONCLUSIVE /
> NOT TESTED). Kendala eksekusi: kuota config API (lihat §0) — sebagian
> skenario berstatus BLOCKED dengan instrumen siap-run dan perintah persisnya.

## 0. Kendala eksekusi (transparan)

CLI resmi **wajib** menerima config live dari `cli.speedtest.net` (licenseKey
anti-tamper per-perangkat, umur sangat pendek — kunci berumur ~15 s ditolak
`InvalidLicenseKey`, terverifikasi 2026-11-04 18:52 UTC). Egress lab
(47.57.232.232, NAT bersama) dibatasi Ookla/CDN: setelah 4 fetch sukses
(18:11, 18:51, 18:56, 19:10 UTC), semua fetch berikut 429 hingga batas
percobaan terakhir sesi ini (19:53 UTC). Konsekuensi: 2 kontrol penuh
(C1, F0) + seluruh validasi instrumen berhasil dijalankan; skenario F2–F8
yang tersisa berstatus BLOCKED di sesi ini (perintah run tersedia di
`reports/AGENT_HANDOFF.md` §3 dan `analysis/EXPERIMENT_MATRIX.md`).

## 1. Hasil terverifikasi

### F1 / C1 — semua trafik → backend pengganti (STS) via instrumen diversion

| Aspek | Nilai |
|---|---|
| Run | `evidence/c1-all-b/` (2026-11-04 18:56:56 UTC, config live di-rewrite) |
| Exit / kelengkapan | **0; latency 0,095 ms + jitter 0,030 ms + download 12,09 GB + upload 8,16 GB + packetLoss 0** |
| Non-publishing | `persisted:false` + `results.speedtest.net` DITOLAK proxy |
| Atribusi | 34 koneksi → 100% backend B; byte diverter (12,12 GB be→cli; 8,30 GB cli→be) ≈ laporan CLI (Δ = framing protokol); STS: 373 download, 258 upload, 432 udp_recv |
| Status | **VERIFIED** — diversion penuh ke backend non-resmi TIDAK merusak pengukuran (reproduksi gate repo melalui instrumen tambahan) |

### F0 / F8c — semua trafik → daemon resmi via instrumen (middlebox NAT)

| Aspek | Nilai |
|---|---|
| Run | `evidence/f0-all-a/` (19:10:54 UTC) |
| Exit / kelengkapan | **0; download 17,18 GB + upload 16,99 GB + packetLoss 0** |
| Non-publishing | ✓ (persisted:false + blocked) |
| Temuan 1 — enkripsi | Probe seleksi terenkripsi DITERIMA daemon → **seluruh run berjalan terenkripsi** (koneksi pengukuran tanpa fallback plaintext) — kontras C1 (fallback penuh). Enkripsi dipelajari CLI dari jawaban probe. |
| Temuan 2 — loss & NAT | UDP 240 datagram via diverter, **RECV balasan daemon MELEWATI diverter** (dikirim ke alamat yang dilaporkan klien sendiri — fenomena F-7 repo terjadi juga pada diverter). Meski begitu **packetLoss = 0** — karena akuntansi loss mengalir via koneksi PLOSS (lihat temuan 3). |
| Temuan 3 — kanal loss plaintext | **Koneksi loss (`HI <UUID>`+`INITPLOSS`+`PLOSS`) SELALU plaintext** — bahkan saat run terenkripsi penuh (conn 23 F0: teks murni). Kanal akuntansi loss selalu dapat diamati/dirote. |
| Status | **VERIFIED** |

### S (validasi instrumen, klien sintetis — bukan gerbang CLI)

`evidence/synth-validation/` — S1 all:B (PLOSS 3 0 2, RECV via diverter);
S2 phase+replay+swallow (routing per fase benar; PLOSS 0 0 0 saat loss-conn→A
& UDP→B — keterikatan akuntansi lintas-backend); S3 cmd-level (16/16 UPLOAD OK
lintas 2 backend); S4 firstN:A:12 (belahan indeks eksak 1–12→A, 13–23→B).
**Status: VERIFIED (mekanisme instrumen; bukan bukti perilaku CLI).**

## 2. Skenario inti — status & jawaban parsial berbasis bukti terverifikasi

### F2a — seleksi/handshake → daemon resmi (A), pengukuran → STS (B)

- Status eksekusi: **BLOCKED** (kuota config; 9 percobaan 19:12–19:53 UTC).
- Prediksi berbasis bukti: **lulus** — karena (i) F0 membuktikan daemon
  menerima probe terenkripsi; (ii) C1/gate-repo membuktikan STS melayani
  koneksi pengukuran fallback plaintext per koneksi (CLI memulihkan fallback
  per koneksi — 23 sesi ERROR→HI di gate-cli2); (iii) UUID sesi membuat
  backend mana pun menerima koneksi pengukuran; (iv) kanal loss plaintext
  dapat dilayani B. Titik risiko: apakah CLI "mengingat" enkripsi berhasil
  (dari probe→A) lalu MENOLAK fallback pada koneksi pengukuran→B — belum
  ada bukti empiris CLI menolak fallback per koneksi setelah belajar
  enkripsi (gate-repo menunjukkan sebaliknya: fallback per koneksi selalu
  tersedia). → menjadikan F2a eksperimen pertama yang harus dijalankan
  saat kuota pulih.
- Perintah: `EXP_ID=f2a POLICY="phase:pre=A,enc=A,sel=A,ping=B,loss=B,dn=B,up=B,upctl=B" UDP=B ./run-diversion.sh`

### F2b, F3, F4, F5(n), F5r, F7b, F8a, F8b, F8d, G1–G5

**BLOCKED** di sesi ini (kuota). Perintah lengkap + pertanyaan spesifik:
`analysis/EXPERIMENT_MATRIX.md`. Yang bisa dikatakan dari bukti yang ada:

- **F5 (firstN)**: koneksi zero-byte (±11) dan probe (±12) mendahului semua
  koneksi pengukuran → N ≥ ~23 mengarahkan SELURUH pengukuran ke backend
  kedua, N ≤ 12 hanya memindahkan probe — titik belah menarik N ∈ [13, 22]
  (loss-conn/pingmon/download tepat setelah probe).
- **F7b (per-perintah)**: terverifikasi secara instrumen (S3) bahwa backend
  menerima subset perintah dari satu koneksi klien; belum teruji pada CLI.
- **F8a (TCP→A, UDP→B)**: dua mekanisme loss klien (hitungan PLOSS di A yang
  tak menerima UDP vs RECV dari B) akan bersaing — hasil empiris menentukan
  `packetLoss` yang dilaporkan. F8b: daemon tanpa INITPLOSS (kanal loss→B)
  kemungkinan tidak membalas RECV (indikasi S3: 0 RECV saat INITPLOSS tidak
  sampai) — dan PLOSS dari B melaporkan 0 0 0.
- **F6 (DNS)**: INCONCLUSIVE-by-instrument (lihat DNS_AND_IP_BEHAVIOR §2) —
  bukti tidak langsung: tidak ada re-resolusi/re-fetch di tengah run.

## 3. Tabel ringkas status

| ID | Skenario | Status | Bukti |
|---|---|---|---|
| F0 | semua→A via diverter (=F8c NAT) | **VERIFIED — PASS** | `evidence/f0-all-a/` |
| F1/C1 | semua→B via diverter | **VERIFIED — PASS** | `evidence/c1-all-b/` |
| F2a | handshake→A, pengukuran→B | BLOCKED (prediksi: lulus — lihat di atas) | `evidence/f2a/` (9× config 429) |
| F2b | kebalikan | BLOCKED | — |
| F3 | latency→A, beban→B | BLOCKED | — |
| F4 | lat+dl→A, ul→B | BLOCKED | — |
| F5 | firstN sweep | BLOCKED (analisis batas: lihat §2) | — |
| F6 | DNS | INCONCLUSIVE (tanpa kontrol DNS; bukti tak ada re-resolusi) | proxy logs semua run |
| F7a | phase-aware level koneksi | BLOCKED pada CLI; VERIFIED pada instrumen (S2) | `synth-validation/s2` |
| F7b | per-perintah | BLOCKED pada CLI; VERIFIED pada instrumen (S3) | `synth-validation/s3` |
| F7c | jawaban lokal | NOT TESTED | — |
| F8a | TCP→A, UDP→B | BLOCKED (eksperimen diskriminatif kunci) | — |
| F8b | TCP→B, UDP→A | BLOCKED | — |
| F8c | NAT loss | **VERIFIED — PASS (loss 0)** (tergabung F0) | `evidence/f0-all-a/` |
| F8d | loss→A saja | BLOCKED | — |
| G1–G5 | injeksi kegagalan | BLOCKED (G3 quick-run saat kuota) | — |
| H | Cloudflare Workers | **VERIFIED (analitis)** — lihat laporan H | `reports/CLOUDFLARE_WORKERS_FEASIBILITY.md` |

## 4. Perbandingan volume (atribusi byte) — kontrol

| Run | CLI laporkan (DL/UL) | Diverter ukur (be→cli / cli→be) | Δ |
|---|---|---|---|
| C1 (→B) | 12,09 / 8,16 GB | 12,12 / 8,30 GB | 0,3 % / 1,7 % (framing) |
| F0 (→A) | 17,18 / 16,99 GB | (lihat analysis.json) | konsisten |
