# Hybrid architecture — VPS (origin) + Cloudflare Workers (edge)

> Research branch `hybrid-vps-workers`. Full findings:
> [`reports/HYBRID_RESEARCH_REPORT.md`](reports/HYBRID_RESEARCH_REPORT.md) ·
> claims register: [`reports/WORKERS_LIMITS.md`](reports/WORKERS_LIMITS.md) ·
> experiments: [`lab/`](lab/).

A hybrid Ookla-compatible speedtest architecture where **both components have
measured, meaningful responsibilities**:

| Component | Responsibilities (verified) |
|---|---|
| **VPS** (SpeedtestServer + `hybrid/gateway`) | the full NetGauge TCP/TLS plane for official clients (the CLI lane — 100 % of its payload), **UDP packet-loss/jitter**, discovery, session tokens, result intake, stable identity (hostname/ACME), stats |
| **Cloudflare Workers** (`hybrid/worker`) | the **bandwidth-intensive plane** for web and custom clients: NetGauge over **WSS** (`/ws`), HTTP streaming (`/__down`, `/__up`), and the daemon legacy HTTP surface — payload generated/drained **at the edge** |

**Measured (this branch):** a hybrid session moves its payload 100 % through
the edge — 56 MiB at the Worker vs **3 653 bytes** on the VPS (offload ratio
≈ 1 : 16 000); the official host-tester suite passes **10/10** against the
Worker (1.25 GB speed phases through the edge); the unmodified official CLI
**provably cannot** use the edge (its own error: `Protocol error: Did not
receive HELLO` → `NoServers`, exit 2) and instead completes 26 GB runs against
the VPS lane.

## Layout

```
hybrid/
├── worker/        Cloudflare Worker (TypeScript, wrangler)
│   ├── src/       netgauge.ts (WS engine) · http-legacy.ts · token.ts · pool.ts · index.ts
│   ├── test/      conformance battery (62 checks) + token battery + runner
│   └── DEPLOY.md  one-command production deployment
├── gateway/       VPS control plane (zero-dependency Node): discovery, HMAC
│                  session tokens, result intake, TTFB ping
├── probe-client/  hybrid session instrument with per-endpoint byte accounting
├── lab/           experiment harness + evidence (E-A … E-I)
└── reports/       research report + claims register
```

## Quick start (local lab)

```bash
# 1. Worker conformance — 62/62 (needs wrangler; see test/run-tests.sh)
cd hybrid/worker && bash test/run-tests.sh

# 2. Full hybrid session with byte accounting (STS + gateway + workerd)
bash hybrid/lab/harness/run-hybrid-lab.sh

# 3. Official host-tester suite vs the Worker — 10/10
bash hybrid/lab/harness/run-e-g-host-tester.sh
```

## Production

```bash
cd hybrid/worker
wrangler secret put HYBRID_SHARED_SECRET   # shared with the VPS gateway
wrangler deploy                             # → https://speedtest-hybrid-worker.<account>.workers.dev
```

Then on the VPS:

```bash
HYBRID_GATEWAY_PORT=8090 \
HYBRID_SHARED_SECRET=<same secret> \
HYBRID_WORKER_BASE=https://speedtest-hybrid-worker.<account>.workers.dev \
HYBRID_VPS_PUBLIC_BASE=https://origin.example.net \
HYBRID_STS_BASE=https://origin.example.net:8080 \
node hybrid/gateway/src/gateway.mjs
```

Point DNS: `speed.example.net` → the Worker (zone route), `origin.example.net`
→ the VPS. Clients discover both via `GET /api/servers`.

## The one-line protocol map

| Client | Transport | Endpoint | Payload path |
|---|---|---|---|
| Official Ookla CLI | NetGauge TCP (+UDP loss) | VPS `:8080` (STS) | VPS only — edge **proven impossible** (E-D/E-E) |
| Official web / host-tester pattern | WSS | Worker `/ws` | **edge only** (E-G) |
| Custom engine | HTTP(S) | Worker `/__down`,`/__up` | **edge only** (E-I) |
| Any | UDP loss/jitter | VPS `:8080/udp` | VPS only (no UDP ingress at the edge) |

Not affiliated with Ookla. "Speedtest"/"OoklaServer" are Ookla marks; this is
an independent interoperability research project (see the root README).
