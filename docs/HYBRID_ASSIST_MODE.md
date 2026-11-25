# HYBRID ASSIST MODE v1.4 — "VPS mengeluarkan SEMUA potensi bandwidth, Cloudflare hanya membantu"

**Dibuat:** 25 November 2026 (sesi 9, v1.3 — model budget) · **Revisi besar:** 26 November 2026 (v1.4 — penghapusan budget, atas keputusan operator).
**Branch:** `vps-full-potential`.
**Status v1.4:** unit gateway **13/13** (T1–T14) + E2E assist **4/4** + E2E pool regression **PASS** — semua pada kode v1.4.

> **Keputusan operator (26 Nov 2026):** `HYBRID_VPS_DL_BUDGET_MBPS` / `HYBRID_VPS_DL_BURST_S`
> **DIHAPUS total**. Model v1.3 memBATASI kontribusi VPS dengan token bucket
> byte-budget — operator menolak pembatasan: *"saya mau VPS bisa mengeluarkan
> semua potensi bandwidth DL/UL nya tapi di bantu dengan CF worker"*.
> v1.4 menggantinya dengan **pembagian pangsa permintaan (share interleave)**:
> tidak ada budget, tidak ada throttle, VPS selalu berjalan pada kecepatan
> penuh; Cloudflare menambah kapasitas DI ATASNYA.

## 1. Konsep v1.4 (tanpa budget)

v1.3: VPS melayani sampai **budget byte** habis → sisanya overflow ke edge.
Masalah: budget = CAP. VPS 470 Mbps dengan budget 100 Mbps hanya menyumbang
100 Mbps — 370 Mbps potensinya dikubur oleh konfigurasi sendiri.

v1.4: **tidak ada batas byte sama sekali**. Yang membagi jalur hanyalah
**pangsa permintaan** `HYBRID_VPS_DL_SHARE` (0.0–1.0):

```
permintaan download klien ──┬─ share ──────────► LANE VPS: 200 langsung,
                            │                     kecepatan PENUH, tanpa
                            │                     token bucket, tanpa
                            │                     throttle (backpressure TCP
                            │                     = satu-satunya flow control)
                            └─ (1 − share) ────► LANE EDGE: 302 → worker
                                                  pool __down (assist)
```

Kedua lane berjalan **PARALEL** dalam satu pengukuran klien, sehingga:

```
throughput ≈ min(demand_klien, kapasitas_VPS_di_lane_nya + kapasitas_edge_di_lane_nya)
```

- VPS **tidak pernah dibatasi**: tiap respons lane VPS mengalir secepat
  link mengizinkan (streaming 256 KiB + backpressure; disconnect client
  langsung menghentikan generasi — nol byte terbuang).
- Edge **hanya membantu**: mengambil (1 − share) permintaan, kapasitasnya
  menumpuk DI ATAS kontribusi VPS, bukan menggantikannya.
- `HYBRID_VPS_DL_SHARE=1.0` → 100% VPS (potensi penuh; edge idle, kuota CF
  hemat). `0.0` → 100% edge (perilaku offload v1.2 lama).
- **Menyetel share ≈ kapasitas_VPS / demand_klien** memberi agregat
  maksimum: lane VPS jenuh tepat di kapasitas VPS (semua potensinya
  keluar), lane edge menangkap sisanya. Share BESAR tidak membuat VPS
  lebih cepat (sudah tanpa cap) — hanya memindahkan permintaan dari edge
  ke VPS (hemat kuota); share KECIL memberi edge lebih banyak permintaan
  (agregat lebih tinggi saat edge >> VPS).

Contoh operator (VPS terukur ~470 Mbps jalur NetGauge, klien 1 Gbps):

| share | lane VPS | lane edge | agregat kira-kira |
|---|---|---|---|
| 1.0 | 1 Gbps demand, jenuh ~470 | 0 | ~470 Mbps + kuota CF hemat total |
| 0.5 | 500 Mbps demand, jenuh ~470 | ~500 | ~970 Mbps |
| 0.15 | 150 Mbps demand (< kapasitas) | ~850 | ~1 Gbps (client-limited) |

