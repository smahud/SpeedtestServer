# HYBRID ASSIST MODE — "Cloudflare membantu beban, bukan menggantikan"

**Dibuat:** 25 November 2026 (sesi 9).
**Branch:** `hybrid-assist-lane`.
**Status:** PRODUCTION-VERIFIED — pool 100 worker ter-deploy, gateway v1.3 live di VPS,
unit 12/12 + E2E 4/4 + regression 3/3 + pengukuran produksi: hybrid 600.1 Mbps down /
339.7 Mbps up (dari stock 218.5/127.1); CLI resmi Ookla 470.9 Mbps down jalur VPS murni;
root-cause "load < 1 Gbps" (limit SYN nftables nPerf) ditemukan & diperbaiki (43×).

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
5. **deploy-pool.sh: wrangler 4.x me-resolve `main` relatif lokasi file
   TOML** — config di /tmp membuat semua deploy gagal "entry-point not
   found" (bug laten: pool belum pernah dideploy penuh). Config kini
   ditulis di sebelah src/; script juga menerima Global API Key
   (CLOUDFLARE_EMAIL + CLOUDFLARE_API_KEY).
6. **Split upload modulo keliru** — `n % 1000 < share×1000` mengirim 150
   request PERTAMA semuanya ke VPS (sekuens speedtest hanya ~50-100
   POST → edge tidak pernah kebagian). Diganti interleave Bresenham
   (distribusi benar dari request pertama; 60 req → 9/51 untuk share 0.15).

## 5. Bukti

### 5.1 Sandbox test suite (2026-11-25)

| Suite | Hasil |
|---|---|
| Unit gateway (T1–T13 + extra) | **12/12** — termasuk T11 (lane lokal: 245,388 B eksak, printable-ASCII 0x20–0x7F, X-Hybrid-Lane), T12 (budget habis → 302; 5 request = 1 mint), T13 (pattern L→302→302→forced-L→forced-L) |
| E2E assist (`test/e2e-assist-test.sh`) | **4/4** — pool-skip-broken (active={1,3}, worker 2 canary-broken), local-lane, edge-overflow-302, forced-local-no-429 |
| E2E pool lama (`test/e2e-pool-test.sh`) | **3/3** (regression: scale-up-2, shrink-1, session-download) |

### 5.2 Produksi (2026-11-25, sesi 9 — klien dari sandbox z.ai, RTT ~62 ms ke VPS)

Lingkungan: pool **100 worker ter-deploy penuh** (spot-check 5 acak: id/poolMax benar, colo
HKG), gateway v1.3 live, assist budget 100 Mbps, HYBRID_WORKER_ACTIVE_MIN=2,
probe berkala 60 s.

| Pengukuran | Nilai | Catatan |
|---|---|---|
| Stock `speedtest-cli --mini` (threads stock) | **218.5 Mbps down / 127.1 Mbps up** | lane VPS 24 req/76.8 MB + edge 13 redirect; 1 token untuk 13 redirect edge (cache); upload drain VPS |
| Hybrid wrapper 16/8 thread, split 15/85 | **543.4 Mbps down / 332.3 Mbps up** | 731.6 MB diterima; aditif: ~520 edge + ~31 VPS (bucket baru isi ulang) |
| Hybrid wrapper 32/8 thread (MAX) | **600.1 Mbps down / 339.7 Mbps up** | 752.5 MB; limiter = engine urllib (~20-25 Mbps/thread), bukan arsitektur |
| CLI RESMI Ookla 1.2.0.84 (NetGauge VPS:8080, hosts-redirect 74964/61853) | **470.9 / 448.8 Mbps down, 170.3 / 140.9 Mbps up, loss 0.5%** | 625 MB & 481 MB via jalur VPS murni — VPS terbukti mampu ~470 Mbps (NIC 1 Gbps), bukan 100 Mbps |
| Edge single-stream 25 MB (worker) | 330 Mbps | curl |
| Edge 8 stream paralel (8 worker beda) | **2.27 Gbps** | curl — plafon arsitektur jauh di atas engine klien |

**Kesimpulan aditivitas terbukti di produksi**: throughput agregat = kontribusi lane VPS
(token-bucket budget) + lane edge (worker pool) secara bersamaan dalam satu
pengukuran klien — persis konsep "CF membantu beban, bukan menggantikan".

### 5.3 ROOT CAUSE "load < 1 Gbps" yang ditemukan & diperbaiki di produksi

**Firewall nftables nPerfServer membatasi SYN: `limit rate over 260/second
burst 5 packets drop`** — setiap burst >5 koneksi baru didrop → klien
retransmit SYN 1–3 detik (bukti historis: 13.958 TcpExtTCPSynRetrans,
192 ListenOverflows). Klien speedtest multi-thread (16–32 koneksi) kena
penalti ini di SEMUA port VPS. Terukur: 16 koneksi paralel = **3.137 ms →
72 ms** (43×) setelah rule diganti menjadi `rate over 2000/second burst 64
packets drop comment "SYN-guard-relaxed-for-speedtest"`.

Perintah (VPS, root):
```bash
# sebelum: tcp flags syn limit rate over 260/second burst 5 packets drop
nft replace rule inet filter input handle <H> \
  tcp flags syn limit rate over 2000/second burst 64 packets drop \
  comment "SYN-guard-relaxed-for-speedtest"
# rollback: ganti kembali ke 260/second burst 5
```
Catatan: rule nftables ini TIDAK persisten di /etc/nftables.conf (dibuat
runtime oleh nPerf) — jika nPerf restart bisa dibuat ulang; periksa dengan
`nft list chain inet filter input`. Rule tetap melindungi dari SYN-flood
(2000/s masih limit).

Bug lain yang diperbaiki di sesi 9 (lihat §4): 413-destroy, banjir mint,
pool growth macet, crash EADDRINUSE, deploy-pool.sh path wrangler 4.x,
split upload Bresenham (modulo %1000 mengirim 150 request pertama semuanya
ke VPS).

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
