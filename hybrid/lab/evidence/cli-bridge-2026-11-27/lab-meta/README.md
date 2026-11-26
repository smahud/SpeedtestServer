# Evidence — cli-bridge-2026-11-27

Eksperimen: **cli-bridge** — CLI resmi Ookla (tidak dimodifikasi, hosts-mock server
ter-publish → VPS 45.126.249.250) dilayani oleh **VPS + Cloudflare Worker**
melalui bridge lane native NetGauge di VPS :8080.

**Pertanyaan operator:** dapatkah CLI resmi, saat melakukan speedtest ke server
yang sudah ter-publish (IP di-mock ke VPS yang sudah link ke Worker CF),
dilayani secara otomatis oleh VPS + Worker? — **YA, dengan relay VPS**
(edge-origin, VPS-relay). Angka lengkap: `lab-meta/run-matrix.{json,md}`;
laporan: `docs/CLI_BRIDGE_REPORT_2026-11-27.md`; metode uji CLI resmi:
`docs/OFFICIAL_CLI_TESTING_GUIDE.md`.

## Struktur

| Direktori/file | Isi |
|---|---|
| `runs/` | Per-run: `<label>.cli.json` (output CLI resmi 1.2.0.84 + baris EXIT), `.window` (UTC mulai/selesai), `.dns-proof`, `.cli.stderr` (hanya run gagal), `graphql-window-experiment.json` (CF GraphQL 20:00–20:40Z: 885 invocations, semua success, 0 error) |
| `bridge-logs/` | JSONL asli bridge per backend (`cli-bridge-worker-http*.jsonl`, `-worker-ws*.jsonl`, `-local1.jsonl`) — per-lane byte counters, receipts, retry, conn stats |
| `lab-meta/` | `metadata.json`, `run-matrix.{json,md}`, `build-matrix.py`, `checksums.txt`, README ini |

## Ringkasan matriks (angka kunci)

| Run | Backend | Exit | DL Mbps | DL dari Worker | UL Mbps | UL ke Worker | Receipts |
|---|---|---:|---:|---|---:|---|---:|
| b0 | daemon produksi | 0 | 451,7 | 0% (kontrol) | 164,8 | 0% | n/a |
| b1-local | bridge `local` | 0 | 454,5 | 0% (kontrol front) | 158,8 | 0% | 0 |
| b2-wh-3 | bridge worker-http | 0 | 416,3 | **656,7 MB (≈100% origin edge)** | 133,2 | **218,7 MB (97,8%)** | 54 |
| b2-wh-4 | bridge worker-http | 0 | 431,3 | **476,8 MB (≈100%)** | 118,4 | **195,1 MB (96,8%)** | 48 |
| b3-ww-2 | bridge worker-ws | 0 | 436,6 | **748,4 MB (≈100%)** | 177,3 | **158,4 MB (≈100%)** | 2 OK-ack |
| b4 | daemon dipulihkan | 0 | 462,1 | 0% (kontrol restore) | 160,3 | 0% | n/a |

Run yang gagal + akar masalah (semua sudah diperbaiki di master, lihat
metadata `notes`): `b2-wh-2` exit 2 (bug cache mint token → gateway 429),
`b2-wh-1` (bug akumulasi UL + tanpa retry reset), `b3-ww-1` (perintah UPLOAD
mentah tidak diteruskan ke WSS → tanpa receipt).

## Atribusi 3 sisi (run definitif b2-wh-3, worker-http)

- **Client**: exit 0; DL 630.057.324 B @ 416,3 Mbps; UL 223.587.202 B @
  133,2 Mbps; ping 60,0 ms; `persisted=false` (`result.url=null`) — non-publishing.
- **VPS (bridge JSONL)**: 44 conn; bytesDownCli 656.605.560 B ≈
  bytesFromWorkerDl 656.706.995 B (100% + overhead refetch); bytesUpCli
  225.891.809 B → bytesToWorkerUl 218.720.131 B (96,8%); 54 receipt
  `{"bytes":N}`; 21 worker_retry (pemulihan reset tengah-stream).
- **Worker (edge)**: CF GraphQL window = 885 invocations `success`, 0 error.

## Reproduksi

Lihat `docs/OFFICIAL_CLI_TESTING_GUIDE.md` (metode lengkap: lab unshare,
mockhosts, window eksperimen di VPS, restore, atribusi). Ringkas:

```bash
# sandbox: lab CLI resmi
tar xzf speedtest-cli_official/ookla-speedtest-1.2.0-linux-x86_64.tgz -C lab
unshare --user --map-root-user --mount bash -c '
  mount --bind mockhosts /etc/hosts
  ./speedtest --server-id=66281 --accept-license --accept-gdpr -f json'

# VPS (window eksperimen): daemon turun dari 8080, bridge naik
sed -i "s/tcpPorts = .*/tcpPorts = 5060/; s/udpPorts = .*/udpPorts = 5060/" \
  /etc/speedtestserver/OoklaServer.properties && systemctl restart speedtestserver
BRIDGE_BACKEND=worker-http node hybrid/lab/cli-bridge/cli-bridge.mjs \
  --port 8080 --log /var/lib/cli-bridge/….jsonl
# restore: kembalikan properties (backup) + restart + verifikasi 1 run
```
