# TIMELINE — f8a (generator: gen-timeline.mjs)

Policy: `all:A` | UDP→B | diverter :9090 | A=127.0.0.1:18080 (official) | B=127.0.0.1:8080 (SpeedtestServer TS)

- **Config fetch**: 2026-11-04 21:24:34.800 UTC — GET /api/cli/config?deviceId=REDACTED&hid=REDACTED&sid=R… via lab proxy (MITM lab-CA) → served live-curl, 2953 B, semua servers[] → localhost:9090
- **Non-publishing**: results.speedtest.net:443 DITOLAK proxy (403) → CLI `persisted:false`
- **Hasil CLI**: exit=0 type=result | latency 0.106 ms | DL 16.65 GB | UL 14.82 GB | packetLoss 0 | result.id=7ebd179f-2994-48c2-866a-2cf566aafbb3
- **UUID sesi**: 7ebd179f-2994-48c2-866a-2cf566aafbb3 (diumumkan winner-probe & dipakai semua koneksi pasca-seleksi)

## Koneksi TCP (34)

| # | mulai (UTC) | dur (ms) | sumber CLI | gateway | backend aktual | handshake | UUID sesi | fase | basis fase | c→b (B) | b→c (B) | penutupan | evidence |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 2026-11-04 21:24:35.038 UTC | 3 | undefined:undefined | localhost:9090 | — | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 1 |
| 2 | 2026-11-04 21:24:35.039 UTC | 6 | ::1:46610 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | selection-probe (inferred) | byte-signature: small, short-lived | 209 | 235 | client-close (conn_close) | diverter.jsonl conn 2 |
| 3 | 2026-11-04 21:24:35.046 UTC | 1 | ::1:46626 | localhost:9090 | A (127.0.0.1:18080) | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 3 |
| 4 | 2026-11-04 21:24:35.047 UTC | 3 | ::1:46628 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | selection-probe (inferred) | byte-signature: small, short-lived | 188 | 236 | client-close (conn_close) | diverter.jsonl conn 4 |
| 5 | 2026-11-04 21:24:35.050 UTC | 1 | ::1:46640 | localhost:9090 | A (127.0.0.1:18080) | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 5 |
| 6 | 2026-11-04 21:24:35.051 UTC | 2 | ::1:46656 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | selection-probe (inferred) | byte-signature: small, short-lived | 214 | 238 | client-close (conn_close) | diverter.jsonl conn 6 |
| 7 | 2026-11-04 21:24:35.053 UTC | 1 | ::1:46658 | localhost:9090 | A (127.0.0.1:18080) | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 7 |
| 8 | 2026-11-04 21:24:35.055 UTC | 2 | ::1:46670 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | selection-probe (inferred) | byte-signature: small, short-lived | 194 | 237 | client-close (conn_close) | diverter.jsonl conn 8 |
| 9 | 2026-11-04 21:24:35.057 UTC | 1 | ::1:46686 | localhost:9090 | A (127.0.0.1:18080) | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 9 |
| 10 | 2026-11-04 21:24:35.059 UTC | 2 | ::1:46690 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | selection-probe (inferred) | byte-signature: small, short-lived | 187 | 236 | client-close (conn_close) | diverter.jsonl conn 10 |
| 11 | 2026-11-04 21:24:35.061 UTC | 1 | undefined:undefined | localhost:9090 | — | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 11 |
| 12 | 2026-11-04 21:24:35.061 UTC | 2 | ::1:46710 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | selection-probe (inferred) | byte-signature: small, short-lived | 210 | 237 | client-close (conn_close) | diverter.jsonl conn 12 |
| 13 | 2026-11-04 21:24:35.063 UTC | 1 | undefined:undefined | localhost:9090 | — | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 13 |
| 14 | 2026-11-04 21:24:35.064 UTC | 2 | ::1:46714 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | selection-probe (inferred) | byte-signature: small, short-lived | 190 | 236 | client-close (conn_close) | diverter.jsonl conn 14 |
| 15 | 2026-11-04 21:24:35.067 UTC | 0 | ::1:46722 | localhost:9090 | A (127.0.0.1:18080) | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 15 |
| 16 | 2026-11-04 21:24:35.067 UTC | 2 | ::1:46730 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | selection-probe (inferred) | byte-signature: small, short-lived | 213 | 236 | client-close (conn_close) | diverter.jsonl conn 16 |
| 17 | 2026-11-04 21:24:35.070 UTC | 0 | ::1:46746 | localhost:9090 | A (127.0.0.1:18080) | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 17 |
| 18 | 2026-11-04 21:24:35.071 UTC | 3 | ::1:46762 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | selection-probe (inferred) | byte-signature: small, short-lived | 205 | 237 | client-close (conn_close) | diverter.jsonl conn 18 |
| 19 | 2026-11-04 21:24:35.072 UTC | 0 | undefined:undefined | localhost:9090 | — | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 19 |
| 20 | 2026-11-04 21:24:35.073 UTC | 4 | ::1:46786 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | selection-probe (inferred) | byte-signature: small, short-lived | 188 | 238 | client-close (conn_close) | diverter.jsonl conn 20 |
| 21 | 2026-11-04 21:24:35.079 UTC | 1 | undefined:undefined | localhost:9090 | — | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 21 |
| 22 | 2026-11-04 21:24:35.080 UTC | 2 | ::1:46804 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | selection-probe (inferred) | byte-signature: small, short-lived | 326 | 324 | client-close (conn_close) | diverter.jsonl conn 22 |
| 23 | 2026-11-04 21:24:35.081 UTC | 21698 | ::1:46812 | localhost:9090 | A (127.0.0.1:18080) | plaintext-HI | 7EBD179F-2994-48C2-866A-2CF566AAFBB3 | packet-loss-accounting | observed command | 182 | 311 | client-close (conn_close) | diverter.jsonl conn 23 |
| 24 | 2026-11-04 21:24:35.081 UTC | 10728 | ::1:46818 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | download-worker (inferred) | byte-signature: GB-scale backend→cli | 5094 | 3460259829 | client-close (conn_close) | diverter.jsonl conn 24 |
| 25 | 2026-11-04 21:24:35.083 UTC | 10727 | ::1:46830 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | download-worker (inferred) | byte-signature: GB-scale backend→cli | 6286 | 4352000060 | client-close (conn_close) | diverter.jsonl conn 25 |
| 26 | 2026-11-04 21:24:35.083 UTC | 10731 | ::1:46846 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | download-worker (inferred) | byte-signature: GB-scale backend→cli | 6072 | 4236712356 | client-close (conn_close) | diverter.jsonl conn 26 |
| 27 | 2026-11-04 21:24:35.083 UTC | 10727 | ::1:46848 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | download-worker (inferred) | byte-signature: GB-scale backend→cli | 6798 | 4736000060 | client-close (conn_close) | diverter.jsonl conn 27 |
| 28 | 2026-11-04 21:24:35.087 UTC | 13710 | ::1:46856 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | ping-monitor (inferred) | byte-signature: KB-scale, long-lived, spans a load phase | 9452 | 10043 | client-close (conn_close) | diverter.jsonl conn 28 |
| 29 | 2026-11-04 21:24:45.812 UTC | 10966 | ::1:58778 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | ping-monitor (inferred) | byte-signature: KB-scale, long-lived, spans a load phase | 9500 | 10011 | client-close (conn_close) | diverter.jsonl conn 29 |
| 30 | 2026-11-04 21:24:45.812 UTC | 10931 | ::1:58786 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | upload-worker (inferred) | byte-signature: GB-scale cli→backend | 2877081729 | 4759 | client-close (conn_close) | diverter.jsonl conn 30 |
| 31 | 2026-11-04 21:24:45.814 UTC | 10932 | ::1:58800 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | upload-worker (inferred) | byte-signature: GB-scale cli→backend | 3264000079 | 5411 | client-close (conn_close) | diverter.jsonl conn 31 |
| 32 | 2026-11-04 21:24:45.814 UTC | 10930 | ::1:58816 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | upload-worker (inferred) | byte-signature: GB-scale cli→backend | 4737686788 | 7869 | client-close (conn_close) | diverter.jsonl conn 32 |
| 33 | 2026-11-04 21:24:45.814 UTC | 10931 | ::1:58818 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | upload-worker (inferred) | byte-signature: GB-scale cli→backend | 3968000064 | 6593 | client-close (conn_close) | diverter.jsonl conn 33 |
| 34 | 2026-11-04 21:24:45.814 UTC | 10929 | ::1:58832 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | upload-control (inferred) | byte-signature: tiny c→b, tens-of-KB b→c, upload-phase window | 136 | 41165 | client-close (conn_close) | diverter.jsonl conn 34 |

## Endpoint UDP (3)

| klien | backend | datagram cli→be | balasan be→cli |
|---|---|---|---|
| ::1:53908 | B (127.0.0.1:8080) | 214 | 214 |
| ::1:53891 | B (127.0.0.1:8080) | 214 | 0 |
| ::1:54359 | B (127.0.0.1:8080) | 217 | 217 |

> Fase koneksi terenkripsi dilabel **(inferred)** dan basisnya byte-signature — perintah TIDAK diinfer dari payload terenkripsi (master prompt §11). Fase koneksi plaintext berbasis perintah teramati langsung.

(CSV mesin-terbaca: ../evidence/f8a/timeline.csv)
