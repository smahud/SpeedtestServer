# TIMELINE — f8b (generator: gen-timeline.mjs)

Policy: `all:B` | UDP→A | diverter :9090 | A=127.0.0.1:18080 (official) | B=127.0.0.1:8080 (SpeedtestServer TS)

- **Config fetch**: 2026-11-04 21:31:25.452 UTC — GET /api/cli/config?deviceId=REDACTED&hid=REDACTED&sid=R… via lab proxy (MITM lab-CA) → served live-curl, 2953 B, semua servers[] → localhost:9090
- **Non-publishing**: results.speedtest.net:443 DITOLAK proxy (403) → CLI `persisted:false`
- **Hasil CLI**: exit=0 type=result | latency 0.083 ms | DL 11.00 GB | UL 8.97 GB | packetLoss undefined | result.id=6e53871d-711a-4a91-a47a-fadd5eb3a87b
- **UUID sesi**: 6e53871d-711a-4a91-a47a-fadd5eb3a87b (diumumkan winner-probe & dipakai semua koneksi pasca-seleksi)

## Koneksi TCP (34)

| # | mulai (UTC) | dur (ms) | sumber CLI | gateway | backend aktual | handshake | UUID sesi | fase | basis fase | c→b (B) | b→c (B) | penutupan | evidence |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 2026-11-04 21:31:25.686 UTC | 3 | ::1:39380 | localhost:9090 | B (127.0.0.1:8080) | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 1 |
| 2 | 2026-11-04 21:31:25.689 UTC | 6 | ::1:39382 | localhost:9090 | B (127.0.0.1:8080) | encrypted-binary-hello → plaintext fallback | (not observable — encrypted) | selection-probe | observed command | 90 | 124 | client-close (conn_close) | diverter.jsonl conn 2 |
| 3 | 2026-11-04 21:31:25.697 UTC | 1 | undefined:undefined | localhost:9090 | — | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 3 |
| 4 | 2026-11-04 21:31:25.697 UTC | 4 | ::1:39394 | localhost:9090 | B (127.0.0.1:8080) | encrypted-binary-hello → plaintext fallback | (not observable — encrypted) | selection-probe | observed command | 91 | 124 | client-close (conn_close) | diverter.jsonl conn 4 |
| 5 | 2026-11-04 21:31:25.699 UTC | 1 | undefined:undefined | localhost:9090 | — | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 5 |
| 6 | 2026-11-04 21:31:25.699 UTC | 3 | ::1:39408 | localhost:9090 | B (127.0.0.1:8080) | encrypted-binary-hello → plaintext fallback | (not observable — encrypted) | selection-probe | observed command | 88 | 124 | client-close (conn_close) | diverter.jsonl conn 6 |
| 7 | 2026-11-04 21:31:25.703 UTC | 0 | ::1:39416 | localhost:9090 | B (127.0.0.1:8080) | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 7 |
| 8 | 2026-11-04 21:31:25.704 UTC | 2 | ::1:39422 | localhost:9090 | B (127.0.0.1:8080) | encrypted-binary-hello → plaintext fallback | (not observable — encrypted) | selection-probe | observed command | 84 | 124 | client-close (conn_close) | diverter.jsonl conn 8 |
| 9 | 2026-11-04 21:31:25.707 UTC | 0 | ::1:39430 | localhost:9090 | B (127.0.0.1:8080) | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 9 |
| 10 | 2026-11-04 21:31:25.708 UTC | 2 | ::1:39438 | localhost:9090 | B (127.0.0.1:8080) | encrypted-binary-hello → plaintext fallback | (not observable — encrypted) | selection-probe | observed command | 81 | 124 | client-close (conn_close) | diverter.jsonl conn 10 |
| 11 | 2026-11-04 21:31:25.711 UTC | 0 | ::1:39452 | localhost:9090 | B (127.0.0.1:8080) | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 11 |
| 12 | 2026-11-04 21:31:25.711 UTC | 1 | ::1:39466 | localhost:9090 | B (127.0.0.1:8080) | encrypted-binary-hello → plaintext fallback | (not observable — encrypted) | selection-probe | observed command | 90 | 124 | client-close (conn_close) | diverter.jsonl conn 12 |
| 13 | 2026-11-04 21:31:25.715 UTC | 0 | ::1:39476 | localhost:9090 | B (127.0.0.1:8080) | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 13 |
| 14 | 2026-11-04 21:31:25.716 UTC | 2 | ::1:39490 | localhost:9090 | B (127.0.0.1:8080) | encrypted-binary-hello → plaintext fallback | (not observable — encrypted) | selection-probe | observed command | 90 | 124 | client-close (conn_close) | diverter.jsonl conn 14 |
| 15 | 2026-11-04 21:31:25.719 UTC | 1 | ::1:39504 | localhost:9090 | B (127.0.0.1:8080) | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 15 |
| 16 | 2026-11-04 21:31:25.721 UTC | 2 | ::1:39512 | localhost:9090 | B (127.0.0.1:8080) | encrypted-binary-hello → plaintext fallback | (not observable — encrypted) | selection-probe | observed command | 86 | 124 | client-close (conn_close) | diverter.jsonl conn 16 |
| 17 | 2026-11-04 21:31:25.724 UTC | 0 | ::1:39518 | localhost:9090 | B (127.0.0.1:8080) | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 17 |
| 18 | 2026-11-04 21:31:25.725 UTC | 2 | ::1:39530 | localhost:9090 | B (127.0.0.1:8080) | encrypted-binary-hello → plaintext fallback | (not observable — encrypted) | selection-probe | observed command | 94 | 124 | client-close (conn_close) | diverter.jsonl conn 18 |
| 19 | 2026-11-04 21:31:25.728 UTC | 0 | ::1:39532 | localhost:9090 | B (127.0.0.1:8080) | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 19 |
| 20 | 2026-11-04 21:31:25.729 UTC | 2 | ::1:39546 | localhost:9090 | B (127.0.0.1:8080) | encrypted-binary-hello → plaintext fallback | (not observable — encrypted) | selection-probe | observed command | 95 | 124 | client-close (conn_close) | diverter.jsonl conn 20 |
| 21 | 2026-11-04 21:31:25.735 UTC | 1 | undefined:undefined | localhost:9090 | — | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 21 |
| 22 | 2026-11-04 21:31:25.735 UTC | 2 | ::1:39570 | localhost:9090 | B (127.0.0.1:8080) | encrypted-binary-hello → plaintext fallback | 6E53871D-711A-4A91-A47A-FADD5EB3A87B | selection-probe | observed command | 200 | 162 | client-close (conn_close) | diverter.jsonl conn 22 |
| 23 | 2026-11-04 21:31:25.737 UTC | 19820 | ::1:39586 | localhost:9090 | B (127.0.0.1:8080) | plaintext-HI | 6E53871D-711A-4A91-A47A-FADD5EB3A87B | packet-loss-accounting | observed command | 176 | 299 | client-close (conn_close) | diverter.jsonl conn 23 |
| 24 | 2026-11-04 21:31:25.738 UTC | 9623 | ::1:39592 | localhost:9090 | B (127.0.0.1:8080) | plaintext-HI | 6E53871D-711A-4A91-A47A-FADD5EB3A87B | download-worker | observed command | 1102 | 1855260663 | client-close (conn_close) | diverter.jsonl conn 24 |
| 25 | 2026-11-04 21:31:25.738 UTC | 9722 | ::1:39608 | localhost:9090 | B (127.0.0.1:8080) | plaintext-HI | 6E53871D-711A-4A91-A47A-FADD5EB3A87B | download-worker | observed command | 1336 | 2257104304 | client-close (conn_close) | diverter.jsonl conn 25 |
| 26 | 2026-11-04 21:31:25.739 UTC | 12667 | ::1:39622 | localhost:9090 | B (127.0.0.1:8080) | plaintext-HI | 6E53871D-711A-4A91-A47A-FADD5EB3A87B | ping-monitor | observed command | 3096 | 3673 | client-close (conn_close) | diverter.jsonl conn 26 |
| 27 | 2026-11-04 21:31:25.741 UTC | 9635 | ::1:39632 | localhost:9090 | B (127.0.0.1:8080) | plaintext-HI | 6E53871D-711A-4A91-A47A-FADD5EB3A87B | download-worker | observed command | 1948 | 3367798033 | client-close (conn_close) | diverter.jsonl conn 27 |
| 28 | 2026-11-04 21:31:25.741 UTC | 9633 | ::1:39636 | localhost:9090 | B (127.0.0.1:8080) | plaintext-HI | 6E53871D-711A-4A91-A47A-FADD5EB3A87B | download-worker | observed command | 2074 | 3566071322 | client-close (conn_close) | diverter.jsonl conn 28 |
| 29 | 2026-11-04 21:31:35.378 UTC | 10180 | ::1:33186 | localhost:9090 | B (127.0.0.1:8080) | plaintext-HI | 6E53871D-711A-4A91-A47A-FADD5EB3A87B | ping-monitor | observed command | 3272 | 3882 | client-close (conn_close) | diverter.jsonl conn 29 |
| 30 | 2026-11-04 21:31:35.380 UTC | 10176 | ::1:33196 | localhost:9090 | B (127.0.0.1:8080) | plaintext-HI | 6E53871D-711A-4A91-A47A-FADD5EB3A87B | upload-worker | observed HI <UUID> + byte-signature GB-scale cli→backend (perintah UPLOAD menyatu dgn payload acak dlm satu chunk non-printable) | 1664000040 | 1370 | client-close (conn_close) | diverter.jsonl conn 30 |
| 31 | 2026-11-04 21:31:35.382 UTC | 10146 | ::1:33202 | localhost:9090 | B (127.0.0.1:8080) | plaintext-HI | 6E53871D-711A-4A91-A47A-FADD5EB3A87B | upload-control | observed command | 77 | 93 | client-close (conn_close) | diverter.jsonl conn 31 |
| 32 | 2026-11-04 21:31:35.383 UTC | 10148 | ::1:33204 | localhost:9090 | B (127.0.0.1:8080) | plaintext-HI | 6E53871D-711A-4A91-A47A-FADD5EB3A87B | upload-worker | observed HI <UUID> + byte-signature GB-scale cli→backend (perintah UPLOAD menyatu dgn payload acak dlm satu chunk non-printable) | 2531782319 | 2098 | client-close (conn_close) | diverter.jsonl conn 32 |
| 33 | 2026-11-04 21:31:35.383 UTC | 10148 | ::1:33212 | localhost:9090 | B (127.0.0.1:8080) | plaintext-HI | 6E53871D-711A-4A91-A47A-FADD5EB3A87B | upload-worker | observed HI <UUID> + byte-signature GB-scale cli→backend (perintah UPLOAD menyatu dgn payload acak dlm satu chunk non-printable) | 2400000040 | 1994 | client-close (conn_close) | diverter.jsonl conn 33 |
| 34 | 2026-11-04 21:31:35.383 UTC | 10159 | ::1:33220 | localhost:9090 | B (127.0.0.1:8080) | plaintext-HI | 6E53871D-711A-4A91-A47A-FADD5EB3A87B | upload-worker | observed HI <UUID> + byte-signature GB-scale cli→backend (perintah UPLOAD menyatu dgn payload acak dlm satu chunk non-printable) | 2496000040 | 2072 | client-close (conn_close) | diverter.jsonl conn 34 |

## Endpoint UDP (3)

| klien | backend | datagram cli→be | balasan be→cli |
|---|---|---|---|
| ::1:44713 | A (127.0.0.1:18080) | 191 | 0 |
| ::1:52505 | A (127.0.0.1:18080) | 191 | 0 |
| ::1:41297 | A (127.0.0.1:18080) | 202 | 0 |

> Fase koneksi terenkripsi dilabel **(inferred)** dan basisnya byte-signature — perintah TIDAK diinfer dari payload terenkripsi (master prompt §11). Fase koneksi plaintext berbasis perintah teramati langsung.

(CSV mesin-terbaca: ../evidence/f8b/timeline.csv)
