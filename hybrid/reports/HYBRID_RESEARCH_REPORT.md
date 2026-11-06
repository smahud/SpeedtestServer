# HYBRID_RESEARCH_REPORT — VPS + Cloudflare Workers hybrid speedtest architecture

**Research directive:** design, investigate, and experimentally validate a hybrid
Ookla-compatible SpeedtestServer architecture where the VPS and Cloudflare
Workers cooperate, with the official, unmodified Ookla Speedtest CLI as the
primary interoperability instrument.

**Branch:** `hybrid-vps-workers` · **Date:** 2026-11-06 · **Environment:**
isolated lab (this session), official CLI `1.2.0.84 (ea6b6773cf)` sha256-verified
against `validation/REFERENCE_BINARY_MANIFEST.md`, reference daemon
2.11.5.2 (`ce180aa3…598159` tarball / `f19e5ed2…` binary), SpeedtestServer
baseline re-verified (build clean, 160/160 tests), wrangler 4.158.0 /
workerd local, real Cloudflare production edge (HKG) probed first-hand.

**Evidence convention:** every load-bearing claim carries an experiment ID
(`hybrid/lab/evidence/…`) or a platform citation; the claims register is
`hybrid/reports/WORKERS_LIMITS.md`.

---

## 1. Executive verdict (the 8 success criteria)

| # | Criterion | Verdict | Key evidence |
|---|---|---|---|
| 1 | Which operations the **VPS** handles | **All native-socket operations**: the full NetGauge TCP/TLS plane for official clients (selection, latency PING, DOWNLOAD, UPLOAD), **UDP packet-loss/jitter** (no UDP ingress exists at the edge), discovery/config, session-token minting, result intake & persistence, stable server identity (ACME/TLS, hostname), and the whole CLI lane | baseline contract §1–§3 [P]; E-I control plane |
| 2 | Which operations **Cloudflare Workers** handle | **The entire web-client measurement plane** (NetGauge over WSS: HI→HELLO, PING/PONG, DOWNLOAD binary-frame streams, UPLOAD drain+count, PLOSS accounting over WS) **and the custom-client HTTP plane** (`__down`/`__up` streaming, legacy HTTP surface incl. `random*.jpg` and `upload.php`) — payload generated/drained **at the edge** | W-7…W-10: 62/62 conformance, E-G 10/10, E-I |
| 3 | How both cooperate **within one session** | **Custom clients: tight split** — one token-bound session does VPS discovery+ping+token → edge throughput → VPS result intake (E-I). **Official web clients: session-level selection** — the Worker serves the whole measurement, the VPS receives results via intake (control-plane cooperation, zero payload transit). **Official CLI: no within-session cooperation is possible** — proven, not assumed | E-I; E-G; E-D/E-E |
| 4 | Does the **unmodified official CLI** support the architecture | **For the edge: NO — now experimentally proven.** Offered CF-fronted endpoints the CLI answers `Protocol error: Did not receive HELLO` per candidate and `NoServers` overall (exit 2), with **no HTTP fallback**; in a mixed list it selects only the protocol-compatible VPS. **For the VPS: YES** — full 26 GB run against STS (17.4 Gbps↓ / 13.3 Gbps↑, loss 0) | E-D, E-E; baseline 7/7 gate |
| 5 | Can download/upload payloads **bypass the VPS** | **Web/custom lanes: 100 %** — payload flows client↔edge only (E-I: 56 MiB at edge, 3 653 B on VPS; E-G: 1.25 GB through the Worker). **CLI lane: no** — every byte terminates on the VPS (E-E corroboration: 26.15 GB server-side) | E-I, E-G, E-E |
| 6 | How much VPS bandwidth is actually saved | Web/custom sessions move ~**2.3 GB-class payloads at the edge** and leave ~**3–5 KB** of control plane on the VPS — **offload ratio ≈ 1 : 16 000 measured** (E-I), i.e. >99.99 % of session bytes. A 1 000-test/day web workload drops from ~2.3 TB/day of VPS transit to ~5 MB/day | E-I + E-G + baseline CLI byte profile |
| 7 | Required infrastructure/protocol changes | DNS split (edge hostname vs origin hostname), shared HMAC secret (`wrangler secret put`), Worker deploy (1 command), the gateway service on the VPS, token-aware client (web/custom), no change to STS parity surface | §5 below |
| 8 | Production suitability | **Yes for the operator-branded speedtest product** (the realistic deployment: your domain, your customers — exactly the speed.cloudflare.com pattern on your own VPS identity). **No for entering Ookla's public server list** — that requires the official daemon (VPS-only) and Ookla's commercial approval; the closed-list constraint is CLI-inherent (E-o), independent of Workers | §6 below |

