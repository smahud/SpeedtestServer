# Result Comparison — VPS Murni vs VPS + Cloudflare Worker

**Project:** SpeedtestServer — pengganti mandiri (self-hosted) OoklaServer + mode Hybrid VPS + Cloudflare Worker
**Tanggal uji utama:** 4, 23–25 November 2026 · **Dokumen disusun:** 26 November 2026
**Server:** VPS 45.126.249.250 — daemon NetGauge port **8080** (OoklaServer.properties standar resmi, tidak diubah) + front gateway hybrid port 8790
**Worker:** speedtest-hybrid-worker.lumajangnetworks.workers.dev (Cloudflare)
**Klien uji:** mesin eksternal (Alibaba Hong Kong) — CLI resmi Ookla 1.2.0.84 dan speedtest-cli 2.1.3

---

## Ringkasan 1 Menit

| Yang diukur | VPS murni | VPS + CF Worker | Hasil |
|---|---|---|---|
| Rata-rata UPLOAD | 112,1 Mbps | 625,8 Mbps | **5,6× lebih cepat** |
| Rata-rata DOWNLOAD | 477,6 Mbps | 491,3 Mbps | Setara (line klien jenuh) |
| Data yang lewat VPS per 1 uji | 670–1.022 MB | 0,45–0,49 MB | **Turun lebih dari 1.000×** |
| Server lulus uji end-to-end | 9/9 | 9/9 | Semua sukses |
| Ping diukur ke | IP VPS | IP VPS (tetap) | Sesuai desain |
| Plafon agregat edge (8 stream paralel) | — | **2,27 Gbps** | **Target 2 Gbps terlampaui** |

Cara bacanya:

1. **Identitas tetap milik VPS.** Pemilihan server, ping, dan hasil uji selalu menunjuk IP VPS 45.126.249.250.
2. **Payload besar pindah ke Cloudflare.** Saat mode hybrid aktif, download/upload dilayani Worker di edge Cloudflare. Buktinya dari hitungan byte: dari 539 MB payload per uji, hanya ±0,47 MB yang lewat VPS.
3. **Download tidak naik banyak karena line klien uji cuma ±0,5–0,8 Gbps** (mentok di klien, bukan di server). Upload naik 5,6× karena jalur upload pindah ke edge Cloudflare yang jauh lebih dekat ke klien.
4. **Plafon agregat edge terukur 2,27 Gbps** (8 stream paralel, 8 worker — produksi, 25 Nov). Sejak v1.4 agregatnya = kapasitas VPS penuh + edge di atasnya, tanpa budget/throttle (lihat §3.8 dan §4).

---

## 1. Cara Uji (singkat)

Dua mode diuji berdampingan pada 24 November 2026, 05:30–06:00 UTC, dengan daftar server yang sama (9 server Surabaya dari daftar operator):

- **Mode A — VPS murni:** CLI resmi Ookla 1.2.0.84 diarahkan ke 9 server. Domain server dipetakan ke `45.126.249.250:8080`. Semua trafik (ping, download, upload) lewat VPS.
- **Mode B — VPS + CF Worker (hybrid):** server dan daftar sama. Kontrol (pemilihan server, ping, latency, kirim hasil) tetap ke VPS. Payload besar dialihkan ke Worker Cloudflare lewat token ber-tanda-tangan (redirect 302 ke `workers.dev` + POST upload dengan token).

**Bukti tidak bohong — atribusi byte dari 3 sumber independen:**
counter `eth0` VPS + journal daemon + Cloudflare GraphQL Analytics.
Hasilnya: Mode A = 0 request ke Worker; Mode B = 91–364 request ke Worker dan eth0 VPS hanya 0,45–0,49 MB. Redirect pembuktian langsung: `302 Location: https://speedtest-hybrid-worker.lumajangnetworks.workers.dev/...` dan IP tujuan `172.67.131.176` (Cloudflare, bukan VPS).

---

## 2. Hasil Utama — 9 Server (A/B Test, 24 Nov 2026)

Kecepatan dalam Mbps, ping dalam ms. A = VPS murni (CLI resmi) · B = VPS + CF Worker (transport hybrid, engine ukur 100% asli).

