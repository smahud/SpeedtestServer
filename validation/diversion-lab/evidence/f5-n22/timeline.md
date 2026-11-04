# TIMELINE — f5-n22 (generator: gen-timeline.mjs)

Policy: `firstN:A:22` | UDP→B | diverter :9090 | A=127.0.0.1:18080 (official) | B=127.0.0.1:8080 (SpeedtestServer TS)

- **Config fetch**: 2026-11-04 20:56:47.087 UTC — GET /api/cli/config?deviceId=REDACTED&hid=REDACTED&sid=R… via lab proxy (MITM lab-CA) → served live-curl, 2953 B, semua servers[] → localhost:9090
- **Non-publishing**: results.speedtest.net:443 DITOLAK proxy (403) → CLI `persisted:false`
- **Hasil CLI**: exit=0 type=result | latency 0.095 ms | DL 14.12 GB | UL 9.38 GB | packetLoss 0 | result.id=67b33c0b-492c-42e9-a727-501158cd7f1c
- **UUID sesi**: 67b33c0b-492c-42e9-a727-501158cd7f1c (diumumkan winner-probe & dipakai semua koneksi pasca-seleksi)

## Koneksi TCP (34)

| # | mulai (UTC) | dur (ms) | sumber CLI | gateway | backend aktual | handshake | UUID sesi | fase | basis fase | c→b (B) | b→c (B) | penutupan | evidence |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 2026-11-04 20:56:47.543 UTC | 3 | undefined:undefined | localhost:9090 | — | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 1 |
| 2 | 2026-11-04 20:56:47.544 UTC | 6 | ::1:48606 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | selection-probe (inferred) | byte-signature: small, short-lived | 222 | 262 | client-close (conn_close) | diverter.jsonl conn 2 |
| 3 | 2026-11-04 20:56:47.551 UTC | 0 | ::1:48616 | localhost:9090 | A (127.0.0.1:18080) | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 3 |
| 4 | 2026-11-04 20:56:47.552 UTC | 2 | ::1:48624 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | selection-probe (inferred) | byte-signature: small, short-lived | 220 | 264 | client-close (conn_close) | diverter.jsonl conn 4 |
| 5 | 2026-11-04 20:56:47.555 UTC | 1 | ::1:48634 | localhost:9090 | A (127.0.0.1:18080) | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 5 |
| 6 | 2026-11-04 20:56:47.556 UTC | 2 | ::1:48650 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | selection-probe (inferred) | byte-signature: small, short-lived | 170 | 262 | client-close (conn_close) | diverter.jsonl conn 6 |
| 7 | 2026-11-04 20:56:47.559 UTC | 1 | ::1:48664 | localhost:9090 | A (127.0.0.1:18080) | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 7 |
| 8 | 2026-11-04 20:56:47.559 UTC | 2 | ::1:48678 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | selection-probe (inferred) | byte-signature: small, short-lived | 190 | 261 | client-close (conn_close) | diverter.jsonl conn 8 |
| 9 | 2026-11-04 20:56:47.562 UTC | 1 | ::1:48684 | localhost:9090 | A (127.0.0.1:18080) | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 9 |
| 10 | 2026-11-04 20:56:47.563 UTC | 1 | ::1:48700 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | selection-probe (inferred) | byte-signature: small, short-lived | 171 | 260 | client-close (conn_close) | diverter.jsonl conn 10 |
| 11 | 2026-11-04 20:56:47.565 UTC | 0 | ::1:48710 | localhost:9090 | A (127.0.0.1:18080) | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 11 |
| 12 | 2026-11-04 20:56:47.566 UTC | 2 | ::1:48726 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | selection-probe (inferred) | byte-signature: small, short-lived | 187 | 262 | client-close (conn_close) | diverter.jsonl conn 12 |
| 13 | 2026-11-04 20:56:47.568 UTC | 1 | ::1:48742 | localhost:9090 | A (127.0.0.1:18080) | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 13 |
| 14 | 2026-11-04 20:56:47.569 UTC | 2 | ::1:48758 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | selection-probe (inferred) | byte-signature: small, short-lived | 180 | 264 | client-close (conn_close) | diverter.jsonl conn 14 |
| 15 | 2026-11-04 20:56:47.571 UTC | 0 | ::1:48760 | localhost:9090 | A (127.0.0.1:18080) | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 15 |
| 16 | 2026-11-04 20:56:47.572 UTC | 2 | ::1:48766 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | selection-probe (inferred) | byte-signature: small, short-lived | 192 | 261 | client-close (conn_close) | diverter.jsonl conn 16 |
| 17 | 2026-11-04 20:56:47.575 UTC | 1 | ::1:48770 | localhost:9090 | A (127.0.0.1:18080) | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 17 |
| 18 | 2026-11-04 20:56:47.576 UTC | 2 | ::1:48782 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | selection-probe (inferred) | byte-signature: small, short-lived | 204 | 264 | client-close (conn_close) | diverter.jsonl conn 18 |
| 19 | 2026-11-04 20:56:47.579 UTC | 0 | ::1:48792 | localhost:9090 | A (127.0.0.1:18080) | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 19 |
| 20 | 2026-11-04 20:56:47.579 UTC | 1 | ::1:48802 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | selection-probe (inferred) | byte-signature: small, short-lived | 169 | 259 | client-close (conn_close) | diverter.jsonl conn 20 |
| 21 | 2026-11-04 20:56:47.585 UTC | 1 | undefined:undefined | localhost:9090 | — | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 21 |
| 22 | 2026-11-04 20:56:47.585 UTC | 3 | ::1:48828 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | selection-probe (inferred) | byte-signature: small, short-lived | 348 | 350 | client-close (conn_close) | diverter.jsonl conn 22 |
| 23 | 2026-11-04 20:56:47.587 UTC | 11973 | ::1:48844 | localhost:9090 | B (127.0.0.1:8080) | plaintext-HI | 67B33C0B-492C-42E9-A727-501158CD7F1C | packet-loss-accounting | observed command | 56 | 63 | client-close (conn_close) | diverter.jsonl conn 23 |
| 24 | 2026-11-04 20:56:47.588 UTC | 11457 | ::1:48860 | localhost:9090 | B (127.0.0.1:8080) | encrypted-binary-hello → plaintext fallback | 67B33C0B-492C-42E9-A727-501158CD7F1C | download-worker | observed command | 2067 | 3454717419 | client-close (conn_close) | diverter.jsonl conn 24 |
| 25 | 2026-11-04 20:56:47.588 UTC | 11457 | ::1:48868 | localhost:9090 | B (127.0.0.1:8080) | encrypted-binary-hello → plaintext fallback | 67B33C0B-492C-42E9-A727-501158CD7F1C | download-worker | observed command | 2068 | 3456112584 | client-close (conn_close) | diverter.jsonl conn 25 |
| 26 | 2026-11-04 20:56:47.588 UTC | 11457 | ::1:48882 | localhost:9090 | B (127.0.0.1:8080) | encrypted-binary-hello → plaintext fallback | 67B33C0B-492C-42E9-A727-501158CD7F1C | download-worker | observed command | 1959 | 3235979155 | client-close (conn_close) | diverter.jsonl conn 26 |
| 27 | 2026-11-04 20:56:47.588 UTC | 14456 | ::1:48884 | localhost:9090 | B (127.0.0.1:8080) | encrypted-binary-hello → plaintext fallback | 67B33C0B-492C-42E9-A727-501158CD7F1C | ping-monitor | observed command | 3728 | 4363 | client-close (conn_close) | diverter.jsonl conn 27 |
| 28 | 2026-11-04 20:56:47.589 UTC | 11455 | ::1:48888 | localhost:9090 | B (127.0.0.1:8080) | encrypted-binary-hello → plaintext fallback | 67B33C0B-492C-42E9-A727-501158CD7F1C | download-worker | observed command | 2367 | 3996948530 | client-close (conn_close) | diverter.jsonl conn 28 |
| 29 | 2026-11-04 20:56:59.045 UTC | 10609 | ::1:50118 | localhost:9090 | B (127.0.0.1:8080) | plaintext-HI | 67B33C0B-492C-42E9-A727-501158CD7F1C | upload-worker | observed HI <UUID> + byte-signature GB-scale cli→backend (perintah UPLOAD menyatu dgn payload acak dlm satu chunk non-printable) | 2432000040 | 2020 | client-close (conn_close) | diverter.jsonl conn 29 |
| 30 | 2026-11-04 20:56:59.046 UTC | 10617 | ::1:50132 | localhost:9090 | B (127.0.0.1:8080) | plaintext-HI | 67B33C0B-492C-42E9-A727-501158CD7F1C | upload-worker | observed HI <UUID> + byte-signature GB-scale cli→backend (perintah UPLOAD menyatu dgn payload acak dlm satu chunk non-printable) | 2145752575 | 1786 | client-close (conn_close) | diverter.jsonl conn 30 |
| 31 | 2026-11-04 20:56:59.047 UTC | 10571 | ::1:50148 | localhost:9090 | B (127.0.0.1:8080) | plaintext-HI | 67B33C0B-492C-42E9-A727-501158CD7F1C | upload-worker | observed HI <UUID> + byte-signature GB-scale cli→backend (perintah UPLOAD menyatu dgn payload acak dlm satu chunk non-printable) | 2048666275 | 1708 | client-close (conn_close) | diverter.jsonl conn 31 |
| 32 | 2026-11-04 20:56:59.047 UTC | 10564 | ::1:50152 | localhost:9090 | B (127.0.0.1:8080) | plaintext-HI | 67B33C0B-492C-42E9-A727-501158CD7F1C | upload-control | observed command | 77 | 93 | client-close (conn_close) | diverter.jsonl conn 32 |
| 33 | 2026-11-04 20:56:59.049 UTC | 10615 | ::1:50162 | localhost:9090 | B (127.0.0.1:8080) | plaintext-HI | 67B33C0B-492C-42E9-A727-501158CD7F1C | ping-monitor | observed command | 3384 | 4015 | client-close (conn_close) | diverter.jsonl conn 33 |
| 34 | 2026-11-04 20:56:59.055 UTC | 10608 | ::1:50178 | localhost:9090 | B (127.0.0.1:8080) | plaintext-HI | 67B33C0B-492C-42E9-A727-501158CD7F1C | upload-worker | observed HI <UUID> + byte-signature GB-scale cli→backend (perintah UPLOAD menyatu dgn payload acak dlm satu chunk non-printable) | 2880000040 | 2358 | client-close (conn_close) | diverter.jsonl conn 34 |

## Endpoint UDP (3)

| klien | backend | datagram cli→be | balasan be→cli |
|---|---|---|---|
| ::1:43193 | B (127.0.0.1:8080) | 227 | 0 |
| ::1:42377 | B (127.0.0.1:8080) | 227 | 227 |
| ::1:50913 | B (127.0.0.1:8080) | 209 | 209 |

> Fase koneksi terenkripsi dilabel **(inferred)** dan basisnya byte-signature — perintah TIDAK diinfer dari payload terenkripsi (master prompt §11). Fase koneksi plaintext berbasis perintah teramati langsung.

(CSV mesin-terbaca: ../evidence/f5-n22/timeline.csv)
