# HYBRID_DEPLOYMENT_RUNBOOK — Deploy dan operasional Jalur B (hybrid)

**Dibuat:** 24 November 2026 (sesi agent UAEG, basis `master` + commit lokal hingga Fase 8)
**Lingkup:** Jalur B (hybrid gateway VPS + Cloudflare Worker). Jalur A (Ookla) tidak diubah oleh runbook ini.

## 1. Prasyarat

| Komponen | Versi terverifikasi | Catatan |
|---|---|---|
| Node.js | v24.22.3 (VPS dan mesin deploy) | Gateway zero-dependency; Worker dibundel wrangler |
| wrangler | 4.167.0 via `npx wrangler` (devDependencies `hybrid/worker`) | Jangan pakai `wrangler login`; pakai env `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_API_KEY`+`CLOUDFLARE_EMAIL` |
| git repo | `/opt/SpeedtestServer-src` (VPS), branch `master` | Basis deploy: commit Fase 3 (`d8a034f` ke atas) |
| compatibility_date Worker | `2026-10-01` | Naikkan hanya setelah conformance lulus |
| Akses VPS | UAEG (MCP `https://45.126.249.250:3902/mcp`) | Menjalankan perintah sebagai root |

## 2. Credential dan secret (NAMA saja — nilai tidak boleh masuk repo)

| Nama | Lokasi | Keterangan |
|---|---|---|
| `HYBRID_SHARED_SECRET` | `/etc/speedtest-hybrid/gateway.env` (0600/0640, root) DAN `wrangler secret put HYBRID_SHARED_SECRET` | HMAC-SHA256 shared secret; dibuat dengan `openssl rand -hex 32`; nilai sama di kedua sisi |
| `CLOUDFLARE_API_TOKEN` atau `CLOUDFLARE_API_KEY`+`CLOUDFLARE_EMAIL` | environment proses deploy saja | Token terbatas rekomendasi: template "Edit Cloudflare Workers" + `Zone › Zone:Read` + `Zone › DNS:Read` untuk inventaris |

## 3. Gateway di VPS (sudah TERDEPLOY 24 Nov 2026)

| Item | Nilai |
|---|---|
| Unit systemd | `speedtest-hybrid-gateway.service` (enabled) |
| User/Group | `speedtest-hybrid` (system, nologin) |
| Runtime | `/opt/speedtest-hybrid/gateway/gateway.mjs` |
| Env file | `/etc/speedtest-hybrid/gateway.env` |
| State | `/var/lib/speedtest-hybrid/` (results.jsonl) |
| Port | **8790** TCP publik, TLS 1.2+ (bukan 80/443/5060/8080/8081/8443 — K-5) |
| TLS | Sertifikat wildcard `/var/lib/speedtestserver/certs/{fullchain,privkey}.pem` dibaca lewat `LoadCredential=` → `/run/credentials/speedtest-hybrid-gateway.service/{cert,key}` (file asli tidak diubah; privkey 0600 milik user speedtestserver) |
| URL publik | `https://speedtest.lumajangnetworks.my.id:8790` |
| Endpoint | `/api/servers`, `POST /api/sessions`, `/api/ping`, `POST /api/results`, `/api/health` |
| Firewall | Tidak ada perubahan (nftables policy accept) — hanya ada listener publik baru di 8790 |

### Variabel env gateway (produksi saat ini)

```
HYBRID_GATEWAY_PORT=8790
HYBRID_GATEWAY_BIND=0.0.0.0
HYBRID_GATEWAY_TLS_CERT=/run/credentials/speedtest-hybrid-gateway.service/cert
HYBRID_GATEWAY_TLS_KEY=/run/credentials/speedtest-hybrid-gateway.service/key
HYBRID_VPS_PUBLIC_BASE=https://speedtest.lumajangnetworks.my.id:8790
HYBRID_WORKER_BASE=https://speedtest-hybrid-worker.<subdomain>.workers.dev   # diisi setelah Fase C
HYBRID_STS_BASE=https://speedtest.lumajangnetworks.my.id:8080
HYBRID_TOKEN_TTL_MS=300000        # G-1: 5 menit
HYBRID_TOKEN_BIND_IP=false        # G-1: token ip='*'
HYBRID_DISCOVERY_FALLBACK=false   # G-3/K-7
HYBRID_RESULTS_FILE=/var/lib/speedtest-hybrid/results.jsonl
HYBRID_RESULTS_DEDUP_MS=3600000   # G-9
```

