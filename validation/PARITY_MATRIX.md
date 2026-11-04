# PARITY_MATRIX — official daemon vs TypeScript SpeedtestServer (v6.0 §15 canonical index)

Detail sources: `PROTOCOL_CONTRACT.md` (per-command contract, the single
source of truth), `DIFFERENTIAL_MATRIX.md` + `evidence/gate-revision2/probe-*.json`
(37-probe differential), `HOST_TESTER_COMPARISON.md`, `TEST_MATRIX.md`.
This file is the v6.0 canonical parity summary. Scope statement: parity is
claimed ONLY for the verified compatibility profile (below) — it is not
Ookla certification, not host-network admission, and not internal
source-code identity.

## Bottom line (re-verified this revision against the reference daemon)

- **Differential probes: 35/37 byte-identical** — the 2 differences are the
  documented expected non-differences (PONG timestamp, random DOWNLOAD
  payload prefix). `evidence/gate-revision2/differential-summary.json`.
- **Host tester v1.1.0: 10/10 PASS** on both servers, identical verdict
  strings. `evidence/gate-revision2/host-tester-10of10.txt`.
- **Genuine official CLI 1.2.0.84 → SpeedtestServer: 3/3 gates PASS**
  (exit 0, full latency+download+upload, packetLoss 0, non-publishing).
  `evidence/gate-revision2/gate-r{1,2,3}-*.json`.

## Capability matrix

| Capability | Reference daemon 2.11.5.2 | SpeedtestServer (TS) | Parity | Evidence |
|---|---|---|---|---|
| Native NetGauge TCP (HI/HELLO, GETIP, CAPABILITIES, SERVERID, UPTIME, PING/PONG, DOWNLOAD, UPLOAD, INITPLOSS/PLOSS, QUIT, ERROR) | ✔ | ✔ (`NetGaugeEngine`, plaintext + ERROR-trigger for the CLI's encrypted-binary fallback) | **byte-identical** (probes; CLI completes full tests) | differential, gates |
| Native NetGauge over TLS (same port) | ✔ | ✔ (multiplexed per connection) | identical | probes, T1 |
| WebSocket `/ws` + WSS (NetGauge framing, HELLO no-newline quirk, binary DOWNLOAD frames) | ✔ | ✔ (same engine over WS) | identical | host tester 10/10 |
| UDP packet loss (LOSS 4/5-field, RECV, PLOSS accounting) | ✔ | ✔ (`UdpLossEngine`, anti-spoof session binding) | CLI packetLoss 0 on loopback | gates, battery |
| HTTP legacy surface (`/`, `/hi`, `latency.txt`, `crossdomain.xml`, `random{N}x{N}.jpg` 14-size map, `upload.php` size echo, 404-empty-close, UA-less→500, CORS reflection, keep-alive, security headers) | ✔ | ✔ (`HttpApi`) | byte-identical | probes 35/37 |
| TLS floors (TLSv1.0/1.1 rejected; 1.2/1.3 accepted; configurable via minimumTLSProtocol) | ✔ | ✔ (§9 verified this revision) | identical | probes, T3 |
| Single-port multiplexing model (TCP+TLS+HTTP+WS+UDP on the same ports) | ✔ | ✔ (`ServerCore`) | identical | host tester, gates |
| Strict HTTPS trust semantics (chain, hostname, expiry, key match; self-signed rejected) | ✔ | ✔ (§10 battery 10/10; negative cases fail as required) | identical semantics | TLS battery |
| Custom certificate precedence + hot reload | ✔ (reload behavior not externally observable in lab) | ✔ (§9.2/§9.7: watcher, validated swap, last-valid preserved) | **superset** (documented) | T2 |
| Automatic certificate provisioning | host-management (no public contract) | standard ACME (Let's Encrypt, HTTP-01), fail-closed | **independent equivalent**, not vendor parity (documented §8) | N6/N7 + code |
| Encrypted-binary engine protocol | ✔ | ✖ (planned ERROR → documented plaintext fallback) | **documented deviation (D-2)** — fallback verified 3/3 | FINDINGS F-1 |
| `userAgentFilterEnabled` bad-UA blocklist (11 patterns, 500-with-Date form, default off) | ✔ | ✔ (rev 5, `HttpApi` step 3.5) | **0 mismatches** (21-UA battery, per-variant differential) | FINDINGS F-26, `rea-lab-rev5` |
| `websocket.frameSizeLimitBytes` (default 5242880; >limit → silent RST) | ✔ | ✔ (rev 5, FrameGuard + ws maxPayload) | **0 mismatches** (boundary probes 63/64/65/4096 at limit 64; 5242880/5242881 at default) | FINDINGS F-27, `rea-lab-rev5` |
| useIPv4/useIPv6 per-family listeners (TCP + UDP) | ✔ | ✔ (rev 5, per-family binds, `[::]` V6ONLY) | **identical listener inventories** | FINDINGS F-29, `rea-lab-rev5` |
| `addresses` explicit bind list | ✔ (broken: never binds listed v4; kills v4 wildcard) | ✔ (documented intent — deviation D-9) | **intentional deviation** (the daemon's own handling is defective) | FINDINGS F-28, DECISIONS D-9 |
| Result submission / public Result URL generation | client↔Ookla service (server not involved) | server makes zero outbound connections | **by-design non-goal** | EXTERNAL_FLOWS.md |
| Host telemetry / traceroute / auto-update / host registration | ✔ (proprietary) | decommissioned | **by-design non-goal** (RULE 4) | DECISIONS.md |
| Throughput on loopback | ~3× Node single-thread | 18–22 Gbps DL / 12–15 Gbps UL | informational (not a parity gate) | PERFORMANCE_REPORT.md |

## Verified compatibility profile (the 1:1 claim boundary)

Official OoklaServer 2.11.5.2 observable behavior, exercised by: the genuine
Speedtest CLI 1.2.0.84 (plaintext fallback path), NetGauge clients, the
HTTP/WS legacy surface, UDP loss protocol, TLSv1.2+ with strict validation —
on Debian 13, unprivileged, single host. Anything outside this profile is
documented as deviation, decommissioned, or BLOCKED — never silently claimed.