Distribusi antar-request: **interleave Bresenham per-IP** — deterministik,
benar sejak request PERTAMA (algoritma yang sama dengan split upload klien,
yang sudah terbukti produksi 60 req → 9/51 di share 0.15; lihat §4 bug #6).

## 2. Jalur download di front (gateway :8790)

`GET /speedtest/random{N}x{N}.jpg` — dua jalur + satu fallback, diputus
server-side per-request (klien stock tidak perlu diubah):

| Jalur | Kondisi | Perilaku |
|---|---|---|
| **1. Lane VPS (uncapped)** | request kena giliran share (`HYBRID_VPS_DL_SHARE`) | 200 langsung: byte pool printable-ASCII (paritas daemon F-9), `Content-Length` eksak, `Content-Type: image/jpeg`, header `X-Hybrid-Lane: vps`, streaming 256 KiB + backpressure + abort-aware |
| **2. Lane edge (assist)** | request kena giliran (1 − share) | 302 → `__down?bytes=N&token=…` di worker terpilih pool (round-robin least-mints) — token di-cache per-IP |
| **3. Forced-local fallback** | mint token kena rate-limit DAN share > 0 | 200 lokal (daripada 429 yang merusak pengukuran). `share=0` (operator memilih murni edge) mempertahankan 429 lama |

Tidak ada state budget; state per-IP hanyalah fase Bresenham (1 float) +
cache token.

**Upload (tidak berubah, tetap tanpa cap):**
- Klien stock (mini mode): POST `upload.php` drain di VPS — kontribusi
  ingress VPS penuh (urllib tidak bisa mengikuti redirect ber-body;
  batasan terdokumentasi).
- Klien hybrid (`hybrid/probe-client/speedtest-cli-hybrid.py`): POST dipecah
  berbobot `HYBRID_VPS_UL_SHARE` (default 0.15, Bresenham) — 15% tetap ke
  front VPS, 85% langsung ke Worker `__up` (Bearer token).

## 3. Konfigurasi

### 3.1 Gateway VPS — `/etc/speedtest-hybrid/gateway.env` (di-generate install.sh dari `.env`)

| Env | Default | Arti |
|---|---|---|
| **HYBRID_VPS_DL_SHARE** | **0.15** | Pangsa request download di lane VPS TANPA cap (0.0–1.0; kosong → 0.15; `"0"` dihormati eksplisit). **PENGGANTI** HYBRID_VPS_DL_BUDGET_MBPS yang sudah dihapus |
| HYBRID_FRONT_ENABLED | true (saat install hybrid) | Permukaan HTTP legacy speedtest di gateway |
| HYBRID_FRONT_TOKEN_CACHE_MS | TTL−60s | Cache token offload per-IP; 0 = matikan |
| HYBRID_FRONT_RATE_LIMIT_MPM | 90 | Limit MINT per IP/menit (cache-hit tidak dihitung) |
| HYBRID_WORKER_POOL_MAX | = CF_WORKER_DEPLOY_COUNT | Ukuran pool di rotasi (1..100) |
| HYBRID_WORKER_ACTIVE_MIN/MAX | 2 / pool | Batas aktif autoscaler |

### 3.2 Instalasi full-stack — `.env` (BARU, sumber konfigurasi tunggal)

Semua kredensial Cloudflare (API token ATAU email+global key, account id),
jumlah worker yang di-deploy (`CF_WORKER_DEPLOY_COUNT` 1..100), shared
secret (auto-generate bila kosong), dan seluruh variabel gateway kini
dikonfigurasi di **`.env`** sebelum `install.sh` dijalankan:

```bash
cp .env.example .env && nano .env   # isi kredensial CF + jumlah worker
sudo ./install.sh --start           # daemon + gateway + DEPLOY N worker CF
```

Panduan tiap field + permission scope token yang tepat:
**`.env.example`** (komentar per baris) dan **`docs/CLOUDFLARE_CREDENTIALS.md`**.

### 3.3 Klien hybrid (`speedtest-cli-hybrid.py` v1.2.1)

| Env | Default | Arti |
|---|---|---|
| HYBRID_DL_THREADS | 0 (stock) | Override thread download (16 disarankan ≥500 Mbps) |
| HYBRID_UL_THREADS | 0 (stock) | Override thread upload |
| HYBRID_DL_COUNTS | 0 (stock) | URL per ukuran (8 disarankan) |
| HYBRID_VPS_UL_SHARE | 0.15 | Porsi upload POST yang tetap di VPS (ingress penuh) |

## 4. Sejarah perbaikan bug yang tetap relevan (audit sesi 9)

1. **413-destroy** — `req.destroy()` langsung setelah 413 mengalahkan hook
   `res.on('finish')`-nya sendiri → klien melihat ECONNRESET. Kini
   pause-then-destroy-after-flush. (tetap di v1.4)
2. **Banjir mint mid-measurement** — token per-request merusak ramp
   multi-thread. Kini cache token per-IP; limiter hanya menghitung mint
   sungguhan. (tetap)
3. **Pool growth macet** — worker mati di tengah ring memblokir aktivasi
   worker setelahnya. Kini himpunan aktif eksplisit + kandidat scan. (tetap)
4. **Crash EADDRINUSE tanpa log** → exit(1) dengan errno. (tetap)
5. **deploy-pool.sh path wrangler 4.x** + dukungan Global API Key. (tetap)
6. **Split upload modulo keliru** (`n % 1000 < share×1000` mengirim 150
   request pertama SEMUANYA ke VPS) → Bresenham interleave. **v1.4 memakai
   algoritma yang sama untuk download** — pembagian benar sejak request
   pertama (teruji unit T13/T14: share 0.5 → E,V,E,V,E; share 0.15 →
   20 request = 3/17 eksak).

## 5. Bukti

### 5.1 Test suite v1.4 (sandbox, 26 Nov 2026 — kode `vps-full-potential`)

| Suite | Hasil |
|---|---|
| Unit gateway T1–T14 | **13/13** — termasuk T11 (share=1.0: lane lokal UNCAPPED, 245.388 B eksak + 1.118.012 B multi-chunk, printable-ASCII, 0 mint), T12 (share=0: murni edge 302; 5 request = 1 mint cache), T13 (share=0.5: pola 302,200,302,200,forced-200 tanpa 429), **T14 baru** (share=0.15: distribusi eksak 20 req → 3 VPS/17 edge, 1 mint) |
| E2E assist (`e2e-assist-test.sh`) | **4/4** — pool-skip-broken {1,3}; uncapped-local-lane (2 gambar, lane vps); edge-assist-302; interleave+forced-local tanpa 429 |
| E2E pool regression | **PASS** (scale-up 2, shrink 1, round-robin download) |

### 5.2 Produksi v1.3 (konteks historis, 2026-11-25 — angka di bawah diukur
dengan budget lane; v1.4 MENGHAPUS budget, agregat = VPS murni + edge)

