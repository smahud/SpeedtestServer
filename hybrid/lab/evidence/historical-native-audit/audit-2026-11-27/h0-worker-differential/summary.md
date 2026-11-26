# H0 — Differential audit worker: d6b5f1e (6 Nov) vs HEAD 0ac51ac (v1.5.2)

Metode: workerd lokal (wrangler 4.168.0), client tetap (test/conformance.mjs + clone z.ai Host Tester v1.0.1),
tiga postur konfigurasi diuji pada dua snapshot source. Jendela: 26 Nov 2026 17:14–17:16 UTC.

| Postur | Snapshot | Vars | conformance.mjs | z.ai clone (10 check) |
|---|---|---|---|---|
| open-lama | d6b5f1e | (tidak ada — default era: legacy ON, tanpa secret, cap default 2 GiB) | 55/55 PASS | **10/10 PASS** — DL 1460,63 Mbps / 754 MB; UL 792,31 Mbps / 524 MB; 1,25 GB; verdict "Server is publicly available and properly configured" |
| test-env | HEAD | LEGACY_HTTP_ENABLED:true, cap 32 MiB, tanpa secret | 55/55 PASS | **10/10 PASS** — DL 1639,85 Mbps / 844 MB; UL 934,80 Mbps / 436 MB; 1,25 GB |
| produksi | HEAD | HYBRID_SHARED_SECRET terpasang, LEGACY_HTTP_ENABLED:false, cap 25 MiB | (fase 2 suite repo: hardening 16/16; pool 8/8) | **3/6** — ws 401 unauthorized (missing-token); /hi, latency.txt, random*.jpg, upload.php, crossdomain.xml → 404 |

Endpoint ber-token diverifikasi terpisah: `GET /__down?bytes=1000000` + token minted → 200 + tepat
1.000.000 byte; tanpa token → 401 `missing-token`; `bytes=100000000` → 400 (cap). Token format
`v1~guid~exp~ip~sig` (HMAC-SHA256) — di-mint gateway, diverifikasi lokal worker.

## Kesimpulan H0

1. **NO_REGRESSION pada source code.** Dengan konfigurasi identik (legacy ON, tanpa secret), worker
   HEAD identik secara perilaku konformance dengan worker 6 Nov (55/55 dan 10/10 di KEDUA versi).
2. Seluruh perbedaan perilaku aktual bersumber dari **konfigurasi produksi** (secret terpasang,
   legacy OFF, cap 25 MiB) yang dipasang lewat hardening G-4/G-7/G-8/G-12 (commit 64abbc8, a93b7df,
   0bf2b1b, 0476e7c, 23–24 Nov) → klasifikasi **INTENTIONAL_SECURITY_HARDENING**.
3. Mekanisme token sudah ada sejak d6b5f1e (`config.ts`: "Empty/absent = open lab mode") — era 6 Nov
   berjalan **open mode karena secret belum dipasang**, bukan karena kode berbeda.
4. Postur produksi sengaja menutup permukaan legacy langsung pada worker; jalur klien HTTP eksternal
   yang sah tetap tersedia melalui front gateway :8790 (latency.txt lokal, 302→__down dengan token
   ter-embed di URL, drain upload.php di VPS) — lihat `hybrid/gateway/src/front.mjs` (lane 1/2/3).
5. Dampak cap 25 MiB pada gambar legacy terbesar (random4000x4000.jpg = 31.625.365 B): front
   meng-serve `effective = min(size, maxDownBytes)` (counter `frontDownCapped`) — deviasi ukuran yang
   terobservasi, bukan kegagalan; lane VPS (share) tetap menyajikan ukuran penuh. → klasifikasi
   CONFIGURATION_DIFFERENCE (terdokumentasi, terobservasi).

Ditambahkan oleh: audit 2026-11-27 · bukti mentah: `../h1-eg-replay/`, `../lab-meta/metadata.json`
