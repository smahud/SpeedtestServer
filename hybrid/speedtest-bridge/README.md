# speedtest-bridge — front VPS untuk klien NATIVE Ookla + payload Worker

> **Komponen permanen di VPS** (dipromosikan dari eksperimen lab
> `hybrid/lab/cli-bridge/` yang tervalidasi 27 Nov 2026 — verdict
> REALIZED_WITH_RELAY; angka lengkap: `docs/CLI_BRIDGE_REPORT_2026-11-27.md`).
> Dipasang oleh `install.sh` sebagai `speedtest-bridge.service` (auto-start
> saat boot + auto-restart saat crash), env-gated oleh `SPEEDTEST_BRIDGE_ENABLED`
> di `.env`. Kontrak utama proyek: `CONTRACT.md` (root repo).

## Di mana bridge ini berjalan (penting)

**Di VPS — BUKAN di client.** Ini komponen sisi server. Client tidak pernah
dipasang apa pun dan selalu aplikasi **asli Ookla tanpa modifikasi**: CLI resmi
(binary repo), app Android/iOS, atau web — semua tetap native. Nama lama
"cli-bridge" dipensiunkan agar tidak terkesan ada komponen di sisi client.
CLI resmi di sandbox agent hanyalah **tester** untuk reverse engineering;
client produksi bisa aplikasi Ookla mana pun.

## Arsitektur

```
klien Ookla native (tanpa modifikasi) --NetGauge TCP/UDP--> speedtest-bridge :8080 (VPS)
  control:  HI/HELLO · GETIP · PING · CAPABILITIES · INITPLOSS/PLOSS · UDP LOSS
            → LOKAL di VPS (paritas semantik daemon, PROTOCOL_CONTRACT.md §2–3)
  download: byte pool ← Worker /__down (chunk 4 MiB, streaming + backpressure NYATA)
            atau ← Worker /ws NetGauge (per-chunk command, framing di-strip)
  upload:   payload → Worker /__up (POST per-chunk, receipt {bytes:N})
            atau → Worker /ws (frame; ack "OK n <ts>" = receipt)

TLS ClientHello (0x16 0x03 …) di :8080 → raw-proxy ke gateway hybrid
            (loopback, default 127.0.0.1:8790) — paritas daemon
            PROTOCOL_CONTRACT §1: satu port TCP multiplex TLS + NetGauge.
```

Tata letak port (hanya port native OoklaServer yang terbuka):

| Port | Pemilik | Fungsi |
|---|---|---|
| TCP :8080 | **speedtest-bridge** | front NetGauge native + mux TLS → gateway (loopback) |
| UDP :8080 | **speedtest-bridge** | loss plane (LOSS/RECV) |
| TCP :5060 | **OoklaServer daemon** | port native satunya (konfigurasi di `OoklaServer.properties` — TIDAK diubah bridge) |
| UDP :5060 | **OoklaServer daemon** | loss plane daemon |
| :8790 | gateway hybrid | **loopback saja** (upstream mux; tidak lagi publik) |

- Front bridge men-TERMINASI protokol native persis seperti daemon (port
  `NetGaugeEngine.ts` yang sudah diverifikasi): binary-hello→ERROR (memicu
  fallback plaintext klien), strict GETIP + pre-session gate (mute), three
  strikes (F-24), UPLOAD inclusive counting + `OK n <epoch>` (F-9/F-13),
  byte-exact `DOWNLOAD n`, UDP LOSS init/loaded + `RECV`, bounded loss
  registry (F-33).
- **worker-http** (default, direkomendasikan): `/__down` ber-backpressure
  nyata + `/__up` per-chunk dengan receipt.
- **worker-ws**: satu sesi WSS NetGauge per koneksi; framing per-command
  di-strip (stream tetap byte-exact); chunk 1 MiB wajib (single-command
  32 MiB tanpa pacing ter-bunuh `exceededResources` — reproduksi 27 Nov:
  10/32 mati).
- **local**: pool paritas daemon di-serve VPS (jalur kontrol A/B).

