# NATIVE WORKER VALIDATION — Metode, Acceptance Gate, Seluruh Run, dan Atribusi Byte

**Run:** `audit-2026-11-27` (26–27 Nov 2026, 17:00–17:30 UTC) · evidence: `hybrid/lab/evidence/historical-native-audit/audit-2026-11-27/`
**Integritas pengukuran:** atribusi 3 sisi (client / VPS / Worker) dengan jendela terisolasi; byte dalam B/MB/MiB eksplisit; Mbps desimal; UTC; seluruh angka traceable ke artifact + checksum (`lab-meta/checksums.txt`).

---

## 1. Metode

| Elemen | Keterangan |
|---|---|
| Client resmi | `speedtest` 1.2.0.84 (ea6b6773cf) linux-x86_64 — binary tarball repo, **tidak dimodifikasi**; identitas via `--version` |
| Isolasi lab | `unshare --user --map-root-user --mount` + bind-mount `/etc/hosts` (entri daftar server operator → 45.126.249.250; `results.speedtest.net` → 127.0.0.1); discovery resmi (`cli.speedtest.net`) dibiarkan asli — bukti `run-*-dns-proof.txt` |
| Non-publishing | 4/4 run: `persisted=false`, `result.url=null`; egress hasil diblokir di namespace; tidak ada hasil lab yang dikirim ke Ookla |
| Sisi VPS (read-only) | delta `/sys/class/net/eth0/statistics/{rx,tx}_bytes` pre/post via uaeg MCP; `journalctl -u speedtestserver -o cat` (stat `conn_close` per koneksi); tanpa restart service |
| Sisi Worker | CF GraphQL `workersInvocationsAdaptive` per menit, seluruh script, jendela diperlebar ±1 menit |
| Sisi client | JSON output CLI (dl/ul bytes, ping, jitter, loss, server.ip, persisted) |
| Kontrol lokal | workerd (wrangler 4.168.0) untuk H0/H1; clone z.ai v1.0.1 (branch `audit/z-ai-official-validation` repo SpeedtestHost-Tester) sebagai klien Host-Tester pembanding |

## 2. Acceptance gate (A1–A12)

| Gate | Kriteria | Hasil audit ini |
|---|---|---|
| A1 Historical truth | seluruh klaim 6–26 Nov direkonsiliasi dengan raw artifacts; client/runtime diidentifikasi atau UNKNOWN | **PASS** — ledger lengkap; 1 klaim "official web clients" direklasifikasi DOCUMENTATION_OVERCLAIM (koreksi eksplisit) |
| A2 Regression | perubahan perilaku dikaitkan commit/config via differential test | **PASS** — NO_REGRESSION; selisih perilaku = INTENTIONAL_SECURITY_HARDENING + 2 CONFIGURATION_DIFFERENCE (lihat REGRESSION.md §2) |
| A3 Client matrix | hasil per platform terpisah, tanpa generalisasi Linux | **PASS** — matriks per platform; hanya CLI Linux yang VERIFIED; lainnya NOT_TESTED/BLOCKED_BY_REGISTRATION/BLOCKED_BY_ACCESS berlabel |
| A4 Free feasibility | dokumen primer aktual diperiksa | **PASS** — 8 halaman primer Cloudflare + 5 halaman Ookla + man page binary resmi, per 27 Nov 2026, dengan tanggal akses |
| A5 Official client integrity | client asli tak dimodifikasi; endpoint sah; lab non-publishing | **PASS** — binary utuh; hosts-override hanya di namespace lab atas daftar yang diberi operator; discovery asli; `persisted=false` 4/4 |
| A6 Native baseline | VPS melayani DL/UL native tanpa Worker | **PASS** — H3 4/4 exit 0; byte client ≈ delta eth0 (toleransi overhead TCP/TLS ~7–8% dijelaskan) |
| A7 Native DL hybrid | 1 fase DL native: byte VPS + edge nyata bersamaan, non-relay | **BLOCKED_BY_PROTOCOL + BLOCKED_BY_FREE_PLAN** — Worker 0 request pada seluruh jendela DL |
| A8 Native UL hybrid | idem fase UL | **BLOCKED** — idem |
| A9 Full session native hybrid | A7+A8 dalam satu sesi resmi sama | **BLOCKED** — tidak ada jalur; dan **tidak pernah ada di masa lalu** (bukti historis + replay) |
| A10 Reliability | health/fallback/quota/stream/security/regression suite tak rusak | **PASS** — hardening 16/16, pool 8/8, conformance 55/55 (2 snapshot), token teruji live, gateway/pool/kuota sehat |
| A11 Operational safety | tanpa perubahan produksi tanpa izin; secret terlindungi; rollback terdokumentasi | **PASS** — akses read-only; tidak ada mutasi produksi oleh audit; evidence ter-sanitasi (token di-redact) |
| A12 Public readiness | izin/registrasi Ookla + validasi pasca-registrasi | **BLOCKED_BY_REGISTRATION** — server tidak terdaftar; host tester resmi vs VPS sudah VERIFIED-OPERATOR (prasyarat baik) |

