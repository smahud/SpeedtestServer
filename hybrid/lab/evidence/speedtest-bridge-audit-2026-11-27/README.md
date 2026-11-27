# Evidence: speedtest-bridge audit & kampanye CLI resmi — 27 Nov 2026 (sesi audit dalam)

> Dibuat oleh agent audit 27 Nov 2026 (13:50–14:20Z). Basis: `master@702b8c9`
> di VPS (= HEAD remote), produksi bridge `worker-http`, VERSION 1.6.0.
> Dokumen induk: `docs/AUDIT_2026-11-27.md`. Metode uji:
> `docs/OFFICIAL_CLI_TESTING_GUIDE.md` §2 (mockhosts namespace, discovery asli,
> non-publishing).

## Yang diuji

CLI resmi Ookla **1.2.0.84** (sha256 `31f1124c…`, tarball repo, tanpa modifikasi),
dari sandbox eksternal (egress Alibaba, RTT ke VPS ±63–66 ms, buffer TCP sandbox
max 931 KiB), menargetkan **server ter-publish** dengan IP di-mock ke VPS
(`66281` = speedtest.tuxsnet.id; 1 run `74964` = speedtest.somedigit.net),
delta `results.speedtest.net → 127.0.0.1` (non-publishing).

## Matriks run (semua EXIT=0, `persisted=false`)

| Run | Backend bridge | Sysctl VPS | DL Mbps | UL Mbps | packetLoss |
|---|---|---|---:|---:|---:|
| c1-wh-1 | worker-http | default | 444,4 | 139,5 | 0 |
| c1-wh-2 | worker-http | default | 431,9 | 133,8 | 3,02 |
| c2-ww-1 | worker-ws | default | 440,0 | 158,6 | 0,35 |
| c2-ww-2 | worker-ws | default | 447,8 | 115,6 | 0,78 |
| c3-lo-1 | local (kontrol) | default | 459,0 | 143,9 | 0 |
| c4-wh-74964 | worker-http (server lain) | default | 398,0 | 150,8 | 1,50 |
| c5-tuned-wh-1 | worker-http | tuned 16 MiB | 405,1 | 134,4 | 33,08* |
| c6-tuned-lo-1 | local (kontrol) | tuned 16 MiB | **472,8** | 156,0 | 0 |
| c7-tuned-wh-2 | worker-http | tuned 16 MiB | 430,9 | 130,9 | 3,24 |

\* anomali V-1 (loss UDP diukur saat drain retry lane worker setelah run
beruntun — lihat AUDIT F-09). Byte client: DL 398–639 MB/run, UL 139–246 MB/run.

## Atribusi 3 sisi (ringkas)

| Sisi | Bukti | Hasil |
|---|---|---|
| Client | `runs/*.cli.json` | 9/9 exit 0, `persisted=false`, server.ip=45.126.249.250 |
| VPS (bridge) | `attribution/bridge-sessions.json` (summary per instance + heartbeat) | lane worker-http/ws: `bytesFromWorkerDl` ≈ `bytesDownCli` (≈100% origin edge); lane local: `bytesFromWorkerDl=0` + delta eth0 tx ≈ DL client |
| Worker (CF) | `attribution/cf-graphql-window.json`, `cf-graphql-tuned.json` | req/menit cocok dengan window run (194, 119, 129+22, 18, 215, 200, 222); **0 request pada menit kontrol lokal**; 0 error seluruh window |

Pengukuran kapasitas link VPS: `capacity/vps-link-measurements.txt`
(ingress ≈ 872 Mbps; egress ≈ 429–473 Mbps).

## Interpretasi

Semua lane (worker-http, worker-ws, local) menghasilkan throughput per-sesi
yang setara (±8%) dan tidak ada yang melebihi egress VPS — konsisten dengan
label jujur **relay**: payload ber-origin edge, tetapi setiap byte transit link
VPS, sehingga kapasitas per sesi tetap dibatasi link VPS. Bukti ini
mereproduksi dan memperkuat temuan kampanye 26–27 Nov
(`speedtest-bridge-portauthority-2026-11-27/`, `cli-bridge-2026-11-27/`).

## Isi direktori

```
runs/        9 run: cli.json + cli.stderr + windows.json (t_start/t_end/exit)
attribution/ bridge-sessions.json (meta+summary+last-hb), CF GraphQL 3 window,
             eth0-snapshots.txt (pre/post tiap run), worker-invocations.json (riwayat 3 hari)
vps/         net-state, fw-services, repo-config, health-pool, worker-check
             (kondisi live VPS saat audit; secret di-mask)
cf/          dns-records, workers-list, origin-rule (front gw.lumajangnetworks.my.id)
capacity/    pengukuran ingress/egress link VPS + metode
```

## Reproduksi

1. Kesehatan stack (guide §7): `systemctl is-active speedtest-bridge`, mint
   token via `https://<vps>:8080/api/sessions`, `GET /__down?bytes=32000000`
   ke worker (harus `200 32000000`).
2. Per guide §2: siapkan `mockhosts` (10 host server ter-publish → IP VPS,
   `results.speedtest.net → 127.0.0.1`), lalu
   `unshare --user --map-root-user --mount bash -c '…'` per run, jeda ≥30 s.
3. Ganti backend via env + restart (guide §4); kembalikan `worker-http`
   setelah selesai.
4. Atribusi: summary instance dari `/var/lib/speedtest-bridge/speedtest-bridge.jsonl`
   + CF GraphQL `workersInvocationsAdaptive` per menit window.