| ID | Sponsor | Download A → B | Upload A → B | Ping A | Ping B |
|---|---|---|---|---|---|
| 74964 | somedigit.net | 508,1 → 501,4 | 125,0 → 702,3 | 59,1 | 129,1 |
| 61853 | XL (XLSMART) | 465,5 → 405,0 | 60,6 → 725,9 | 62,1 | 126,5 |
| 62314 | Pratama | 475,9 → 566,6 | 147,6 → 229,5 | 60,7 | 128,7 |
| 66281 | Tuxsindo | 496,1 → 443,7 | 116,7 → 707,2 | 63,7 | 124,1 |
| 65429 | Atharva | 481,9 → 413,5 | 142,5 → 757,6 | 62,1 | 128,3 |
| 68214 | ERA | 455,1 → 622,4 | 146,9 → 589,9 | 61,7 | 128,1 |
| 73025 | Lintas Media | 473,7 → 414,8 | 70,2 → 715,7 | 63,8 | 125,8 |
| 48532 | Faznet | 477,2 → 527,6 | 141,0 → 716,6 | 60,5 | 124,1 |
| 55749 | RingNet | 464,5 → 526,3 | 58,6 → 487,3 | 62,5 | 128,3 |
| **Rata-rata** | | **477,6 → 491,3** | **112,1 → 625,8** | **61,8** | **127,0** |

Catatan baris rata-rata:

- **Upload: 112,1 → 625,8 Mbps (naik 5,6×).** Ini efek langsung offload ke edge Cloudflare.
- **Download: 477,6 → 491,3 Mbps (+2,9%).** Klien uji jenuh di ±0,5–0,8 Gbps, jadi download tidak bisa lebih tinggi dari line klien. Yang penting: beban VPS turun drastis, server tidak lagi menjadi batas.
- **Beban VPS per uji: 670–1.022 MB → 0,45–0,49 MB.** Rasio offload payload ±1:1.200 (539,2 MB payload : 0,47 MB VPS).
- Ping B lebih tinggi karena diukur lewat front gateway TLS (port 8790, ada handshake tambahan) — bukan karena data lewat Cloudflare. Latensi murni ke VPS tetap ±66 ms (uji E-J: median 66,02 ms).
- Semua 18 run (9 server × 2 mode) selesai dengan exit code 0, tanpa kegagalan.

---

## 3. Semua Hasil Uji Sebelumnya (urut tanggal)

### 3.1 Uji front, Sesi 3 — 24 Nov 2026, 03:00–03:40 UTC

| Uji | Klien | Ping | Download | Upload | Payload dilayani |
|---|---|---|---|---|---|
| T1 | CLI resmi Ookla 1.2.0.84, server 74964 | 64,6 ms | 447,2 Mbps | 149,7 Mbps | VPS |
| T1b | CLI resmi Ookla 1.2.0.84, server 66281 | 64,1 ms | 437,5 Mbps | 138,2 Mbps | VPS |
| T2 | speedtest-cli 2.1.3 murni (stock) | 129,1 ms | 580,0 Mbps | 117,1 Mbps | DL = edge; UL = VPS * |
| T3 | speedtest-cli 2.1.3 + transport hybrid | 130,8 ms | 559,5 Mbps | 603,0 Mbps | Worker (DL + UL) |
| T4 | speedtest-cli 2.1.3 + hybrid, server 74964 | 129,8 ms | 556,6 Mbps | 710,7 Mbps | Worker (DL + UL) |

\* Klien stock mengirim seluruh POST sebelum membaca respons, jadi uploadnya tidak bisa dialihkan (perilaku urllib, bukan bug server). Download bisa dialihkan lewat redirect 302. Itulah sebabnya T3/T4 (transport hybrid) memindahkan upload juga.

Atribusi byte T1: VPS rx 265,6 MB / tx 621,0 MB (semua payload lewat VPS).
Atribusi byte T4: VPS rx 0,15 MB / tx 0,31 MB — 539,2 MB payload 100% di edge (rasio ±1:1.000).

### 3.2 Verifikasi ulang setelah push ke GitHub, Sesi 4 — 24 Nov 2026

