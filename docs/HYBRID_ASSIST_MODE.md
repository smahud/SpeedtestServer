# HYBRID ASSIST MODE — "Cloudflare membantu beban, bukan menggantikan"

**Dibuat:** 25 November 2026 (sesi 9).
**Branch:** `hybrid-assist-lane` → target merge ke `master` setelah verifikasi.
**Status:** IMPLEMENTED + unit 12/12 + E2E 4/4 (pool-skip-broken, local-lane,
edge-overflow, forced-local) + regression E2E pool 3/3.

## 1. Konsep

Sebelum sesi 9, mode hybrid memindahkan **100%** payload download ke edge
(front 302 → Worker `__down`) — VPS hanya menyisakan control plane. Bagi
operator dengan VPS berkapasitas terbatas tapi ping bagus (mis. 100 Mbps di
Indonesia), itu berarti kapasitas VPS **tidak dipakai sama sekali** saat
klien mengetes.

Konsep assist membalik pandangannya: **VPS tetap melayani sampai kapasitas
(link) budget-nya habis; Cloudflare Worker menangkap luapan (overflow)
di atasnya.** Hasil agregat yang dirasakan klien:

```
throughput ≈ min(demand_klien, budget_VPS + kapasitas_edge)
```

Contoh operator (VPS 100 Mbps UL/DL, klien 1 Gbps):

- VPS menyumbang ~100 Mbps (rendah RTT, langsung dari gateway),
- worker pool Cloudflare menangani ~900 Mbps sisanya,
- klien mengukur ~1 Gbps — "kebutuhan klien terpenuhi".

Ketika demand klien < budget VPS (mis. klien 50 Mbps), **semua** byte
dilayani VPS — edge idle, kuota CF tertolong.

## 2. Tiga jalur download di front (gateway :8790)

`GET /speedtest/random{N}x{N}.jpg` sekarang punya tiga jalur, diputus
server-side per-request (klien stock tidak perlu diubah sama sekali):

| Jalur | Kondisi | Perilaku |
|---|---|---|
| **1. VPS assist** | token-bucket masih punya budget (`HYBRID_VPS_DL_BUDGET_MBPS`) | 200 langsung: byte pool printable-ASCII (paritas daemon F-9), `Content-Length` eksak, `Content-Type: image/jpeg`, header `X-Hybrid-Lane: vps` |
| **2. Edge overflow** | budget habis | 302 → `__down?bytes=N&token=…` di Worker terpilih pool (round-robin least-mints) — identik perilaku lama |
| **3. Forced-local** | mint token kena rate-limit DAN assist aktif | 200 lokal (daripada 429 yang merusak pengukuran klien) |

Token bucket: kapasitas = `budget × burst_s`, isi ulang kontinu pada rate
budget. Long-run, byte yang dilayani VPS konvergen **tepat** ke budget
(burst hanya menghaluskan start). Byte dilayani streaming 256 KiB dengan
backpressure socket + deteksi disconnect (generasi berhenti saat klien
pergi — tidak ada byte terbuang).

**Upload** (dua jalur):

- Klien stock (mini mode): POST `upload.php` tetap drain di VPS — itu
  kontribusi ingress VPS penuh (urllib tidak bisa mengikuti redirect
  ber-body; batasan terdokumentasi).
- Klien hybrid (`hybrid/probe-client/speedtest-cli-hybrid.py`): POST dipecah
  berbobot `HYBRID_VPS_UL_SHARE` (default 0.15) — 15% tetap ke front VPS,
  85% langsung ke Worker `__up` (Bearer token). Keduanya dihitung engine
  stock sebagai byte terkirim → agregat.

## 3. Konfigurasi (semua di VPS — `/etc/speedtest-hybrid/gateway.env`)

| Env | Default | Arti |
|---|---|---|
| HYBRID_VPS_DL_BUDGET_MBPS | 0 (off) | Budget download VPS (Mbps desimal). 0 = perilaku lama (offload murni). 100 untuk VPS 100 Mbps |
| HYBRID_VPS_DL_BURST_S | 2 | Kapasitas burst bucket (detik × budget) |
| HYBRID_FRONT_TOKEN_CACHE_MS | TTL−60s | Cache token offload per-IP; 0 = matikan. Ramp 16-32 thread kini hanya mint ~1 token/TTL per klien |
| HYBRID_FRONT_RATE_LIMIT_MPM | 90 | Limit **mint** per IP/menit (bukan per request — request yang cache-hit tidak dihitung) |

Klien hybrid (`speedtest-cli-hybrid.py` v1.2):

