# SpeedtestServer — Independent OoklaServer Replacement (v1.5)

An open-source, production-grade replacement for the official OoklaServer
binary. The TypeScript daemon speaks the Ookla NetGauge protocol 1:1 (the
official speedtest CLI cannot tell the difference — verified against the
official binary with real CLI campaigns), then adds what the official
server cannot do:

- **Hybrid Cloudflare assist** — heavy download/upload payload is served in
  parallel by a dynamic pool of Cloudflare Workers, so aggregate throughput
  is no longer capped by a single VPS link (target: ≥ 2 Gbps DL/UL).
- **On-the-fly configuration** — the pool size, credentials, lane share and
  limits live in one `.env` file that the running gateway watches: edit it,
  and the deployed worker pool converges within seconds. No restart, no
  reinstall.
- **Daily self-update** — a systemd timer pulls repository updates,
  reinstalls and restarts the stack every night (version-gated, safe).
- **One-command install** — `sudo ./install.sh --start` builds the daemon,
  installs hardened systemd units, and deploys the Cloudflare worker pool.

> This project is fully self-contained and standalone. It is not a part of,
> and does not depend on, any other project. Future integrations are a
> separate concern.

## Architecture

```
                         ┌────────────────────────────┐
   NATIVE Ookla ─────────┤  VPS :8080 speedtest-bridge│  Lane A — native bridge
   clients (CLI/app,     │  NetGauge front (daemon    │  (unmodified clients:
   NetGauge TCP+UDP)     │  parity) + TLS mux → gw    │  control on the VPS,
                         │  payload ← Worker pool     │  payload edge-origin)
                         ├───────────────────────────┤
                         │  VPS :5060 daemon          │  Lane A′ — native daemon
                         │  (OoklaServer.properties)  │  (full-parity fallback)
                         └──────────┬─────────────────┘
                                    │ TLS mux (daemon-parity
                                    │ first-byte detection)
                         ┌──────────┴─────────────────┐
   HTTP speedtest ───────┤  hybrid gateway (loopback  │  Lane B — hybrid
   clients + probe       │  :8790) control plane+front │  (VPS lane at FULL
                         │  .env watcher (live config)│   speed ∥ CF edge)
                         └──────────┬─────────────────┘
                                    │ 302 offload + HMAC tokens
                    ┌───────────────┴───────────────┐
                    │  Cloudflare Worker pool 1..N  │
                    │  speedtest-hybrid-worker[-N]  │
                    │  .workers.dev (dynamic N)     │
                    └──────────────────────────────┘
```

| Lane | Who it serves | Endpoint | Throughput |
|---|---|---|---|
| A — native bridge | **native Ookla clients** (official CLI today; mobile-app engine family) | `speedtest-bridge :8080` (TCP+UDP NetGauge + TLS mux) | VPS relay of edge-origin payload (honest label: no per-session capacity gain) |
| A′ — native daemon | full-parity NetGauge incl. HTTP/TLS surface + TLS-wrapped NetGauge | daemon `:5060` | VPS link (uncapped) |
| B — hybrid | HTTP speedtest clients (mini/probe/web) | gateway (public via the bridge TLS mux on `:8080`) + worker pool | VPS **+** Cloudflare edge |

The two lanes share one HMAC secret; the gateway mints tokens, the Workers
verify them locally (zero runtime coupling). Result records flow back to the
gateway (`/api/results`) for attribution: exactly which lane served which
bytes.

## Ports — what this project touches

Only the **two native OoklaServer ports** are open to the public
(`OoklaServer.properties` stays the single source for them):

| Port | Component | Notes |
|---|---|---|
| **8080** | **speedtest-bridge** (TCP+UDP) | native NetGauge front for native Ookla clients + daemon-parity TLS mux into the gateway |
| **5060** | SpeedtestServer daemon (TCP+UDP) | OoklaServer-standard secondary port — narrowed here (in `OoklaServer.properties`) while the bridge owns 8080 |
| 8790 | hybrid gateway | **loopback only** (the bridge TLS mux proxies into it; never public) |
| — | Cloudflare Workers | `*.workers.dev` (no VPS port) |

The project **never** binds 80, 443, 8081 or 8443, and never touches
unrelated services on the host. `OoklaServer.properties` follows the
official Ookla format exactly and is preserved across upgrades (the bridge
narrowing writes it a timestamped backup first; `SPEEDTEST_BRIDGE_ENABLED=false`
restores both native ports and removes the bridge unit).

## Quick start

