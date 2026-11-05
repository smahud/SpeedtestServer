# CONFIG_MATRIX — complete OoklaServer.properties parity audit (v6.0 §11)

Audited: 2026-11-04, branch `audit/typescript-official-parity`, against
`reverse-engineered/typescript` canonical implementation + shipped template
`reverse-engineered/typescript/config/OoklaServer.properties`.

Legend: **IV** = implemented and verified · **P** = partial · **PNA** = parsed
but not applied (with documented rationale) · **N/A** = not applicable to this
runtime by design · **EXT** = project extension beyond the official key set.

Precedence (verified by unit test `ConfigParity.test.ts`):
**CLI flags > `OOKLA_SERVER_POCO_CONFIG` env JSON > properties file
(--config or search path) > built-in defaults.** Single-value list fields
(`tcpPorts`, `addresses`, `ssl.acme.domains`, …) coerce to one-element lists
(§11 fix). `openSSL.server.minimumTLSProtocol` keeps string semantics (`1.2`
is never a float). `--config` selects the file verbatim.

## Network & listeners

| Property | Maps to | Runtime consumer | Status & evidence |
|---|---|---|---|
| `OoklaServer.tcpPorts` | `tcpPorts: number[]` | `ServerCore` — one multiplexed listener per port (TLS/HTTP/WS/NetGauge) | **IV** — gates listen on 8080+5060; unit test; battery |
| `OoklaServer.udpPorts` | `udpPorts: number[]` | `UdpLossEngine` (LOSS/RECV) | **IV** — CLI packet-loss accounting works; UDP listeners in inventories |
| `OoklaServer.httpPorts` | `httpPorts` | none (single-port multiplexer serves HTTP on every TCP port — reference deployment model) | **PNA** — redundant by design; kept parsed for template fidelity |
| `OoklaServer.useIPv6` / `useIPv4` | `useIPv6` / `useIPv4` | `ServerCore.resolveBindTargets` → per-family listeners (0.0.0.0 + `[::]` V6ONLY); `UdpLossEngine` mirrors it | **IV** (rev 5, F-29) — `useIPv4=false`/`useIPv6=false` verified against the live daemon (TCP + UDP) |
| `OoklaServer.addresses` | `addresses` → `bindAddresses` | `ServerCore.resolveBindTargets` → exact listed addresses, both families | **IV (documented intent)** — the daemon's own handling is broken (F-28); deliberate deviation D-9 (DECISIONS.md) |
| `OoklaServer.netgaugeVersionString` | `netgaugeVersionString` | NetGauge `HELLO` + HTTP `/hi` banner | **IV (EXT)** — differential probe byte-identical; `--version-string` CLI too |

## Access control

| Property | Maps to | Runtime consumer | Status & evidence |
|---|---|---|---|
| `OoklaServer.allowedDomains` | `allowedDomains: string[]` | `HttpApi` (CSP connect-src, crossdomain.xml entries, CORS Origin filter) | **IV** (rev 4, F-22 — this row was stale before rev 5) |
| `OoklaServer.excludeDefaultDomains` | `excludeDefaultDomains` | none | **PNA** — same rationale |
| `OoklaServer.userAgentFilterEnabled` | `userAgentFilterEnabled` | `HttpApi` step 3.5 — built-in 11-pattern bad-UA blocklist, 500-with-Date form | **IV** (rev 5, F-26) — default false (daemon-verified); full-string case-sensitive regex; Host checks win |
| `OoklaServer.clientAuthToken.denyInvalid` | `clientAuthToken.denyInvalid` | none — the verified profile never requests client tokens (daemon parity: `verificationMode=none`) | **PNA** — see EXTERNAL_FLOWS.md |
| `OoklaServer.clientAuthToken.additionalValidationFields` | `clientAuthToken` | none | **PNA** — same |

## Resource limits & tracking

