# WORKERS_LIMITS — verified claims register for the hybrid research

Labels: **[V-lab]** verified first-hand in this research (experiment IDs in
`hybrid/lab/evidence/`), **[V-doc]** verified against live Cloudflare
documentation/infrastructure during this research (2026-11-06),
**[P]** inherited verified evidence from the baseline repository
(`validation/`), **[D]** documented platform fact cited but not re-verified.

## 1. Ingress capability (what can REACH a Worker)

| # | Claim | Label | Evidence |
|---|---|---|---|
| W-1 | The production Cloudflare edge answers non-HTTP bytes (NetGauge plaintext `HI\n`, TLS-record-shaped binary) on HTTP ingress ports (8080) and on 443 with **HTTP/1.1 400 Bad Request** (`Server: cloudflare`) — no ingress path speaks NetGauge | **[V-lab]** | E-A: 16 probes vs `speed.cloudflare.com` and `cli.speedtest.net`, `e-a-cf-edge-probes.jsonl` |
| W-2 | Local workerd classifies the same byte classes identically (400 for NetGauge bytes; 101 on WS upgrade for `/ws`) | **[V-lab]** | E-B, `e-b-workerd-probes.jsonl` |
| W-3 | Workers accept inbound HTTP/HTTPS and WebSocket only (GA). Raw TCP inbound exists solely as a **private beta** `connect(socket)` handler routed via Spectrum (announced 2026-08-03); no GA docs, no self-serve deployment path, no UDP-in-Workers documented | **[V-doc]** | blog.cloudflare.com/grpc-workers (private beta); developers.cloudflare.com/spectrum/reference/configuration-options (GA Spectrum = L4 proxy to IP/DNS origins, Enterprise features; "L4 payloads … passed back and forth as-is") |
| W-4 | The official CLI, offered Cloudflare-fronted endpoints in its server list, fails each probe with its own diagnosis `Protocol error: Did not receive HELLO` and the run fails `NoServers` (exit 2); the CLI has **no HTTP fallback transport** | **[V-lab]** | E-D, `e-d-all-non-netgauge/` (CF 400 pages + TLS fatal alerts `15 03 01 00 02 02 46` decoded from the CLI's base64 log) |
| W-5 | The official CLI filters `-o`/`-s` against the official server list only; an unlisted host is refused (`NoServersException`) even when the config endpoint is directly reachable | **[V-lab]** | E-o: direct `-L` run OK (same 10 HK servers as baseline evidence), then `-o speed.cloudflare.com:8080` → `No servers defined (NoServersException)` |
| W-6 | In a mixed candidate list, the CLI selects only protocol-compatible endpoints: CF entries → `Latency test failed`; VPS (STS) entries selected and serve the full session (26 GB, exit 0, loss 0) | **[V-lab]** | E-E, `e-e-mixed-cf-plus-sts/` (client 25.9 GB vs STS evidence-log 26.15 GB, ratio 1.008) |

## 2. What a Worker CAN serve (verified positive results)

| # | Claim | Label | Evidence |
|---|---|---|---|
| W-7 | A Worker speaks the full NetGauge command protocol over WebSocket (`/ws`): HI/HELLO (no trailing newline quirk), GETIP, CAPABILITIES, SERVERID, UPTIME, PING/PONG, INITPLOSS/PLOSS, UPLOAD_STATS→ERROR, DOWNLOAD (exact n-byte streams as binary frames), UPLOAD (inclusive counting), QUIT→ERROR, one-command-per-frame, GETIP strictness/muting, no three-strikes | **[V-lab]** | `hybrid/worker` conformance battery: 34/34 WS checks vs local workerd |
| W-8 | A Worker serves the daemon HTTP surface functionally: `/`, `/hi`, `latency.txt`, `crossdomain.xml`, `random{N}x{N}.jpg` (14 exact sizes, exact Content-Length ≤ 1 MiB), `upload.php` (`size=N`), 404 shape, UA-required semantics | **[V-lab]** | 21/21 HTTP checks + 8/8 hybrid endpoint checks (62/62 total incl. token mode) |
| W-9 | The official host-tester check suite (same checks as speedtest.net/host-tester) **passes 10/10 against the Worker** with the verdict string identical to the official daemon's ("Server is publicly available and properly configured"), and real speed phases move GB-scale payload entirely through the Worker (814 MB down via `random4000x4000.jpg` + 468 MB up via WS-NetGauge UPLOAD; 1.25 GB total) | **[V-lab]** | E-G, `e-g-host-tester-vs-worker/` |
| W-10 | A complete hybrid session (discovery → token → VPS TTFB pings → edge TTFB → 6-connection WS download → 4-connection WS upload → result intake) runs end-to-end with the payload 100 % at the edge: 56 MiB payload vs **3 653 B** VPS control-plane bytes (offload ratio ≈ 1 : 16 000) | **[V-lab]** | E-I, `e-i-hybrid-session.json` + gateway counters |

## 3. Platform limits relevant to a speedtest workload (2026-11-06)

| Aspect | Value | Label |
|---|---|---|
| HTTP request wall-clock duration | no limit | [V-doc] workers/platform/limits |
| Response body size | no enforced limit | [V-doc] idem |
| Request body size | 100 MB Free/Pro · 200 MB Business · ≤5 GB Enterprise — uploads must be chunked (WS UPLOAD / HTTP `__up` ≤ 25 MB/chunk recommended) | [V-doc] idem |
| CPU time per request | 10 ms Free · 30 s default / 5 min max Paid | [V-doc] idem |
| Memory per isolate | 128 MB — pool generation is 2 MiB; streams never buffer whole bodies | [V-doc] idem + [V-lab] implementation |
| Subrequests | 50 Free / 10 000 Paid — hybrid token verification is local HMAC (0 subrequests) | [V-doc] + implementation |
| Simultaneous outbound conns awaiting headers | 6 per invocation (inbound client WS not covered by this limit; DO hibernation available for scale) | [V-doc] idem |
| Egress bandwidth cost | Workers billed per request/CPU, not per byte | [D] workers/platform/pricing |

## 4. Platform behaviors that differ from a native server (documented deviations of `hybrid/worker`)

| ID | Deviation | Why | Evidence |
|---|---|---|---|
| D-W2 | Status line always HTTP/1.1+ (daemon echoes request version) | Runtime owns the protocol | E-B vs baseline differential |
| D-W3 | Oversized WS frames: close(1009) without reply instead of raw TCP RST | No socket-level API in Workers | F-27 parity intent |
| D-W4 | `GET /ws` without upgrade → minimal 500 instead of silent socket hold | Workers cannot hold sockets open | conformance check |
| D-W5 | Connection framing/header order runtime-controlled (semantic set matches) | Runtime owns framing | E-B + conformance |
| D-W6 | `upload.php` answers every POST (daemon never answers chunked bodies) | Framing not observable in Workers | conformance |
| D-W8 | `random{N}x{N}.jpg` > 1 MiB streams with chunked framing (exact byte totals; CL preserved ≤ 1 MiB) | Memory-safe streaming | conformance |
| D-W9 | `Connection: keep-alive` header cannot be set by a Worker (hop-by-hop). The REAL edge adds it on HTTP/1.1 responses itself — verified first-hand — so production responses carry it; local workerd omits it (the lab edge-front emulates the production behavior for instruments) | Fetch spec / runtime | E-A http_get probe + `curl --http1.1 https://speed.cloudflare.com/__down` |

## 5. Complementary Cloudflare services — evaluated

| Service | Verdict for the hybrid architecture | Reason |
|---|---|---|
| Spectrum (GA) | **Not an offload path.** It is an L4 proxy to an ORIGIN (IP/DNS) — payload transits CF→VPS→CF; no Worker code on the TCP path; Enterprise features. The only theoretical CLI→CF transport path, and it *increases* VPS transit | [V-doc] Spectrum config docs |
| Workers inbound TCP (`connect(socket)`, private beta) | **Emerging path, not deployable today.** If it reaches GA it could let a Worker speak NetGauge-TCP directly (CLI-lane offload becomes re-evaluable); UDP-in-Workers undocumented; Ookla's closed server list (W-5) still gates production CLI use regardless of transport | [V-doc] blog 2026-08-03 |
| Cloudflare Tunnel (cloudflared) | **Rejected.** Ingress-to-VPS product; TCP mode requires client-side cloudflared (the CLI cannot); adds CF transit, offloads nothing | [D] product docs |
| R2 | **Rejected as unnecessary.** Download payloads are synthetic (2 MiB printable pool, generated per isolate); no storage needed | design |
| Durable Objects | **Not needed for correctness** (stateless speedtest; stateless HMAC tokens). Optional for WS-hibernation at scale and for cross-chunk upload accounting if a future client needs it | design |
| Cache/CDN | **Optional micro-optimization** for the legacy HTTP image paths on a real zone (cacheable static sizes); irrelevant to WS/NetGauge lanes | [D] |
| Turnstile / WAF / rate limiting | **Recommended for production hardening** of the public Worker endpoints (abuse control beyond tokens) | [D] |
