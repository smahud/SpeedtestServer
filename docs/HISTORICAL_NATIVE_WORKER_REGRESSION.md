# HISTORICAL NATIVE WORKER REGRESSION — Differential Audit & Klasifikasi Temuan

**Run:** 26–27 Nov 2026 · **Baseline:** `master@0ac51ac` (v1.5.2) · **Snapshot pembanding:** `d6b5f1e` (Worker awal 6 Nov), `ff48691` (snapshot riset), hardening 23–24 Nov (`64abbc8`/`a93b7df`/`0bf2b1b`/`0476e7c`), HEAD.
**Metode:** worktree terisolasi + workerd lokal (wrangler 4.168.0), dependency terkunci, client tetap (conformance.mjs + clone z.ai v1.0.1 + CLI resmi 1.2.0.84 untuk jalur native). Tidak ada konfigurasi historis insecure yang diekspos ke endpoint publik (semua replay di 127.0.0.1).

---

## 1. Matriks A/B/A — same client × same contract × old/new × one variable

| # | Client (tetap) | Kontrak endpoint | Versi / postur | Variabel yang diubah | Hasil | Klasifikasi |
|---|---|---|---|---|---|---|
| 1 | `test/conformance.mjs` (55 check HTTP+WSS+hybrid) | seluruh permukaan worker | d6b5f1e open (legacy ON, tanpa secret) | — | 55/55 PASS | baseline |
| 2 | idem | idem | HEAD test-env (LEGACY_HTTP_ENABLED:true, cap 32 MiB, tanpa secret) | source 6 Nov → HEAD | **55/55 PASS** | **NO_REGRESSION** |
| 3 | clone z.ai Host Tester v1.0.1 (10 check) | legacy HTTP + WSS NetGauge | d6b5f1e open | — | 10/10, 1,25 GB (DL 1460,63 Mbps/754 MB; UL 792,31 Mbps/524 MB) | baseline (replay E-G sukses) |
| 4 | idem | idem | HEAD test-env | source | **10/10**, 1,25 GB | **NO_REGRESSION** |
| 5 | idem | idem | HEAD produksi (secret + legacy OFF + cap 25 MiB) | **konfigurasi** | **3/6** — ws→401 `missing-token`; /hi, latency.txt, random*.jpg, upload.php, crossdomain.xml→404 | **INTENTIONAL_SECURITY_HARDENING** (G-7/G-8) |
| 6 | `hybrid-probe.mjs` (custom, token via gateway mint) | gateway API + WSS+token | produksi live hari ini | — | 56 MiB edge, kontrol 4.780 B, 3 invocations Worker 0 error, offload 1:12.284,6 | jalur custom **berfungsi** (bukan regresi) |
| 7 | **CLI resmi 1.2.0.84** (unmodified) | NetGauge raw TCP :8080 VPS | produksi v1.5.2 hari ini | — | 4/4 run exit 0; Worker 0 request; eth0 VPS ≈ byte client | **NO_REGRESSION** jalur native |

## 2. Enam prioritas differential — hasil penelusuran

| Prioritas (master prompt §5) | Temuan | Klasifikasi |
|---|---|---|
| 1. `LEGACY_HTTP_ENABLED=false` — efek aktual? | Router HEAD (`hybrid/worker/src/index.ts`, blok legacy): jika flag false, seluruh path legacy (`/`, `/hi`, `/latency.txt`, `/crossdomain.xml`, `/upload.php`, `/speedtest/*`, `random*.jpg`) menjawab **404** daemon-shape. Bukan cuma WS: seluruh permukaan legacy mati di produksi. Kode d6b5f1e selalu menjalankan `handleLegacyHttp` (flag belum ada). Di **front** :8790, permukaan fungsional yang sama TETAP tersedia (latency.txt lokal; 302→`__down`; drain upload.php) sehingga klien HTTP jalur resmi tidak kehilangan fungsi — hanya klien yang menunjuk **langsung** ke worker yang ditolak | INTENTIONAL_SECURITY_HARDENING (G-7/K-7) |
| 2. Bearer/HMAC token — apakah client resmi mendukung? | **Tidak relevan untuk client resmi** (CLI resmi tidak pernah bicara HTTP/WS ke worker — E-D 400, E-M 0 wreq, H3 0 wreq). Untuk klien custom: token `v1~guid~exp~ip~sig` diverifikasi lokal; front meng-embed token pada URL 302 (klien stock urllib ikut tanpa header); wrapper/probe memakai Bearer/query. Klien yang tidak bisa mengirim token sama sekali (clone z.ai) memang gagal (401) — sesuai desain | INTENTIONAL_SECURITY_HARDENING (G-8) — **bukan** melemahkan jalur resmi apapun |
| 3. Cap 25 MiB vs ukuran request native | DEFAULTS kode TIDAK berubah (0x7fffffff); cap datang dari `wrangler.toml [vars]` = 26.214.400 (produksi) / 33.554.432 (`[env.test]`). `__down` menolak `bytes>max` (400). Dampak nyata: gambar legacy `random4000x4000.jpg` (31.625.365 B) melebihi cap → front meng-redirect `effective=min(size,cap)` (counter `frontDownCapped`) — deviasi ukuran terobservasi, bukan error; lane VPS (share 0,15) menyajikan ukuran penuh. Request NetGauge DOWNLOAD per-perintah (CLI: 4–32 koneksi dinamis) ≤ cap → tidak terdampak; dan CLI resmi memang tidak memakai worker | CONFIGURATION_DIFFERENCE (terdokumentasi, ter-mitigasi) |
| 4. Port legacy dihapus v1.5 | Yang dihapus: unit `speedtestserver-legacy` **port-80** + `legacy-http.ts` (permukaan HTTP port 80 milik daemon). Catatan installer v1.5.2 sendiri menyebut unit itu "**silently never ran (production incident 26 Nov)**" — yaitu tidak pernah benar-benar melayani. Tidak ada client resmi yang memakai port 80 (host tester resmi & NetGauge = 8080). Endpoint worker/gateway tidak tersentuh | NO_REGRESSION (pembersihan unit mati) |
| 5. Pemisahan daemon :8080/:5060 vs gateway :8790 | By design sejak awal hybrid. Client resmi memilih host dari server-list (8080); klien HTTP custom eksplisit menunjuk :8790. Tidak ada endpoint yang "hilang" bagi client resmi | NO_REGRESSION (arsitektur) |
| 6. 302/307, upload body, pool health, TLS, routing | 302 front→worker (GET/HEAD), 307 untuk POST deflection antar-worker (hop guard); WS saturasi → 503+Location (reconnect). Upload: front drain 256 MiB safety + `size=<drained>`; worker `countBody` + 413 early-cancel (G-4b). Daemon: **early-answer** `size=<Content-Length>` setelah body stall 2,5 s (commit `f1ed207`) — hanya untuk upload.php legacy (host tester PHP curl 10 s timeout); event terobservasi `http_upload_early_response`; TIDAK menyentuh jalur NetGauge UPLOAD client resmi. Pool: deflection 302/307 + hop guard teruji (P2–P6 8/8). Live: 100/100 deployed, quota 92/100k, sync ok | INTENTIONAL (fitur) + terdokumentasi; tidak ditemukan manipulasi hasil pengukuran jalur resmi |