### Instalasi dari nol (ulang)

1. `useradd --system --home-dir /nonexistent --shell /usr/sbin/nologin speedtest-hybrid`
2. `mkdir -p /opt/speedtest-hybrid/gateway /etc/speedtest-hybrid /var/lib/speedtest-hybrid`
3. `cp <repo>/hybrid/gateway/src/gateway.mjs /opt/speedtest-hybrid/gateway/`
4. Salin `hybrid/gateway/gateway.env.example` → `/etc/speedtest-hybrid/gateway.env`, isi secret (`openssl rand -hex 32`), sesuaikan `HYBRID_WORKER_BASE`; `chown root:speedtest-hybrid`, `chmod 640`
5. Salin `hybrid/gateway/speedtest-hybrid-gateway.service.example` → `/etc/systemd/system/speedtest-hybrid-gateway.service`, tambahkan dua baris `LoadCredential=cert:/var/lib/speedtestserver/certs/fullchain.pem` dan `LoadCredential=key:/var/lib/speedtestserver/certs/privkey.pem`
6. `systemctl daemon-reload && systemctl enable --now speedtest-hybrid-gateway`
7. Verifikasi: `curl -s https://speedtest.lumajangnetworks.my.id:8790/api/health` (TLS ketat, tanpa `-k`)

### Update versi gateway

1. Salin `gateway.mjs` baru ke `/opt/speedtest-hybrid/gateway/`
2. `systemctl restart speedtest-hybrid-gateway` (unit lain TIDAK ikut restart)
3. Verifikasi PID keempat unit produksi tidak berubah: `systemctl show speedtestserver speedtestserver-legacy nperf-server ookla-capture -p MainPID,NRestarts`

## 4. Worker di Cloudflare (MENUNGGU credential — langkah siap pakai)

Konfigurasi acuan sudah ada di `hybrid/worker/wrangler.toml` (production) dan `[env.test]` (worker uji, cap 32 MiB, legacy ON, open mode). Urutan Fase C:

```bash
cd hybrid/worker
# inventaris read-only
npx wrangler whoami
npx wrangler deployments list || true

# 1) Worker uji (open mode + legacy ON, cap 32 MiB)
npx wrangler deploy --env test
node test/conformance.mjs https://speedtest-hybrid-worker-test.<subdomain>.workers.dev
# ukur CPU/invocation (Analytics/wrangler tail) → simpan ke hybrid/lab/evidence/e-j-real-edge/
npx wrangler delete --env test   # WAJIB setelah pengukuran

# 2) Worker produksi
npx wrangler secret put HYBRID_SHARED_SECRET   # nilai sama dengan gateway.env
npx wrangler deploy
# uji token positif+negatif:
TOKEN_TEST_SECRET=<secret> TOKEN_TEST_IP=<ip-egress-anda> node test/token-tests.mjs https://speedtest-hybrid-worker.<subdomain>.workers.dev
```

Catatan:
- `workers.dev = true`, `preview_urls = false`; tidak ada route/DNS/Custom Domain di pilot (K-4).
- Bila akun belum punya subdomain `workers.dev`, pendaftarannya adalah titik STOP (persetujuan operator).
- Batas uji agent: 20.000 invokasi/hari UTC (§3.11 master prompt). Jangan pernah menghabiskan kuota akun.
- Setelah Worker produksi aktif: perbarui `HYBRID_WORKER_BASE` di gateway.env lalu `systemctl restart speedtest-hybrid-gateway`.

