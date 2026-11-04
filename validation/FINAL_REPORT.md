# FINAL_REPORT — audit/official-cli-interoperability (2026-11-04)

Scope: MASTER PROMPT v3.0 (SpeedtestServer interoperability, differential
validation, autonomous remediation, open-source production readiness).

## A. Repository state

- Baseline: `master` @ `f3ea41cdd2bb8b6ea7dff7b4bb552d7455710bf8`
- Deliverable branch: **`audit/official-cli-interoperability`** (this tree)
- Canonical implementation: `reverse-engineered/typescript` — new core
  `ServerCore.ts`, `NetGaugeEngine.ts`, `UdpLossEngine.ts`, `HttpApi.ts`,
  rewritten `OoklaServer.ts` and `bin/ooklaserver.ts` (+ fixes in
  `ConfigManager`/types). JavaScript twin: deprecated, frozen.
- Implementation commit: see `git log` (first commit on the branch);
  this documentation commit adds the validation package on top.

## B. Architecture

Original defects (verified): competing HTTP/HTTPS listeners on 8080 with
swallowed EADDRINUSE, **no native protocol at all**, WS random-bytes, UDP
blind echo, root-only paths, JSON-mangled bodies, mock subsystems, outbound
`rejectUnauthorized:false` — see `FINDINGS.md` (7 P0/P1 entries + 7 new
reference-behavior discoveries).
Corrected design: single-port multiplexing (TLS/HTTP/WS/NetGauge per
connection), fail-closed binds, one engine shared by three transports,
byte-parity HTTP surface, UDP LOSS/RECV with anti-spoof session binding,
built-in JSONL evidence logging — `ARCHITECTURE_TARGET.md`.

## C. Official binary reference

OoklaServer 2.11.5.2 `2026-06-04.1737.7d0993d`, tarball sha256
`ce180aa3…598159` (current stable; the prompt's previously recorded
`f19e5ed2…` artifact is preserved as a *separate* historical baseline and all
2026-11-04 evidence is labeled with the current one). Official CLI 1.2.0.84,
tarball sha256 `5690596c…cfeeb7`, unmodified. No vendor binaries committed.
`REFERENCE_BINARY_MANIFEST.md`.

## D. Differential validation

Probe battery: **35/37 byte-identical**, 2 expected non-differences (PONG
timestamp, random payload). Host tester v1.1.0: **10/10 on both servers**.
`DIFFERENTIAL_MATRIX.md`, `evidence/diff-probe-*.json`.

## E. Genuine Speedtest CLI cross-validation ★

`OFFICIAL_CLI_RESULTS.md` + machine-readable gate files:

| Path | Outcome |
|---|---|
| Official CLI → official OoklaServer | 3 runs, exit 0 (direct runs loss 0; the one relayed run documents the relay-NAT UDP artifact, A-2) |
| Official CLI → **SpeedtestServer** | **3/3 exit 0 · ping 0.033–0.047 ms · download 18.4–21.7 Gbps (24.56 GB on the gate run) · upload 13.6–15.7 Gbps (18.95 GB) · packetLoss 0 · persisted=false** |
| Official CLI → SpeedtestServer, **publishing opt-in** | 9 runs / 6 distinct server IDs, all exit 0, `persisted=true`, each returning a **genuine public Result URL** (spot-verified against the live result pages) — `PUBLISHED_RESULT_URLS.md` |

Destination proof: `server.host=localhost`, `server.ip=::1`, port owned by
`node dist/bin/ooklaserver.js` (pid recorded pre-run); all daemon processes
verified absent. Server-side corroboration: SpeedtestServer's own evidence
log shows 23 NetGauge sessions / 1,883 commands / **24,651,035,453 B sent /
19,107,443,639 B received**, matching the client-reported volumes. Non-publishing:
`persisted:false` + submission endpoint refused at the proxy (logged), every run.

## F. Host tester cross-validation

10/10 both servers, identical verdict strings — `HOST_TESTER_COMPARISON.md`.

## G. Remaining compatibility gaps

| Gap | Severity | Blocks replacement objective? |
|---|---|---|
| Encrypted-binary engine protocol not implemented (plaintext fallback used instead) | Low (fallback verified 3/3; documented D-2) | **No** — for the verified client profile |
| `allowedDomains`/`userAgentFilterEnabled` not enforced (keys parsed) | Low | No (lab/standalone profile) |
| Traceroute/metrics/auto-update decommissioned | Intentional | No |
| Throughput ~30–37% of native daemon on loopback (single-threaded Node) | Informational | No (assignment §15) |

## H. Security & performance

`SECURITY_AUDIT.md` (validated mitigations + 4 documented residual risks),
`PERFORMANCE_REPORT.md` (stability over ~118 GB of gate+diagnostic traffic;
backpressure-aware streaming; no leak trend).

## I. Automated tests

Unit/protocol conformance: **44/44** (jest). Negative battery: **7/7**.
Differential probes: 37 (35 identical/2 expected). Official CLI gates: **6/6
exit 0** (3 baseline + 3 replacement). Mocks never substitute the mandatory
real-client runs.

## J. Git delivery

- Branch `audit/official-cli-interoperability`, coherent commits
  (implementation → validation/docs → multi-server Result-URL battery).
  `master` untouched.
- Push: executed at delivery time (2026-11-04) with owner-supplied
  credentials; the audit environment itself holds none. A **git bundle**
  with the full branch is also exported for archival (`download/`).
- No proprietary binaries or credentials are included anywhere.

## K. Release verdict

### **CONDITIONAL PASS — VERIFIED STANDALONE REPLACEMENT PROFILE**

All mandatory gates verified with independent evidence: server launches
standalone (unprivileged), full native protocol functions (TCP + TLS-wrapped +
WS + UDP), host-tester parity 10/10, **the unmodified official CLI completes
the authorized test against SpeedtestServer with the official daemon absent
(3/3, packetLoss 0, non-publishing)**, security findings remediated,
reproducible build + harness. "Conditional" reflects the documented residual
items in §G (none of which blocks the verified profile) per MASTER PROMPT §23.
This is **not** Ookla certification, **not** server-network admission, and
applies only to the verified compatibility profile.

## L. Future-session handoff

`HANDOFF.md` (self-contained: re-verify steps, ordered next steps, knowledge
map). `REPRODUCE.md` reproduces every claim from a clean checkout.
