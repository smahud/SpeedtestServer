# SpeedtestServer

**An independent, open-source speedtest server implementing the OoklaServer
compatibility profile** — verified end-to-end against the *unmodified official
Speedtest CLI*.

> This project is not an Ookla product and is not affiliated with Ookla. It is
> a clean-room interoperability implementation built from authorized,
> observable protocol behavior (see `validation/PROTOCOL_CONTRACT.md`).

## 1. Project overview and scope

Fresh 2026-11-23 analysis with the unmodified official CLI and reference binary,
using `speedtest.lumajangnetworks.my.id` as the remote endpoint:
[`validation/REINVESTIGATION_2026-11-23.md`](validation/REINVESTIGATION_2026-11-23.md).
This distinguishes CLI interoperability, host-tester HTTP behavior, and official
server discovery. The wildcard Host fix was subsequently deployed to the VPS;
the public-subdomain host tester passed 19/19 (see
[`validation/DEPLOYMENT_WILDCARD_2026-11-23.md`](validation/DEPLOYMENT_WILDCARD_2026-11-23.md)).
Subsequent original-binary analysis found additional multi-port policy and upload
alias/OPTIONS gaps that the 19-check tester missed. See
[`validation/HTTP_COMPATIBILITY_REPAIR_2026-11-23.md`](validation/HTTP_COMPATIBILITY_REPAIR_2026-11-23.md)
for those fixes and stricter acceptance evidence.
The subsequent maximum-upload byte/encoding regression and combined 31-case
gate are documented in
[`validation/MAX_UPLOAD_REGRESSION_2026-11-23.md`](validation/MAX_UPLOAD_REGRESSION_2026-11-23.md).

SpeedtestServer replaces the *observable server-side behavior* of the official
OoklaServer daemon for legitimate OoklaServer-compatible clients: the native
NetGauge measurement protocol (TCP, TLS-wrapped, WebSocket), the HTTP legacy
surface, UDP packet-loss accounting, and TLS with correct trust semantics.
Out of scope: Ookla host-network admission/certification, proprietary backend
parity, and any behavior without a publicly observable contract
(`validation/EXTERNAL_FLOWS.md`).

### Hybrid VPS + Cloudflare Workers (branch `hybrid-vps-workers`)

This repository's `hybrid-vps-workers` branch adds and **experimentally
validates** a hybrid architecture in which the VPS (SpeedtestServer + a
control-plane gateway) and a Cloudflare Worker cooperate: the Worker serves
the bandwidth-intensive plane for web/custom clients — the **full NetGauge
protocol over WSS**, the daemon HTTP surface, and `__down`/`__up` streaming,
with payload generated/drained **at the edge** — while the VPS keeps the
native-socket responsibilities (official-CLI lane, UDP loss/jitter,
discovery, tokens, results, identity). Headline measured results: host-tester
suite **10/10 PASS against the Worker** (1.25 GB speed phases through the
edge); hybrid sessions offload payload at ratio **≈1:16 000** (56 MiB at the
edge vs 3 653 B on the VPS); the unmodified official CLI **provably cannot**
use the edge (`Protocol error: Did not receive HELLO` → `NoServers`, exit 2)
and completes 26 GB runs on the VPS lane instead. Full report:
[`hybrid/reports/HYBRID_RESEARCH_REPORT.md`](hybrid/reports/HYBRID_RESEARCH_REPORT.md),
claims register: [`hybrid/reports/WORKERS_LIMITS.md`](hybrid/reports/WORKERS_LIMITS.md),
quickstart: [`hybrid/README.md`](hybrid/README.md).


## 2. Relationship to the official OoklaServer

The official binary (reference: 2.11.5.2, tarball sha256 `ce180aa3…598159`)
is used **only** as an authorized behavioral reference for differential
testing. No proprietary code or assets are included; the compatibility
banner is configurable (`OoklaServer.netgaugeVersionString`). Parity claims
are bounded to the verified profile — `validation/PARITY_MATRIX.md`.

## 3. Current TypeScript compatibility status (revision 5 — config-parity + defect fix, 2026-11-05)

