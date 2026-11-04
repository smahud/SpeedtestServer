# CLIENT_INTEROPERABILITY — what works with what

## Verified with first-hand evidence (2026-11-04)

| Client | Transport | Result |
|---|---|---|
| **Official Speedtest CLI 1.2.0.84** (unmodified) | NetGauge plaintext fallback over TCP (+UDP LOSS) | **Full test**: latency, download (20+ Gbps), upload (15+ Gbps), packet-loss 0 — 3/3 runs exit 0 |
| Speedtest Host Tester v1.1.0 (z.ai, SpeedtestHost-Tester) | HTTP + HTTPS + WS/WSS + NetGauge-over-WS + images + upload.php | **10/10 PASS** — identical verdict to the reference daemon |
| Protocol probe battery (37 checks) | all of the above + TLS versions + strict CA | **35/37 byte-identical**, 2 expected non-differences |
| curl / plain HTTP | legacy HTTP surface | byte-parity responses |

## Mechanism note for client authors

Modern Ookla clients open their measurement connections with an AES-encrypted
binary framing. This server answers that hello with `ERROR`, which triggers
the clients' plaintext-fallback negotiation (`HI → GETIP → PING …`), after
which the complete measurement runs over the documented text protocol. This
is the same surface the reference daemon keeps for legacy/third-party clients
(`clientAuthToken.denyInvalid=true` still admits token-less clients).

## Not supported (documented limitations)

- The encrypted-binary engine protocol itself (per-connection AES, anti-replay)
  — see `DECISIONS.md` D-2. Any hypothetical client that *requires* it would
  not interoperate; no such client was observed in the verified profile.
- Ookla "server network" admission features: host authentication tokens
  (`SERVER_HOST_AUTH` is advertised for banner parity but not enforced),
  traceroute (decommissioned), metrics upload, auto-update — none are needed
  for standalone interoperability, and none contact Ookla from this server.