```bash
git clone https://github.com/smahud/SpeedtestServer.git
cd SpeedtestServer
cp .env.example .env
nano .env          # fill the Cloudflare credentials + worker count
sudo ./install.sh --start
```

That single command: builds the TypeScript daemon, installs hardened
systemd units, creates the service users, deploys 1..N Cloudflare Workers
(REST, fingerprint-gated), installs the daily auto-update timer, and starts
everything. Re-running it is safe (config, certificates and `.env` are
preserved; unchanged workers are not redeployed).

### Modes

| Mode | When | Behavior |
|---|---|---|
| **hybrid** (default) | usable Cloudflare credential + `CF_WORKER_DEPLOY_COUNT ≥ 1` | VPS serves its share at full speed; the worker pool assists in parallel |
| **vps-only** (fallback) | no/invalid credentials, or count 0 | everything served by the VPS; fix `.env` and re-run `install.sh` (or just save the file — the running gateway retries) |

## Configuration — one `.env` file

`cp .env.example .env` — every key is documented inline. The essentials:

| Key | Default | Meaning |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` *or* `CLOUDFLARE_EMAIL` + `CLOUDFLARE_API_KEY` | — | credentials (token preferred; global key is the automatic fallback) |
| `CLOUDFLARE_ACCOUNT_ID` | — | 32-hex account id |
| `CF_WORKER_DEPLOY_COUNT` | 100 | worker pool target — **synced on the fly** |
| `CF_WORKERS_SUBDOMAIN` / `CF_WORKER_NAME` | — | workers.dev URL derivation |
| `HYBRID_SHARED_SECRET` | auto | HMAC secret (auto-generated; deployed to every worker) |
| `HYBRID_VPS_DL_SHARE` | 0.15 | fraction of download requests served directly by the VPS at FULL speed; the rest is 302-assisted by the pool. 1.0 = pure VPS, 0.0 = pure edge |
| `HYBRID_GATEWAY_PORT` | 8790 | gateway listener — loopback-only under the bridge TLS mux |
| `HYBRID_GATEWAY_TLS_CERT/KEY` | daemon cert | gateway TLS (served via systemd `LoadCredential`) |

Full field reference, Cloudflare token scopes and troubleshooting:
[docs/CLOUDFLARE_CREDENTIALS.md](docs/CLOUDFLARE_CREDENTIALS.md).

### Hot-applied (no restart) vs restart-required

| Hot-applied while running (`HYBRID_ENV_FILE` watched, ~2 s) | Restart required (re-run `install.sh`) |
|---|---|
| `CF_WORKER_DEPLOY_COUNT` (deploy/undeploy workers) | `HYBRID_GATEWAY_PORT` / `BIND` / TLS paths |
| `HYBRID_WORKER_*` (pool bounds, autoscaler tuning) | `HYBRID_VPS_PUBLIC_BASE`, `HYBRID_STS_BASE` |
| `HYBRID_VPS_DL_SHARE`, `HYBRID_FRONT_*` limits | `HYBRID_RESULTS_FILE` |
| `HYBRID_SESSIONS_RATE_LIMIT_MPM` | |
| `HYBRID_SHARED_SECRET` (workers redeploy to match) | |
| `CLOUDFLARE_*` credentials (re-authenticate + re-converge) | |

Watch it happen:

```bash
journalctl -u speedtest-hybrid-gateway -f | grep -E "env_change_applied|worker_sync"
curl -sk https://127.0.0.1:8790/api/health    # mode, version, sync state
curl -sk https://127.0.0.1:8790/api/workers   # deployment sync status
curl -sk https://127.0.0.1:8790/api/pool      # routing pool status
```

## Dynamic worker pool

`CF_WORKER_DEPLOY_COUNT` is the deployment target. When it changes (in
`.env`, while everything is running), the gateway converges the real
Cloudflare state to match:

- **grow** → missing workers deployed via the REST API (6 concurrent),
  shared secret included;
- **shrink** → surplus workers deleted (highest ids first, never worker 1,
  only the exact `speedtest-hybrid-worker[-N]` naming scheme — anything
  else in the account is untouchable);
- **rotate** → a changed worker bundle / secret / pool config (deployment
  fingerprint) triggers a full redeploy.

Set `HYBRID_WORKER_SYNC_DELETE=false` to forbid deletions. Quota guard:
the account-wide 100k/day Workers Free request budget is polled hourly;
growth stops at the soft threshold, token minting stops at the hard one.

## Auto-update

`install.sh` installs `speedtest-autoupdate.timer` (daily 04:30 + up to
30 min jitter, `Persistent=true`). It pulls `master`, ff-only, reinstalls
when code changed (docs-only commits are pulled without reinstall), and
restarts the units. The `VERSION` file gates and reports the release.
Details: [docs/AUTO_UPDATE.md](docs/AUTO_UPDATE.md).

```bash
systemctl list-timers speedtest-autoupdate.timer
systemctl start speedtest-autoupdate.service   # run once now
```

## Verifying the server

### Native lane (official Ookla CLI) — 1:1 with the official binary

The official CLI speaks binary NetGauge to `:8080`. Point the CLI at this
VPS with a hosts entry (the CLI resolves server hostnames locally):

```bash
# on the measurement machine (root):
echo "45.126.249.250 speedtest.somedigit.net" >> /etc/hosts
./speedtest-cli_official/speedtest --accept-license --accept-gdpr -s 74964 --json
```

The result JSON (ping / download / upload) must be indistinguishable from a
run against the official binary — that equivalence is the project's core
contract, verified with multi-server CLI campaigns.

### Hybrid lane (HTTP clients)

```bash
HYBRID_FRONT_BASE=https://speedtest.lumajangnetworks.my.id:8080 \
HYBRID_WORKER_BASE=https://speedtest-hybrid-worker.lumajangnetworks.workers.dev \
HYBRID_GATEWAY_BASE=https://speedtest.lumajangnetworks.my.id:8080 \
HYBRID_DL_THREADS=16 HYBRID_UL_THREADS=8 \
python3 hybrid/probe-client/speedtest-cli-hybrid.py --json --server 99999
```

`/api/health` front counters attribute every byte (`dlLocal*` vs
`downRedirects` + worker-side counts) — the evidence that the Cloudflare
pool is genuinely carrying payload.

## Performance model

The VPS lane is **never capped** (the old `HYBRID_VPS_DL_BUDGET_MBPS`
throttle was removed at operator request): every VPS-lane response runs at
full socket speed, TCP backpressure being the only flow control. The edge
lane adds worker-pool capacity **in parallel**, so a fast client measures
≈ VPS capacity + edge capacity. Tune `HYBRID_VPS_DL_SHARE ≈
VPS capacity / expected client demand` for the maximum aggregate (e.g. a
500 Mbps VPS serving 2 Gbps clients → 0.25).

## Maintenance

```bash
systemctl status speedtestserver speedtest-hybrid-gateway
journalctl -u speedtestserver -f               # daemon log (JSONL events)
journalctl -u speedtest-hybrid-gateway -f      # gateway + pool + env-sync log
sudo ./install.sh --start                      # reinstall/upgrade (safe, idempotent)
curl -sk https://127.0.0.1:8790/api/health     # version, mode, sync, counters
```

Uninstall: `systemctl disable --now speedtestserver speedtest-hybrid-gateway
speedtest-autoupdate.timer`, remove `/opt/speedtestserver`,
`/opt/speedtest-hybrid`, the units and users, and (optionally) the worker
pool via `CLOUDFLARE_…=… POOL_SIZE=0 node hybrid/worker/rest-deploy.mjs`.

## Repository layout

```
install.sh                     one-command full-stack installer
auto-update.sh                 daily self-update (systemd timer)
VERSION                        release version (auto-update gate)
.env.example                   the single source of configuration
reverse-engineered/typescript  the OoklaServer-compatible daemon (NetGauge)
hybrid/gateway/src             VPS control plane + front + live .env watcher
hybrid/worker/                 Cloudflare Worker (NetGauge-over-WSS + __down/__up)
hybrid/worker/rest-deploy.mjs  REST deploy/undeploy for the worker pool
hybrid/probe-client/           hybrid speedtest client (multi-thread, attribution)
docs/                          credentials, worker pool, assist mode, auto-update
validation/                    protocol/e2e validation reports + evidence
speedtest-cli_official/        official CLI binaries used for equivalence testing
OoklaServer-*                  official reference binaries (protocol RE source)
```

## Development

```bash
cd reverse-engineered/typescript && npm ci && npm run build && npm test
node hybrid/gateway/test/gateway-tests.mjs       # 18 gateway tests
bash hybrid/gateway/test/e2e-fullstack-v14.sh    # full-stack e2e with real clients
```

The daemon's protocol implementation is reverse-engineered from the
official OoklaServer binaries (`reverse-engineering-batch/`,
`speedtest-cli_analysis/`); its compatibility profile is pinned by
`validation/PROTOCOL_CONTRACT.md`.