| Gate | Result |
|---|---|
| **Live differential battery vs the running reference daemon** (103 probes: NetGauge/HTTP/TLS/WS/UDP) | **89/103 raw byte-identical**; 6 expected non-differences (timestamps, random payload, own port); 8 documented deviations (D-2/D-3 + safety refusals) — re-verified on the rev-5 code (zero regression) |
| **Per-config-variant differential (new, rev 5)**: `userAgentFilterEnabled`, `frameSizeLimitBytes`, `useIPv4`/`useIPv6` | **0 mismatches** on every battery — `validation/evidence/rea-lab-rev5/` |
| Official Speedtest CLI 1.2.0.84 → this server (non-publishing) | rev 4: **PASS 3/3 isolated runs** · rev 5 re-run: **BLOCKED upstream** (config endpoint throttles the CLI UA from the lab IP — see HANDOFF); plaintext-fallback paths covered by the differential |
| Publishing opt-in battery (multi-server, forced local) | genuine public speedtest.net Result URLs, e.g. `https://www.speedtest.net/result/c/55713fba-3d50-4558-95f2-7afbde18107a` (`validation/PUBLISHED_RESULT_URLS.md`) |
| Speedtest Host Tester v1.1.0 | **10/10 PASS** (identical verdict to the official reference daemon) |
| Unit/protocol/conformance suite | **143/143** (125 rev-4 + 18 rev-5 regressions: F-26/F-27/F-28/F-29 wiring + the F-30 security fix) |
| Negative/security battery | **7/7** (rev 4 shipped 5/7-effective: a >64 KiB header block OOM-killed the server — F-30 fixed; see FINDINGS) |
| Strict TLS battery (§9/§10) | **10/10 PASS** (re-run on rev-5 code) |
| Installer (dry-run/staged/idempotent/fail-closed) | PASS (systemd start: container-blocked, documented) |

Revision 4 (2026-11-04) re-verified the protocol **against the live
reference binary** on this very machine and closed 25 new reference findings
(F-8…F-25 in `validation/FINDINGS.md`): the Host/SAN validation with 307
redirects, the verified `allowedDomains` semantics (CSP + crossdomain.xml +
CORS Origin filter), byte-exact HTTP header order/casing, the DOWNLOAD
trailing-newline + printable-ASCII pool structure, the TCP "three strikes"
rule, CRLF tolerance, the pre-session GETIP gate, WS one-command-per-frame
and QUIT-over-WS semantics, plus fail-closed/hardening fixes (explicit-config
failures, prototype pollution, UDP binds, evidence flush, per-IP limits).

Evidence: `validation/evidence/` · index: `validation/TEST_RESULTS.md` ·
reproduce everything: `validation/REPRODUCE.md`.

## 4. Requirements

- Debian 13 (trixie) — primary target (other Linuxes work unverified)
- Node.js ≥ 18 (v24 tested), npm, rsync (installer only)
- No root required to run (unprivileged, no `/var/lock` or `/etc/ooklaserver`
  writes); the system installer needs root once

## 5. Installation using `install.sh` (Debian 13 + systemd)

```bash
./install.sh --dry-run        # checks + plan + config/TLS validation, no changes
sudo ./install.sh             # build, validate, install to /opt, systemd unit
sudo ./install.sh --start     # … and enable + start the service now
```

The installer deploys the open-source TypeScript server (never the
proprietary binary), creates a dedicated non-root service user, preserves
existing configuration and certificates on re-runs (idempotent), verifies the
installed server answers (`HELLO …` probe), and reports TLS readiness.
Staged/portable installs: `./install.sh --staging-dir /tmp/sts`.

## 6. Manual installation

### HTTP fallback required by host testers

The native daemon on ports 5060/8080 and the HTTP legacy fallback on port 80
are separate services. Installing the daemon alone does not install the legacy
site. The legacy site needs actual JPEG files and the PHP-style form upload
accounting (`500 + sum(byteLength(key) + byteLength(value) + 3)`); the daemon
continues to return the raw POST body length on its own ports.

After the standard installer, run `sudo bash install-legacy.sh`. It downloads
the reference fallback asset bundle over HTTPS, verifies its pinned SHA-256,
extracts only the ten known JPEG files, and enables `speedtestserver-legacy`
on port 80. You can supply a pre-downloaded archive as its first argument.
The separately distributed bundle is not included or relicensed in this repo.
Requirements: curl, python3, sha256sum, and the standard `/opt/speedtestserver`
installation. If port 80 is already occupied, the installer refuses to replace
the existing web server; configure that server's legacy paths instead.