**Kesimpulan gate:** A1–A6, A10–A11 PASS; **A7–A9 tetap BLOCKED (dua akar independen)**; A12 menunggu keputusan registrasi operator. Konsisten dengan audit 26 Nov — kini dengan bukti independen baru dan koreksi framing historis.

## 3. Seluruh run baru (matriks atribusi byte)

| Run | Client/versi | Source SHA | Mode | Transport | DL VPS B | DL Edge B | UL VPS B | UL Edge B | Overlap | Client dl/ul | Latency/loss | Outcome | Evidence |
|---|---|---|---|---|---:|---:|---:|---:|---|---|---|---|---|
| h3-r1 | CLI resmi 1.2.0.84 | prod `b629642` | native | NetGauge TCP+UDP → VPS:8080 | 533.143.005 (tx) | **0** | 228.810.148 (rx) | **0** | n/a (edge 0) | 481,6 Mbps / 506.052.502 B; 126,1 Mbps / 199.587.854 B | 59,2 ms; loss 0,38% | exit 0; dmon 42 conn; bytesDown 573.581.518 B, bytesUp 202.032.459 B; Worker req **0** | `h3-official-cli-vps/run-r1-*` |
| h3-r2 | idem | idem | native | idem | 534.015.182 | **0** | 198.288.280 | **0** | n/a | 440,9 Mbps / 505.890.428 B; 131,3 Mbps / 170.934.716 B | 64,2 ms; loss 0,45% | exit 0; dmon 34 conn (jendela journal memotong conn upload — eth0 rx otoritatif); Worker req **0** | `run-r2-*` |
| h3-r3 | idem | idem | native | idem | 649.006.259 | **0** | 100.184.722 | **0** | n/a | 433,8 Mbps / 622.467.744 B; 152,4 Mbps / 72.908.452 B | 65,7 ms; **loss 67,06%** | exit 0; dilaporkan apa adanya (run back-to-back; late-window journal +30–90 s: 40 conn, bytesUp 75.842.884 B); Worker req **0** | `run-r3-*` |
| h3-trial | idem | idem | native | idem | — | **0** | — | **0** | n/a | 450,3 / 462.929.944 B; 150,1 / 221.274.923 B | 64,8 ms; loss 0,39% | exit 0; `persisted=false` | `trial-66281.cli.json` |
| h2 | probe custom `hybrid-probe/1.0` | prod | hybrid | gateway API + WSS edge (token) | — | 58.720.256 (payload) | 4.780 (kontrol; eth0 ±28 KB termasuk overhead) | (termasuk di edgeBytes) | n/a | DL 6×8 MiB + UL 4×2 MiB via WS edge | lat VPS ~64 ms; TTFB edge 591 ms | exit 0; 3 invocations Worker 0 error; offload **1:12.284,6**; guid receipt tersimpan | `h2-hybrid-probe/` |
| h1-old | clone z.ai v1.0.1 | `d6b5f1e` (open) | lab | HTTP legacy + WSS (front lokal :8793) | 0 (lab lokal) | 1,25 GB | 0 | 0 | n/a | DL 1460,63 Mbps / 754 MB; UL 792,31 Mbps / 524 MB | 1,5 ms | 10/10 — replay klaim E-G sukses | `h1-eg-replay/` |
| h1-testenv | idem | HEAD (legacy ON, tanpa secret) | lab | idem | 0 | 1,25 GB | 0 | 0 | n/a | DL 1639,85 / 844 MB; UL 934,80 / 436 MB | 0,4 ms | 10/10 — NO_REGRESSION kode | idem |
| h1-prod | idem | HEAD (secret + legacy OFF) | lab | idem | 0 | 0 | 0 | 0 | n/a | — | — | **3/6** — ws 401; legacy 404 — batas hardening disengaja | idem |
| h0-old | conformance.mjs | `d6b5f1e` (open) | lab | HTTP+WSS+hybrid | — | — | — | — | — | — | — | **55/55** | `h0-worker-differential/` |
| h0-new | conformance.mjs | HEAD test-env | lab | idem | — | — | — | — | — | — | — | **55/55**; hardening 16/16; pool 8/8 | idem |