## 3. Temuan tambahan (deployment drift & kejadian pasca-audit-26)

| Temuan | Bukti | Klasifikasi |
|---|---|---|
| Gateway restart 2× pada 26 Nov 16:00 & 16:11 UTC; sync error "HTTP 503 code 10001 Unable to authenticate" sebelumnya; kredensial CF dirotasi operator (env-watcher: `CLOUDFLARE_API_TOKEN/EMAIL/API_KEY/ACCOUNT_ID/AUTH_MODE` berubah 16:11:35Z); setelahnya `worker_sync_converged 100/100` | journal gateway via UAEG read-only; `/api/health` env.lastChangeKeys | DEPLOYMENT_DRIFT (selesai/healthy — rotasi kredensial yang memang diumumkan operator) |
| Repo VPS = `b629642`; master = `0ac51ac` (+1 commit docs-only `Result_Comparison` note 5) | `git -C /opt/SpeedtestServer-src log` | NO_DRIFT (runtime = source produksi; untracked `.env.bak-*` tidak dibaca) |
| Daemon PID 4412 tidak berubah sejak audit 26 Nov (tidak ada restart); listener 8080/5060 utuh; gateway PID 10052 aktif | systemctl + ss via UAEG | layar hijau |
| `speedtest.lumajangnetworks.my.id` tetap A→45.126.249.250 **proxied=false** | CF API | constraint DNS-only terpenuhi |

## 4. Commit penyebab terkecil (untuk setiap perubahan perilaku)

| Perubahan perilaku | Commit | Sifat |
|---|---|---|
| Worker open→secret (401 untuk tanpa-token) | `64abbc8` (G-8, var `HYBRID_SHARED_SECRET` via `wrangler secret put` — mekanisme `token.ts` sudah ada di `d6b5f1e`) | disengaja |
| Legacy ON→OFF (404) | `64abbc8` (G-7 flag) + `0bf2b1b` (G-12 `[vars] LEGACY_HTTP_ENABLED="false"` produksi; `[env.test]` true) | disengaja |
| Cap tak terbatas→25 MiB | `a93b7df` (G-4 stream-cancel/413) + `0bf2b1b` (G-12 nilai 25 MiB dari pengukuran E-J) | disengaja |
| Deflection/pool 302/307/503 | `ecbf11f` (pool) | fitur baru (teruji 8/8) |
| Upload drain + early-answer | `880e5f1` (front drain) + `f1ed207` (early-answer host tester) | fitur/fix kompatibilitas host tester |

**Tidak ditemukan satu pun commit yang menurunkan kemampuan client resmi.** Jalur native diuji setelah setiap kelompok perubahan (E-K/E-M pasca-hardening 24 Nov; sesi 9 pasca-v1.4; H3 hari ini pasca-v1.5.2) — selalu exit 0, byte penuh di VPS.

## 5. Apakah perlu perbaikan?

**Tidak ada perbaikan kode yang dibutuhkan oleh temuan audit ini** (tidak ada `CONFIRMED_REGRESSION`). Dua saran kualitas non-blocking:

1. **Dokumentasi**: tambahkan satu kalimat korektif pada `hybrid/reports/HYBRID_RESEARCH_REPORT.md` versi HEAD (atau errata baru) yang menarik klaim "Official web clients: session-level selection" (kriteria 3, snapshot 6 Nov) menjadi "hipotesis arsitektur yang tidak pernah diuji dengan client web resmi" — melengkapi errata `b053f27` yang sudah mengoreksi E-G/W-9. *(Disarankan, docs-only.)*
2. **Observability**: ekspos `frontDownCapped` pada `/api/health` ringkasan front counters (sudah ada di objek counters — cukup dipantau; tidak ada perubahan kode).

Regression test yang relevan sudah ada dan lulus di run ini: `test/conformance.mjs` 55/55, `test/free-hardening-tests.mjs` 16/16, `test/pool-tests.mjs` 8/8, `test/token-tests.mjs` (masuk fase 2), plus replay z.ai 3 postur (H1) — semua tersimpan di evidence folder.