| Uji | Mode | Ping | Download | Upload | Payload |
|---|---|---|---|---|---|
| T2 | stock | 129,6 ms | 544,8 Mbps | 132,4 Mbps | DL edge; UL VPS |
| T3 | hybrid | 124,5 ms | 452,2 Mbps | 778,6 Mbps | Worker (DL + UL) |
| T4 | hybrid (server 74964) | 129,4 ms | 573,0 Mbps | 757,5 Mbps | Worker (DL + UL) |

Total 4 uji download di sesi ini: eth0 VPS hanya 14,7 MB — 4×387,7 MB payload tidak pernah menyentuh VPS. Bukti redirect langsung: `random1000x1000.jpg` → 302 ke `workers.dev` → HTTP/2 200 `server: cloudflare`, `cf-ray: …-HKG`.

### 3.3 Ukur throughput edge Cloudflare murni (E-J) — 24 Nov 2026

Dari klien eksternal ke gateway hybrid (mode `both`, total 3,6 detik):

| Jalur | Throughput |
|---|---|
| Download WebSocket (6 koneksi paralel) | **600,1 Mbps** |
| Upload WebSocket (4 koneksi paralel) | **368,7 Mbps** |
| Download HTTP (3 paruh × 16 MiB) | 536,2 Mbps |
| Upload HTTP (16 MiB tunggal) | 241,4 Mbps |

- Rasio offload sesi ini: **1:27.337** (117,4 MB payload vs 4.296 byte kontrol di VPS).
- Latensi VPS (10 sampel): min 64,88 ms, median 66,02 ms · TTFB edge: min 12,51 ms.
- Biaya CPU Worker terukur (Cloudflare GraphQL): upload 25 MiB = 259 ms CPU (HTTP) vs 85 ms (WebSocket) → transport utama yang dipakai adalah WebSocket; 0 error, 0 `exceededCpu`.

### 3.4 Sesi hybrid penuh (E-I) — 24 Nov 2026

Sesi uji web-client lengkap: **56 MiB payload dilayani edge vs 3.653 byte di VPS** — rasio offload ±1:16.075 (99,99% byte sesi tidak menyentuh VPS).

### 3.5 Kampanye E-M — 24 Nov 2026

Tabel utama di Bagian 2. Ringkasan: 18/18 run sukses (9 server × 2 mode), 0 kegagalan; Mode A 0 request Worker (terbukti lewat rerun terisolasi server 66281), Mode B 91–364 request Worker per uji. Server 72945 (BLiP) tidak ikut karena hostname servernya tidak resolve (bukan kegagalan server ini).

### 3.6 Validasi protokol & kapasitas (lab) — 4 Nov 2026

CLI resmi Ookla 1.2.0.84 vs server pengganti (SpeedtestServer) dan vs binary resmi OoklaServer 2.11.5.2:

| Target uji | Download | Upload | Exit |
|---|---|---|---|
| CLI → binary resmi OoklaServer (referensi) | 67,0–68,8 Gbps | 37,6–42,3 Gbps | 3/3 sukses |
| CLI → SpeedtestServer (pengganti) | 18,4–21,7 Gbps | 13,6–15,7 Gbps | 3/3 sukses |

- Packet loss 0 di semua run. Identitas server terverifikasi (`ss -tlnp`: proses node di :8080; daemon resmi dimatikan saat uji).
- **Host Tester speedtest.net: 10/10 PASS** untuk pengganti DAN 10/10 untuk binary resmi — hasil baris-per-baris identik (banner versi sama: `2.11 (2.11.5) 2026-06-04.1737.7d0993d`). Kedua verdict: "Server is publicly available and properly configured."
- Paritas protokol: 35/37 uji byte-identical (2 perbedaan memang diharapkan: stempel waktu PONG & payload acak).
- **Hasil asli terpublikasi di speedtest.net** (bukti kompatibilitas 1:1 — ID server nyata, hasil masuk ke situs resmi Ookla):
  - `https://www.speedtest.net/result/c/55713fba-3d50-4558-95f2-7afbde18107a` — DL 19.054,83 Mbps / UL 13.268,76 Mbps / ping 0,081 ms / loss 0
  - `https://www.speedtest.net/result/c/572dd200-a096-4093-9363-1f086a6cf526` — DL 18.090,00 Mbps / UL 13.496,00 Mbps
  - `https://www.speedtest.net/result/c/42afd2e9-6b73-4729-9b1d-caaf8efbf715` — DL 17.957,06 Mbps / UL 12.747,58 Mbps
  - `https://www.speedtest.net/result/c/cd393af6-2b69-4d23-b576-a73894ce6f15` — DL 18.439,67 Mbps / UL 12.804,00 Mbps

