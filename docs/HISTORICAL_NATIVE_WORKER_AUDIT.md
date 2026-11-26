# HISTORICAL NATIVE WORKER AUDIT — Kebenaran Historis, Regresi, dan Interoperabilitas Client Native Resmi

**Tanggal audit:** 26–27 November 2026 (17:00–17:30 UTC eksekusi lab; laporan final 27 Nov WIB)
**Basis:** `master@0ac51ac1ad3022523c616948b35a3879ebc2c5de` (VERSION 1.5.2) — diverifikasi sebagai HEAD master saat eksekusi; runtime VPS `/opt/speedtest-hybrid` = `b629642` (selisih 1 commit docs-only, bukan source drift).
**Metode:** rekonstruksi bukti historis lintas commit (`git show` pada 28 SHA referensi terverifikasi), differential audit A/B/A pada workerd lokal, replay terkontrol, uji live 3-sisi (client + VPS + Worker) terhadap produksi, riset dokumentasi primer Cloudflare/Ookla per 2026-11-27.
**Evidence run ini:** `hybrid/lab/evidence/historical-native-audit/audit-2026-11-27/` (metadata, checksums, artefak mentah ter-sanitasi).
**Disiplin:** seluruh akses VPS/Cloudflare read-only; tidak ada restart service, deploy, perubahan DNS, atau rotasi secret yang dilakukan audit ini; hasil uji pra-publikasi non-publishing (`persisted=false`, `results.speedtest.net` diblokir di namespace lab).

---

## 1. Ringkasan eksekutif

> **Jawaban atas pertanyaan inti: keberhasilan historis "Speedtest dengan bantuan Cloudflare Worker" TIDAK PERNAH berasal dari client resmi Ookla yang tidak dimodifikasi.** Seluruh byte payload Worker dalam sejarah repo (E-G, E-I, E-J, E-K T3/T4, E-M mode B, front test T2/T3) berasal dari client **custom/clone**: probe `hybrid-probe.mjs`, sivel speedtest-cli 2.1.3 stock (hanya download via 302), wrapper `speedtest-cli-hybrid.py`, dan **clone Host Tester z.ai v1.0.1** (bukan produk resmi Ookla). Sebaliknya, setiap run **client resmi** yang tervalidasi (E-E, E-K T1/T1b, E-M mode A + run terisolasi 66281, sesi 9, dan 4 run baru audit ini) selalu 100% NetGauge TCP di daemon VPS `:8080` dengan **0 request Worker**.
>
> **Tidak ada regresi source code.** Differential audit A/B/A menunjukkan worker HEAD identik secara perilaku konformance dengan worker 6 Nov ketika konfigurasinya disamakan (55/55 dan 10/10 di kedua versi). Perbedaan perilaku nyata (legacy 404, token 401, cap 25 MiB) adalah **hardening konfigurasi yang disengaja** (G-4/G-7/G-8/G-12, 23–24 Nov) — mekanisme token bahkan sudah ada sejak commit pertama Worker (`d6b5f1e`, "open lab mode" karena secret belum dipasang). Verdict audit 26 Nov (`NATIVE_VPS_ONLY + CUSTOM_CLIENT_ONLY`) **kokoh dan direkonfirmasi** — ditambah satu koreksi framing: klaim awal laporan 6 Nov tentang "**official web clients**" dan "**official host-tester suite**" adalah **overclaim dokumentasi** yang telah dikoreksi errata `b053f27` untuk E-G, namun baris "official web clients" baru terkoreksi implisit (dokumen ini mengekspilkannya).
>
> **Status akhir tetap:** jalur native = `NATIVE_VPS_ONLY` (live 3/3 run baru, Worker 0 request); jalur hybrid = `CUSTOM_CLIENT_ONLY` (live hari ini, offload 1:12.284); `NATIVE_HYBRID` = `BLOCKED_BY_PROTOCOL + BLOCKED_BY_FREE_PLAN` (dikonfirmasi ulang dari dokumentasi primer per 27 Nov 2026; tidak ada mekanisme baru sejak audit 26 Nov).

## 2. Timeline kejadian (dari bukti git + evidence)

