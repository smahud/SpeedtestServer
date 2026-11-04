# TIMELINE — f5-n28 (generator: gen-timeline.mjs)

Policy: `firstN:A:28` | UDP→A | diverter :9090 | A=127.0.0.1:18080 (official) | B=127.0.0.1:8080 (SpeedtestServer TS)

- **Config fetch**: 2026-11-04 21:32:27.507 UTC — GET /api/cli/config?deviceId=REDACTED&hid=REDACTED&sid=R… via lab proxy (MITM lab-CA) → served live-curl, 2953 B, semua servers[] → localhost:9090
- **Non-publishing**: results.speedtest.net:443 DITOLAK proxy (403) → CLI `persisted:false`
- **Hasil CLI**: exit=0 type=result | latency 0.092 ms | DL 18.01 GB | UL 7.39 GB | packetLoss 0 | result.id=b12a743a-fbb8-4624-89a3-a830cd88e627
- **UUID sesi**: b12a743a-fbb8-4624-89a3-a830cd88e627 (diumumkan winner-probe & dipakai semua koneksi pasca-seleksi)

## Koneksi TCP (34)

| # | mulai (UTC) | dur (ms) | sumber CLI | gateway | backend aktual | handshake | UUID sesi | fase | basis fase | c→b (B) | b→c (B) | penutupan | evidence |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 2026-11-04 21:32:27.777 UTC | 3 | undefined:undefined | localhost:9090 | — | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 1 |
| 2 | 2026-11-04 21:32:27.778 UTC | 6 | ::1:38608 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | selection-probe (inferred) | byte-signature: small, short-lived | 193 | 258 | client-close (conn_close) | diverter.jsonl conn 2 |
| 3 | 2026-11-04 21:32:27.786 UTC | 1 | ::1:38620 | localhost:9090 | A (127.0.0.1:18080) | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 3 |
| 4 | 2026-11-04 21:32:27.787 UTC | 1 | ::1:38628 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | selection-probe (inferred) | byte-signature: small, short-lived | 175 | 257 | client-close (conn_close) | diverter.jsonl conn 4 |
| 5 | 2026-11-04 21:32:27.790 UTC | 1 | ::1:38636 | localhost:9090 | A (127.0.0.1:18080) | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 5 |
| 6 | 2026-11-04 21:32:27.791 UTC | 1 | ::1:38652 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | selection-probe (inferred) | byte-signature: small, short-lived | 191 | 258 | client-close (conn_close) | diverter.jsonl conn 6 |
| 7 | 2026-11-04 21:32:27.794 UTC | 1 | ::1:38668 | localhost:9090 | A (127.0.0.1:18080) | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 7 |
| 8 | 2026-11-04 21:32:27.795 UTC | 2 | ::1:38670 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | selection-probe (inferred) | byte-signature: small, short-lived | 191 | 260 | client-close (conn_close) | diverter.jsonl conn 8 |
| 9 | 2026-11-04 21:32:27.798 UTC | 1 | ::1:38678 | localhost:9090 | A (127.0.0.1:18080) | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 9 |
| 10 | 2026-11-04 21:32:27.799 UTC | 2 | ::1:38686 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | selection-probe (inferred) | byte-signature: small, short-lived | 213 | 257 | client-close (conn_close) | diverter.jsonl conn 10 |
| 11 | 2026-11-04 21:32:27.801 UTC | 0 | ::1:38694 | localhost:9090 | A (127.0.0.1:18080) | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 11 |
| 12 | 2026-11-04 21:32:27.802 UTC | 2 | ::1:38710 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | selection-probe (inferred) | byte-signature: small, short-lived | 175 | 259 | client-close (conn_close) | diverter.jsonl conn 12 |
| 13 | 2026-11-04 21:32:27.805 UTC | 0 | ::1:38714 | localhost:9090 | A (127.0.0.1:18080) | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 13 |
| 14 | 2026-11-04 21:32:27.806 UTC | 1 | ::1:38730 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | selection-probe (inferred) | byte-signature: small, short-lived | 212 | 258 | client-close (conn_close) | diverter.jsonl conn 14 |
| 15 | 2026-11-04 21:32:27.809 UTC | 1 | ::1:38736 | localhost:9090 | A (127.0.0.1:18080) | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 15 |
| 16 | 2026-11-04 21:32:27.810 UTC | 2 | ::1:38750 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | selection-probe (inferred) | byte-signature: small, short-lived | 201 | 260 | client-close (conn_close) | diverter.jsonl conn 16 |
| 17 | 2026-11-04 21:32:27.814 UTC | 0 | ::1:38758 | localhost:9090 | A (127.0.0.1:18080) | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 17 |
| 18 | 2026-11-04 21:32:27.815 UTC | 2 | ::1:38774 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | selection-probe (inferred) | byte-signature: small, short-lived | 195 | 259 | client-close (conn_close) | diverter.jsonl conn 18 |
| 19 | 2026-11-04 21:32:27.818 UTC | 0 | ::1:38784 | localhost:9090 | A (127.0.0.1:18080) | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 19 |
| 20 | 2026-11-04 21:32:27.819 UTC | 2 | ::1:38790 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | selection-probe (inferred) | byte-signature: small, short-lived | 198 | 259 | client-close (conn_close) | diverter.jsonl conn 20 |
| 21 | 2026-11-04 21:32:27.825 UTC | 0 | undefined:undefined | localhost:9090 | — | none | — | zero-byte (no data) | observed (0 bytes both ways) | 0 | 0 | client-close (conn_close) | diverter.jsonl conn 21 |
| 22 | 2026-11-04 21:32:27.825 UTC | 2 | ::1:38816 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | selection-probe (inferred) | byte-signature: small, short-lived | 318 | 358 | client-close (conn_close) | diverter.jsonl conn 22 |
| 23 | 2026-11-04 21:32:27.827 UTC | 12035 | ::1:38824 | localhost:9090 | A (127.0.0.1:18080) | plaintext-HI | B12A743A-FBB8-4624-89A3-A830CD88E627 | packet-loss-accounting | observed command | 56 | 63 | client-close (conn_close) | diverter.jsonl conn 23 |
| 24 | 2026-11-04 21:32:27.828 UTC | 11536 | ::1:38830 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | download-worker (inferred) | byte-signature: GB-scale backend→cli | 5399 | 3618946807 | client-close (conn_close) | diverter.jsonl conn 24 |
| 25 | 2026-11-04 21:32:27.829 UTC | 11532 | ::1:38838 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | download-worker (inferred) | byte-signature: GB-scale backend→cli | 7890 | 5461953836 | client-close (conn_close) | diverter.jsonl conn 25 |
| 26 | 2026-11-04 21:32:27.829 UTC | 11537 | ::1:38850 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | download-worker (inferred) | byte-signature: GB-scale backend→cli | 6906 | 4736000071 | client-close (conn_close) | diverter.jsonl conn 26 |
| 27 | 2026-11-04 21:32:27.829 UTC | 11538 | ::1:38854 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | download-worker (inferred) | byte-signature: GB-scale backend→cli | 6392 | 4289833594 | client-close (conn_close) | diverter.jsonl conn 27 |
| 28 | 2026-11-04 21:32:27.830 UTC | 14568 | ::1:38868 | localhost:9090 | A (127.0.0.1:18080) | encrypted-binary-hello (byte pertama diperiksa gateway) | (not observable — encrypted) | ping-monitor (inferred) | byte-signature: KB-scale, long-lived, spans a load phase | 10092 | 11007 | client-close (conn_close) | diverter.jsonl conn 28 |
| 29 | 2026-11-04 21:32:39.361 UTC | 8882 | ::1:56586 | localhost:9090 | B (127.0.0.1:8080) | encrypted-binary-hello → plaintext fallback | B12A743A-FBB8-4624-89A3-A830CD88E627 | upload-worker | observed HI <UUID> + byte-signature GB-scale cli→backend (perintah UPLOAD menyatu dgn payload acak dlm satu chunk non-printable) | 2017228564 | 1688 | client-close (conn_close) | diverter.jsonl conn 29 |
| 30 | 2026-11-04 21:32:39.363 UTC | 8921 | ::1:56602 | localhost:9090 | B (127.0.0.1:8080) | encrypted-binary-hello → plaintext fallback | B12A743A-FBB8-4624-89A3-A830CD88E627 | upload-worker | observed HI <UUID> + byte-signature GB-scale cli→backend (perintah UPLOAD menyatu dgn payload acak dlm satu chunk non-printable) | 1600000098 | 1324 | client-close (conn_close) | diverter.jsonl conn 30 |
| 31 | 2026-11-04 21:32:39.365 UTC | 8901 | ::1:56614 | localhost:9090 | B (127.0.0.1:8080) | encrypted-binary-hello → plaintext fallback | B12A743A-FBB8-4624-89A3-A830CD88E627 | upload-worker | observed HI <UUID> + byte-signature GB-scale cli→backend (perintah UPLOAD menyatu dgn payload acak dlm satu chunk non-printable) | 1792000105 | 1506 | client-close (conn_close) | diverter.jsonl conn 31 |
| 32 | 2026-11-04 21:32:39.365 UTC | 8878 | ::1:56628 | localhost:9090 | B (127.0.0.1:8080) | encrypted-binary-hello → plaintext fallback | B12A743A-FBB8-4624-89A3-A830CD88E627 | upload-control | observed command | 140 | 99 | client-close (conn_close) | diverter.jsonl conn 32 |
| 33 | 2026-11-04 21:32:39.367 UTC | 8917 | ::1:56630 | localhost:9090 | B (127.0.0.1:8080) | encrypted-binary-hello → plaintext fallback | B12A743A-FBB8-4624-89A3-A830CD88E627 | ping-monitor | observed command | 2909 | 3375 | client-close (conn_close) | diverter.jsonl conn 33 |
| 34 | 2026-11-04 21:32:39.370 UTC | 8914 | ::1:56646 | localhost:9090 | B (127.0.0.1:8080) | encrypted-binary-hello → plaintext fallback | B12A743A-FBB8-4624-89A3-A830CD88E627 | upload-worker | observed HI <UUID> + byte-signature GB-scale cli→backend (perintah UPLOAD menyatu dgn payload acak dlm satu chunk non-printable) | 2112000111 | 1740 | client-close (conn_close) | diverter.jsonl conn 34 |

## Endpoint UDP (3)

| klien | backend | datagram cli→be | balasan be→cli |
|---|---|---|---|
| ::1:44728 | A (127.0.0.1:18080) | 229 | 0 |
| ::1:50291 | A (127.0.0.1:18080) | 230 | 0 |
| ::1:35385 | A (127.0.0.1:18080) | 176 | 0 |

> Fase koneksi terenkripsi dilabel **(inferred)** dan basisnya byte-signature — perintah TIDAK diinfer dari payload terenkripsi (master prompt §11). Fase koneksi plaintext berbasis perintah teramati langsung.

(CSV mesin-terbaca: ../evidence/f5-n28/timeline.csv)