| Pengukuran | Nilai |
|---|---|
| Stock `speedtest-cli --mini` | 218.5 / 127.1 Mbps |
| Hybrid wrapper 32/8 thread | 600.1 / 339.7 Mbps |
| CLI resmi Ookla (NetGauge VPS :8080) | **470.9 / 448.8 Mbps down, 170.3 up** — bukti kapasitas VPS murni |
| Edge 8-stream paralel (8 worker) | **2.27 Gbps** — plafon arsitektur |
| Root-cause plafon lama | nftables SYN limit 260/s burst 5 → 2000/s burst 64 (43×) |

v1.4 menghapus satu-satunya cap buatan yang tersisa (budget byte) —
dengan share yang tepat, lane VPS kini bisa jenuh pada ~470 Mbps itu
SEKALIGUS edge menambah sisanya.

## 6. Cara mengaktifkan (operator)

**Instalasi baru / full-stack (jalur disarankan):**

```bash
cp .env.example .env
nano .env        # CLOUDFLARE_API_TOKEN / ACCOUNT_ID / CF_WORKER_DEPLOY_COUNT=100
sudo ./install.sh --start
```

install.sh memasang: daemon speedtest (OoklaServer.properties STANDAR —
tidak disentuh), gateway hybrid + systemd unit + gateway.env dari .env,
secret HMAC (auto-generate bila kosong), lalu **deploy N worker ke
Cloudflare beserta secret-nya** + verifikasi `/__meta` per worker.

**Upgrade dari v1.3 (VPS yang sudah jalan):**

```bash
cd /path/to/SpeedtestServer && git fetch && git checkout vps-full-potential   # atau setelah merge: master
cp .env.example .env && nano .env    # isi kredensial + CF_WORKER_DEPLOY_COUNT
sudo ./install.sh --start            # idempotent: gateway.env di-regenerate (backup .bak otomatis)
# HAPUS var lama bila masih ada di .env: HYBRID_VPS_DL_BUDGET_MBPS (diabaikan)
```

**Klien hybrid yang memaksimalkan agregat:**

```bash
HYBRID_DL_THREADS=16 HYBRID_UL_THREADS=8 HYBRID_DL_COUNTS=8 \
HYBRID_VPS_UL_SHARE=0.15 \
python3 hybrid/probe-client/speedtest-cli-hybrid.py --json --server <ID>
```

Observasi: `curl -s https://<front>:8790/api/health` →
`front.assist.vpsDlShare` + `front.counters` (dlLocal / dlLocalBytes /
downRedirects / dlLocalForced) — atribusi per jalur.
`journalctl -u speedtest-hybrid-gateway | grep front_download` — lane per
request.

## 7. Batasan yang jujur

- **CLI resmi Ookla tidak terpengaruh** — jalurnya selalu NetGauge TCP
  langsung ke VPS :8080 (protokol binary tidak bisa lewat edge; terbukti
  E-D/E-E). Assist hanya untuk klien HTTP-plane (stock speedtest-cli,
  mini, custom).
- **Kuota Workers Free tetap per-akun 100k request/hari** — pool
  mendistribusikan, tidak mengalikan. Share VPS yang lebih besar justru
  menghemat kuota (request yang dilayani lokal tidak memakai CF).
- **Upload klien stock tetap 100% di VPS** — tidak ada mekanisme redirect
  POST ber-body untuk urllib; pemecahan hanya di klien hybrid.
- Aritmetika agregat adalah upper bound: cap sebenarnya =
  min(kapasitas klien, kontribusi VPS + throughput edge agregat
  RTT-tergantung). VPS tidak dibatasi apapun selain link dan TCP-nya.
- **Migrasi v1.3 → v1.4:** variabel budget lama di environment diabaikan
  (tidak error); keluarkan dari .env/gateway.env manual agar tidak membingungkan.
