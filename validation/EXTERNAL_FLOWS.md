# EXTERNAL_FLOWS — client / server / Ookla-services communication audit (v6.0 §8)

Method: authorized, passive observation of the LABORATORY chain only — the
official CLI was directed through the lab's `cv-proxy.mjs` (a transparent
config-level redirector) with every external destination logged, plus the
server's own JSONL evidence channel. Sanitized field names and observed
behavior only; no proprietary payload schemas are invented, no credentials
replayed, no host impersonation. Evidence:
`evidence/published*/run-*-proxy.jsonl` (publishing opt-in runs),
`evidence/gate-revision2/gate-r*-*-proxy.jsonl` (non-publishing gates),
`evidence/published*/run-*-sts-evidence.jsonl` (server side).

## 1. Observed actors and destinations

| Actor | Destination | Purpose | Transport | Evidence | Outcome | Confidence |
|---|---|---|---|---|---|---|
| Speedtest CLI | `cli.speedtest.net:443` `/api/cli/config?deviceId=…&serverid=…&uname=…` | fetch ENGINE CONFIG (server list the CLI may use) | HTTPS via proxy CONNECT (MITM'd by the lab CA) | `config_req` + `mitm` entries in every proxy log | 1274 B live config fetched with the CLI's own query + `ookla-cli/1.2.0.84` UA; lab rewrote every server entry to `localhost:8080` and re-signed (`config_served`, 1304 B) | **Verified** (direct capture) |
| Speedtest CLI | SpeedtestServer `localhost:8080` | the MEASUREMENT itself: NetGauge TCP sessions (HI/PING/DOWNLOAD/UPLOAD), UDP loss stream, HTTP legacy surface | TCP + TLS + WS + UDP (single port) | server evidence: 13 `conn_netgauge`, 882 `ng_download_done`, 487 `ng_upload_done`, 446 `udp_recv`, 257 `udp_count` per run | full latency + download + upload + packet-loss measurement completes | **Verified** |
| Speedtest CLI | `results.speedtest.net:443` | RESULT SUBMISSION (the CLIENT posts the finished measurement; asks for persistence) | HTTPS via proxy CONNECT (`publish_tunnel` in publishing runs) | publishing proxy logs; CLI JSON `result.persisted:true` + `result.url` | a **public Result URL** (`https://www.speedtest.net/result/c/<uuid>`) is returned by the service and printed by the CLI; spot-verified live (page values == CLI-reported values, exact) | **Verified** (publishing opt-in only) |
| — (refused) | `results.speedtest.net:443` | non-publishing gates: submission endpoint REFUSED at the proxy | — | `blocked` entries in gate proxy logs | CLI still exits 0 with complete measurements; `result.persisted:false` and **no** Result URL | **Verified** |
| SpeedtestServer | *(no external destination)* | the canonical server makes **zero outbound connections** | — | differential/host-tester/gate batteries; code audit (no outbound HTTP in the startup path) | independence requirement met | **Verified** |

## 2. Who does what (responsibility split, as observed)

- **The CLIENT measures.** Latency (PING), download (DOWNLOAD), upload
  (UPLOAD), and UDP packet loss (INITPLOSS/PLOSS) are all executed by the CLI
  against the server's data streams. The server is a byte pump + accountant.
- **The CLIENT aggregates and submits.** After the measurement the CLI
  CONNECTs to `results.speedtest.net` and submits the finished result. In
  non-publishing mode (lab default) that destination is refused and the CLI
  reports `persisted:false` — measurements remain complete without any
  result backend.
- **The result ID / Result URL is produced by the Ookla result service, not
  by the speedtest server.** `result.persisted=true` coincides with the
  service accepting the submission; the URL `…/result/c/<uuid>` is returned
  through the submission flow and printed by the CLI. SpeedtestServer never
  generates, signs, or proxies a Result URL, and `OoklaServer.resultEndpointUrl`
  in its config has **no effect on the public result pipeline**.
- **The SERVER's own reporting knobs are a different (server-side) channel.**
  `OoklaServer.resultEndpointUrl`, `sendStatsInterval`, `hostApiUrl`,
  traceroutes and host registration belong to Ookla host management/telemetry
  between a REGISTERED official host and Ookla services. No public contract
  for that channel is observable in an authorized independent lab; the
  independent implementation therefore **decommissions** it (no invented
  endpoints — RULE 4) and this is documented rather than substituted.

## 3. Failures when the result service is unavailable

Observed directly: with the submission destination refused, the CLI completes
the full measurement and exits 0 with `result.persisted:false` and no URL.
The speedtest server's operation is unaffected — it neither knows nor needs
the result backend. (This is the profile all mandatory gates enforce.)

## 4. Certificate provisioning flow (independent implementation)

`OoklaServer.ssl.useLetsEncrypt=true` in the independent server maps to
**standard public ACME** (Let's Encrypt via `acme-client`, HTTP-01) — an
operator-controlled domain is required; the official daemon's own
host-management provisioning has no public contract and is not emulated
(see TLS_CERTIFICATES.md §1/§4).

## 5. Conclusion for the 1:1 scope

For standalone interoperability the server must implement: the engine-config
**contract is not the server's** (it is a client↔Ookla flow — the lab only
redirects it), the **measurement protocols** (fully implemented and verified),
and **nothing else** for results: submission is the client's job against
Ookla's public result service. The independent server correctly makes zero
outbound connections, and every external-flow claim above is backed by a
committed capture.
