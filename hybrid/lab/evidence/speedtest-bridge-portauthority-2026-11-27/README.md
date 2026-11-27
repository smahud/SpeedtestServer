# Evidence: PORT AUTHORITY + frozen installer — production campaign 27 Nov 2026

> Operator contract, 27 Nov 2026: (1) the ONLY listening TCP/UDP ports of
> the whole project are the ones configured in `OoklaServer.properties`
> (port 8080 mandatory; NO assumption that any other port exists); (2) the
> install/update files never change when the code changes (uaeg U-13
> frozen-bootstrap pattern). This directory is the production proof of both.

## What was deployed (commit `4572bf5`)

- `install.sh` = **frozen bootstrap** (never changes; fetches the latest
  `installer/install-core.sh` from GitHub at run time). `auto-update.sh` =
  frozen wrapper (pull + full delegation). Contract:
  `docs/INSTALL_BOOTSTRAP.md`.
- **Port authority**: `OoklaServer.properties` restored to the operator's
  original `tcpPorts/udpPorts = 5060,8080` (from the v1.6 narrowing backup —
  the only migration touch; the file is never written again). The
  speedtest-bridge binds EVERY properties port (TCP+UDP) with the complete
  daemon-parity mux; the gateway serves on the Unix socket
  `/run/speedtest-hybrid/gateway.sock` (NO TCP port); the daemon unit is
  parked (stopped+disabled, files intact).

## Production state (VPS 45.126.249.250, post-deploy)

- TCP `*:5060` + `*:8080` (one bridge process), UDP `*:5060` + `*:8080` —
  and **nothing else** from this project: `8790/8791/18790/18791/18808` all
  ABSENT (`vps/vps-evidence.txt`).
- Both ports answer the full mux: `HELLO 2.11 …` on **:8080 AND :5060**,
  UDP LOSS `RECV` on both UDP ports, TLS mode = terminate (cert via
  LoadCredential), gateway via `unix:/run/speedtest-hybrid/gateway.sock`.
- Services: `speedtest-bridge` active+enabled, `speedtest-hybrid-gateway`
  active+enabled (socket), `speedtestserver` inactive+disabled (parked),
  `speedtest-autoupdate.timer` active.
- NetGauge probes ran on BOTH ports (deploy verification) — a single-port
  properties file also validated locally (only that port bound; the
  no-8080 case fails with a clear FATAL, never silently "fixed").

## Official-CLI runs (method: docs/OFFICIAL_CLI_TESTING_GUIDE.md — hosts-mock lab)

Unmodified official CLI 1.2.0.84 (sha256 `31f1124c…`), isolated namespace,
mockhosts: operator server list → `45.126.249.250`, `results.speedtest.net` →
127.0.0.1 (non-publishing), real discovery, pinned `--server-id=66281`
(Tuxsindo, `speedtest.tuxsnet.id:8080`).

| Run | backend | EXIT | DL (bytes / MBps) | UL (bytes / MBps) | persisted |
|---|---|---|---|---|---|
| b8-wh-1 | worker-http | **0** | 435,456,358 / 47.3 | 119,022,542 / 16.1 | **false** |
| b8-wh-2 | worker-http | **0** | 487,645,841 / 52.8 | 197,306,476 / 17.0 | **false** |
| b8-ww-1 | worker-ws | **0** | 443,804,032 / 51.0 | 172,084,656 / 15.5 | **false** |

3/3 full runs `EXIT=0`, `persisted=false`, `result.url=null` on the
PRODUCTION bridge (no experiment window — permanent mode).

## 3-side attribution (per the honest-label rule)

| Side | Evidence |
|---|---|
| Client | `runs/b8-*.cli.json` (EXIT=0, byte totals, persisted=false), `.dns-proof`, `.window` |
| VPS | `vps/bridge-heartbeats-campaign.txt`: b8-wh-1 bridge instance `bytesDownCli=455.9MB` / `bytesFromWorkerDl=456.1MB` / `bytesToWorkerUl=111.7MB`, workerRequests=169; b8-wh-2 cumulative `bytesFromWorkerDl=966.2MB` (Δ≈510MB); worker-ws instance peak `bytesDownCli=485.9MB` / `bytesFromWorkerDl=485.9MB` / `bytesToWorkerUl=173.2MB`, workerRequests=486 (WS frames) |
| Worker edge | `worker-edge/invocations-window.json` (GraphQL `workersInvocationsAdaptive`, 02:45–03:00Z): **407 requests, 0 errors** — 169 @02:48 (wh-1), 173 @02:49 (wh-2), 37 @02:51 (ww-1; WSS = fewer, larger requests) |

`worker_err` events during runs are end-of-stream `conn closed` aborts (the
official CLI's own connection pattern — handled by retry/remainder refetch;
all byte totals fully delivered; Worker edge reports 0 errors).

## Honest labels (unchanged)

- Bridge mode = **edge-ORIGIN payload with VPS RELAY** — every byte still
  transits the VPS link; no single-session capacity gain (runs landed at
  38–42 MB/s ≈ 306–422 Mbps class, consistent with the 27 Nov campaign's
  416–449 Mbps window; the sandbox–VPS link is the ceiling).
- Direct (non-relay) edge path for native clients remains BLOCKED
  (BLOCKED_BY_PROTOCOL + BLOCKED_BY_FREE_PLAN, audit 26–27 Nov).

## Verified properties of the new architecture

1. **Ports come only from OoklaServer.properties**: bridge meta logs
   `ports:[5060,8080]`, `udpPorts:[5060,8080]`; both TCP ports serve the
   full mux; both UDP ports serve the loss plane. A one-port config serves
   exactly that one port (validated on the staging install); a config
   without 8080 is refused loudly.
2. **No extra ports anywhere**: gateway = Unix socket only (0660
   speedtest-hybrid:speedtest-hybrid), daemon parked — `ss` shows only the
   properties ports.
3. **Properties file never rewritten**: the daemon-parking approach
   replaced the v1.6 narrowing; `SPEEDTEST_BRIDGE_ENABLED=false` re-enables
   the daemon on ALL properties ports with nothing to restore.
4. **Frozen installer**: after this commit, `install.sh` (bootstrap) and
   `auto-update.sh` (wrapper) must not change with the code — all installer
   logic lives in `installer/install-core.sh` (fetched fresh per run; free
   to change). Old checkouts keep updating forever.