**Pembacaan atribusi:** pada semua run H3, byte client ≈ byte VPS (selisih 7–8% = framing TCP/TLS + koneksi kontrol + fase UDP; arah benar: DL client = TX server, UL client = RX server — lihat `run-*-vps-eth0.txt` vs `run-*-cli.json`). Worker 0 request pada seluruh jendela H3 (GraphQL tanpa baris; lihat `run-*-worker-graphql.json`). Tidak ada angka agregat dari dua benchmark terpisah; offload ratio H2 dihitung payload-vs-kontrol sesi yang sama.

## 4. Risiko & catatan

| # | Risiko/catatan | Tingkat |
|---|---|---|
| V-1 | Run H3 dieksekusi back-to-back → r3 melaporkan UDP loss 67,06% (loaded-latency/loss di bawah beban sisa). DILAPORKAN APA ADANYA; run r1/r2 (jeda 20 s + celah) loss 0,38–0,45%. Rekomendasi: beri jeda ≥30 s antar run untuk pengukuran loss | minor metodik |
| V-2 | Journal window r2/r3 memotong koneksi upload yang ditutup belakangan (daemon menutup sesi setelah 30–90 s) — delta eth0 adalah angka otoritatif untuk UL; journal late-window disertakan di metadata | minor metodik |
| V-3 | GraphQL `workersInvocationsAdaptive` agregasi per menit — jendela diperlebar ±1 menit; dengan traffic idle (≈1–3 req/jam) tidak ada kontaminasi jendela | kecil |
| V-4 | Worker-3..100 belum di-probe satu-per-satu (R-6 warisan audit 26 Nov); sinkron REST melaporkan konvergen 100/100 | minor |
| V-5 | Klaim "official web clients" pada laporan riset 6 Nov belum punya errata eksplisit — disarankan patch docs 1 kalimat (REGRESSION.md §5.1) | minor dokumentasi |

## 5. Rekomendasi tindak lanjut

1. Pertahankan status quo dua-jalur (A6 + lane custom) — tidak ada perubahan kode yang dibutuhkan.
2. Terapkan koreksi dokumentasi 1 kalimat untuk klaim "official web clients" (docs-only, branch ini sudah menyediakan landasannya).
3. Bila operator mengejar client resmi secara publik: mulai proses registrasi Speedtest Server Network (VPS Jalur A sudah lolos host tester resmi 4/4 run — prasyarat teknis baik); setelah terdaftar, ulangi matriks platform web/mobile dengan server terdaftar (label `NATIVE_VPS_ONLY`/`NATIVE_EDGE_ONLY` akan tetap berlaku — satu entri = satu endpoint).
4. Pantau dua peristiwa yang dapat mengubah verdict `BLOCKED_BY_FREE_PLAN`: GA inbound-TCP Workers, dan perubahan eligibility Spectrum Free (changelog Cloudflare).
5. Untuk pengukuran loss serupa berikutnya: jeda ≥30 s antar run (V-1).