| Property | Maps to | Runtime consumer | Status & evidence |
|---|---|---|---|
| `OoklaServer.workerThreadPool.capacity` / `.stackSizeBytes` | `workerThreadPool` | none — Node.js event-loop runtime has no worker pool | **N/A** by design (documented architecture difference; capacity-equivalent protections: `maxConnections` 4096, per-IP limit, body/line caps) |
| `OoklaServer.ipTracking.maxConnPerIp` | `ipTracking.maxConnPerIp` | `ServerCore.maxConnectionsPerIp` (connection rejected above limit, `conn_rejected_per_ip` event) | **IV** |
| `OoklaServer.ipTracking.gcIntervalMinutes` / `maxIdleAgeMinutes` / `slidingWindowBucketLengthMinutes` / `metricTopIpCount` / `maxConnPerBucketPerIp` | `ipTracking.*` | LossRegistry GC is fixed 300 s; per-bucket admission counters not ported | **P** — maxConnPerIp applied; the metrics-bucket machinery fed the decommissioned metrics uploader (§8) |
| `OoklaServer.maxConnectionSeconds` | `maxConnectionSeconds` | socket idle timeout (`conn_timeout`), capped at 1 h | **IV** — mirrors daemon default 3600 |
| `OoklaServer.http.maxHeadersSize` | `http.maxHeadersSize` | none — Node's HTTP parser enforces its own header limits | **PNA** — equivalent protection verified by negative test "oversized HTTP headers → server survives" |
| `OoklaServer.websocket.frameSizeLimitBytes` | `websocket.frameSizeLimitBytes` → `wsFrameSizeLimitBytes` | ws `maxPayload` = limit (message-level bound) + per-frame `FrameGuard` (silent RST on `> limit`, daemon parity) | **IV** (rev 5, F-27) — boundary verified against the live daemon at limit 64 and at the 5242880 default |

## SSL / TLS (v6.0 §9 — all semantics verified this revision)

| Property | Maps to | Runtime consumer | Status & evidence |
|---|---|---|---|
| `OoklaServer.ssl.useLetsEncrypt` | `ssl.useLetsEncrypt` | `CertificateManager.resolve()` §9.4 → `AcmeProvisioner` (standard ACME, HTTP-01) | **IV (EXT semantics)** — fail-closed verified (N6/N7: missing acme config / dead directory → startup aborts; no self-signed fallback). Real issuance requires an operator-controlled domain → BLOCKED in lab, documented |
| `openSSL.server.certificateFile` + `openSSL.server.privateKeyFile` | `ssl.certificateFile/privateKeyFile` | `CertificateManager` §9.2/§9.3 — custom pair precedence, pair validation, watcher | **IV** — TLS battery T1/T2/N4/N5 |
| only one of the pair | — | fatal `TLS_INCOMPLETE_CUSTOM_PAIR` | **IV** (§9.3, N5) |
| `openSSL.server.verificationMode` | `ssl.verificationMode` | server never requests client certificates (daemon default `none`) | **P** — behavior hardcoded to the verified daemon default; no other mode verified as observable |
| `openSSL.server.minimumTLSProtocol` | `ssl.minimumTLSProtocol` → `ServerCore.tlsMinVersion` (1.0/1.1/1.2/1.3 → TLSv1…TLSv1.3) | per-connection TLSSocket `minVersion` | **IV** — T3 (1.3-only rejects TLSv1.2); default 1.2 matches daemon probes (TLSv1.0/1.1 rejected, 1.2/1.3 accepted) |
| `OoklaServer.ssl.acme.domains` / `.email` / `.directoryUrl` / `.http01Port` / `.storageDir` | `ssl.acme.*` | `AcmeProvisioner` | **IV (EXT)** — config presence-checked, fail-closed |
| `OoklaServer.ssl.allowSelfSigned` | `ssl.allowSelfSigned` | `CertificateManager` §9.5/§9.6 — explicit development mode | **IV (EXT)** |

## Logging (verified this revision)

| Property | Maps to | Runtime consumer | Status & evidence |
|---|---|---|---|
| `logging.loggers.<n>.name` | logger name | `Logger` channels | **IV** — unit test maps template block |
| `logging.loggers.<n>.level` | channel level / default level | `Logger` | **IV** |
| `logging.loggers.<n>.channel.class` | `ConsoleChannel`/`FileChannel`/`EventLogChannel`/… | `Logger` (EventLogChannel → stdout, captured by the systemd journal) | **IV** |
| `logging.loggers.<n>.channel.path` | `channelOptions.path` (`${application.dir}` expanded) | file channels | **IV** |
| `logging.loggers.<n>.channel.rotation` / `archive` / `compress` / `purgeCount` | — | not implemented (journald handles rotation for the console/journal channel) | **PNA** |

