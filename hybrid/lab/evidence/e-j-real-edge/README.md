# Evidence E-J — Real Edge (Cloudflare Workers Free, 24 November 2026)

## Deploy
- Subdomain workers.dev: `lumajangnetworks` (terdaftar 24 Nov 2026 via API oleh agent; operator memberikan token Worker untuk pilot B1 di sesi ini).
- Worker uji `speedtest-hybrid-worker-test`: versi `c564820b-527c-49f8-aee5-ba0f34ac67d0` (legacy ON, cap 32 MiB, open mode). **DIHAPUS** setelah pengukuran (wajib, master prompt §5 Fase 4.5).
- Worker produksi `speedtest-hybrid-worker`:
  - v1 `b54b744d-01c1-489e-9bdc-575536517459` (cap 25 MiB, legacy OFF, secret HYBRID_SHARED_SECRET terpasang)
  - v2 `28e2f5cc-9bd3-4c17-a5d1-cdb26574b567` (G-4b: `request.body.cancel()` pada jalur early-413)
- URL produksi: https://speedtest-hybrid-worker.lumajangnetworks.workers.dev

## Conformance (worker uji, edge nyata, dari VPS)
- `conformance.mjs`: **55/55 PASS** (termasuk WS DOWNLOAD 5 MiB eksak 80 frame, `__down` 25.000.000 B eksak, upload.php, header keamanan).

## Pengukuran CPU per invokasi (measure-real-edge-2026-11-24T01-57-50-889Z.json, Workers Analytics GraphQL)
| Titik uji | klien OK | request | error | CPU P50max (us) | CPU P99max (us) |
|---|---|---|---|---|---|
| cold-small (1 KB) | 10/10 | 12 | 0 | 16.883 | 23.424 |
| http-down-1mib | 5/5 | 6 | 0 | 16.883 | 23.424 |
| http-down-4mib | 5/5 | 7 | 0 | 28.302 | 28.302 |
| http-down-16mib | 3/3 | 4 | 0 | 51.128 | 51.128 |
| http-down-25mib | 3/3 | 4 | 0 | 51.128 | 51.128 |
| http-up-4mib | 3/3 | 4 | 0 | 74.258 | 74.258 |
| http-up-16mib | 3/3 | 4 | 0 | 160.041 | 160.041 |
| http-up-25mib | 3/3 | 5 | 0 | 258.962 | 258.962 |
| ws-down-4mib | 3/3 | 4 | 0 | 20.959 | 22.126 |
| ws-down-8mib | 3/3 | 3 | 0 | 64.357 | 64.357 |
| ws-down-32mib | 2/2 | 4 | 0 | 88.131 | 88.131 |
| ws-up-4mib | 3/3 | 4 | 0 | 51.070 | 51.070 |
| ws-up-16mib | 2/2 | 4 | 0 | 84.929 | 84.929 |
| ws-up-25mib | 2/2 | 1 | 0 | 84.929 | 84.929 |

Semua status `success`; tidak ada `exceededCpu`/1102/1027/429/413 pada battery. Batas nominal Free 10 ms CPU tidak ditegakkan keras pada pola beban ini (fleksibilitas platform; verifikasi batas 24 Nov 2026: developers.cloudflare.com/workers/platform/limits/).

**Keputusan dari data (B2):**
- `MAX_DOWNLOAD_BYTES`/`MAX_UPLOAD_BYTES` produksi tetap 25 MiB (26214400): 0 error pada 3 repetisi per ukuran hingga batas.
- Transport utama: **WS NetGauge** (WS UPLOAD 25 MiB = 85 ms CPU vs HTTP `__up` 25 MiB = 259 ms CPU — 3x lebih murah; WS DOWNLOAD 32 MiB = 88 ms). HTTP `__down`/`__up` tetap tersedia sebagai fallback (keduanya terukur aman).

## Token & hardening (worker produksi, edge nyata, dari VPS; egress 45.126.249.131)
- `token-tests.mjs`: **11/11 PASS** (401 tanpa token; valid/Bearer/wildcard ip=* OK; tampered/expired/wrong-secret 401; WS ditolak tanpa token).
- `free-hardening-tests.mjs` (EDGE_EARLY_RESPONSE=1, TEST_OVERCAP_BODY=1): **17/17 PASS** (cap `__down` 400; HEAD di MAX; body nyata MAX+1 → 413; seluruh permukaan legacy 404).
- **Temuan platform (terverifikasi 2x, sebelum & sesudah G-4b):** edge Cloudflare (dan workerd) MENAHAN respons Worker sampai body request selesai, sehingga "413 early" atas lying-Content-Length tidak teramati klien. Perlindungan tetap terbukti: body nyata > cap → 413 (`{"error":"upload too large","limit":26214400}`), dan `countBody` membatalkan stream pada cap (G-4).

## E2E + atribusi byte (e-j-e2e-sandbox-both.json, e-j-byte-attribution-sandbox.json)
- Klien eksternal (sandbox, bukan VPS), mode `both` (WS + HTTP), jendela 02:11:37–02:12:58Z.
- Payload client<->edge: **117.440.512 B**; kontrol client<->VPS: **4.296 B**; gateway app: in 885 + out 3.519 = **4.404 B**.
- Delta interface eth0 (batas atas, seluruh trafik VPS): rx 119.475 + tx 63.918 = **183.393 B**.
- **Offload ≈ 1:27.337** (payload : kontrol). Hasil dipersist di `results.jsonl` (guid `0b3dd684-9f1a-495c-994b-f96844759164`); replay dedup OK (G-9).
- Throughput teramati dari sandbox: DL WS ~600 Mbps, UL WS ~369 Mbps.

## Kuota (24 Nov 2026 UTC)
- `speedtest-hybrid-worker` (produksi): 110 request, 0 error.
- `speedtest-hybrid-worker-test`: ~94 request sebelum dihapus.
- Budget uji agent 20.000/hari (master prompt §3.11) — terpakai <1,5%.

