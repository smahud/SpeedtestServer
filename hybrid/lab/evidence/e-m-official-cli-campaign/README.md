# E-M — Kampanye CLI resmi Ookla 9 server Surabaya + hybrid transport (Sesi 5)

Uji end-to-end sesi 5 (24 November 2026, 05:30–06:00 UTC): binary CLI resmi Ookla
**1.2.0.84** (`speedtest-cli_official/ookla-speedtest-1.2.0-linux-x86_64.tgz`)
dijalankan terhadap 9 server id Surabaya yang IP publiknya di-mock ke VPS
45.126.249.250 (`/etc/hosts` namespace), ditambah run hybrid transport pada
server id yang sama. Laporan lengkap: `docs/OFFICIAL_CLI_MOCK_CAMPAIGN_2026-11-24.md`.

## Isi direktori

| File | Isi |
|---|---|
| `summary.json` | Ringkasan 9 server × 2 mode (ping/dl/ul/byte VPS/wreq Worker) — sumber tabel laporan |
| `attribution.txt` | Pembukuan byte per run: delta `eth0` VPS, journal daemon (conn_close), permintaan Worker (CF GraphQL) |
| `dns-proof.txt` | Bukti resolusi `getaddrinfo` per hostname di dalam namespace uji (semua → 45.126.249.250; `results.speedtest.net` → 127.0.0.1) |
| `a-<id>.cli.json` | Output JSON CLI resmi per server (mode A "native") — 9 file |
| `b-<id>.cli.json` | Output JSON klien hybrid per server (mode B "offload") — 9 file |
| `journal-map-smoke-74964.txt` | Peta 48 koneksi satu run A di daemon (peran per koneksi, byte per arah) |
| `iso-a-66281.cli.json` / `.meta.json` | Run A terisolasi (celah hening): bukti Worker = 0 permintaan saat CLI resmi berjalan |

## Interpretasi kunci

- **Mode A (CLI resmi, mock DNS → VPS):** seluruh sesi NetGauge mentah TCP
  mendarat di `speedtestserver.service` :8080 — 41–42 koneksi/run, `eth0`
  rx+tx 670–1022 MB/run ≈ byte yang dilaporkan client. **Worker menerima 0
  permintaan** (bukti terisolasi `iso-a-66281.*` + CF GraphQL
  `workersInvocationsAdaptive` tanpa baris pada jendela 05:46–05:49 UTC).
- **Mode B (hybrid transport, server id sama):** `eth0` VPS 0,45–0,49 MB/run
  sementara 387,7 MB download + 151,5 MB upload dilayani Worker
  (wreq 91–364/run) → offload ≈ 1:1200. Receipt guid per run di
  `/var/lib/speedtest-hybrid/results.jsonl` gateway.
- **Kesimpulan protokol:** payload CLI resmi secara fisik transit endpoint
  host:port yang di-resolve-nya (NetGauge TCP mentah, tanpa WebSocket/redirect
  pada binary 1.2.0.84) — tidak ada jalur offload untuk binary resmi; offload
  berlaku untuk klien transport-HTTP (sivel + custom). Rincian: laporan §4.

IP client disamarkan pada semua file. Token/session tidak pernah dicatat.
