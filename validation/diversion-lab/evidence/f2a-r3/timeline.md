# TIMELINE — f2a-r3 (generator: gen-timeline.mjs)

Policy: `phase:pre=A,enc=A,sel=A,ping=B,loss=B,dn=B,up=B,upctl=B` | UDP→B | diverter :9090 | A=127.0.0.1:18080 (official) | B=127.0.0.1:8080 (SpeedtestServer TS)

- **Config fetch**: 2026-11-04 20:50:28.212 UTC — GET /api/cli/config?deviceId=REDACTED&hid=REDACTED&sid=R… via lab proxy (MITM lab-CA) → served live-curl, 2953 B, semua servers[] → localhost:9090
- **Non-publishing**: results.speedtest.net:443 DITOLAK proxy (403) → CLI `persisted:false`
- **Hasil CLI**: exit=0 type=result | latency 0.085 ms | DL 14.34 GB | UL 12.06 GB | packetLoss 0 | result.id=bfa70ff2-2ab4-44ae-bdf6-8815adc1c9bc
- **UUID sesi**: bfa70ff2-2ab4-44ae-bdf6-8815adc1c9bc (diumumkan winner-probe & dipakai semua koneksi pasca-seleksi)

## Koneksi TCP (34)

| # | mulai (UTC) | dur (ms) | sumber CLI | gateway | backend aktual | handshake | UUID sesi | fase | basis fase | c→b (B) | b→c (B) | penutupan | evidence |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 2026-11-04 20:50:28.476 UTC | 2 | undefined:undefined | localhost:9090 | — | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 1 |
| 2 | 2026-11-04 20:50:28.476 UTC | 5 | ::1:40878 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | selection-probe (inferred) | byte-signature: small, short-lived | 190 | 244 | client-close (conn_close) | diverter.jsonl conn 2 |
| 3 | 2026-11-04 20:50:28.484 UTC | 1 | ::1:40890 | localhost:9090 | — | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 3 |
| 4 | 2026-11-04 20:50:28.484 UTC | 1 | ::1:40896 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | selection-probe (inferred) | byte-signature: small, short-lived | 175 | 242 | client-close (conn_close) | diverter.jsonl conn 4 |
| 5 | 2026-11-04 20:50:28.488 UTC | 0 | ::1:40908 | localhost:9090 | — | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 5 |
| 6 | 2026-11-04 20:50:28.489 UTC | 1 | ::1:40922 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | selection-probe (inferred) | byte-signature: small, short-lived | 213 | 242 | client-close (conn_close) | diverter.jsonl conn 6 |
| 7 | 2026-11-04 20:50:28.493 UTC | 0 | ::1:40936 | localhost:9090 | — | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 7 |
| 8 | 2026-11-04 20:50:28.493 UTC | 2 | ::1:40950 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | selection-probe (inferred) | byte-signature: small, short-lived | 202 | 241 | client-close (conn_close) | diverter.jsonl conn 8 |
| 9 | 2026-11-04 20:50:28.497 UTC | 1 | ::1:40956 | localhost:9090 | — | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 9 |
| 10 | 2026-11-04 20:50:28.498 UTC | 1 | ::1:40960 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | selection-probe (inferred) | byte-signature: small, short-lived | 210 | 240 | client-close (conn_close) | diverter.jsonl conn 10 |
| 11 | 2026-11-04 20:50:28.502 UTC | 0 | ::1:40970 | localhost:9090 | — | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 11 |
| 12 | 2026-11-04 20:50:28.502 UTC | 2 | ::1:40982 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | selection-probe (inferred) | byte-signature: small, short-lived | 182 | 241 | client-close (conn_close) | diverter.jsonl conn 12 |
| 13 | 2026-11-04 20:50:28.507 UTC | 0 | ::1:40996 | localhost:9090 | — | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 13 |
| 14 | 2026-11-04 20:50:28.507 UTC | 1 | ::1:41002 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | selection-probe (inferred) | byte-signature: small, short-lived | 201 | 242 | client-close (conn_close) | diverter.jsonl conn 14 |
| 15 | 2026-11-04 20:50:28.511 UTC | 0 | ::1:41018 | localhost:9090 | — | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 15 |
| 16 | 2026-11-04 20:50:28.511 UTC | 2 | ::1:41022 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | selection-probe (inferred) | byte-signature: small, short-lived | 189 | 243 | client-close (conn_close) | diverter.jsonl conn 16 |
| 17 | 2026-11-04 20:50:28.515 UTC | 1 | ::1:41028 | localhost:9090 | — | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 17 |
| 18 | 2026-11-04 20:50:28.516 UTC | 1 | ::1:41036 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | selection-probe (inferred) | byte-signature: small, short-lived | 205 | 239 | client-close (conn_close) | diverter.jsonl conn 18 |
| 19 | 2026-11-04 20:50:28.520 UTC | 0 | ::1:41038 | localhost:9090 | — | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 19 |
| 20 | 2026-11-04 20:50:28.520 UTC | 2 | ::1:41044 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | selection-probe (inferred) | byte-signature: small, short-lived | 200 | 239 | client-close (conn_close) | diverter.jsonl conn 20 |
| 21 | 2026-11-04 20:50:28.528 UTC | 1 | undefined:undefined | localhost:9090 | — | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 21 |
| 22 | 2026-11-04 20:50:28.528 UTC | 1 | ::1:41068 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | selection-probe (inferred) | byte-signature: small, short-lived | 337 | 322 | client-close (conn_close) | diverter.jsonl conn 22 |
| 23 | 2026-11-04 20:50:28.529 UTC | 10334 | ::1:41078 | localhost:9090 | B (127.0.0.1:8080) | plaintext-HI | BFA70FF2-2AB4-44AE-BDF6-8815ADC1C9BC | packet-loss-accounting | observed command | 56 | 107 | client-close (conn_close) | diverter.jsonl conn 23 (prefix replayed cross-backend) |
| 24 | 2026-11-04 20:50:28.530 UTC | 12846 | ::1:41086 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | ping-monitor (inferred) | byte-signature: KB-scale, long-lived, spans a load phase | 8616 | 9185 | client-close (conn_close) | diverter.jsonl conn 24 |
| 25 | 2026-11-04 20:50:28.530 UTC | 9861 | ::1:41098 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | download-worker (inferred) | byte-signature: GB-scale backend→cli | 5818 | 3906359144 | client-close (conn_close) | diverter.jsonl conn 25 |
| 26 | 2026-11-04 20:50:28.530 UTC | 9830 | ::1:41110 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | download-worker (inferred) | byte-signature: GB-scale backend→cli | 4577 | 3147598997 | client-close (conn_close) | diverter.jsonl conn 26 |
| 27 | 2026-11-04 20:50:28.533 UTC | 9857 | ::1:41114 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | download-worker (inferred) | byte-signature: GB-scale backend→cli | 5932 | 4122999308 | client-close (conn_close) | diverter.jsonl conn 27 |
| 28 | 2026-11-04 20:50:28.533 UTC | 9826 | ::1:41124 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | download-worker (inferred) | byte-signature: GB-scale backend→cli | 4678 | 3202357457 | client-close (conn_close) | diverter.jsonl conn 28 |
| 29 | 2026-11-04 20:50:38.361 UTC | 11164 | ::1:37320 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | upload-worker (inferred) | byte-signature: GB-scale cli→backend | 3776000080 | 6362 | client-close (conn_close) | diverter.jsonl conn 29 |
| 30 | 2026-11-04 20:50:38.361 UTC | 11167 | ::1:37334 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | upload-worker (inferred) | byte-signature: GB-scale cli→backend | 2897041458 | 4845 | client-close (conn_close) | diverter.jsonl conn 30 |
| 31 | 2026-11-04 20:50:38.362 UTC | 11145 | ::1:37338 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | upload-control (inferred) | byte-signature: tiny c→b, tens-of-KB b→c, upload-phase window | 172 | 45644 | client-close (conn_close) | diverter.jsonl conn 31 |
| 32 | 2026-11-04 20:50:38.363 UTC | 11134 | ::1:37348 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | upload-worker (inferred) | byte-signature: GB-scale cli→backend | 3200000068 | 5344 | client-close (conn_close) | diverter.jsonl conn 32 |
| 33 | 2026-11-04 20:50:38.363 UTC | 11131 | ::1:37356 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | upload-worker (inferred) | byte-signature: GB-scale cli→backend | 2240000074 | 3797 | client-close (conn_close) | diverter.jsonl conn 33 |
| 34 | 2026-11-04 20:50:38.363 UTC | 11165 | ::1:37366 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | ping-monitor (inferred) | byte-signature: KB-scale, long-lived, spans a load phase | 9698 | 10252 | client-close (conn_close) | diverter.jsonl conn 34 |

## Endpoint UDP (3)

| klien | backend | datagram cli→be | balasan be→cli |
|---|---|---|---|
| ::1:56166 | B (127.0.0.1:8080) | 196 | 196 |
| ::1:36001 | B (127.0.0.1:8080) | 196 | 0 |
| ::1:55780 | B (127.0.0.1:8080) | 221 | 221 |

> Fase koneksi terenkripsi dilabel **(inferred)** dan basisnya byte-signature — perintah TIDAK diinfer dari payload terenkripsi (master prompt §11). Fase koneksi plaintext berbasis perintah teramati langsung.

(CSV mesin-terbaca: ../evidence/f2a-r3/timeline.csv)
