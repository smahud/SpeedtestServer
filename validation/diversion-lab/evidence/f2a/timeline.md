# TIMELINE — f2a (generator: gen-timeline.mjs)

Policy: `phase:pre=A,enc=A,sel=A,ping=B,loss=B,dn=B,up=B,upctl=B` | UDP→B | diverter :9090 | A=127.0.0.1:18080 (official) | B=127.0.0.1:8080 (SpeedtestServer TS)

- **Config fetch**: 2026-11-04 20:43:03.033 UTC — GET /api/cli/config?deviceId=REDACTED&hid=REDACTED&sid=R… via lab proxy (MITM lab-CA) → served live-curl, 2953 B, semua servers[] → localhost:9090
- **Non-publishing**: results.speedtest.net:443 DITOLAK proxy (403) → CLI `persisted:false`
- **Hasil CLI**: exit=0 type=result | latency 0.079 ms | DL 15.86 GB | UL 13.26 GB | packetLoss 0 | result.id=da52b37a-f832-4ded-b09b-54b697cd5eb2
- **UUID sesi**: da52b37a-f832-4ded-b09b-54b697cd5eb2 (diumumkan winner-probe & dipakai semua koneksi pasca-seleksi)

## Koneksi TCP (34)

| # | mulai (UTC) | dur (ms) | sumber CLI | gateway | backend aktual | handshake | UUID sesi | fase | basis fase | c→b (B) | b→c (B) | penutupan | evidence |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 2026-11-04 20:43:03.280 UTC | 2 | undefined:undefined | localhost:9090 | — | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 1 |
| 2 | 2026-11-04 20:43:03.280 UTC | 6 | ::1:44152 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | selection-probe (inferred) | byte-signature: small, short-lived | 225 | 263 | client-close (conn_close) | diverter.jsonl conn 2 |
| 3 | 2026-11-04 20:43:03.288 UTC | 1 | ::1:44158 | localhost:9090 | — | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 3 |
| 4 | 2026-11-04 20:43:03.289 UTC | 2 | ::1:44170 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | selection-probe (inferred) | byte-signature: small, short-lived | 197 | 265 | client-close (conn_close) | diverter.jsonl conn 4 |
| 5 | 2026-11-04 20:43:03.291 UTC | 0 | undefined:undefined | localhost:9090 | — | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 5 |
| 6 | 2026-11-04 20:43:03.291 UTC | 3 | ::1:44182 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | selection-probe (inferred) | byte-signature: small, short-lived | 195 | 264 | client-close (conn_close) | diverter.jsonl conn 6 |
| 7 | 2026-11-04 20:43:03.292 UTC | 0 | ::1:44196 | localhost:9090 | — | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 7 |
| 8 | 2026-11-04 20:43:03.294 UTC | 2 | ::1:44206 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | selection-probe (inferred) | byte-signature: small, short-lived | 204 | 265 | client-close (conn_close) | diverter.jsonl conn 8 |
| 9 | 2026-11-04 20:43:03.297 UTC | 0 | ::1:44216 | localhost:9090 | — | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 9 |
| 10 | 2026-11-04 20:43:03.297 UTC | 1 | ::1:44220 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | selection-probe (inferred) | byte-signature: small, short-lived | 217 | 267 | client-close (conn_close) | diverter.jsonl conn 10 |
| 11 | 2026-11-04 20:43:03.301 UTC | 0 | ::1:44232 | localhost:9090 | — | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 11 |
| 12 | 2026-11-04 20:43:03.301 UTC | 2 | ::1:44242 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | selection-probe (inferred) | byte-signature: small, short-lived | 175 | 261 | client-close (conn_close) | diverter.jsonl conn 12 |
| 13 | 2026-11-04 20:43:03.304 UTC | 0 | ::1:44254 | localhost:9090 | — | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 13 |
| 14 | 2026-11-04 20:43:03.305 UTC | 1 | ::1:44268 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | selection-probe (inferred) | byte-signature: small, short-lived | 191 | 262 | client-close (conn_close) | diverter.jsonl conn 14 |
| 15 | 2026-11-04 20:43:03.308 UTC | 0 | ::1:44270 | localhost:9090 | — | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 15 |
| 16 | 2026-11-04 20:43:03.309 UTC | 2 | ::1:44280 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | selection-probe (inferred) | byte-signature: small, short-lived | 212 | 263 | client-close (conn_close) | diverter.jsonl conn 16 |
| 17 | 2026-11-04 20:43:03.312 UTC | 0 | ::1:44290 | localhost:9090 | — | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 17 |
| 18 | 2026-11-04 20:43:03.312 UTC | 2 | ::1:44306 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | selection-probe (inferred) | byte-signature: small, short-lived | 201 | 265 | client-close (conn_close) | diverter.jsonl conn 18 |
| 19 | 2026-11-04 20:43:03.316 UTC | 1 | ::1:44316 | localhost:9090 | — | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 19 |
| 20 | 2026-11-04 20:43:03.316 UTC | 2 | ::1:44332 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | selection-probe (inferred) | byte-signature: small, short-lived | 192 | 265 | client-close (conn_close) | diverter.jsonl conn 20 |
| 21 | 2026-11-04 20:43:03.323 UTC | 1 | undefined:undefined | localhost:9090 | — | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 21 |
| 22 | 2026-11-04 20:43:03.323 UTC | 3 | ::1:44350 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | selection-probe (inferred) | byte-signature: small, short-lived | 345 | 353 | client-close (conn_close) | diverter.jsonl conn 22 |
| 23 | 2026-11-04 20:43:03.325 UTC | 20842 | ::1:44356 | localhost:9090 | B (127.0.0.1:8080) | plaintext-HI | DA52B37A-F832-4DED-B09B-54B697CD5EB2 | packet-loss-accounting | observed command | 176 | 405 | client-close (conn_close) | diverter.jsonl conn 23 (prefix replayed cross-backend) |
| 24 | 2026-11-04 20:43:03.326 UTC | 13248 | ::1:44370 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | ping-monitor (inferred) | byte-signature: KB-scale, long-lived, spans a load phase | 8953 | 9623 | client-close (conn_close) | diverter.jsonl conn 24 |
| 25 | 2026-11-04 20:43:03.326 UTC | 10248 | ::1:44376 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | download-worker (inferred) | byte-signature: GB-scale backend→cli | 4241 | 2944000066 | client-close (conn_close) | diverter.jsonl conn 25 |
| 26 | 2026-11-04 20:43:03.326 UTC | 10266 | ::1:44380 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | download-worker (inferred) | byte-signature: GB-scale backend→cli | 4659 | 3214811031 | client-close (conn_close) | diverter.jsonl conn 26 |
| 27 | 2026-11-04 20:43:03.326 UTC | 10240 | ::1:44396 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | download-worker (inferred) | byte-signature: GB-scale backend→cli | 8773 | 6094680130 | client-close (conn_close) | diverter.jsonl conn 27 |
| 28 | 2026-11-04 20:43:03.327 UTC | 10240 | ::1:44412 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | download-worker (inferred) | byte-signature: GB-scale backend→cli | 5460 | 3722616755 | client-close (conn_close) | diverter.jsonl conn 28 |
| 29 | 2026-11-04 20:43:13.567 UTC | 12790 | ::1:40474 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | ping-monitor (inferred) | byte-signature: KB-scale, long-lived, spans a load phase | 11027 | 11910 | client-close (conn_close) | diverter.jsonl conn 29 |
| 30 | 2026-11-04 20:43:13.567 UTC | 12789 | ::1:40478 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | upload-worker (inferred) | byte-signature: GB-scale cli→backend | 4065032172 | 6968 | client-close (conn_close) | diverter.jsonl conn 30 |
| 31 | 2026-11-04 20:43:13.568 UTC | 12788 | ::1:40486 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | upload-worker (inferred) | byte-signature: GB-scale cli→backend | 3634857454 | 6199 | client-close (conn_close) | diverter.jsonl conn 31 |
| 32 | 2026-11-04 20:43:13.574 UTC | 12746 | ::1:40496 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | upload-worker (inferred) | byte-signature: GB-scale cli→backend | 2623047065 | 4477 | client-close (conn_close) | diverter.jsonl conn 32 |
| 33 | 2026-11-04 20:43:13.575 UTC | 12735 | ::1:40510 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | upload-worker (inferred) | byte-signature: GB-scale cli→backend | 2972477320 | 5059 | client-close (conn_close) | diverter.jsonl conn 33 |
| 34 | 2026-11-04 20:43:13.575 UTC | 12734 | ::1:40512 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | upload-control (inferred) | byte-signature: tiny c→b, tens-of-KB b→c, upload-phase window | 174 | 52338 | client-close (conn_close) | diverter.jsonl conn 34 |

## Endpoint UDP (3)

| klien | backend | datagram cli→be | balasan be→cli |
|---|---|---|---|
| ::1:50650 | B (127.0.0.1:8080) | 204 | 204 |
| ::1:52409 | B (127.0.0.1:8080) | 204 | 0 |
| ::1:40761 | B (127.0.0.1:8080) | 254 | 254 |

> Fase koneksi terenkripsi dilabel **(inferred)** dan basisnya byte-signature — perintah TIDAK diinfer dari payload terenkripsi (master prompt §11). Fase koneksi plaintext berbasis perintah teramati langsung.

(CSV mesin-terbaca: ../evidence/f2a/timeline.csv)