| Tanggal | Peristiwa | Bukti |
|---|---|---|
| 4 Nov | Daemon native TypeScript + NetGauge; battery CLI resmi **publishing** vs STS lokal (satu-satunya run terpublikasi; pra-Worker) | `55f89a6`→`8912b07`; `validation/PUBLISHED_RESULT_URLS.md` |
| 6 Nov | Worker TypeScript pertama (NetGauge-over-WSS + HTTP legacy), gateway, probe; **eksperimen E-A..E-I** | `d6b5f1e`, `2fd1c5d`, `64e3f55` |
| 6 Nov | Laporan riset menyebut "official host-tester suite 10/10" (E-G) dan "Official web clients: session-level selection" — **keduanya dari clone/probe, bukan client resmi** | `ff48691` §3/W-9; errata `b053f27` |
| 23–24 Nov | **Hardening Worker**: Bearer token (G-8), LEGACY_HTTP_ENABLED=false (G-7), caps 25 MiB (G-4/G-12), backpressure; errata E-G (z.ai v1.0.1; upload.php bukan WS; front lokal) | `64abbc8`, `a93b7df`, `0bf2b1b`, `0476e7c`, `b053f27` |
| 24 Nov | E-K (CLI resmi T1/T1b 100% VPS; sivel T2; wrapper T3/T4 edge) dan **E-M kampanye 18 run** — CLI resmi 9/9 via VPS, 0 request Worker (run terisolasi 66281) | `e93da35`, `1c3fea1`, `9c7ff76` |
| 24 Nov (malam) | Host tester **resmi** speedtest.net oleh operator: 4/4 run semua check lulus vs **VPS saja** (tidak pernah ke Worker) | `docs/HOST_TESTER_RUNBOOK.md` §5; `6d5f9c7` |
| 25 Nov | Worker pool 100, assist lane v1.3, full-potential v1.4, v1.5 dynamic sync | `ecbf11f`, `2fd492f`, `308bcfe`, `50516dc` |
| 26 Nov 13:42 UTC | v1.5.2 full redeploy pool 100 + secret baru | `b629642`, `0ac51ac` |
| 26 Nov 15:05–15:16 UTC | **Audit 26 Nov** → verdict NATIVE_VPS_ONLY + CUSTOM_CLIENT_ONLY | `1d6e802` (branch `audit/native-hybrid-2026-11-26`) |
| 26 Nov 15:51–16:11 UTC | Token CF lama gagal ("Unable to authenticate"); operator **merotasi kredensial CF**; gateway restart 2×; sync konvergen 100/100 | journal gateway (live, via UAEG); env-watcher `lastChangeKeys` |
| **26–27 Nov** | **Audit ini** (historis + differential + lab + live) | `audit/historical-native-worker-2026-11-27` |

## 3. Rekonsiliasi klaim historis utama