## 5. Verifikasi rutin

1. `/api/health` publik (TLS ketat) — counters + konfigurasi tanpa secret.
2. Gate Jalur A: `validation/harness/check-http-compatibility.py --host speedtest.lumajangnetworks.my.id` (31/31) dan `host-tester-check.py` dua varian (19/19 default; varian `--legacy-port 8080` 9/19 adalah deviasi magic-byte JPEG yang diketahui — lihat HOST_TESTER_RUNBOOK).
3. Atribusi byte E2E (jendela terisolasi):
   - C0: `cat /sys/class/net/eth0/statistics/{rx,tx}_bytes` di VPS + counters `/api/health`
   - jalankan probe: `PROBE_MODE=both HYBRID_GATEWAY_BASE=https://speedtest.lumajangnetworks.my.id:8790 HYBRID_WORKER_BASE=<edge> node hybrid/probe-client/src/hybrid-probe.mjs`
   - C1: baca ulang counters; delta VPS harus KB-scale sedangkan payload puluhan MB (evidence 24 Nov: payload 117.440.512 B vs delta interface 67.971 B, offload ≈1:28.000).
4. PID keempat unit produksi tidak berubah.

## 6. Rollback

| Komponen | Perintah |
|---|---|
| Gateway | `systemctl disable --now speedtest-hybrid-gateway` (unit/env/`/opt/speedtest-hybrid` dihapus hanya dengan persetujuan operator) |
| Worker | `npx wrangler deployments list` lalu `npx wrangler rollback <version-id>`; atau turunkan `MAX_*` di vars lalu deploy ulang |
| Worker uji | `npx wrangler delete --env test` |
| Berhenti mengarah client ke Worker | Set `HYBRID_DISCOVERY_FALLBACK=false` (sudah) DAN hentikan penerbitan sesi (matikan `/api/sessions` via secret kosong tidak disarankan — cukup matikan unit gateway) |

## 7. Troubleshooting

| Gejala | Penyebab | Tindakan |
|---|---|---|
| 401 `ip-mismatch` | Gateway di-set `HYBRID_TOKEN_BIND_IP=true` sementara client dual-stack/proxy | Set `false` (default) — token di-mint `ip='*'` |
| 401 `bad-signature` massal setelah rotasi secret | Secret Worker ≠ gateway | Samakan nilai; token lama otomatis gagal (kontrak v1 tanpa `kid`) |
| 1102 / CPU exceeded di Worker | Transfer per invokasi terlalu besar untuk Free (10 ms CPU) | Turunkan `MAX_DOWNLOAD/MAX_UPLOAD_BYTES` atau kecilkan chunk client; data pengukuran di `e-j-real-edge/` |
| 1027 / 429 | Kuota harian akun habis | Berhenti menguji; reset 00:00 UTC; jangan pernah habiskan kuota akun |
| 413 di `__up`/`upload.php` | Body melebihi `MAX_UPLOAD_BYTES` | Normal (G-4); kecilkan chunk |
| Gateway tidak mau start: TLS key tidak terbaca | Path `LoadCredential` salah / env file 0644 | Cek `journalctl -u speedtest-hybrid-gateway`; env harus 0640 root:speedtest-hybrid |
| `NoServersException` CLI resmi | Host tidak terdaftar di daftar server Ookla (bukan bug server) | Di luar kendali kode; lihat HOST_TESTER_RUNBOOK §registrasi |

## 8. Catatan kuota Workers Free

- 100.000 invokasi/akun/hari (reset 00:00 UTC = 07:00 WIB); batas uji agent 20.000/hari.
- 10 ms CPU/invokasi; 128 MB/isolate; body request 100 MB (Free).
- Transfer HTTP per chunk 16–25 MiB (final dari pengukuran edge nyata — Fase C.3).
- CPU per koneksi WebSocket di Free belum terverifikasi — ukur dulu sebelum menjadikan `/ws` transport utama (K-6).
