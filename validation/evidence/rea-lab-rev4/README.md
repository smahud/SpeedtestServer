# REA-Lab Revision 4 — live differential evidence (2026-11-04)

Setup: the official `OoklaServer-linux-x86_64` daemon (2.11.5.2) running
live next to the SpeedtestServer build on the same machine — daemon on
TCP/UDP 18080, SpeedtestServer on TCP/UDP 18081 — with identical lab
certificates (CN=cnhost.local, SANs: san1.local, san2.local, 10.1.2.3) and
identical `OoklaServer.allowedDomains = *.example.org`.

Contents:
- `probe-diff-results.json` — the 103-case differential battery
  (netgauge-tcp / http / tls / ws / udp), run with
  `node probe-diff.mjs 18080 18081` (see `validation/harness/probe-diff.mjs`).
  Result after remediation: 89 raw byte-identical; 6 expected non-differences
  (timestamps, random payload content, own listening port); 8 documented
  deviations (D-2/D-3 + the unbounded-DOWNLOAD safety refusal).
- The focused follow-up probes (DOWNLOAD hex structure, HI/GETIP/PING/UPLOAD
  edge matrices, pre-session gate, CRLF tolerance, "three strikes",
  Host/SAN and Origin experiments) are summarized in `validation/FINDINGS.md`
  F-8…F-25; `validation/harness/probe-round2.mjs` is the reproduction script.

Notes for reproduction: the daemon requires a properties file with
`OoklaServer.enableAutoUpdate = false` and the same cert pair; the
certificate's SAN list defines the HTTP Host allow-list (see F-16), so both
servers must run the SAME certificate for byte-comparable HTTP results.