The fallback has bounded wire uploads (8 MiB, to accommodate percent encoding
of the maximum test payload), request/header timeouts, persistent
HTTP connections, and streams the real JPEG bytes from disk. It runs under the
dedicated service user, with only the capability required to bind port 80.

Both the daemon and fallback must be reachable at the hostname entered into
the tester. Verify public A/AAAA records point to the intended VPS, and verify
inbound TCP 80/8080 and UDP 5060/8080. A locally pinned DNS test proves the VPS
implementation, not public DNS routing or the official hosted tester verdict.

When sharing a host with nPerf, check nftables redirect rules as well as
`ss`: nPerf can redirect external port 80 to 8081 even when no process listens
on 80. Allocate port 80 to the fallback and keep nPerf on 8081/8443 (and 443),
or use a web proxy to share the legacy paths. Set nPerf's `REDIRECT_PORT_80=0`
in its operator configuration before removing the existing port-80 redirect,
otherwise nPerf can recreate it on restart. Back up the configuration/rules
first; the generic fallback installer never changes another service's firewall.

Logs: `journalctl -u speedtestserver -u speedtestserver-legacy`.
To remove the fallback listener: `systemctl disable --now speedtestserver-legacy`.

### Native daemon

```bash
cd reverse-engineered/typescript
npm ci                       # committed lock file → reproducible deps
npm run build                # → dist/bin/ooklaserver.js
node dist/bin/ooklaserver.js --config /path/to/OoklaServer.properties
```

## 7. Configuration (`OoklaServer.properties`)

Searched in `./config`, `/etc/ooklaserver`, … or selected explicitly with
`--config <path>`. Precedence: **CLI flags > `OOKLA_SERVER_POCO_CONFIG` env
JSON > properties file > defaults** (unit-verified). Key properties:

- `OoklaServer.tcpPorts` / `OoklaServer.udpPorts` — listeners (default 5060,8080; every TCP port multiplexes TLS/HTTP/WS/NetGauge)
- `openSSL.server.certificateFile` + `openSSL.server.privateKeyFile` — custom certificate pair (takes precedence, disables auto issuance)
- `OoklaServer.ssl.useLetsEncrypt = true` — automatic issuance via standard ACME (needs `OoklaServer.ssl.acme.domains` + `.email`)
- `openSSL.server.minimumTLSProtocol` — 1.0/1.1/1.2/1.3 (default 1.2)
- `OoklaServer.netgaugeVersionString` — compatibility banner
- `OoklaServer.evidenceLogFile` — JSONL evidence log (the audit channel)
- `logging.loggers.*` — Poco-style logging (EventLogChannel→journal, FileChannel→file)

Full property-by-property status: `validation/CONFIG_MATRIX.md`.

## 8. Let's Encrypt behavior

`useLetsEncrypt=true` (with no custom pair) provisions through **standard
public ACME** (Let's Encrypt via the established `acme-client` library,
HTTP-01 challenge on port 80 — configurable `ssl.acme.http01Port`). Issued
material is stored under `ssl.acme.storageDir` (default `./certs/acme`),
reused while valid, renewed ≤30 days before expiry, and hot-activated without
restart. **Failures are fatal**: missing ACME settings, unreachable
directory, or failed issuance abort startup — the server never hides an
issuance failure behind a self-signed certificate. Operators should validate
on the Let's Encrypt **staging** directory first, then switch
`ssl.acme.directoryUrl` to production.

## 9. Custom certificate configuration and precedence

Both `openSSL.server.certificateFile` and `openSSL.server.privateKeyFile`
configured → the custom pair wins: loaded, validated (parse + key match),
never overwritten, `effectiveUseLetsEncrypt=false` (even if
`useLetsEncrypt=true` remains in the file). Only one of the two configured →
**startup fails** with a clear error. Certificates replaced on disk after
startup are hot-reloaded (validated first; the last valid certificate is
preserved if a replacement is broken).

## 10. SSL validation and troubleshooting

- Dev quick start (no TLS config) generates a **self-signed development
  certificate** — loudly announced, `publiclyTrusted:false`; strict HTTPS
  clients correctly reject it. Production needs a custom pair or ACME.
- Validate any configuration without binding ports:
  `node dist/bin/ooklaserver.js --config <file> --validate-config`
