# SECURITY_AUDIT — canonical implementation

Scope: the code that actually runs (`ServerCore`, `NetGaugeEngine`,
`UdpLossEngine`, `HttpApi`, `OoklaServer`, `bin`, `ConfigManager`).
The decommissioned legacy modules (`OoklaRequestHandler`, `TLSCertificateManager`
ACME path, `BinaryManager`, `MetricsUploader`, `TracerouteManager`) are not
instantiated by the server; their historical defects are recorded in
`FINDINGS.md` (P1-6/P1-7).

## Validated mitigations

| Risk | Mitigation | Verification |
|---|---|---|
| Unbounded request bodies | HTTP upload.php cap 512 MiB → 413 + destroy; streamed consumption (never fully buffered for NetGauge) | negative test #6; code paths stream |
| Oversized command lines | 1 MiB cap → connection dropped | negative test #2 |
| Oversized HTTP headers | 64 KiB cap (Node parser + explicit check) | negative test #6 |
| Slowloris / idle sockets | per-connection idle timeout (configurable, default 1 h; harness used 1 h) | timeout wiring in `ServerCore`; future work: tighter default |
| Memory exhaustion via concurrent allocations | download data served from one 2 MiB startup pool; uploads consumed as a stream; per-IP + global connection caps (500/4096 defaults) | counters + negative suite |
| TLS abuse | TLS 1.2 floor; malformed handshakes cannot crash the loop | negative tests #4; probe battery |
| UDP spoofing / amplification | LOSS sessions bound to the sender IP; mismatches dropped; replies are 1-line (tiny) — no amplification vector | LossRegistry unit tests (anti-spoof case) |
| Credential leakage | **zero outbound connections** in the server; no secrets logged; generated key written 0600 under `certs/` | code review; startup log |
| Unsafe auto-update / telemetry | decommissioned entirely (D-5) | no update code in the live path |
| Root-only paths | none; runs unprivileged; self-signed certs generated into `./certs` | ran as uid 1001 all session |

## Residual risks (documented, accepted)

1. **Plaintext protocol by design** — the compatibility profile is unencrypted
   NetGauge; a hostile network can read/modify test traffic. Same is true of
   the reference daemon's legacy path; TLS-wrapped transport is available on
   the same port for clients that negotiate it (HTTPS/WSS verified).
2. **Permissive ploss session registration** (D-3) lets any host *count* packets
   for a fresh UUID; spoofing a *known* UUID from another IP is still dropped.
   Loopback/lab acceptable; operators can tighten by requiring announced UUIDs.
3. **Idle timeout default** is generous (1 h, daemon parity
   `maxConnectionSeconds=3600`); operators should lower it for hostile
   environments.
4. `allowedDomains`/`userAgentFilterEnabled` config keys are accepted but not
   enforced in the canonical server (the UA-less-500 core behavior is
   implemented). Future work; noted in HANDOFF.

## Compliance with the assignment's safety boundary

- No authentication or licensing bypass; no Ookla endpoints contacted at
  runtime; no production identity impersonation (lab targeting only rewrites
  connection targets, keeping genuine ids/names, and blocks result
  submission); no system DNS/cert changes (all user-space env vars and CLI
  flags); no proprietary assets committed.
