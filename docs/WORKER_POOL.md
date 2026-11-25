# WORKER_POOL — Smart Worker Pool 1..100 (VPS kendali + worker otonom)

**Dibuat:** 25 November 2026 (sesi 8 — production hardening + worker pool).
**Status:** IMPLEMENTED (gateway + worker + deploy script) · Worker v1.2 DEPLOYED (primary, verifikasi E2E) · Pool 2..100 menunggu `HYBRID_SHARED_SECRET` (lihat "Cara mengaktifkan pool").

> **Sesi 9 (2026-11-25, branch `hybrid-assist-lane`):** growth pool diperbaiki —
> worker mati/benched di tengah ring tidak lagi memblokir aktivasi worker
> setelahnya (himpunan aktif eksplisit + kandidat scan; bukti E2E 4/4 di
> `docs/HYBRID_ASSIST_MODE.md`). Pool kini juga berpasangan dengan **VPS
> assist lane** — VPS menyumbang bandwidth sampai budget, worker menangkap
> overflow: lihat `docs/HYBRID_ASSIST_MODE.md`.

## 1. Konsep dan batasan platform (jujur)

| Fakta | Bukti |
|---|---|
| Workers Free membatasi **100 script Worker per akun** | developers.cloudflare.com/workers/platform/limits (verifikasi 2026-11-25) |
| Kuota harian **100.000 request/hari adalah PER AKUN** — pool 100 worker TIDAK mengalikan kuota, hanya MENDISTRIBUSIKANNYA | idem + docs/WORKERS_LIMITS.md |
| CPU 10 ms/invocation bersifat **soft-limit** (overrun jarang ditoleransi; konsisten → error 1102). Terukur real-edge: CPU P50 s/d 259 ms tanpa error; 2 event `exceededResources` sejak 24 Nov | hybrid/lab/evidence/e-j-real-edge/, CF GraphQL Analytics |
| Worker idle = **0 invocation** (gratis); traffic hanya masuk ke worker yang di-rotasi gateway | desain pool |

Apa yang DIBERIKAN pool 100 worker:
- **Distribusi CPU per-script**: traffic tersebar → rata-rata CPU per script turun, event 1102 per script berkurang.
- **Isolasi blast-radius**: satu script kena throttle/error tidak mematikan jalur lain.
- **Kapasitas kendali**: VPS menentukan siapa yang menerima traffic (rotasi aktif), worker menolong satu sama lain saat jenuh.

## 2. Arsitektur

```
                     ┌──────────────────── VPS (kendali) ────────────────────┐
                     │ gateway /api/sessions → mintToken + pickWorker()     │
                     │ workerpool.mjs: autoscaler (mint-rate), canary,       │
                     │ bench, round-robin, CF-quota guard (opsional)        │
                     └───────────────┬──────────────────────────────────────┘
                                     │ token + worker terpilih (302 / JSON)
   ┌─────────────────────────────────┼─────────────────────────────────┐
   │  Worker 1 (primary)   Worker 2 … Worker N (≤100)                 │
   │  WORKER_ID/POOL_MAX + HYBRID_SHARED_SECRET (HMAC, sama semua)     │
   │  per-isolate gauge: inFlight + EWMA → /__meta                     │
   │  SATURASI (inFlight ≥ WORKER_DEFLECT_CONCURRENCY):                │
   │    __down/__up → 302/307 ke sibling + hop=1 (loop-guarded)        │
   │    /ws → 503 + Location (client hybrid reconnect)                 │
   └───────────────────────────────────────────────────────────────────┘
```

Dua lapis keputusan ("siapa yang aktif"):
1. **Gateway (VPS)** — autoscaler global: `activeCount` tumbuh mengikuti mint-rate (tokens/min per worker aktif), tiap kandidat baru di-**canary** (`__down?bytes=0`, 1 invocation) sebelum masuk rotasi; mengecil setelah idle berkelanjutan. Kandidat canary gagal → backoff eksponensial 5 s→60 s + bench.
2. **Worker (otonom)** — gauge per-isolate; saat jenuh, request terautentikasi **dibelokkan** ke sibling berikutnya (ring 1→2→…→N→1). Anonim tidak pernah dibelokkan (401 dulu). `hop=1` mencegah loop.

## 3. Konfigurasi (semua di VPS — /etc/speedtest-hybrid/gateway.env)