## Guard abuse (rekomendasi #1 laporan 27 Nov)

- `SPEEDTEST_BRIDGE_MAX_CONN_PER_IP` (default 500, paritas daemon).
- `SPEEDTEST_BRIDGE_CONN_RATE_PER_MIN` (default 240 koneksi baru/menit/IP;
  satu run CLI membuka 30–45 koneksi → default memuat ~5 run paralel per IP;
  0 = mati). Koneksi ke-241 dari satu IP dalam satu menit di-destroy +
  dilog `conn_rate_rejected`.
- Mint token tetap di belakang rate-limiter gateway (token satu proses
  di-cache + backoff 5 dtk).

## Menjalankan

```bash
# produksi: sudah otomatis (install.sh + systemd):
systemctl status speedtest-bridge
journalctl -u speedtest-bridge -f
# log JSONL: /var/lib/speedtest-bridge/speedtest-bridge.jsonl

# foreground (debug):
SPEEDTEST_BRIDGE_BACKEND=worker-http \
SPEEDTEST_BRIDGE_GATEWAY_BASE=https://127.0.0.1:8790 \
  node hybrid/speedtest-bridge/speedtest-bridge.mjs \
  --port 8080 --log /tmp/speedtest-bridge.jsonl

# token tetap (tanpa gateway): SPEEDTEST_BRIDGE_TOKEN=… SPEEDTEST_BRIDGE_WORKER_BASE=https://…
# backend: SPEEDTEST_BRIDGE_BACKEND=worker-ws|local
# knob: SPEEDTEST_BRIDGE_HTTP_CHUNK / UL_CHUNK / WS_CHUNK / WS_PACE_MS /
#       TLS_MUX / TLS_UPSTREAM / TLS_SNIFF_MS / IDLE_MS / MAX_CONN_PER_IP /
#       CONN_RATE_PER_MIN / MAX_DL_BYTES / MAX_UL_BYTES / VERSION_STRING
```

JSONL (`--log`): `meta`, `conn_open`, `cmd`, `dl_done` (per lane, ms),
`ul_start`/`ul_done` (receipts), `worker_chunk_dl`, `worker_retry`,
`worker_err`, `conn_close` (bytesDown/bytesUp per koneksi),
`conn_rate_rejected`, `tls_proxy_open/close/err`, `udp_count`/`udp_recv`,
`heartbeat`, `summary`. Konter agregat: `bytesFromWorkerDl`,
`bytesToWorkerUl`, `workerReceipts`, `tlsProxied`.

## Test

```bash
bash hybrid/speedtest-bridge/test/run-tests.sh   # (3 backend + mux + rate-limit + concurrency)
```

Baterai: mock worker lokal (HTTP + WS NetGauge semantik-worker) × klien
sintetis peniru pola CLI (binary-hello fallback → HI/GETIP/PING/CAP →
DOWNLOAD/UPLOAD → UDP LOSS), mux TLS (routing + split-ClientHello),
rate-limit per-IP, plus smoke konkurensi 8 sesi.

## Batasan (jujur)

- **Relay VPS**: byte edge tetap transit link VPS — throughput satu sesi
  tidak bisa melebihi kapasitas VPS; klaim "dilayani VPS + Worker" = asal
  byte di edge, bukan tambahan kapasitas.
- **Deviasi terdokumentasi**: HTTP polos (non-TLS) ke :8080 jatuh ke front
  NetGauge (ERROR/3-strikes) — gateway produksi TLS-only; permukaan
  HTTP/TLS penuh tetap di daemon :5060 (paritas penuh), dan TLS-wrapped
  NetGauge hanya di daemon.
- worker-ws: tanpa chunking/pacing → kill `exceededResources` (sudah
  diatasi chunk default 1 MiB).
- Atribusi: `/__meta` worker per-isolate (bukan agregat) — gunakan
  GraphQL `workersInvocationsAdaptive` + receipt JSONL untuk bukti
  (metode: `docs/OFFICIAL_CLI_TESTING_GUIDE.md` §5).
