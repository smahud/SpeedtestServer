# SPEEDTEST-BRIDGE PERMANENT 2026-11-27 — mode produksi permanen + penyatuan port

> Kampanye deploy mode permanen (operator request 27 Nov: "jalankan
> rekomendasi anda agar menjadi service dan auto start saat setelah restart
> atau error terjadi" + rename cli-bridge → speedtest-bridge + map :8790 ke
> port native OoklaServer). Evidence: direktori ini. Laporan eksperimen
> asli: `docs/CLI_BRIDGE_REPORT_2026-11-27.md`. Kontrak: `CONTRACT.md`.

## Hasil akhir (produksi LIVE sejak 27 Nov 2026)

| Aspek | Status |
|---|---|
| `speedtest-bridge.service` | **aktif + enabled** — `Restart=always` (auto-start saat boot + auto-restart saat crash, `RestartSec=3`), hardening + `LoadCredential` (cert wildcard daemon) |
| CLI resmi Ookla 1.2.0.84 (hosts-mock server ter-publish → VPS) | **3/3 run lengkap EXIT=0**, `persisted=false` (b5-wh-1 worker-http · b6-ww-1 worker-ws · b7-wh-2 pasca-restore worker-http) |
| Penyatuan port | **hanya port native OoklaServer terbuka**: `:8080` bridge (TCP+UDP) + `:5060` daemon (TCP+UDP, dikonfigurasi di `OoklaServer.properties` dengan backup); gateway **loopback saja** `127.0.0.1:8790` (TLS) + `127.0.0.1:8791` (plain, upstream pipe HTTP) |
| Mux :8080 (paritas daemon PROTOCOL_CONTRACT §1) | TLS **diterminasi di bridge** → NetGauge native DI DALAM TLS (jalur utama klien resmi) ATAU metode HTTP → pipe gateway; plaintext → front NetGauge |
| Lane web/custom via :8080 | `curl -k https://speedtest.lumajangnetworks.my.id:8080/api/health` → **HTTP 200** (via mux TLS bridge) |
| Instalasi | `.env` (WAJIB di atas, default di bawah) → `sudo ./install.sh --start` — semuanya otomatis (bridge + gateway loopback + daemon :5060 + pool worker + auto-update) |

## Kronologi jujur (dua bug ditemukan oleh run pertama — diperbaiki)

1. **b5-wh-1 (percobaan #1) GAGAL** — exit 2 "Latency test failed:
   Cannot read from socket", dan **bridge CRASH** (unhandled `ECONNRESET`
   pada socket fase sniff) → systemd `Restart=always` memulihkan 3 dtk.
   Dua akar masalah:
   a. **Koneksinya di-RST saat sniff tanpa handler 'error'** → proses mati.
   b. **Klien resmi membuka jalur TLS-wrapped** — mux lama me-proxy TLS mentah
      ke gateway (HTTP di dalam TLS): handshake klien SUKSES (cert gateway
      valid) tapi isi jawaban HTTP → klien tidak fallback → mati.
   Perbaikan `1b2317b`: handler 'error' dipasang di awal koneksi + **TLS
   diterminasi DI BRIDGE** (`TLSSocket` + `pause()` sebelum `unshift()`
   ClientHello — tanpa pause, handshake tidak pernah selesai) + deteksi
   ulang by first-byte DI DALAM TLS (NetGauge → front; HTTP → pipe gateway
   plain loopback baru `HYBRID_GATEWAY_PLAIN_PORT=8791`). Tes 236/236
   (termasuk regresi RST-saat-sniff + NetGauge-dalam-TLS).
2. **b5-wh-1 (percobaan #2) SUKSES** — worker-http: DL 571,1 MB @ 48,0 Mbps,
   UL 266,9 MB @ 23,5 Mbps; bridge: DL origin-edge 594,8 MB, UL
   diteruskan 263,3 MB, 65 receipt, 255 worker request, 0 rate-reject.
3. **b6-ww-1 SUKSES** — worker-ws: DL 616,2 MB @ 53,8 Mbps, UL 213,7 MB @
   17,5 Mbps, `persisted=false`.
4. **b7-wh-2 SUKSES (pasca-restore default produksi)** — worker-http: DL
   516,3 MB @ 50,5 Mbps, UL 171,6 MB @ 19,3 Mbps; bridge (proses akhir):
   DL origin-edge 538,6 MB, UL diteruskan 163,1 MB, 40 receipt.
5. **Perbaikan ketiga `91d2c0a`** (ditemukan saat konvergensi akhir):
   probe installer gateway mencoba bind `:8791` milik gateway live →
   EADDRINUSE → install gagal; probe kini memakai port bebas 18791.

## Catatan throughput (jujur)

Sandbox→VPS saat kampanye ini hanya **±44–54 Mbps** (probe langsung daemon
:5060 = 44,2 Mbps — tanpa bridge), sementara sandbox→Cloudflare edge = 780
Mbps. Run CLI ≈ kapasitas link VPS — sesuai **label jujur relay**: semua
byte bridged transit link VPS; jalur edge LANGSUNG untuk klien resmi tetap
BLOCKED (audit 26–27 Nov). Bukan regresi bridge (eksperimen 27 Nov pagi
mencatat 416–449 Mbps saat link VPS sedang sehat).

## Atribusi 3 sisi (metode: docs/OFFICIAL_CLI_TESTING_GUIDE.md)

- Klien: `runs/b5-wh-1.cli.json` dll. (exit, bandwidth, bytes,
  `persisted=false`, `result.url=null`).
- VPS: `vps/bridge-events-compact.jsonl` (dl_done/ul_done per lane,
  worker_retry 139 / worker_err 103 pada link terkendali — refetch
  remainder bekerja, run tetap selesai), `vps/bridge-summaries.jsonl`
  (konter per proses), `vps/port-layout-final.txt` (listener akhir),
  `vps/crash-excerpt-journal.txt` (jejak crash percobaan #1).
- Worker: pool live diverifikasi via mint token dari gateway
  (`/__down 200 32000000`) + receipt per chunk pada lane worker-http / ack
  OK per UPLOAD pada lane worker-ws (konter `workerReceipts`).

## Layout file evidence

```
runs/   b5-wh-1.* · b6-ww-1.* · b7-wh-2.*   (cli.json / stderr / window / dns-proof)
vps/    bridge-events-compact.jsonl · bridge-summaries.jsonl ·
        port-layout-final.txt · crash-excerpt-journal.txt
```
