# CLI BRIDGE REPORT 2026-11-27 — CLI resmi dilayani VPS + Cloudflare Worker

> **Pembaruan 27 Nov (kemudian): nama "cli-bridge" dipensiunkan →
> `speedtest-bridge`** (komponen produksi permanen
> `hybrid/speedtest-bridge/`, unit `speedtest-bridge.service`, env
> `SPEEDTEST_BRIDGE_*`, + mux TLS :8080 + guard rate-limit per-IP —
> implementasi rekomendasi #1 laporan ini; tes 225/225). Laporan historis di
> bawah tetap memakai nama lama dan angka window eksperimen asli.
>
> Lanjutan eksperimen `cli-bridge` (agent 26–27 Nov 2026). Evidence lengkap:
> `hybrid/lab/evidence/cli-bridge-2026-11-27/` (checksums di
> `lab-meta/checksums.txt`). Audit pendahulu:
> `audit/historical-native-worker-2026-11-27` (branch) — verdict
> NATIVE_VPS_ONLY + BLOCKED_BY_PROTOCOL/BY_FREE_PLAN untuk jalur edge
> **langsung**. Metode uji CLI resmi: `docs/OFFICIAL_CLI_TESTING_GUIDE.md`.

## Pertanyaan operator

> "Ookla speedtest cli resmi ketika melakukan speedtest bisa dilayani secara
> otomatis oleh **vps + worker** atau tidak? Saya tidak mau test dilakukan
> oleh client speedtest custom. Test juga harus ke server yg sudah publish
> tapi IP di mock ke vps yg mana vps sudah link ke worker CF."

## Jawaban singkat

**YA — BISA, dengan relay VPS (edge-origin, VPS-relay).**

CLI resmi Ookla **1.2.0.84 tidak dimodifikasi** (binary repo, sha256
`31f1124c…`), hosts-mock `speedtest.tuxsnet.id` (server ter-publish, ID 66281)
→ VPS 45.126.249.250:8080, menyelesaikan pengukuran **penuh** (exit 0,
`persisted=false`) dengan **seluruh payload pengukuran ber-origin di Worker
edge** dan mengalir melalui VPS — pada **kedua** lane Worker
(`/__down`+`/__up` HTTP dan `/ws` NetGauge):

| Run | Lane | Exit | DL client | DL origin-edge | UL client | UL diteruskan edge | Receipt edge |
|---|---|---:|---:|---:|---:|---:|---:|
| b2-wh-3 | worker-http | 0 | 630,1 MB @ 416,3 Mbps | **656,7 MB (≈100%)** | 223,6 MB @ 133,2 Mbps | **218,7 MB (97,8%)** | 54 `{"bytes":N}` |
| b2-wh-4 | worker-http | 0 | 462,0 MB @ 431,3 Mbps | **476,8 MB (≈100%)** | 201,6 MB @ 118,4 Mbps | **195,1 MB (96,8%)** | 48 |
| b3-ww-2 | worker-ws | 0 | 704,8 MB @ 436,6 Mbps | **748,4 MB (≈100%)** | 154,5 MB @ 177,3 Mbps | **158,4 MB (≈100%)** | 2 `OK n <ts>` per UPLOAD |
| b1-local (kontrol) | pool VPS | 0 | 639,0 MB @ 454,5 Mbps | 0 | 179,4 MB @ 158,8 Mbps | 0 | 0 |
| b0/b4 (kontrol daemon) | daemon | 0 | 519/523 MB @ ~452–462 | 0 | 214/205 MB @ ~160–165 | 0 | 0 |

Sisi Worker (CF GraphQL, window 20:00–20:40Z): **885 invocation, semua
`success`, 0 error** — tidak ada kill `exceededResources` selama eksperimen.
Semua run `persisted=false` / `result.url=null` (non-publishing terjaga).

**Label jujur (jangan dihilangkan saat mengutip):** ini adalah payload
**ber-origin di edge dengan relay melalui VPS**. Setiap byte bridged tetap
transit link VPS → **tidak menambah kapasitas per sesi**; throughput satu
sesi tetap dibatasi link VPS (terlihat: DL bridge ≈ 416–449 Mbps vs daemon
451–462 Mbps). Jalur edge **langsung (non-relay)** untuk CLI resmi **tetap
ter-BLOCK** (BLOCKED_BY_PROTOCOL + BLOCKED_BY_FREE_PLAN — audit 26–27 Nov,
tidak berubah).

## Arsitektur yang diuji

```
CLI resmi 1.2.0.84 (sandbox, unshare+mockhosts)
   │  NetGauge TCP :8080 (fallback plaintext) + UDP :8080 (LOSS)
   ▼
cli-bridge di VPS :8080 (transient systemd unit)
   │ kontrol: HI/HELLO, GETIP, PING, CAPABILITIES, INITPLOSS/PLOSS, UDP LOSS → lokal VPS (paritas daemon)
   │ DL: "DOWNLOAD n" → prefix "DOWNLOAD " (lokal) + pool ← Worker + "\n" (lokal) — byte-exact F-9
   │ UL: konsumsi n inklusif → "OK n <epoch>" (paritas daemon) + payload → Worker
   ├─ worker-http: GET /__down?bytes=4MiB (streaming, backpressure NYATA) + POST /__up (receipt {bytes:N})
   └─ worker-ws  : WSS /ws NetGauge per-koneksi, per-chunk command (1 MiB, framing di-strip), UPLOAD mentah diteruskan, ack OK = receipt
```

Front bridge adalah port paritas-semantik penuh dari engine daemon yang sudah
diverifikasi (binary-hello→ERROR yang memicu fallback plaintext CLI, strict
GETIP + pre-session gate, three-strikes F-24, UPLOAD inklusif F-9/F-13, UDP
LOSS init/loaded + `RECV`, registry bounded F-33). Baterai: **158/158**
(klien sintetis peniru pola CLI + mock worker HTTP/WS; berjalan di sandbox
dan VPS).

## Kronologi & perbaikan (transparansi penuh)

| Run | Hasil | Akar masalah → perbaikan (commit) |
|---|---|---|
| b2-wh-1 | exit 0, DL ≈100% edge, UL relay rusak (55,5 KB dari 181,9 MB) + 47× ECONNRESET | buffer upload per-call (hilang antar feed) → akumulasi persisten `0aea68b`; retry reset → `5699d7f` |
| b2-wh-2 | exit 2 (NoServers) | token mint tak pernah di-cache → 92 mint → gateway 429 rate-limit → cache token shared + backoff `f9de54e` |
| b2-wh-3/4 | exit 0 ✓ | — |
| b3-ww-1 | exit 0, DL ≈100% edge, UL terkirim tapi tanpa receipt (payload jadi frame sampah, 1 ERROR per frame) | perintah `UPLOAD` mentah tidak diteruskan ke WSS → diteruskan + retry sesi `1393887` |
| b3-ww-2 | exit 0 ✓ (DL+UL ≈100% edge, receipt OK) | — |

Seluruh window: daemon direkonfigurasi `tcpPorts/udpPorts=5060` (backup
`OoklaServer.properties.exp-backup-20261127`), bridge transient di :8080
(TCP+UDP), lalu **restore + verifikasi** (b4 exit 0, listener kini daemon).

## Verifikasi kebenaran stack (sebelum eksperimen)

- Worker yang dideploy = source yang di-commit: rebuild `npx esbuild` dari
  master menghasilkan bundle **byte-identik** dengan dist live
  (sha256 `1cfa1869…`).
- Suite worker di VPS (workerd lokal): conformance **55/55**, token 11/11,
  free-hardening 16/16, pool 8/8 (dengan patch `?pace=` + cap 128 MiB).
- Suite cli-bridge: **158/158**.

## Kesimpulan per acceptance gate

| Gate | Hasil |
|---|---|
| Klien resmi asli, tanpa modifikasi | ✓ binary repo 1.2.0.84, verifikasi sha256 |
| Target = server ter-publish, IP di-mock ke VPS | ✓ 66281 `speedtest.tuxsnet.id` → 45.126.249.250 (mockhosts namespace lab) |
| Non-publishing | ✓ 100% run `persisted=false` |
| Satu pengukuran dilayani VPS + Worker bersamaan | ✓ kontrol VPS + payload edge dalam sesi yang sama (kedua lane) |
| Atribusi 3 sisi | ✓ CLI JSON + JSONL bridge per-lane + GraphQL (885 inv success) + receipt per-chunk/ack |
| Produksi kembali utuh | ✓ restore + verifikasi exit 0 |
| Peningkatan kapasitas per sesi | ✗ (memang tidak mungkin via relay — semua byte transit VPS; jalur langsung tetap BLOCKED) |

## Rekomendasi

1. **Operator dapat mengaktifkan mode ini permanen** jika yang diinginkan
   adalah "payload pengukuran ber-origin di edge" (hemat generasi di VPS,
   identitas/latensi tetap VPS): jalankan bridge sebagai systemd unit tetap
   (env-gated) dengan daemon tetap pemilik :5060, dan pasang guard abuse
   (rate-limit per-IP di sisi bridge; mint sudah dibatasi gateway).
2. Untuk **kapasitas agregat lebih dari satu link VPS**, arsitektur ini tidak
   membantu (relay) — yang sudah terbukti tetap lane web/custom (front 302)
   untuk klien non-CLI, dan jalur registrasi Ookla (A12) bila ingin melayani
   CLI resmi secara publik tanpa mock.
3. Pertahankan chunking+retry di kedua lane (reproduksi kill
   `exceededResources` 10/32 tanpa chunking tercantum di
   `hybrid/lab/cli-bridge/README.md`).
