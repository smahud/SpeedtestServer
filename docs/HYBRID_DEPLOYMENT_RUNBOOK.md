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
3. Verifikasi PID keempat unit produksi tidak berubah: `systemctl show speedtestserver speedtestserver-legacy layanan-lain ookla-capture -p MainPID,NRestarts`

## 4. Worker di Cloudflare (TERDEPLOY 24 November 2026 - status produksi)

**Status produksi saat ini:**

- Subdomain workers.dev: `lumajangnetworks` (terdaftar via API 24 Nov 2026).
- Worker produksi: `speedtest-hybrid-worker` -> https://speedtest-hybrid-worker.lumajangnetworks.workers.dev
  - Versi: `28e2f5cc-9bd3-4c17-a5d1-cdb26574b567` (v1 `b54b744d` + G-4b `request.body.cancel()` early-413).
  - Cap: MAX_DOWNLOAD/MAX_UPLOAD 25 MiB; LEGACY_HTTP_ENABLED=false; secret `HYBRID_SHARED_SECRET` terpasang (nilai sama dengan gateway).
  - Bukti edge nyata: conformance 55/55 (worker uji), token 11/11, hardening 17/17, CPU terukur - `hybrid/lab/evidence/e-j-real-edge/README.md`.
- Worker uji `speedtest-hybrid-worker-test`: dipakai untuk conformance + pengukuran CPU, **sudah dihapus** (wajib).
- Gateway VPS: `HYBRID_WORKER_BASE` menunjuk URL produksi di atas.
- Platform-hold (terverifikasi): respons Worker ditahan sampai body request selesai; "413 early" lying-CL tidak teramati klien - perlindungan via real-body 413 (TEST_OVERCAP_BODY=1).
- Kuota 24 Nov UTC: produksi 110 request + uji ~94 (dihapus) - jauh di bawah budget uji agent 20.000/hari.

Langkah di bawah tetap berlaku untuk deploy ulang / update versi:

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


---

## §front — Speedtest front di gateway (sesi 3, 24 November 2026)

Front = permukaan HTTP legacy speedtest (`latency.txt`, `random*.jpg`, `upload.php`) di gateway VPS dengan offload payload ke Worker. Latar dan hasil uji: `docs/SPEEDTEST_FRONT_TEST_REPORT_2026-11-24.md`.

### File dan env

| Item | Nilai |
|---|---|
| Runtime | `/opt/speedtest-hybrid/gateway/{gateway.mjs,front.mjs}` (unit `speedtest-hybrid-gateway.service`, port 8790 TLS — tidak berubah) |
| Sumber repo | `hybrid/gateway/src/{gateway.mjs,front.mjs}` |
| `HYBRID_FRONT_ENABLED` | `true` di `/etc/speedtest-hybrid/gateway.env` (default kode `false`) |
| `HYBRID_FRONT_RATE_LIMIT_MPM` | `90` (mint token per IP per menit; 0 = mati) |
| `HYBRID_FRONT_MAX_DOWN_BYTES` | `26214400` (25 MiB, harus ≤ `MAX_DOWNLOAD_BYTES` Worker) |

### Perilaku rute

| Rute | Perilaku |
|---|---|
| `GET/HEAD /speedtest/latency.txt` | `test=test` langsung dari VPS (plane ping — jangan di-redirect) |
| `GET/HEAD /speedtest/random{N}x{N}.jpg` | `302 Location: <WORKER_BASE>/__down?bytes=<effective>&token=<mint>`; `effective = min(size, HYBRID_FRONT_MAX_DOWN_BYTES)` |
| `POST /speedtest/upload.php` | drain penuh → `200 size=<drained>` (klien stock; watchdog 180 s, cap 256 MiB) |
| `GET/HEAD /speedtest/upload.php` | `200 size=0` (probe mini server) |
| `GET / , /hi` | banner paritas daemon |

### Verifikasi pasca-deploy

```bash
BASE=https://speedtest.lumajangnetworks.my.id:8790
curl -s $BASE/api/health | python3 -m json.tool      # "front": {"enabled": true, ...}
curl -s "$BASE/speedtest/latency.txt?x=1"            # test=test
curl -s "$BASE/speedtest/upload.php"                 # size=0
curl -s -o /dev/null -D - "$BASE/speedtest/random350x350.jpg"   # 302 -> workers.dev
curl -s -L -o /dev/null -w '%{http_code} %{size_download} %{remote_ip}\n' \
  "$BASE/speedtest/random350x350.jpg"                # 200 245388 <anycast-CF> (bukan IP VPS)
curl -s -o /dev/null -w '%{http_code}\n' "https://speedtest-hybrid-worker.lumajangnetworks.workers.dev/__down?bytes=100"  # 401
# rate limit: 91+ request cepat -> 429
```

