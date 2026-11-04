# SpeedtestServer

**An independent, open-source speedtest server implementing the OoklaServer
compatibility profile** — verified end-to-end against the *unmodified official
Speedtest CLI*.

> This project is not an Ookla product and is not affiliated with Ookla. It is
> a clean-room interoperability implementation built from authorized,
> observable protocol behavior (see `validation/PROTOCOL_CONTRACT.md`).

## Status (branch `audit/official-cli-interoperability`, 2026-11-04)

| Gate | Result |
|---|---|
| Official Speedtest CLI 1.2.0.84 → this server | **PASS 3/3 runs** — exit 0, latency+download+upload complete, packet loss 0, no result publishing |
| Speedtest Host Tester v1.1.0 | **10/10 PASS** (identical verdict to the official reference daemon) |
| Differential probes vs reference daemon 2.11.5.2 | **35/37 byte-identical** (2 expected non-differences: timestamps, random payload) |
| Unit/protocol conformance suite | 44/44 |
| Negative/security battery | 7/7 |

Evidence: `validation/evidence/` (machine-readable gate files in the schema of
`validation/FINAL_REPORT.md`). Reproduce everything: `validation/REPRODUCE.md`.

## Quick start

```bash
cd reverse-engineered/typescript
npm install && npm run build && npm test
node dist/bin/ooklaserver.js                    # TCP+UDP 5060,8080, all protocols multiplexed
```

Manual check:

```bash
printf 'HI\nGETIP\nPING 1\n' | nc 127.0.0.1 8080
# HELLO 2.11 (2.11.5) 2026-06-04.1737.7d0993d   ← compatibility banner (configurable)
# YOURIP 127.0.0.1
# PONG 1793776390681
```

## What it speaks (single port: 8080 and 5060)

- **Native NetGauge protocol** (TCP + TLS-wrapped): `HI/GETIP/CAPABILITIES/
  SERVERID/UPTIME/PING/DOWNLOAD/UPLOAD/INITPLOSS/PLOSS/QUIT` — the protocol
  used by the official CLI (via its plaintext fallback) and NetGauge clients.
- **UDP packet-loss protocol**: `LOSS`/`RECV` + `PLOSS` accounting.
- **HTTP legacy surface** byte-parity: `/`, `/hi`, `/speedtest/latency.txt`,
  `/crossdomain.xml`, `/speedtest/random{N}x{N}.jpg` (14 fixed sizes),
  `POST /speedtest/upload.php`, security headers, keep-alive.
- **WebSocket** `/ws` (NetGauge over WS/WSS, same port).

## Configuration

`OoklaServer.properties` (searched in `./config`, `/etc/ooklaserver`, …) or
`--config <path>`; CLI flags `--ports`, `--udp-ports`, `--evidence-log`,
`--version-string`. Key properties: `OoklaServer.tcpPorts`,
`OoklaServer.udpPorts`, `openSSL.server.certificateFile/privateKeyFile`
(self-signed generated into `./certs` if absent — the server runs
unprivileged), `OoklaServer.netgaugeVersionString` (compatibility banner),
`OoklaServer.evidenceLogFile` (JSONL connection/command/byte evidence).

## Repository layout

```
reverse-engineered/typescript/   ← CANONICAL implementation (build, run, test)
javascript/                      ← deprecated frozen port (see DEPRECATED.md)
reverse-engineered/documentation/ reverse-engineered/strings/   ← RE artifacts
reverse-engineering-batch/       ← binary analysis artifacts (historical)
validation/                      ← protocol contract, harness, evidence, reports
```

## Validation harness

`validation/harness/` reproduces every claim: lab PKI, a config-level proxy
that legitimately directs the official CLI at a local target while
**refusing result submission** (non-publishing), fail-closed gate scripts,
differential probes and negative tests. `validation/REPRODUCE.md` is the
step-by-step guide.

## License & trademark notice

Project source: MIT (see LICENSE statements in the tree). This covers **this
project's code only** — it conveys no rights over Ookla binaries, protocol
documentation, or "OoklaServer"/"Speedtest" trademarks. The default version
banner is a *compatibility-profile string* and is configurable
(`OoklaServer.netgaugeVersionString`). No Ookla proprietary assets are
included.
