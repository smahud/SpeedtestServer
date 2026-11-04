# TIMELINE — f2a-r2 (generator: gen-timeline.mjs)

Policy: `phase:pre=A,enc=A,sel=A,ping=B,loss=B,dn=B,up=B,upctl=B` | UDP→B | diverter :9090 | A=127.0.0.1:18080 (official) | B=127.0.0.1:8080 (SpeedtestServer TS)

- **Config fetch**: 2026-11-04 20:44:55.582 UTC — GET /api/cli/config?deviceId=REDACTED&hid=REDACTED&sid=R… via lab proxy (MITM lab-CA) → served live-curl, 2953 B, semua servers[] → localhost:9090
- **Non-publishing**: results.speedtest.net:443 DITOLAK proxy (403) → CLI `persisted:false`
- **Hasil CLI**: exit=0 type=result | latency 0.106 ms | DL 12.71 GB | UL 16.80 GB | packetLoss 0 | result.id=9dfb0bf5-e17f-4819-9aa8-3af2b0ce92e8
- **UUID sesi**: 9dfb0bf5-e17f-4819-9aa8-3af2b0ce92e8 (diumumkan winner-probe & dipakai semua koneksi pasca-seleksi)

## Koneksi TCP (34)

| # | mulai (UTC) | dur (ms) | sumber CLI | gateway | backend aktual | handshake | UUID sesi | fase | basis fase | c→b (B) | b→c (B) | penutupan | evidence |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 2026-11-04 20:44:55.920 UTC | 2 | ::1:37762 | localhost:9090 | — | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 1 |
| 2 | 2026-11-04 20:44:55.921 UTC | 7 | ::1:37778 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | selection-probe (inferred) | byte-signature: small, short-lived | 200 | 252 | client-close (conn_close) | diverter.jsonl conn 2 |
| 3 | 2026-11-04 20:44:55.925 UTC | 1 | undefined:undefined | localhost:9090 | — | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 3 |
| 4 | 2026-11-04 20:44:55.925 UTC | 5 | ::1:37788 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | selection-probe (inferred) | byte-signature: small, short-lived | 183 | 253 | client-close (conn_close) | diverter.jsonl conn 4 |
| 5 | 2026-11-04 20:44:55.932 UTC | 0 | ::1:37800 | localhost:9090 | — | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 5 |
| 6 | 2026-11-04 20:44:55.932 UTC | 2 | ::1:37806 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | selection-probe (inferred) | byte-signature: small, short-lived | 183 | 253 | client-close (conn_close) | diverter.jsonl conn 6 |
| 7 | 2026-11-04 20:44:55.936 UTC | 0 | ::1:37814 | localhost:9090 | — | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 7 |
| 8 | 2026-11-04 20:44:55.936 UTC | 2 | ::1:37818 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | selection-probe (inferred) | byte-signature: small, short-lived | 180 | 254 | client-close (conn_close) | diverter.jsonl conn 8 |
| 9 | 2026-11-04 20:44:55.940 UTC | 0 | ::1:37832 | localhost:9090 | — | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 9 |
| 10 | 2026-11-04 20:44:55.941 UTC | 2 | ::1:37836 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | selection-probe (inferred) | byte-signature: small, short-lived | 214 | 257 | client-close (conn_close) | diverter.jsonl conn 10 |
| 11 | 2026-11-04 20:44:55.945 UTC | 0 | ::1:37838 | localhost:9090 | — | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 11 |
| 12 | 2026-11-04 20:44:55.945 UTC | 1 | ::1:37840 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | selection-probe (inferred) | byte-signature: small, short-lived | 180 | 254 | client-close (conn_close) | diverter.jsonl conn 12 |
| 13 | 2026-11-04 20:44:55.949 UTC | 0 | ::1:37846 | localhost:9090 | — | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 13 |
| 14 | 2026-11-04 20:44:55.949 UTC | 1 | ::1:37856 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | selection-probe (inferred) | byte-signature: small, short-lived | 179 | 253 | client-close (conn_close) | diverter.jsonl conn 14 |
| 15 | 2026-11-04 20:44:55.954 UTC | 0 | ::1:37858 | localhost:9090 | — | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 15 |
| 16 | 2026-11-04 20:44:55.954 UTC | 2 | ::1:37868 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | selection-probe (inferred) | byte-signature: small, short-lived | 218 | 251 | client-close (conn_close) | diverter.jsonl conn 16 |
| 17 | 2026-11-04 20:44:55.958 UTC | 0 | ::1:37878 | localhost:9090 | — | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 17 |
| 18 | 2026-11-04 20:44:55.959 UTC | 2 | ::1:37892 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | selection-probe (inferred) | byte-signature: small, short-lived | 201 | 258 | client-close (conn_close) | diverter.jsonl conn 18 |
| 19 | 2026-11-04 20:44:55.963 UTC | 1 | ::1:37894 | localhost:9090 | — | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 19 |
| 20 | 2026-11-04 20:44:55.963 UTC | 2 | ::1:37900 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | selection-probe (inferred) | byte-signature: small, short-lived | 213 | 253 | client-close (conn_close) | diverter.jsonl conn 20 |
| 21 | 2026-11-04 20:44:55.970 UTC | 0 | undefined:undefined | localhost:9090 | — | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 21 |
| 22 | 2026-11-04 20:44:55.970 UTC | 2 | ::1:37916 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | selection-probe (inferred) | byte-signature: small, short-lived | 297 | 359 | client-close (conn_close) | diverter.jsonl conn 22 |
| 23 | 2026-11-04 20:44:55.972 UTC | 10252 | ::1:37926 | localhost:9090 | B (127.0.0.1:8080) | plaintext-HI | 9DFB0BF5-E17F-4819-9AA8-3AF2B0CE92E8 | packet-loss-accounting | observed command | 56 | 107 | client-close (conn_close) | diverter.jsonl conn 23 (prefix replayed cross-backend) |
| 24 | 2026-11-04 20:44:55.973 UTC | 9766 | ::1:37942 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | download-worker (inferred) | byte-signature: GB-scale backend→cli | 4030 | 2771005333 | client-close (conn_close) | diverter.jsonl conn 24 |
| 25 | 2026-11-04 20:44:55.973 UTC | 9899 | ::1:37950 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | download-worker (inferred) | byte-signature: GB-scale backend→cli | 4222 | 2898348814 | client-close (conn_close) | diverter.jsonl conn 25 |
| 26 | 2026-11-04 20:44:55.974 UTC | 9749 | ::1:37956 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | download-worker (inferred) | byte-signature: GB-scale backend→cli | 4388 | 2958154538 | client-close (conn_close) | diverter.jsonl conn 26 |
| 27 | 2026-11-04 20:44:55.977 UTC | 9733 | ::1:37972 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | download-worker (inferred) | byte-signature: GB-scale backend→cli | 6074 | 4192000079 | client-close (conn_close) | diverter.jsonl conn 27 |
| 28 | 2026-11-04 20:44:55.984 UTC | 12721 | ::1:37980 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | ping-monitor (inferred) | byte-signature: KB-scale, long-lived, spans a load phase | 8565 | 9153 | client-close (conn_close) | diverter.jsonl conn 28 |
| 29 | 2026-11-04 20:45:05.714 UTC | 15032 | ::1:45300 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | upload-control (inferred) | byte-signature: tiny c→b, tens-of-KB b→c, upload-phase window | 172 | 62962 | client-close (conn_close) | diverter.jsonl conn 29 |
| 30 | 2026-11-04 20:45:05.722 UTC | 15054 | ::1:45312 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | ping-monitor (inferred) | byte-signature: KB-scale, long-lived, spans a load phase | 12970 | 13998 | client-close (conn_close) | diverter.jsonl conn 30 |
| 31 | 2026-11-04 20:45:05.725 UTC | 15051 | ::1:45316 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | upload-worker (inferred) | byte-signature: GB-scale cli→backend | 3264524180 | 5545 | client-close (conn_close) | diverter.jsonl conn 31 |
| 32 | 2026-11-04 20:45:05.728 UTC | 15019 | ::1:45326 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | upload-worker (inferred) | byte-signature: GB-scale cli→backend | 4896000074 | 8261 | client-close (conn_close) | diverter.jsonl conn 32 |
| 33 | 2026-11-04 20:45:05.728 UTC | 15048 | ::1:45336 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | upload-worker (inferred) | byte-signature: GB-scale cli→backend | 4448000073 | 7428 | client-close (conn_close) | diverter.jsonl conn 33 |
| 34 | 2026-11-04 20:45:05.728 UTC | 15017 | ::1:45344 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | upload-worker (inferred) | byte-signature: GB-scale cli→backend | 4241545173 | 7129 | client-close (conn_close) | diverter.jsonl conn 34 |

## Endpoint UDP (3)

| klien | backend | datagram cli→be | balasan be→cli |
|---|---|---|---|
| ::1:59849 | B (127.0.0.1:8080) | 194 | 194 |
| ::1:39517 | B (127.0.0.1:8080) | 194 | 0 |
| ::1:46855 | B (127.0.0.1:8080) | 299 | 299 |

> Fase koneksi terenkripsi dilabel **(inferred)** dan basisnya byte-signature — perintah TIDAK diinfer dari payload terenkripsi (master prompt §11). Fase koneksi plaintext berbasis perintah teramati langsung.

(CSV mesin-terbaca: ../evidence/f2a-r2/timeline.csv)