- Strict probe: `node validation/harness/tls-strict-check.mjs --port 8080 --ca <ca.pem>`
- Expired / wrong-hostname / mismatched-key / self-signed behaviors are
  covered by the 10-scenario battery: `validation/harness/run-tls-validation.sh`
  (evidence `validation/evidence/tls/`).

## 11. Service management (systemd)

```bash
sudo systemctl status speedtestserver
sudo systemctl restart speedtestserver
journalctl -u speedtestserver -f          # EventLogChannel output
```

Hardened unit (NoNewPrivileges, ProtectSystem=strict, dedicated user,
StateDirectory for certificates). Manual runs: `Ctrl-C`/SIGTERM for a clean
shutdown.

## 12. Logs and diagnostics

- Console/journal channel: `logging.loggers.app.*` (default information level)
- Optional file channels: `logging.loggers.<n>.channel.class = FileChannel` + `.path`
- Evidence log: `OoklaServer.evidenceLogFile` — every connection, command,
  and byte counter (used by all validation gates)
- `--validate-config` prints the effective plan as JSON

## 13. SpeedtestHost-Tester validation

The independent host tester (v1.1.0, read-only upstream) passes **10/10**
against this server with verdict strings identical to the official daemon's.
Run: `node speedtest-host-tester.mjs 127.0.0.1:8080`
(comparison: `validation/HOST_TESTER_COMPARISON.md`).

## 14. Official Speedtest CLI validation ★

The primary acceptance proof: the **genuine, unmodified** official CLI
(1.2.0.84, sha256-verified) completes full latency/download/upload/packet-loss
measurements against this server, non-publishing (3/3 gates, loss 0) —
with per-run destination proof (port owner, official daemon absent) and
server-side byte corroboration. An opt-in publishing battery forces several
distinct live server IDs at this server and captures genuine public Result
URLs (spot-verified against the live result pages). Details:
`validation/OFFICIAL_CLI_RESULTS.md`, `validation/PUBLISHED_RESULT_URLS.md`.

## 15. Known limitations

- The CLI's encrypted-binary engine protocol is not implemented; the
  documented plaintext fallback (verified 3/3) is used instead (D-2).
- Automatic issuance requires an operator-controlled domain; real ACME
  issuance is not exercised in the lab (fail-closed paths are).
- `userAgentFilterEnabled`, `frameSizeLimitBytes` override,
  `useIPv4`/`useIPv6` and `addresses` binding are **applied** as of
  revision 5 (F-26…F-29, verified against the live daemon). The one
  deliberate deviation: `addresses` implements the documented intent
  (deviation D-9) because the reference daemon's own handling never binds
  listed IPv4 addresses — details in `validation/CONFIG_MATRIX.md` and
  FINDINGS.md §rev 5. (`allowedDomains` has been applied since rev 4.)
- HTTP Host validation accepts exact certificate SAN entries and single-label
  wildcard SANs (e.g. `*.example.com` covers `speedtest.example.com`). Others
  get a 307 redirect to `https://<cert-CN>`. The reference's more permissive
  wildcard-certificate behavior is deliberately restricted (decision D-12).
  Deploy a certificate whose SANs cover the hostnames/IPs clients will use.
- Single-process serving tops out at ~18–22 Gbps loopback (informational).
- systemd service start verified on Debian 13 only via offline unit checks +
  direct-launch probes (container limitation, documented).

## 16. Security and licensing notes

Source: MIT (this project's code only — no rights over Ookla binaries,
protocol documentation, or trademarks; "OoklaServer"/"Speedtest" are Ookla
marks). The server makes **zero outbound connections**; TLS
misconfiguration is fatal rather than silently degrading; the earlier
invented "Host API" endpoints and `rejectUnauthorized:false` code were
removed (see `validation/FINDINGS.md` C-3, `validation/SECURITY_AUDIT.md`).

---

## Quick start (development)

```bash
cd reverse-engineered/typescript
npm ci && npm run build && npm test
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

## Repository layout

```
install.sh                       ← automated installer (Debian 13 + systemd)
reverse-engineered/typescript/   ← CANONICAL implementation (build, run, test)
javascript/                      ← deprecated frozen port (see DEPRECATED.md)
reverse-engineered/documentation/ reverse-engineered/strings/   ← RE artifacts
reverse-engineering-batch/       ← binary analysis artifacts (historical)
validation/                      ← §15 package: matrices, harness, evidence
```
