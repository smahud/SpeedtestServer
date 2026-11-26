| Run | Backend | Exit | DL Mbps | DL MB (cli) | DL dari Worker | UL Mbps | UL MB (cli) | UL ke Worker | Receipts | Ping ms | persisted |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| b0-daemon-baseline | daemon (produksi) | 0 | 451.7 | 519.2 | 0% (daemon) | 164.8 | 213.9 | 0% (daemon) | n/a | 61.2 | False |
| b1-local-1 | bridge local | 0 | 454.5 | 639.0 | 0.0% (0.0 MB) | 158.8 | 179.4 | 0.0% (0.0 MB) | 0 | 63.4 | False |
| b2-wh-1 | bridge worker-http (v1) | 0 | 419.5 | 572.7 | 103.7% (594.1 MB) | 147.6 | 181.9 | 0.0% (0.1 MB) | 4 | 64.1 | False |
| b2-wh-2 | bridge worker-http (v2, bug mint) | 2 | 0.0 | — | 0% (710.1 MB) | 0.0 | — | 0% (107.5 MB) | 26 | 0 | None |
| b2-wh-3 | bridge worker-http | 0 | 416.3 | 630.1 | 104.2% (656.7 MB) | 133.2 | 223.6 | 97.8% (218.7 MB) | 54 | 60.0 | False |
| b2-wh-4 | bridge worker-http | 0 | 431.3 | 462.0 | 103.2% (476.8 MB) | 118.4 | 201.6 | 96.8% (195.1 MB) | 48 | 60.5 | False |
| b3-ww-1 | bridge worker-ws (v1, bug UL cmd) | 0 | 448.8 | 577.0 | 107.0% (617.4 MB) | 134.4 | 238.1 | 101.0% (240.6 MB) | 0 | 64.1 | False |
| b3-ww-2 | bridge worker-ws | 0 | 436.6 | 704.8 | 106.2% (748.4 MB) | 177.3 | 154.5 | 102.5% (158.4 MB) | 2 | 59.9 | False |
| b4-restore-verify | daemon (dipulihkan) | 0 | 462.1 | 523.4 | 0% (daemon) | 160.3 | 205.2 | 0% (daemon) | n/a | 65.9 | False |