**The one-sentence answer:** the hybrid is real and measured — the VPS keeps
everything that needs native sockets and stable identity, Workers takes the
entire bandwidth-intensive plane for every client that can speak
HTTP/WebSocket (web + custom), and the official CLI is *provably* locked to
the VPS lane by its own protocol behavior on the CF edge.

---

## 2. The routing-layers framework (where work can be split)

All evidence, baseline and new, organizes into three routing layers. Workers'
ingress constraint (HTTP/WS only — W-1/W-3) decides its position at each layer:

| Layer | Granularity | Mechanism | Can Workers participate? |
|---|---|---|---|
| **L1 — per-session backend selection** | whole session | server-list / DNS: the client picks ONE endpoint per run | **Web/custom clients: YES** (the WSS/HTTP endpoint *is* a Worker). **CLI: NO** — selection requires NetGauge HELLO; CF endpoints fail (`Latency test failed`), and unlisted hosts are refused outright (E-o, W-5/W-6) |
| **L2 — per-connection split** | within one session, at connection boundaries | a TCP/UDP-capable endpoint fans connections out to different backends (baseline diverter: selection→daemon, measurement→STS, verified 3/3 [P]) | **NO** — the fan-out point must speak raw TCP+UDP, which the GA edge does not offer (W-1/W-3). This layer exists only on the VPS side |
| **L3 — per-command routing** | individual commands | protocol-aware routing inside plaintext sessions | **NO** — needs L2's transport plus plaintext visibility; encrypted CLI sessions are opaque (baseline [P]); irrelevant for web clients whose whole session can live at the edge anyway |

**Consequence for the directive's questions:**
- *Routing at the connection boundary* (L2) is real but VPS-local — it splits
  work between backends **behind one endpoint**, so it never offloads VPS
  bandwidth. Verified by the baseline (F5-n22, 3/3); consistent with all new
  evidence.
- *DNS/IP-based backend selection* (L1) is the **only layer that can send
  payload to the edge**, because DNS/config is where a hostname (and thus a
  CF-fronted endpoint) enters the picture. The CLI resolves once per run and
  never re-resolves [P] — DNS is a per-RUN knob, not per-phase.
- *Protocol-aware routing* (L3) is closed for encrypted CLI sessions [P] and
  unnecessary for the web lane (the Worker *is* the protocol endpoint).

---

## 3. Experiment log (what was run, what it proved)

