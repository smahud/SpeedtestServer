# cli-bridge — the official-CLI native lane bridge (VPS front + Worker payload)

> Eksperimen lanjutan tervalidasi-label dari audit 26–27 Nov 2026
> (`audit/historical-native-worker-2026-11-27`): CLI resmi Ookla TIDAK
> DIMODIFIKASI, protokol native NetGauge TCP+UDP — bisa atau tidak payload
> pengukurannya dilayani **VPS + Cloudflare Worker** sekaligus?

## Jawaban singkat (per eksperimen 27 Nov 2026 — REALIZED_WITH_RELAY)

**Ya — CLI resmi 1.2.0.84 (tidak dimodifikasi, hosts-mock server ter-publish
→ VPS :8080) menyelesaikan pengukuran penuh (exit 0, `persisted=false`) dengan
payload pengukuran ber-origin di Worker edge, pada kedua lane: worker-http
(DL ≈100% edge 656,7 MB; UL 97,8% 218,7 MB; 54 receipt) dan worker-ws
(DL ≈100% edge 748,4 MB; UL ≈100% 158,4 MB; ack OK per UPLOAD).** CF GraphQL
window: 885 invocation semuanya `success`, 0 error. **Label jujur:** ini
edge-origin dengan **relay VPS** — semua byte tetap transit link VPS (tidak
ada tambahan kapasitas per sesi; DL bridge 416–449 Mbps vs daemon 451–462
Mbps); jalur edge langsung (non-relay) untuk CLI resmi tetap BLOCKED per
audit. Angka lengkap + kronologi: `docs/CLI_BRIDGE_REPORT_2026-11-27.md` +
`hybrid/lab/evidence/cli-bridge-2026-11-27/`.

## Arsitektur

```
official CLI (unmodified) --NetGauge TCP/UDP--> cli-bridge :8080 (VPS)
  control:  HI/HELLO · GETIP · PING · CAPABILITIES · INITPLOSS/PLOSS · UDP LOSS
            → LOKAL di VPS (paritas semantik daemon, PROTOCOL_CONTRACT.md §2–3)
  download: byte pool ← Worker /__down (chunk 4 MiB, streaming + backpressure NYATA)
            atau ← Worker /ws NetGauge (per-chunk command, framing di-strip)
  upload:   payload → Worker /__up (POST per-chunk, receipt {bytes:N})
            atau → Worker /ws (frame; ack "OK n <ts>" = receipt)
```

- Front bridge men-TERMINASI protokol native persis seperti daemon (port
  `NetGaugeEngine.ts` yang sudah diverifikasi): binary-hello→ERROR (memicu
  fallback plaintext CLI), strict GETIP + pre-session gate (mute), three
  strikes (F-24), UPLOAD inclusive counting + `OK n <epoch>` (F-9/F-13),
  byte-exact `DOWNLOAD n` (`"DOWNLOAD "` prefix + pool + `\n`, semua
  dihitung dalam n), UDP LOSS init/loaded + `RECV` reply, bounded loss
  registry (F-33).
- **worker-http** (default, direkomendasikan): `/__down` ber-backpressure
  nyata (`writer.ready` di worker — worker hanya men-generate yang
  di-drain bridge) + `/__up` per-chunk dengan receipt. Tervalidasi di
  worker live dengan pola koneksi CLI sendiri (32×32 MiB: 32/32 DL +
  32/32 UL, 0 error).
- **worker-ws**: satu sesi WSS NetGauge per koneksi CLI; `DOWNLOAD`
  di-relay sebagai per-chunk command (default 1 MiB) dengan framing
  per-command (`"DOWNLOAD "` prefix + `\n`) di-strip → stream tetap
  byte-exact; per-command in-flight ter-bounded. Single-command 32 MiB
  tanpa pacing ter-bunuh `exceededResources` di bawah pola 32 koneksi CLI
  (reproduksi 27 Nov: 10/32 mati) — itulah sebabnya chunking + patch
  `?pace=` (commit master 27 Nov) ada.
- **local**: pool paritas daemon di-serve VPS (jalur kontrol A/B).

## Menjalankan (VPS, window eksperimen — daemon tidak boleh memegang :8080)

```bash
# daemon dilepas dari 8080 selama window (lihat TESTING_GUIDE):
#   /etc/speedtestserver/OoklaServer.properties -> tcpPorts = 5060, udpPorts = 5060
#   systemctl restart speedtestserver
BRIDGE_BACKEND=worker-http \
BRIDGE_GATEWAY_BASE=https://127.0.0.1:8790 \
node hybrid/lab/cli-bridge/cli-bridge.mjs \
  --port 8080 --log /var/lib/cli-bridge/cli-bridge.jsonl

# token tetap (tanpa gateway): BRIDGE_TOKEN=… BRIDGE_WORKER_BASE=https://…
# backend lain: BRIDGE_BACKEND=worker-ws|local
# knob: BRIDGE_HTTP_CHUNK, BRIDGE_UL_CHUNK, BRIDGE_WS_CHUNK, BRIDGE_WS_PACE_MS
```

JSONL (`--log`): `meta`, `conn_open`, `cmd`, `dl_done` (per lane, ms),
`ul_start`/`ul_done` (receipts), `worker_chunk_dl`, `worker_err`,
`conn_close` (bytesDown/bytesUp per koneksi), `udp_count`/`udp_recv`,
`heartbeat`, `summary`. Konter agregat: `bytesFromWorkerDl`,
`bytesToWorkerUl`, `receipts`, `workerRequests`.

## Test

```bash
bash hybrid/lab/cli-bridge/test/run-tests.sh   # 158/158 (3 backend + concurrency)
```

Baterai: mock worker lokal (HTTP + hand-rolled WS NetGauge dengan semantik
terverifikasi worker) × klien sintetis peniru pola CLI (binary-hello
fallback → HI/GETIP/PING/CAP → DOWNLOAD/UPLOAD → UDP LOSS), plus smoke
konkurensi 8 sesi.

## Batasan (jujur)

- Relay VPS: byte edge tetap transit link VPS — throughput satu sesi tidak
  bisa melebihi kapasitas VPS; klaim “dilayani VPS + Worker” = asal byte di
  edge, bukan tambahan kapasitas.
- worker-ws: tanpa chunking/pacing → `exceededResources` kill di bawah
  beban konkuren (diatasi chunk 1 MiB + `?pace=`).
- Bridge TIDAK meng-serve permukaan HTTP/TLS daemon (:8080 dipakai CLI
  plaintext fallback + UDP); server produksi daemon tetap pemilik
  multiplex penuh.
- Atribusi: `/__meta` worker per-isolate (bukan agregat) — gunakan
  GraphQL `workersInvocationsAdaptive` + receipt JSONL untuk bukti.