### 3.7 Perbaikan slow upload & konfirmasi Host Tester — 23–24 Nov 2026

- Masalah `max_upload` Host Tester (timeout 10 detik saat upload lambat dari tester) diperbaiki dengan early-answer 2,5 detik + `size=<panjang sebenarnya>`. Verifikasi: upload 2 MB dithrottle 20 KB/s → sekarang jawaban `200 size=2000000` dalam 3,0 detik (sebelumnya: timeout, 0 byte).
- Host tester clone setelah perbaikan: **10/10 PASS, 12,1 Gbps down / 2,2 Gbps up**.
- Konformansi Worker: 62/62 uji WS+HTTP lulus; ulang setelah deploy produksi: 55/55 konformansi, 11/11 token, 17/17 hardening — semua PASS.

### 3.8 Produksi v1.3 (sesi 9, 25 Nov 2026) — angka produksi pertama

| Pengukuran | Nilai |
|---|---|
| Klien stock `--mini` (VPS murni) | 218,5 Mbps DL / 127,1 Mbps UL |
| Klien hybrid 32/8 thread | **600,1 Mbps DL / 339,7 Mbps UL** |
| CLI resmi Ookla (jalur NetGauge VPS :8080, murni) | **470,9 / 448,8 Mbps DL · 170,3 Mbps UL** |
| Edge 8-stream paralel (8 worker) | **2,27 Gbps — plafon arsitektur** |
| Root-cause plafon lama <1 Gbps | rule nftables SYN limit 260/s burst 5 → dinaikkan 2000/s burst 64: koneksi paralel 3.137 ms → 72 ms (**43×**), SYN retrans 13.958 → 0 |

Catatan: angka klien di baris 1–2 diukur saat model budget v1.3 masih ada. Sejak v1.4 (keputusan operator, 26 Nov) `HYBRID_VPS_DL_BUDGET_MBPS` **dihapus permanen** — VPS berjalan pada potensi penuh tanpa throttle, Cloudflare hanya menambah kapasitas di atasnya (share interleave, teruji unit 13/13 + E2E 4/4 + full-stack 12/12 dengan klien nyata).

---

## 4. Apakah Target Project Tercapai?

| Target | Status | Bukti |
|---|---|---|
| Penggantian 1:1 OoklaServer (protokol resmi) | **TERCAPAI** | CLI resmi exit 0; Host Tester 10/10; paritas byte 35/37; hasil masuk ke speedtest.net asli |
| Kemampuan server ≥ 2 Gbps | **TERCAPAI** | 18,4–21,7 Gbps (CLI resmi), 12,1 Gbps (host tester), hasil terpublikasi ±19 Gbps |
| Hybrid VPS + CF Worker aktif | **TERCAPAI** | Payload offload ±1:1.200; upload klien naik 5,6×; 9/9 server lulus |
| Pool Worker siap diperluas | **TERCAPAI** | deploy-pool 1–100 worker, auto-scale di gateway, deflection antar worker |
| Identitas server = VPS | **TERCAPAI** | Ping & pemilihan server mendarat di 45.126.249.250 (bukti DNS + journal) |
| Plafon agregat ≥ 2 Gbps | **TERCAPAI** | Edge 8-stream **2,27 Gbps** (produksi, §3.8); agregat v1.4 = VPS penuh (~470–490 Mbps jalur NetGauge) + edge di atasnya |
| VPS potensi penuh tanpa budget | **TERCAPAI** | v1.4: `HYBRID_VPS_DL_BUDGET_MBPS` dihapus; lane VPS tanpa throttle (uji share=1.0 lane lokal uncapped) |
| End-to-end dari klien uji HK | **DIBATASI LINE KLIEN** | Klien mentok ±0,5–0,8 Gbps; bukti atribusi menunjukkan VPS bukan bottleneck (99,9%+ payload di edge) |

