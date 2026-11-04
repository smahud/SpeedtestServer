# TIMELINE — f5-n22-r2 (generator: gen-timeline.mjs)

Policy: `firstN:A:22` | UDP→B | diverter :9090 | A=127.0.0.1:18080 (official) | B=127.0.0.1:8080 (SpeedtestServer TS)

- **Config fetch**: 2026-11-04 20:58:14.074 UTC — GET /api/cli/config?deviceId=REDACTED&hid=REDACTED&sid=R… via lab proxy (MITM lab-CA) → served live-curl, 2953 B, semua servers[] → localhost:9090
- **Non-publishing**: results.speedtest.net:443 DITOLAK proxy (403) → CLI `persisted:false`
- **Hasil CLI**: exit=0 type=result | latency 0.109 ms | DL 10.24 GB | UL 7.16 GB | packetLoss 9.090909090909092 | result.id=bd9f8e4d-a1fe-4b11-9075-8e8525df638f
- **UUID sesi**: bd9f8e4d-a1fe-4b11-9075-8e8525df638f (diumumkan winner-probe & dipakai semua koneksi pasca-seleksi)

## Koneksi TCP (34)

| # | mulai (UTC) | dur (ms) | sumber CLI | gateway | backend aktual | handshake | UUID sesi | fase | basis fase | c→b (B) | b→c (B) | penutupan | evidence |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 2026-11-04 20:58:14.364 UTC | 3 | ::1:40690 | localhost:9090 | A (127.0.0.1:18080) | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 1 |
| 2 | 2026-11-04 20:58:14.368 UTC | 4 | ::1:40698 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | selection-probe (inferred) | byte-signature: small, short-lived | 174 | 243 | client-close (conn_close) | diverter.jsonl conn 2 |
| 3 | 2026-11-04 20:58:14.372 UTC | 0 | ::1:40712 | localhost:9090 | A (127.0.0.1:18080) | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 3 |
| 4 | 2026-11-04 20:58:14.373 UTC | 3 | ::1:40724 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | selection-probe (inferred) | byte-signature: small, short-lived | 214 | 244 | client-close (conn_close) | diverter.jsonl conn 4 |
| 5 | 2026-11-04 20:58:14.375 UTC | 2 | undefined:undefined | localhost:9090 | — | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 5 |
| 6 | 2026-11-04 20:58:14.375 UTC | 3 | ::1:40740 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | selection-probe (inferred) | byte-signature: small, short-lived | 182 | 245 | client-close (conn_close) | diverter.jsonl conn 6 |
| 7 | 2026-11-04 20:58:14.377 UTC | 1 | ::1:40750 | localhost:9090 | A (127.0.0.1:18080) | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 7 |
| 8 | 2026-11-04 20:58:14.379 UTC | 1 | ::1:40758 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | selection-probe (inferred) | byte-signature: small, short-lived | 194 | 245 | client-close (conn_close) | diverter.jsonl conn 8 |
| 9 | 2026-11-04 20:58:14.382 UTC | 0 | ::1:40764 | localhost:9090 | A (127.0.0.1:18080) | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 9 |
| 10 | 2026-11-04 20:58:14.383 UTC | 1 | ::1:40766 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | selection-probe (inferred) | byte-signature: small, short-lived | 191 | 246 | client-close (conn_close) | diverter.jsonl conn 10 |
| 11 | 2026-11-04 20:58:14.386 UTC | 0 | ::1:40768 | localhost:9090 | A (127.0.0.1:18080) | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 11 |
| 12 | 2026-11-04 20:58:14.387 UTC | 1 | ::1:40774 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | selection-probe (inferred) | byte-signature: small, short-lived | 194 | 242 | client-close (conn_close) | diverter.jsonl conn 12 |
| 13 | 2026-11-04 20:58:14.390 UTC | 1 | ::1:40780 | localhost:9090 | A (127.0.0.1:18080) | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 13 |
| 14 | 2026-11-04 20:58:14.391 UTC | 1 | ::1:40794 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | selection-probe (inferred) | byte-signature: small, short-lived | 193 | 244 | client-close (conn_close) | diverter.jsonl conn 14 |
| 15 | 2026-11-04 20:58:14.395 UTC | 1 | ::1:40804 | localhost:9090 | A (127.0.0.1:18080) | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 15 |
| 16 | 2026-11-04 20:58:14.395 UTC | 2 | ::1:40816 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | selection-probe (inferred) | byte-signature: small, short-lived | 223 | 242 | client-close (conn_close) | diverter.jsonl conn 16 |
| 17 | 2026-11-04 20:58:14.399 UTC | 0 | ::1:40824 | localhost:9090 | A (127.0.0.1:18080) | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 17 |
| 18 | 2026-11-04 20:58:14.400 UTC | 2 | ::1:40832 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | selection-probe (inferred) | byte-signature: small, short-lived | 206 | 242 | client-close (conn_close) | diverter.jsonl conn 18 |
| 19 | 2026-11-04 20:58:14.403 UTC | 1 | ::1:40848 | localhost:9090 | A (127.0.0.1:18080) | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 19 |
| 20 | 2026-11-04 20:58:14.404 UTC | 1 | ::1:40856 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | selection-probe (inferred) | byte-signature: small, short-lived | 208 | 241 | client-close (conn_close) | diverter.jsonl conn 20 |
| 21 | 2026-11-04 20:58:14.410 UTC | 1 | undefined:undefined | localhost:9090 | — | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 21 |
| 22 | 2026-11-04 20:58:14.410 UTC | 2 | ::1:40868 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | selection-probe (inferred) | byte-signature: small, short-lived | 324 | 326 | client-close (conn_close) | diverter.jsonl conn 22 |
| 23 | 2026-11-04 20:58:14.412 UTC | 18050 | ::1:40878 | localhost:9090 | B (127.0.0.1:8080) | plaintext-HI | BD9F8E4D-A1FE-4B11-9075-8E8525DF638F | packet-loss-accounting | observed command | 152 | 297 | client-close (conn_close) | diverter.jsonl conn 23 |
| 24 | 2026-11-04 20:58:14.412 UTC | 12433 | ::1:40890 | localhost:9090 | B (127.0.0.1:8080) | encrypted-binary-hello → plaintext fallback | BD9F8E4D-A1FE-4B11-9075-8E8525DF638F | ping-monitor | observed command | 3094 | 3603 | client-close (conn_close) | diverter.jsonl conn 24 |
| 25 | 2026-11-04 20:58:14.412 UTC | 9448 | ::1:40900 | localhost:9090 | B (127.0.0.1:8080) | encrypted-binary-hello → plaintext fallback | BD9F8E4D-A1FE-4B11-9075-8E8525DF638F | download-worker | observed command | 2111 | 3521140608 | client-close (conn_close) | diverter.jsonl conn 25 |
| 26 | 2026-11-04 20:58:14.412 UTC | 9447 | ::1:40904 | localhost:9090 | B (127.0.0.1:8080) | encrypted-binary-hello → plaintext fallback | BD9F8E4D-A1FE-4B11-9075-8E8525DF638F | download-worker | observed command | 1194 | 1881802802 | client-close (conn_close) | diverter.jsonl conn 26 |
| 27 | 2026-11-04 20:58:14.412 UTC | 9447 | ::1:40918 | localhost:9090 | B (127.0.0.1:8080) | encrypted-binary-hello → plaintext fallback | BD9F8E4D-A1FE-4B11-9075-8E8525DF638F | download-worker | observed command | 1218 | 1932301856 | client-close (conn_close) | diverter.jsonl conn 27 |
| 28 | 2026-11-04 20:58:14.416 UTC | 9427 | ::1:40928 | localhost:9090 | B (127.0.0.1:8080) | encrypted-binary-hello → plaintext fallback | BD9F8E4D-A1FE-4B11-9075-8E8525DF638F | download-worker | observed command | 1777 | 2928103315 | client-close (conn_close) | diverter.jsonl conn 28 |
| 29 | 2026-11-04 20:58:23.857 UTC | 8586 | ::1:51332 | localhost:9090 | B (127.0.0.1:8080) | plaintext-HI | BD9F8E4D-A1FE-4B11-9075-8E8525DF638F | ping-monitor | observed command | 2760 | 3274 | client-close (conn_close) | diverter.jsonl conn 29 |
| 30 | 2026-11-04 20:58:23.859 UTC | 8550 | ::1:51336 | localhost:9090 | B (127.0.0.1:8080) | plaintext-HI | BD9F8E4D-A1FE-4B11-9075-8E8525DF638F | upload-control | observed command | 77 | 93 | client-close (conn_close) | diverter.jsonl conn 30 |
| 31 | 2026-11-04 20:58:23.861 UTC | 8594 | ::1:51352 | localhost:9090 | B (127.0.0.1:8080) | plaintext-HI | BD9F8E4D-A1FE-4B11-9075-8E8525DF638F | upload-worker | observed HI <UUID> + byte-signature GB-scale cli→backend (perintah UPLOAD menyatu dgn payload acak dlm satu chunk non-printable) | 1760000040 | 1474 | client-close (conn_close) | diverter.jsonl conn 31 |
| 32 | 2026-11-04 20:58:23.861 UTC | 8603 | ::1:51354 | localhost:9090 | B (127.0.0.1:8080) | plaintext-HI | BD9F8E4D-A1FE-4B11-9075-8E8525DF638F | upload-worker | observed HI <UUID> + byte-signature GB-scale cli→backend (perintah UPLOAD menyatu dgn payload acak dlm satu chunk non-printable) | 1799847927 | 1500 | client-close (conn_close) | diverter.jsonl conn 32 |
| 33 | 2026-11-04 20:58:23.861 UTC | 8588 | ::1:51356 | localhost:9090 | B (127.0.0.1:8080) | plaintext-HI | BD9F8E4D-A1FE-4B11-9075-8E8525DF638F | upload-worker | observed HI <UUID> + byte-signature GB-scale cli→backend (perintah UPLOAD menyatu dgn payload acak dlm satu chunk non-printable) | 1696000040 | 1422 | client-close (conn_close) | diverter.jsonl conn 33 |
| 34 | 2026-11-04 20:58:23.862 UTC | 8602 | ::1:51358 | localhost:9090 | B (127.0.0.1:8080) | plaintext-HI | BD9F8E4D-A1FE-4B11-9075-8E8525DF638F | upload-worker | observed HI <UUID> + byte-signature GB-scale cli→backend (perintah UPLOAD menyatu dgn payload acak dlm satu chunk non-printable) | 1984000040 | 1656 | client-close (conn_close) | diverter.jsonl conn 34 |

## Endpoint UDP (3)

| klien | backend | datagram cli→be | balasan be→cli |
|---|---|---|---|
| ::1:34230 | B (127.0.0.1:8080) | 187 | 187 |
| ::1:34534 | B (127.0.0.1:8080) | 187 | 0 |
| ::1:54311 | B (127.0.0.1:8080) | 171 | 171 |

> Fase koneksi terenkripsi dilabel **(inferred)** dan basisnya byte-signature — perintah TIDAK diinfer dari payload terenkripsi (master prompt §11). Fase koneksi plaintext berbasis perintah teramati langsung.

(CSV mesin-terbaca: ../evidence/f5-n22-r2/timeline.csv)