| Env | Default | Arti |
|---|---|---|
| HYBRID_DL_THREADS | 0 (stock) | Override thread download (stock = threadcount×2 dari config speedtest.net — kecil). 16 disarankan untuk link ≥500 Mbps |
| HYBRID_UL_THREADS | 0 (stock) | Override thread upload (stock 4, dinaikkan 8 otomatis engine bila download >100 kbps) |
| HYBRID_DL_COUNTS | 0 (stock) | URL per ukuran — 8 disarankan (amortisasi handshake TLS per-request pada rate gigabit) |
| HYBRID_VPS_UL_SHARE | 0.15 | Porsi upload POST yang tetap di VPS (0 = semua ke edge; 1 = semua VPS) |

## 4. Perbaikan bug yang ikut dibawa (audit sesi 9)

1. **front.mjs v1.2 regression** — `req.destroy()` langsung setelah tulis
   413 mengalahkan hook `res.on('finish')`-nya sendiri: klien melihat
   ECONNRESET, bukan 413. Sekarang: `req.pause()` → destroy setelah flush.
2. **Banjir mint mid-measurement** — token di-mint per request download;
   ramp multi-thread melampaui rate limit (90/menit) di tengah tes → 429
   merusak pengukuran. Sekarang: cache token per-IP (stateless HMAC —
   reuse aman), limiter hanya menghitung mint sungguhan.
3. **Pool growth macet** — worker mati/benched di posisi tengah ring
   memblokir aktivasi semua worker setelahnya (`workers[activeCount]`
   fixed). Sekarang: himpunan aktif eksplisit + kandidat scan melompati
   yang benched/backoff (terbukti E2E: pool {1,3} dengan worker 2 mati).
4. **Crash tanpa log saat EADDRINUSE** — listener tanpa handler `error`
   → systemd restart loop tanpa baris log yang bisa didiagnosis. Sekarang:
   exit(1) dengan log `gateway_error` berisi errno.

## 5. Bukti (2026-11-25, sandbox)

| Suite | Hasil |
|---|---|
| Unit gateway (T1–T13 + extra) | **12/12** — termasuk T11 (lane lokal: 245,388 B eksak, printable-ASCII 0x20–0x7F, X-Hybrid-Lane), T12 (budget habis → 302; 5 request = 1 mint), T13 (pattern L→302→302→forced-L→forced-L) |
| E2E assist (`test/e2e-assist-test.sh`) | **4/4** — pool-skip-broken (active={1,3}, worker 2 canary-broken), local-lane, edge-overflow-302, forced-local-no-429 |
| E2E pool lama (`test/e2e-pool-test.sh`) | **3/3** (regression: scale-up-2, shrink-1, session-download) |

## 6. Cara mengaktifkan (operator)

```bash
# di /etc/speedtest-hybrid/gateway.env (VPS):
HYBRID_VPS_DL_BUDGET_MBPS=100      # = kapasitas link VPS
HYBRID_WORKER_POOL_MAX=100         # pool 1..100 (deploy-pool.sh)
HYBRID_WORKER_ACTIVE_MIN=2
systemctl restart speedtest-hybrid-gateway

# klien hybrid yang memaksimalkan agregat:
HYBRID_DL_THREADS=16 HYBRID_UL_THREADS=8 HYBRID_DL_COUNTS=8 \
HYBRID_VPS_UL_SHARE=0.15 \
python3 hybrid/probe-client/speedtest-cli-hybrid.py --json --server <ID>
```

Observasi: `curl -s https://speedtest.lumajangnetworks.my.id:8790/api/health`
→ `front.counters.dlLocalBytes` (lane VPS) vs `downRedirects` (lane edge) —
atribusi byte per jalur. `journalctl -u speedtest-hybrid-gateway | grep
front_download` menunjukkan lane per request.

## 7. Batasan yang jujur

- **CLI resmi Ookla tidak terpengaruh** — jalurnya selalu NetGauge TCP
  langsung ke VPS :8080 (terbukti E-D/E-E; protokol binary tidak bisa
  lewat edge). Assist hanya untuk klien HTTP-plane (stock speedtest-cli,
  mini, custom).
- **Kuota Workers Free tetap per-akun 100k request/hari** — pool
  mendistribusikan, tidak mengalikan. Lane VPS justru MENGHEMAT kuota
  (request yang dilayani lokal tidak memakai CF).
- **Upload klien stock tetap 100% di VPS** — tidak ada mekanisme redirect
  POST ber-body untuk urllib; pemecahan hanya di klien hybrid.
- Aritmetika "1 Gbps" adalah upper bound: cap sebenarnya = min(kapasitas
  klien, budget VPS + throughput edge agregat RTT-tergantung).