### Rollback front

```bash
# 1. matikan front tanpa memundurkan kode:
sed -i 's/^HYBRID_FRONT_ENABLED=.*/HYBRID_FRONT_ENABLED=false/' /etc/speedtest-hybrid/gateway.env
systemctl restart speedtest-hybrid-gateway
# 2. kembalikan kode sesi 2 (snapshot pra-deploy sesi 3 ada di /root/speedtest-hybrid-work/gateway-backup-*):
cp /root/speedtest-hybrid-work/gateway-backup-<ts>/gateway.mjs /opt/speedtest-hybrid/gateway/gateway.mjs
rm -f /opt/speedtest-hybrid/gateway/front.mjs
chown root:speedtest-hybrid /opt/speedtest-hybrid/gateway/gateway.mjs && chmod 644 /opt/speedtest-hybrid/gateway/gateway.mjs
systemctl restart speedtest-hybrid-gateway && systemctl is-active speedtest-hybrid-gateway
```

Rollback front TIDAK menyentuh Jalur A (daemon :8080/legacy :80 tidak pernah berubah).

### Mock domain (`speedtest-mock.lumajangnetworks.my.id`)

Sertifikat wildcard sudah mencakup nama ini. Aktivasi saat ini via `/etc/hosts` client uji (credential API tidak punya izin `Zone › DNS`). Untuk mengaktifkan di DNS publik (butuh token dengan `Zone › DNS › Edit`, atau dashboard):

```bash
curl -X POST "https://api.cloudflare.com/client/v4/zones/c299f26316fb0615d05d00c3d1e436a3/dns_records" \
  -H "Authorization: Bearer <token-dns-edit>" -H "Content-Type: application/json" \
  -d '{"type":"A","name":"speedtest-mock","content":"45.126.249.250","proxied":false,"comment":"hybrid speedtest front - sesi 3"}'
```

`proxied:false` WAJIB (DNS-only) — front memakai TLS asli VPS, bukan proxy Cloudflare. Rollback: hapus record tersebut (tidak boleh menyentuh record lain — invariant §3.1).

### Klien uji

- Stock: `speedtest-cli --json --mini https://speedtest.lumajangnetworks.my.id:8790` (download via edge, upload jalur VPS — batas urllib, lihat laporan §6.2).
- Hybrid penuh: `python3 hybrid/probe-client/speedtest-cli-hybrid.py` dengan env `HYBRID_GATEWAY_BASE`, `HYBRID_WORKER_BASE`, `HYBRID_FRONT_BASE`, dan (mode domain list) `HYBRID_SERVER_LIST_FILE=hybrid/probe-client/server-list-surabaya.json` + `--server <ID>`.
- CLI resmi Ookla: jalur Jalur A (`--server-id`, tanpa perubahan apa pun); hasilnya jangan dipublikasikan dari tes paksa (blokir `results.speedtest.net` di /etc/hosts client uji).

### Troubleshooting front

| Gejala | Penyebab umum | Tindakan |
|---|---|---|
| speedtest-cli stock: `Upload: 0.00 Mbit/s` | klien mengikuti 307/302 dengan body (tidak didukung urllib) — atau `HYBRID_FRONT_ENABLED=false` | pastikan front aktif; gunakan wrapper untuk offload upload |
| `429` saat uji cepat | rate limit mint (90/menit/IP) | naikkan `HYBRID_FRONT_RATE_LIMIT_MPM` untuk pengujian (jangan permanen) |
| `random4000x4000.jpg` turun ke 25 MiB | `HYBRID_FRONT_MAX_DOWN_BYTES` < 31,6 MB (disengaja, T-11) | ukuran tetap terukur jujur; jangan naikkan di atas cap Worker |
| `NoMatchedServers` saat `--server <ID Surabaya>` | daftar geo-lokal speedtest.net (T-12) | pakai `HYBRID_SERVER_LIST_FILE` |
| ping gagal (`cum 3600`) | `latency.txt` bukan 200/`test=test` (mis. front mati) | cek `systemctl status speedtest-hybrid-gateway` + journal `front_latency` |