| Klaim historis | Kebenaran (bukti) | Status |
|---|---|---|
| E-G 6 Nov: "814 MB DL / 468 MB UL / Host Tester 10/10" | Client = **clone z.ai v1.0.1** (`speedtest-host-tester.mjs`) vs **front LOKAL** (edge-front.mjs :8793 → workerd :8790, open mode). Upload via `upload.php` POST (213 POST, 0 event `ng_upload`), bukan WS-NetGauge. Tidak reprodusibel di edge CF nyata. **Direproduksi audit ini 10/10** (DL 1460 Mbps/754 MB, UL 792 Mbps/524 MB, 1,25 GB) di postur yang sama | `e-g-host-tester-vs-worker/host-tester-output.txt`; errata `b053f27`; replay `h1-eg-replay/` | 
| Laporan 6 Nov: "official host-tester suite / Speedtest Host Tester v1.1.0" | Tester riil = z.ai clone **v1.0.1** (output sendiri). Errata 24 Nov mengoreksi identitas + transport | `ff48691` W-9; `b053f27` | **DOCUMENTATION_OVERCLAIM (dikoreksi errata)** |
| Laporan 6 Nov: "Official web clients: session-level selection — Worker serves the whole measurement" | **Tidak ada satu pun run client web resmi** di seluruh repo; evidence yang dirujuk (E-I, E-G) = probe custom + clone. Ekstrapolasi arsitektur disajikan sebagai temuan | `ff48691` kriteria 3 | **DOCUMENTATION_OVERCLAIM (koreksi implisit — dieksplisitkan di sini)** |
| E-D/E-E 6 Nov: "CLI resmi ke CF endpoint gagal" | Dikonfirmasi: CF menjawab HTTP 400 → CLI `Protocol error: Did not receive HELLO` → `NoServers` exit 2; mixed-list E-E memilih STS (26,15 GB di VPS), entri CF gagal seleksi "Latency test failed" | `e-d-all-non-netgauge/cli.stderr`, `e-e-mixed-cf-plus-sts/cli.json` | **BUKTI EMPIRIS BLOCKED_BY_PROTOCOL CLI** |
| E-I: 56 MiB payload vs 3.653 B VPS | Client = **probe custom** (`hybrid-probe/1.0`); lab 6 Nov = workerd lokal; varian produksi 23 Nov memakai **workerd stand-in**, bukan edge nyata | `e-i-hybrid-session.json`, `e-i-production-gateway/attribution.json` | **CUSTOM_CLIENT_ONLY** |
| E-J 24 Nov: offload edge nyata 117.440.512 B | Client = probe custom; conformance 55/55; offload ≈1:27.337 — **sah untuk lane custom, bukan native** | `e-j-real-edge/` | **CUSTOM_CLIENT_ONLY** |
| E-M 24 Nov: 18 run, CLI resmi "berhasil" | TEST-A (CLI resmi) = 100% VPS, 0 Worker; TEST-B (wrapper) = offload. Kriteria literal operator ("Worker melayani saat run resmi") **tidak tercapai — by design** | `attribution.txt`, `iso-a-66281.meta.json` | **NATIVE_VPS_ONLY + CUSTOM_CLIENT_ONLY** |
| "Status v1.5.2: 100 Worker healthy, mode hybrid" | Deployed=100, sync ok, kuota 0,1% — status **deployment**, bukan bukti sesi native memakai edge (0 request Worker terbukti berulang) | live `/api/health`; H3 run r1–r3 | **DEPLOYED ≠ SERVING_PAYLOAD (untuk native)** |

## 4. Root cause kesenjangan "dahulu berhasil, sekarang tidak"

1. **Klien berbeda, bukan regresi.** "Dahulu berhasil" = client custom/clone di lab open-mode; "sekarang gagal (untuk native)" = client resmi yang memang tidak pernah memakai Worker. Tidak ada kemampuan yang hilang dari client resmi (jalur native VPS tetap 100% sehat, terbukti 4/4 run baru).
2. **Postur konfigurasi berubah (disengaja).** Era 6 Nov: worker open mode (tanpa secret, legacy ON). Era 24 Nov+: secret + legacy OFF + cap 25 MiB (G-4/7/8/12). Client custom yang tidak beradaptasi (clone, sivel direct-to-worker) memang kini ditolak (401/404) — **karena itu desain security**, sedangkan jalur resmi klien custom adalah front :8790 (302 + token ter-embed + drain upload) yang tetap berfungsi (H2 hari ini).
3. **Dua blocker fundamental native tidak berubah** (riset primer 27 Nov): (a) protokol NetGauge CLI resmi tidak punya mekanisme endpoint alternatif/redirect/WS (bukti primer: man page CLI `-s/-o` hanya memilih dari server list; empiris: E-D, E-M iso, H3); (b) ingress TCP publik di Cloudflare tetap hanya via Spectrum (beta publik), "Free zones are not supported" (per 20 Nov 2026), UDP hanya Enterprise.

## 5. Kesimpulan per pertanyaan wajib operator