Penjelasan baris terakhir (jujur dan singkat): uji end-to-end memakai sandbox Alibaba Hong Kong yang line-nya terbatas (±0,5–0,8 Gbps), jadi angka ujung-ke-ujung dari klien itu tidak bisa melebihi line klien sendiri. Yang terbukti lebih dari 2 Gbps: plafon agregat edge (2,27 Gbps, §3.8), kemampuan perangkat lunak server (18,4–21,7 Gbps, §3.6), dan hasil terpublikasi ±19 Gbps. Dengan klien yang line-nya di atas 2 Gbps, agregat v1.4 (VPS penuh + edge paralel) yang menjadi batas atasnya — bukan lagi VPS sendirian.

---

## 5. Catatan Jujur

1. CLI resmi Ookla memakai protokol NetGauge TCP mentah yang tertutup — payload CLI resmi tidak bisa di-offload ke Worker. Karena itu Mode A (CLI resmi) = jalur VPS murni; Mode B memakai transport hybrid dengan engine pengukuran 100% asli (hanya jalur kirim/terima yang diganti, hitungan kecepatan tidak diubah).
2. Ping Mode B dihitung lewat front gateway TLS (port 8790) sehingga ±127 ms; latensi langsung ke VPS tetap ±66 ms (E-J: median 66,02 ms, min 64,88 ms).
3. Dari 10 server daftar operator, 9 diuji end-to-end; 72945 (BLiP) dikecualikan karena hostname servernya tidak resolve.
4. Dua errata kecil di laporan riset lama (uji E-G memakai clone host tester lokal; 1 unit test jest gagal sudah ada sebelum perubahan) tidak berhubungan dengan angka-angka di dokumen ini.
5. Dokumen ini disusun dari bukti uji yang terdokumentasi di repo. Angka berasal dari hasil uji nyata tanggal 4, 23–25 November 2026. Deploy ulang ke VPS (v1.5.2) dilakukan 26 November 2026 setelah VPS aktif kembali, lewat jalur ringan: push GitHub → `git pull` di VPS → `./install.sh --start`. Verifikasi pasca-deploy: daemon :8080 aktif (probe protokol HELLO), gateway :8790 mode hybrid, pool 100 worker ter-deploy ulang penuh (fullRedeploy + secret baru di semua worker), uji unduh edge 302→200 OK, unit legacy port-80 dihapus, timer auto-update harian aktif.

---

## 6. File Bukti (audit trail)

| Bukti | Lokasi di repo |
|---|---|
| Kampanye A/B 9 server + atribusi + bukti DNS | `hybrid/lab/evidence/e-m-official-cli-campaign/` (summary.json, a-*.cli.json, b-*.cli.json, attribution.txt, dns-proof.txt) |
| Uji front T1–T4 | `docs/SPEEDTEST_FRONT_TEST_REPORT_2026-11-24.md` + `hybrid/lab/evidence/e-k-speedtest-front/` |
| Verifikasi pasca-push | `hybrid/lab/evidence/e-l-post-push-verification/` |
| Ukur edge + CPU Worker | `hybrid/lab/evidence/e-j-real-edge/` |
| Sesi hybrid penuh (E-I) | `hybrid/lab/evidence/e-i-production-gateway/`, `e-i-results.jsonl` |
| Validasi lab & CLI resmi | `validation/PERFORMANCE_REPORT.md`, `validation/OFFICIAL_CLI_RESULTS.md`, `validation/FINAL_REPORT.md` |
| Host Tester resmi | `validation/HOST_TESTER_COMPARISON.md`, `validation/evidence/hosttester-run-20261124.json` |
| URL hasil terpublikasi | `validation/PUBLISHED_RESULT_URLS.md` |
| Batas platform Worker | `hybrid/reports/WORKERS_LIMITS.md`, `docs/WORKER_POOL.md` |
| Angka produksi v1.3 + model share v1.4 | `docs/HYBRID_ASSIST_MODE.md` (§5.2 produksi, §1 konsep tanpa budget) |
