# HOST_TESTER_COMPARISON — diagnostic matrix outcomes

Tester: **Speedtest Host Tester v1.1.0** (z.ai implementation from the
read-only SpeedtestHost-Tester repository, branch
`audit/z-ai-official-validation`) — "same checks as speedtest.net/host-tester",
zero-dependency Node CLI. Run date 2026-11-04.

| Check | Reference daemon :18080 | SpeedtestServer :8080 |
|---|---|---|
| Hostname resolution | PASS | PASS |
| OoklaServer daemon connection (HTTP 200) | PASS | PASS |
| Daemon version banner | PASS `2.11 (2.11.5) 2026-06-04.1737.7d0993d` | PASS — identical string |
| Netgauge / WebSocket (wss, HI→HELLO, PING→PONG) | PASS (ping 0.1 ms) | PASS (ping 0.2 ms) |
| HTTPS functionality (TLSv1.3, CN=localhost, lab CA) | PASS | PASS — same cert, same issuer |
| Keep-Alive | PASS (`Keep-Alive`) | PASS (`keep-alive`) |
| Latency file | PASS `test=test\n` | PASS — identical |
| Download image files | PASS 10/10 (240 KB–30.2 MB) | PASS 10/10 — identical sizes |
| Legacy upload script | PASS `size=265` | PASS — identical |
| Crossdomain settings | PASS `domain="*"` | PASS — identical |
| **Total** | **10 PASS / 0 FAIL** | **10 PASS / 0 FAIL** |

Both verdict lines: "Server is publicly available and properly configured."

Speed-measurement phases also ran to completion on both targets (daemon
17.5 GB traffic / STS 11.9 GB in ~21 s).

## Other testers (context from the read-only repo)

The SpeedtestHost-Tester repository contains four agent implementations
(chatgpt, arena.ai, mistral.ai, z.ai). Only the z.ai CLI is fully headless and
zero-dependency, so it was selected for the differential matrix. Its protocol
findings were treated as **hints only**; every load-bearing fact in
`PROTOCOL_CONTRACT.md` was re-verified first-hand (several prior ambiguities —
UPLOAD counting, UDP forms, GETIP/CAPABILITIES/SERVERID/UPTIME — were resolved
differently here, see `FINDINGS.md` F-1…F-7).