1. **Apakah dahulu pernah ada official client asli + Worker?** **TIDAK.** Tidak ditemukan satu pun run di manapun dalam riwayat repo. Semua bukti "Worker melayani payload" memakai probe/sivel/wrapper/clone.
2. **Apakah dahulu pernah ada client tanpa modifikasi tapi non-Ookla yang terlayani Worker?** **YA** — sivel stock 2.1.3 (download via 302 front; upload di-drain VPS) dan clone z.ai (lokal lab). Kontribusi aktual: 387,7 MB DL edge + 151,5 MB UL edge per run wrapper (E-M B); sivel: download-only ~387,7 MB edge, upload tetap VPS.
3. **Apakah ada regresi source/config terkonfirmasi?** **TIDAK** — `NO_REGRESSION` (H0: 55/55 & 10/10 di kedua versi bila konfigurasi disamakan). Perubahan perilaku = `INTENTIONAL_SECURITY_HARDENING` + 2 `CONFIGURATION_DIFFERENCE` terdokumentasi (cap 25 MiB → gambar >25 MiB di-capping oleh front, terobservasi counter `frontDownCapped`; port-80 legacy unit dihapus v1.5 — unit itu sendiri "silently never ran" menurut catatan installer, tidak ada client resmi yang memakainya).
4. **Hasil per platform resmi:** lihat `OFFICIAL_NATIVE_CLIENT_MATRIX.md` — CLI Linux 1.2.0.84 `NATIVE_VPS_ONLY` (VERIFIED); CLI Win/macOS, web, Android, iOS, desktop `NOT_TESTED`/`BLOCKED_BY_REGISTRATION`/`BLOCKED_BY_ACCESS` — **tidak ada generalisasi**; audit 26 Nov secara substansi tidak menggeneralisasi (framingnya sudah per-CLI), dokumen ini membuatnya eksplisit per platform.
5. **Apakah Cloudflare Free masih memungkinkan untuk salah satu official client?** **TIDAK ADA jalur payload** untuk client resmi mana pun dalam constraint (Free + client asli + non-relay). WSS/HTTP Worker tetap legal di Free — tetapi client resmi tidak memakainya, dan satu-satunya cara agar endpoint operator dipilih client resmi adalah registrasi direktori Ookla (`BLOCKED_BY_REGISTRATION`), yang bahkan lalu tetap menghasilkan `NATIVE_EDGE_ONLY` atau `NATIVE_VPS_ONLY` — bukan hibrida (satu entri server = satu endpoint).
6. **Apakah VPS + Worker bekerja bersamaan pada DL dan UL dalam sesi native yang sama?** **TIDAK — dan tidak pernah terbukti di masa lalu.** H3 hari ini: 3/3 run, Worker 0 request. A7/A8/A9 tetap BLOCKED.
7. **Spectrum?** Tetap opsi analisis terakhir: Free tidak didukung (protokol-per-plan per 19–20 Nov 2026); Pro/Business = 1 app/zone/port TCP tanpa TLS termination; UDP hanya Enterprise — packet-loss phase CLI tidak terlayani kecuali Enterprise. **Tidak dibeli/diaktifkan** (sesuai batas). Detail di matrix.
8. **Yang diubah/di-test/belum:** tidak ada perubahan kode (tidak ada regresi yang butuh perbaikan); yang diuji: H0 (A/B/A worker), H1 (replay E-G 3 postur), H2 (hybrid probe live), H3 (CLI resmi live ×4, 3-sisi); yang belum: platform web/mobile/desktop (butuh registrasi/perangkat). Keputusan operator yang tersisa: registrasi Ookla (komersial) dan/atau menerima arsitektur dua-jalur saat ini.

## 6. Rekomendasi

1. **Pertahankan arsitektur dua-jalur** (jalur A native VPS untuk client resmi; jalur B front+Worker untuk client HTTP/custom) — keduanya terverifikasi sehat hari ini.
2. **Jangan pernah mencantumkan "official client" pada klaim edge-offload** tanpa bukti run client resmi; gunakan label `CUSTOM_CLIENT_ONLY`.
3. Jika suatu saat mengejar client resmi lewat jalur sah: satu-satunya jalur adalah **registrasi Speedtest Server Network** (daemon harus lolos Server Tester resmi — sudah VERIFIED-OPERATOR 24 Nov untuk VPS Jalur A) — dan hasilnya tetap satu-endpoint-per-server (bukan hibrida), kecuali Ookla mengubah kontrak protokolnya.
4. Kualitas evidence: tambahkan pemeriksaan massal worker-3..100 (R-6 audit lama, masih berlaku) dan pantau changelog Cloudflare untuk GA inbound-TCP/ubah eligibility Spectrum — kedua hal itu adalah satu-satunya peristiwa yang bisa mengubah verdict `BLOCKED_BY_FREE_PLAN`.

---

Lampiran teknis: `HISTORICAL_NATIVE_WORKER_REGRESSION.md` (differential detail), `OFFICIAL_NATIVE_CLIENT_MATRIX.md` (matriks platform), `NATIVE_WORKER_VALIDATION.md` (gate + seluruh run + atribusi), evidence `hybrid/lab/evidence/historical-native-audit/audit-2026-11-27/`.