| Env | Default | Arti |
|---|---|---|
| HYBRID_WORKER_POOL_MAX | 1 | Ukuran pool di rotasi (1 = perilaku lama; 100 = batas Free) |
| HYBRID_WORKER_ACTIVE_MIN | 1 | Jumlah worker aktif minimum |
| HYBRID_WORKER_ACTIVE_MAX | = pool | Batas aktif |
| HYBRID_WORKER_SCALE_RATE | 24 | tokens/min per worker aktif yang mengjustifikasi +1 worker |
| HYBRID_WORKER_SHRINK_RATE | 6 | tokens/min per worker di bawah garis idle |
| HYBRID_WORKER_IDLE_SHRINK_MS | 600000 | Idle berkelanjutan sebelum mengecil 1 |
| HYBRID_WORKER_PROBE_INTERVAL_MS | 0 | Probe berkala set aktif (0 = off; canary saat scale-up selalu ON) |
| HYBRID_WORKER_BENCH_COOLDOWN_MS | 120000 | Bench untuk worker gagal |
| HYBRID_WORKER_URLS | (auto) | Daftar URL eksplisit (wajib untuk pool custom-domain) |
| HYBRID_CF_API_TOKEN + HYBRID_CF_ACCOUNT_ID | (off) | Quota guard: query GraphQL per jam; ≥soft% → stop grow, ≥hard% → tolak mint |
| HYBRID_CF_QUOTA_SOFT_PCT / HARD_PCT | 80 / 95 | Ambang quota guard |
| HYBRID_SESSIONS_RATE_LIMIT_MPM | 60 | Rate-limit per-IP /api/sessions (fix token fountain) |

Worker-side vars (wrangler): `WORKER_ID`, `WORKER_POOL_MAX`, `WORKER_DEFLECT_CONCURRENCY` (default 6).

URL pool diturunkan otomatis: `speedtest-hybrid-worker.lumajangnetworks.workers.dev` → `speedtest-hybrid-worker-2..-100.lumajangnetworks.workers.dev`.

## 4. Cara mengaktifkan pool (operator, butuh 2 hal)

1. **HYBRID_SHARED_SECRET** (nilai sama dengan gateway VPS; secret Worker write-only — tidak bisa dibaca ulang).
2. **Akses shell VPS** (UAEG) untuk update gateway + env.

Langkah:
```bash
# di repo hybrid/worker:
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... \
HYBRID_SHARED_SECRET=<rahasia yang sama dengan VPS> \
POOL_SIZE=100 bash deploy-pool.sh          # deploy 1..100 + verify /__meta

# di VPS:
#   git pull master; rsync hybrid/gateway → /opt/speedtest-hybrid (prosedur runbook)
#   tambahkan di /etc/speedtest-hybrid/gateway.env:
#     HYBRID_WORKER_POOL_MAX=100
#     HYBRID_WORKER_ACTIVE_MIN=2
#   systemctl restart speedtest-hybrid-gateway
#   curl -s https://speedtest.lumajangnetworks.my.id:8790/api/pool   # status live
```

## 5. Bukti pengujian (2026-11-25)

| Suite | Hasil |
|---|---|
| Worker lokal (conformance + token + free-hardening + **pool**) | **90/90** (`hybrid/worker/test/run-tests.sh`, fase 3 baru: deflection 302+hop=1, anonim tak dibelokkan, 503+Location WS, UPLOAD wire-length) |
| Gateway lokal (crash-guard, rate-limit, 413, pool unit) | **9/9** (`hybrid/gateway/test/gateway-tests.mjs`) |
| **E2E autoscaler** (3 worker lokal, 1 sengaja rusak) | **PASS semua**: idle→1 aktif; burst 40 mint/min → naik 2 (worker rusak DITOLAK canary); idle → turun 1; download via worker terpilih 200/1 MiB (`hybrid/gateway/test/e2e-pool-test.sh`) |
| Worker primary v1.2 di produksi | DEPLOYED (versi d50eb297); E2E vs gateway produksi: token → 5 MiB @30,6 MB/s (HKG); 302 front; 401 tanpa token |

## 6. Pemeliharaan & rollback

- Naik/turun pool: ubah `HYBRID_WORKER_POOL_MAX` di gateway.env → restart (worker tak dipakai tidak dihapus).
- Hapus sibling: `npx wrangler delete --name speedtest-hybrid-worker-N` (jangan hapus primary).
- Deflection mati total: set `WORKER_DEFLECT_CONCURRENCY=999999` (var per worker) atau `HYBRID_WORKER_POOL_MAX=1` di gateway.
- Observasi: `journalctl -u speedtest-hybrid-gateway | grep pool_` (event `pool_scaled_up/down`, `pool_canary_backoff`, `pool_deflect`).
