# TEST_MATRIX — acceptance levels (MASTER PROMPT §19)

| Level | Requirement | Status | Evidence |
|---|---|---|---|
| **1 — Server starts correctly** | listener ownership, TCP/UDP binds, clean start/stop, no silent bind failures | **PASS** | startup logs (dual-stack 8080/5060 TCP+UDP), `ss -tlnp` ownership, fail-closed bind code; server runs unprivileged |
| **2 — Host Tester compatibility** | endpoints, status codes, bodies, headers, TLS, NetGauge/WS, download/upload diagnostics | **PASS 10/10** (identical to reference) | `HOST_TESTER_COMPARISON.md`, `DIFFERENTIAL_MATRIX.md` |
| **3 — Genuine Speedtest CLI compatibility** ★ | real client, real session, latency+download+upload complete, correct exit, structured result, no hidden daemon, no result pollution | **PASS 3/3 runs** | `OFFICIAL_CLI_RESULTS.md`, `evidence/OFFICIAL_CLI_TO_SPEEDTESTSERVER.json` |
| **4 — Negative testing** | invalid protocol messages, unsupported endpoints, TLS errors, abrupt disconnects, invalid config, oversized data, partial transfers, timeouts, cancellation | **PASS 7/7** | `evidence/negative-tests.json` |
| **5 — Performance & stability** | repeatable sessions, bounded resources, no leaks under sustained load | **PASS (bounded)** | `PERFORMANCE_REPORT.md` — 3 CLI runs (≈63 GB down / ≈55 GB up total), 17.5 GB host-tester traffic, counters return to idle, RSS stable |
| **6 — Release readiness** | independent deployment, documented config, reproducible build, automated regression, licensing disclosures, handoff | **PASS (see §23 caveats)** | `REPRODUCE.md`, `HANDOFF.md`, `FINAL_REPORT.md`, README |

## Automated suites

| Suite | Count | Status |
|---|---|---|
| Unit/protocol conformance (`npm test`, jest) | 44 | **44/44 PASS** (incl. 13-command NetGauge contract, UDP registry, multiplexer integration, HTTP parity) |
| Negative battery | 7 | 7/7 PASS |
| Differential probe battery | 37 | 35 identical + 2 expected non-differences |
| Official CLI gates | 6 runs | 6/6 exit 0 (3 baseline + 3 replacement) |

A passing unit suite never overrides the real-client suite; the real-client
gate is the primary criterion, and it passed.