## Host/telemetry/update (external services — §8)

| Property | Maps to | Runtime consumer | Status & evidence |
|---|---|---|---|
| `OoklaServer.host.id` / `adminPassword` | `host.*` | none — host registration is a proprietary Ookla service | **PNA** — RULE 4 (no assumed private APIs) |
| `OoklaServer.resultEndpointUrl` | `resultEndpointUrl` | none — result submission is performed by the CLIENT to results.speedtest.net (verified, EXTERNAL_FLOWS.md); server-side per-session reporting is decommissioned | **PNA** (intentional, DECISIONS.md) |
| `OoklaServer.sendStatsInterval` | `sendStatsInterval` | none (metrics uploader decommissioned) | **PNA** (intentional) |
| `OoklaServer.hostApiUrl` / `apiUrl` | `hostApiUrl`/`apiUrl` | none | **PNA** (intentional) |
| `OoklaServer.performTraceroutes` | `performTraceroutes` | none (TracerouteManager decommissioned — produced fabricated data) | **PNA** (intentional) |
| `OoklaServer.enableAutoUpdate` / `binaryAutoUpdate` | `enableAutoUpdate`/`binaryAutoUpdate` | none (auto-update decommissioned — no vendor binaries) | **PNA** (intentional) |

## Project extensions (documented, verified)

| Property | Maps to | Runtime consumer | Status |
|---|---|---|---|
| `OoklaServer.evidenceLogFile` | `evidenceLogFile` | `ServerCore` JSONL evidence log (connections, commands, byte counters) | **IV (EXT)** — the corroboration channel for every gate |
| (CLI) `--config`, `--ports`, `--udp-ports`, `--evidence-log`, `--version-string`, `--validate-config`, `--role` | config overrides / validation mode | `bin/ooklaserver.ts` | **IV (EXT)** — `--config` + precedence unit-verified; `--validate-config` used by install.sh |

## Summary counts (updated rev 5, 2026-11-05)

- **IV (official keys):** tcpPorts, udpPorts, **useIPv6/useIPv4 (per-family listeners)**, **addresses (documented intent, D-9)**, **allowedDomains (rev 4 F-22 — row was stale)**, **userAgentFilterEnabled (rev 5 F-26)**, **websocket.frameSizeLimitBytes (rev 5 F-27)**, maxConnPerIp, maxConnectionSeconds, useLetsEncrypt, certificateFile/privateKeyFile (+incomplete-pair fatal), verificationMode (default behavior), minimumTLSProtocol, logging.loggers.\* (name/level/class/path)
- **P:** ipTracking (partially — maxConnPerIp applied; metrics-bucket machinery decommissioned)
- **PNA (documented rationale each):** httpPorts (redundant), excludeDefaultDomains semantics beyond allowedDomains union, clientAuthToken.\*, http.maxHeadersSize (equivalent protection), rotation keys, host/result/stats/traceroute/update keys
- **N/A by design:** workerThreadPool.\*
- **EXT:** netgaugeVersionString, evidenceLogFile, ssl.acme.\*, ssl.allowSelfSigned, validate-config

Every "not applied" row carries its rationale here — no silent acceptance.

## Revision 6 additions (2026-11-05) — independent safety keys (EXT)

| Property | Maps to | Runtime consumer | Status |
|---|---|---|---|
| `OoklaServer.shutdownGraceSeconds` | `shutdownGraceSeconds` | `ServerCore.stop()` grace window (default 10 s; force-destroy after) | **IV (EXT, F-35)** — not a daemon-parity key; documented as D-11 |
| `OoklaServer.evidenceMaxBacklogBytes` | `evidenceMaxBacklogBytes` | evidence WriteStream backlog cap (default 32 MiB; degrade to OFF past cap) | **IV (EXT, F-36)** — not a daemon-parity key; documented as D-11 |