| ID | Question | Method | Result |
|---|---|---|---|
| **E-A** | What does the REAL CF edge do with NetGauge bytes? | 16 raw-socket probes (NetGauge `HI\n`, TLS-record-shaped binary, valid HTTP, WS-upgrade) × {speed.cloudflare.com, cli.speedtest.net} × {8080, 443} | Non-HTTP bytes → `HTTP/1.1 400 Bad Request, Server: cloudflare` on every port/host; valid HTTP → 301 (speed.cloudflare.com) or silent (cli.speedtest.net). **The edge never speaks NetGauge** [W-1] |
| **E-B** | Does local workerd match the edge classification? | Same probes vs `wrangler dev` | 400 for NetGauge bytes; 200 for HTTP; **101 on WS upgrade at `/ws`** — the local runtime reproduces the production ingress decision boundary [W-2] |
| **E-D** | Can the official CLI use non-NetGauge (CF) endpoints? | Config-proxy (per-entry rewrite) lists only CF:8080, CF:443, workerd:8790, closed port; unmodified CLI, non-publishing | 8× `Protocol error: Did not receive HELLO` (the CLI's own log base64-decodes to the CF 400 page and a TLS fatal alert `protocol_version`), 2× `[111] Connection refused`, final `Server Selection - Failed to find a working test server. (NoServers)`, **exit 2**. No HTTP fallback attempted [W-4] |
| **E-E** | Hybrid candidate list: edge + VPS | List = [CF:8080, STS:8080]×5; CLI selects and runs | CF entries fail selection (`Latency test failed`); STS selected (0.025 ms); **full run: 9.96 GB↓ / 15.98 GB↑ (17.4/13.3 Gbps), packetLoss 0, non-publishing**; STS evidence log corroborates 26.15 GB server-side (ratio 1.008) [W-6] |
| **E-o** | Can the CLI be aimed at an arbitrary host in production? | Direct (unproxied) `-o speed.cloudflare.com:8080` after a working direct `-L` | `Configuration - No servers defined (NoServersException)` — the official list is closed; config endpoint itself reachable (same 10 HK servers as baseline) [W-5] |
| **E-G** | Does the Worker satisfy the official host-tester suite? | Speedtest Host Tester v1.1.0 (same checks as speedtest.net/host-tester; 10/10 parity with the official daemon in the baseline) vs the Worker through the edge-emulation front (TLS/plain multiplex + edge `Connection` header) | **10/10 PASS, exit 0, verdict "Server is publicly available and properly configured"** — incl. wss HI→HELLO/PING→PONG, TLSv1.3, keep-alive, latency.txt, 10/10 images, upload.php, crossdomain; speed phases moved **1.25 GB** (814 MB↓ via images + 468 MB↑ via WS-NetGauge UPLOAD) entirely through the Worker [W-9] |
| **E-I** | Full hybrid session with byte accounting | probe-client: discovery → token → VPS TTFB ×10 → edge TTFB ×10 → 6×WS DOWNLOAD (8 MiB each) → 4×WS UPLOAD (2 MiB each) → result intake | **Payload 56 MiB at the edge; VPS served 3 653 B** (discovery+token+10 pings+result). Offload ratio 1:16 075. Gateway counters corroborate (4.1 KB total incl. headers) [W-10] |
| Conformance | Is the Worker protocol-correct? | 62-check battery vs workerd (34 WS + 21 HTTP + 7 token) | 62/62 PASS [W-7/W-8] |
| Baseline gates | Is the environment faithful? | STS 160/160 tests; CLI 1.2.0.84 sha256; daemon banner parity | All PASS (this session) |

**Quota/ethics notes:** official CLI runs were non-publishing
(`results.speedtest.net` refused by the lab proxy; `resultUrl` absent from
output); 4 live config fetches consumed; no CLI modification; no result
publication; device identity sanitized in committed evidence.

---

## 4. The verified hybrid architecture (HYBRID-1)

```
                         ┌──────────────────────────────────────────────┐
                         │                 SPEEDTEST CLIENTS             │
                         │  ┌──────────┐ ┌──────────┐ ┌───────────────┐  │
                         │  │ official │ │ official │ │ custom (web/  │  │
                         │  │   CLI    │ │ web (WS) │ │ TS engine)    │  │
                         │  └────┬─────┘ └────┬─────┘ └──────┬────────┘  │
                         └───────┼────────────┼───────────────┼──────────┘
        NetGauge TCP+TLS+UDP     │            │ WSS / HTTPS   │ HTTP + WSS
        (E-D/E-E: CF impossible) │            │               │
                         ┌───────▼────────────▼───────────────▼──────────┐
                         │            L1 — SESSION SELECTION             │
                         │   DNS/config decides: edge hostname or origin  │
                         └───────┬────────────────────────────┬──────────┘
                                 │ (CLI only)                 │ (web/custom)
                 ┌───────────────▼──────────┐   ┌─────────────▼───────────────┐
                 │        VPS (origin)      │   │   CLOUDFLARE WORKERS (edge) │
                 │ • STS :8080 — full       │   │ • /ws — NetGauge over WSS   │
                 │   NetGauge TCP/TLS +     │   │   (HI/PING/DOWNLOAD/UPLOAD)│
                 │   UDP loss/jitter  [CLI  │   │ • /__down /__up — HTTP      │
                 │   lane: 100 % of payload]│   │   streaming throughput      │
                 │ • gateway :8090 —        │   │ • legacy HTTP surface       │
                 │   discovery, HMAC tokens,│   │   (random*.jpg, upload.php) │
                 │   result intake, TTFB    │   │ payload generated/drained   │
                 │ • identity: hostname,    │   │ AT THE EDGE — the VPS never │
                 │   ACME/TLS, persistence  │   │ sees a payload byte         │
                 └───────────┬──────────────┘   └─────────────┬──────────────┘
                             │      shared HMAC secret (mint on VPS,        │
                             │      verify at edge — zero subrequests)      │
                             └──────────────────┬───────────────────────────┘
                                                │ result intake (KB-scale)
                                                ▼
                                    VPS stores / aggregates
```

**Responsibility matrix (the evidence-based split):**

| Operation | VPS | Worker | Why |
|---|---|---|---|
| Discovery / endpoint map | ✅ (`/api/servers`) | — | single source of truth, operator control |
| Session tokens | ✅ mint | ✅ verify (local HMAC) | stateless, 0 subrequests, works in every PoP |
| Latency (idle, stable identity) | ✅ TTFB + UDP | ✅ WSS PING / `bytes=0` (comparative) | anycast makes edge latency PoP-relative; label both |
| Jitter / packet loss (UDP) | ✅ **only** | ❌ no UDP ingress | W-3; STS UDP plane already verified |
| Download payload | fallback only | ✅ **primary** (WS frames / HTTP stream, edge-generated) | E-G/E-I; zero egress cost |
| Upload payload | fallback only | ✅ **primary** (WS drain+count / `__up`) | E-G/E-I |
| CLI measurement (all phases) | ✅ **only** | ❌ proven impossible today | E-D/E-E + W-1/W-3 |
| Result persistence / stats | ✅ | — (optionally reports via 1 fetch) | E-I |
| TLS identity | ✅ ACME/custom | edge cert (CF-managed) | D-W9 |

---

## 5. Required changes for production (criterion 7)

1. **DNS**: `speed.example.net` → Worker (zone route or workers.dev);
   `origin.example.net` → VPS. The discovery document (`/api/servers`) hands
   both to clients.
2. **Secret**: `wrangler secret put HYBRID_SHARED_SECRET` (same value as the
   gateway's) — one command, no other runtime coupling.
3. **Deploy**: `cd hybrid/worker && wrangler deploy` (see `DEPLOY.md`).
4. **VPS**: run the gateway (`node gateway.mjs` + env) next to STS
   (`:8080`). No change to STS's OoklaServer-parity surface (the control
   plane lives on its own port — the differential gates stay byte-clean).
5. **Client**: web page uses WSS `HI → PING/DOWNLOAD/UPLOAD` (host-tester
   pattern, E-G-proven) or the HTTP `__down`/`__up` pair (speed.cloudflare.com
   pattern); token from `POST /api/sessions`.
6. **Optional hardening**: Turnstile/WAF/rate-limiting on the Worker;
   DO-hibernation if concurrent-WS scale demands it.

## 6. Production assessment (criterion 8)

**Suitable — for the operator-branded product lane.** The architecture is the
proven speed.cloudflare.com pattern re-composed around the operator's own VPS
identity: the VPS keeps discovery/identity/UDP/CLI, the edge takes the
bandwidth. Measured effects: web-lane sessions leave ~KB on the VPS instead
of ~2.3 GB; the edge adds 330+ PoPs of download/upload capacity that the
Node-based STS (30–37 % of the native daemon's single-core throughput [P])
could never supply; edge egress is free.

**Caveats (honest):**
- **Metrics are lane-labeled**: edge throughput measures the client↔PoP path,
  not client↔VPS. Offer both numbers (E-I measures both latencies) — the
  same transparency speed.cloudflare.com applies.
- **Anycast PoP variance**: record colo (already in `__meta`/headers).
- **CPU tier**: free tier's 10 ms/request is tight for long WS sessions under
  load; the paid plan (30 s default) is the production assumption.
- **Request-body cap** (100–200 MB non-Enterprise): uploads are chunked by
  design (WS UPLOAD at 1–4 MiB/command in E-G; HTTP ≤25 MB/chunk guidance).
- **Not suitable for Ookla's public list**: listing requires the official
  daemon (VPS-only) and Ookla approval; the CLI's closed discovery (E-o)
  binds that lane to the program, independent of any Workers capability.
- **Emerging path to re-evaluate**: Workers inbound TCP (`connect(socket)`
  via Spectrum) is in **private beta** (2026-08-03). If it reaches GA with
  self-serve access, the CLI-lane offload question can be re-opened — though
  UDP-in-Workers remains undocumented, and the closed server list would still
  gate production CLI use.

## 7. What was deliberately NOT done

- No modification of the official CLI (sha256-verified; only runtime flags).
- No result publication (non-publishing guarantee, verified per run).
- No proprietary binaries committed (CLI stays outside the repo; daemon already
  governed by the baseline manifest).
- No silent substitution of the hybrid objective: the negative CLI results are
  reported as measured, and the closest legitimate alternative (official
  host-tester lane + custom-client lane, both at the edge with the VPS as
  control plane) is the delivered architecture.

## 8. Reproduction

```bash
# Worker conformance (62/62)
cd hybrid/worker && bash test/run-tests.sh

# E-A/E-B ingress probes (real edge + local workerd)
python3 hybrid/lab/harness/e-a-cf-edge-probe.py hybrid/lab/evidence/e-a.jsonl
python3 hybrid/lab/harness/e-b-workerd-probe.py hybrid/lab/evidence/e-b.jsonl 8790

# E-G host-tester vs Worker (10/10)
bash hybrid/lab/harness/run-e-g-host-tester.sh

# E-I hybrid session + byte accounting
bash hybrid/lab/harness/run-hybrid-lab.sh

# E-D/E-E official-CLI experiments (quota-aware, non-publishing)
EXP_ID=e-d-… NEED_WORKER=1 SERVERS="speed.cloudflare.com:8080,…" \
  bash hybrid/lab/harness/run-cli-experiment.sh
```
