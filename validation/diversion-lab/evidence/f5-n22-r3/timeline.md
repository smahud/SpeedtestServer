# TIMELINE — f5-n22-r3 (generator: gen-timeline.mjs)

Policy: `firstN:A:22` | UDP→B | diverter :9090 | A=127.0.0.1:18080 (official) | B=127.0.0.1:8080 (SpeedtestServer TS)

- **Config fetch**: 2026-11-04 21:08:06.397 UTC — GET /api/cli/config?deviceId=REDACTED&hid=REDACTED&sid=R… via lab proxy (MITM lab-CA) → served live-curl, 2953 B, semua servers[] → localhost:9090
- **Non-publishing**: results.speedtest.net:443 DITOLAK proxy (403) → CLI `persisted:false`
- **Hasil CLI**: exit=0 type=result | latency 0.119 ms | DL 17.19 GB | UL 8.61 GB | packetLoss 0 | result.id=f6950b35-bd96-41cd-a492-5a23ae9b494a
- **UUID sesi**: f6950b35-bd96-41cd-a492-5a23ae9b494a (diumumkan winner-probe & dipakai semua koneksi pasca-seleksi)

## Koneksi TCP (34)

| # | mulai (UTC) | dur (ms) | sumber CLI | gateway | backend aktual | handshake | UUID sesi | fase | basis fase | c→b (B) | b→c (B) | penutupan | evidence |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 2026-11-04 21:08:06.672 UTC | 2 | ::1:51906 | localhost:9090 | A (127.0.0.1:18080) | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 1 |
| 2 | 2026-11-04 21:08:06.675 UTC | 5 | ::1:51918 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | selection-probe (inferred) | byte-signature: small, short-lived | 193 | 242 | client-close (conn_close) | diverter.jsonl conn 2 |
| 3 | 2026-11-04 21:08:06.680 UTC | 0 | ::1:51926 | localhost:9090 | A (127.0.0.1:18080) | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 3 |
| 4 | 2026-11-04 21:08:06.680 UTC | 2 | ::1:51934 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | selection-probe (inferred) | byte-signature: small, short-lived | 194 | 246 | client-close (conn_close) | diverter.jsonl conn 4 |
| 5 | 2026-11-04 21:08:06.682 UTC | 0 | ::1:51948 | localhost:9090 | A (127.0.0.1:18080) | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 5 |
| 6 | 2026-11-04 21:08:06.683 UTC | 1 | ::1:51960 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | selection-probe (inferred) | byte-signature: small, short-lived | 205 | 240 | client-close (conn_close) | diverter.jsonl conn 6 |
| 7 | 2026-11-04 21:08:06.686 UTC | 0 | ::1:51962 | localhost:9090 | A (127.0.0.1:18080) | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 7 |
| 8 | 2026-11-04 21:08:06.687 UTC | 1 | ::1:51974 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | selection-probe (inferred) | byte-signature: small, short-lived | 187 | 243 | client-close (conn_close) | diverter.jsonl conn 8 |
| 9 | 2026-11-04 21:08:06.693 UTC | 0 | ::1:51976 | localhost:9090 | A (127.0.0.1:18080) | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 9 |
| 10 | 2026-11-04 21:08:06.694 UTC | 1 | ::1:51982 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | selection-probe (inferred) | byte-signature: small, short-lived | 188 | 239 | client-close (conn_close) | diverter.jsonl conn 10 |
| 11 | 2026-11-04 21:08:06.696 UTC | 0 | ::1:51994 | localhost:9090 | A (127.0.0.1:18080) | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 11 |
| 12 | 2026-11-04 21:08:06.697 UTC | 2 | ::1:52004 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | selection-probe (inferred) | byte-signature: small, short-lived | 205 | 242 | client-close (conn_close) | diverter.jsonl conn 12 |
| 13 | 2026-11-04 21:08:06.701 UTC | 0 | ::1:52020 | localhost:9090 | A (127.0.0.1:18080) | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 13 |
| 14 | 2026-11-04 21:08:06.701 UTC | 1 | ::1:52036 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | selection-probe (inferred) | byte-signature: small, short-lived | 187 | 243 | client-close (conn_close) | diverter.jsonl conn 14 |
| 15 | 2026-11-04 21:08:06.706 UTC | 0 | ::1:52042 | localhost:9090 | A (127.0.0.1:18080) | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 15 |
| 16 | 2026-11-04 21:08:06.706 UTC | 2 | ::1:52050 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | selection-probe (inferred) | byte-signature: small, short-lived | 194 | 242 | client-close (conn_close) | diverter.jsonl conn 16 |
| 17 | 2026-11-04 21:08:06.711 UTC | 0 | ::1:52060 | localhost:9090 | A (127.0.0.1:18080) | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 17 |
| 18 | 2026-11-04 21:08:06.712 UTC | 2 | ::1:52068 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | selection-probe (inferred) | byte-signature: small, short-lived | 175 | 242 | client-close (conn_close) | diverter.jsonl conn 18 |
| 19 | 2026-11-04 21:08:06.716 UTC | 0 | ::1:52084 | localhost:9090 | A (127.0.0.1:18080) | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 19 |
| 20 | 2026-11-04 21:08:06.716 UTC | 1 | ::1:52094 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | selection-probe (inferred) | byte-signature: small, short-lived | 221 | 241 | client-close (conn_close) | diverter.jsonl conn 20 |
| 21 | 2026-11-04 21:08:06.723 UTC | 0 | undefined:undefined | localhost:9090 | — | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 21 |
| 22 | 2026-11-04 21:08:06.723 UTC | 3 | ::1:52108 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | selection-probe (inferred) | byte-signature: small, short-lived | 320 | 318 | client-close (conn_close) | diverter.jsonl conn 22 |
| 23 | 2026-11-04 21:08:06.725 UTC | 15543 | ::1:52122 | localhost:9090 | B (127.0.0.1:8080) | plaintext-HI | F6950B35-BD96-41CD-A492-5A23AE9B494A | packet-loss-accounting | observed command | 56 | 63 | client-close (conn_close) | diverter.jsonl conn 23 |
| 24 | 2026-11-04 21:08:06.726 UTC | 15031 | ::1:52124 | localhost:9090 | B (127.0.0.1:8080) | encrypted-binary-hello → plaintext fallback | F6950B35-BD96-41CD-A492-5A23AE9B494A | download-worker | observed command | 2439 | 4099210837 | client-close (conn_close) | diverter.jsonl conn 24 |
| 25 | 2026-11-04 21:08:06.726 UTC | 15031 | ::1:52138 | localhost:9090 | B (127.0.0.1:8080) | encrypted-binary-hello → plaintext fallback | F6950B35-BD96-41CD-A492-5A23AE9B494A | download-worker | observed command | 2926 | 4992309033 | client-close (conn_close) | diverter.jsonl conn 25 |
| 26 | 2026-11-04 21:08:06.729 UTC | 15027 | ::1:52150 | localhost:9090 | B (127.0.0.1:8080) | encrypted-binary-hello → plaintext fallback | F6950B35-BD96-41CD-A492-5A23AE9B494A | download-worker | observed command | 2811 | 4799718838 | client-close (conn_close) | diverter.jsonl conn 26 |
| 27 | 2026-11-04 21:08:06.730 UTC | 15026 | ::1:52154 | localhost:9090 | B (127.0.0.1:8080) | encrypted-binary-hello → plaintext fallback | F6950B35-BD96-41CD-A492-5A23AE9B494A | download-worker | observed command | 2034 | 3391850228 | client-close (conn_close) | diverter.jsonl conn 27 |
| 28 | 2026-11-04 21:08:06.730 UTC | 18067 | ::1:52162 | localhost:9090 | B (127.0.0.1:8080) | encrypted-binary-hello → plaintext fallback | F6950B35-BD96-41CD-A492-5A23AE9B494A | ping-monitor | observed command | 4882 | 5712 | client-close (conn_close) | diverter.jsonl conn 28 |
| 29 | 2026-11-04 21:08:21.760 UTC | 10986 | ::1:48944 | localhost:9090 | B (127.0.0.1:8080) | plaintext-HI | F6950B35-BD96-41CD-A492-5A23AE9B494A | upload-control | observed command | 77 | 93 | client-close (conn_close) | diverter.jsonl conn 29 |
| 30 | 2026-11-04 21:08:21.761 UTC | 11015 | ::1:48954 | localhost:9090 | B (127.0.0.1:8080) | plaintext-HI | F6950B35-BD96-41CD-A492-5A23AE9B494A | ping-monitor | observed command | 3528 | 4186 | client-close (conn_close) | diverter.jsonl conn 30 |
| 31 | 2026-11-04 21:08:21.762 UTC | 10998 | ::1:48960 | localhost:9090 | B (127.0.0.1:8080) | plaintext-HI | F6950B35-BD96-41CD-A492-5A23AE9B494A | upload-worker | observed HI <UUID> + byte-signature GB-scale cli→backend (perintah UPLOAD menyatu dgn payload acak dlm satu chunk non-printable) | 2492976603 | 2046 | client-close (conn_close) | diverter.jsonl conn 31 |
| 32 | 2026-11-04 21:08:21.762 UTC | 10984 | ::1:48968 | localhost:9090 | B (127.0.0.1:8080) | plaintext-HI | F6950B35-BD96-41CD-A492-5A23AE9B494A | upload-worker | observed HI <UUID> + byte-signature GB-scale cli→backend (perintah UPLOAD menyatu dgn payload acak dlm satu chunk non-printable) | 1818132543 | 1500 | client-close (conn_close) | diverter.jsonl conn 32 |
| 33 | 2026-11-04 21:08:21.762 UTC | 10994 | ::1:48972 | localhost:9090 | B (127.0.0.1:8080) | plaintext-HI | F6950B35-BD96-41CD-A492-5A23AE9B494A | upload-worker | observed HI <UUID> + byte-signature GB-scale cli→backend (perintah UPLOAD menyatu dgn payload acak dlm satu chunk non-printable) | 2307522623 | 1916 | client-close (conn_close) | diverter.jsonl conn 33 |
| 34 | 2026-11-04 21:08:21.762 UTC | 10998 | ::1:48976 | localhost:9090 | B (127.0.0.1:8080) | plaintext-HI | F6950B35-BD96-41CD-A492-5A23AE9B494A | upload-worker | observed HI <UUID> + byte-signature GB-scale cli→backend (perintah UPLOAD menyatu dgn payload acak dlm satu chunk non-printable) | 2144000040 | 1786 | client-close (conn_close) | diverter.jsonl conn 34 |

## Endpoint UDP (3)

| klien | backend | datagram cli→be | balasan be→cli |
|---|---|---|---|
| ::1:39067 | B (127.0.0.1:8080) | 299 | 299 |
| ::1:47221 | B (127.0.0.1:8080) | 299 | 0 |
| ::1:54124 | B (127.0.0.1:8080) | 218 | 218 |

> Fase koneksi terenkripsi dilabel **(inferred)** dan basisnya byte-signature — perintah TIDAK diinfer dari payload terenkripsi (master prompt §11). Fase koneksi plaintext berbasis perintah teramati langsung.

(CSV mesin-terbaca: ../evidence/f5-n22-r3/timeline.csv)
