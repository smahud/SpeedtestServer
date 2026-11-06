# DEPLOY — speedtest-hybrid-worker on the real Cloudflare edge

The Worker is deploy-ready: stateless, no bindings, no build step beyond
wrangler's bundling. Everything below was validated locally on workerd
(wrangler 4.158.0, 62/62 conformance) — the real-edge deltas are documented
in `../reports/WORKERS_LIMITS.md` (notably D-W9: the real edge adds
`Connection: keep-alive` on HTTP/1.1 itself, which local workerd omits).

## 1. Prerequisites

- A Cloudflare account (Workers Free works for evaluation; Workers Paid is
  the production assumption — 30 s CPU default vs 10 ms on Free).
- `npm i -g wrangler` (or use npx) and `wrangler login`.

## 2. Configure

Secrets (never in `wrangler.toml`):

```bash
wrangler secret put HYBRID_SHARED_SECRET   # the same value as the VPS gateway
```

Optional vars (edit `wrangler.toml`):

| Var | Default | Meaning |
|---|---|---|
| `VERSION_STRING` | `2.11 (2.11.5) 2026-06-04.1737.7d0993d` | NetGauge banner |
| `ALLOWED_DOMAINS` | `*` | CSP / crossdomain / CORS list (daemon semantics) |
| `WS_FRAME_LIMIT_BYTES` | `5242880` | max WS message size |
| `MAX_DOWNLOAD_BYTES` / `MAX_UPLOAD_BYTES` | 2 GiB | per-command caps |

## 3. Deploy

```bash
cd hybrid/worker
wrangler deploy
# → https://speedtest-hybrid-worker.<your-subdomain>.workers.dev
```

On a custom zone (recommended for production — TLS + hostname identity):

- DNS: `speed.example.net` CNAME/proxied on your zone
- Route: `speed.example.net/*` → this Worker (or a Custom Domain)

## 4. Post-deploy validation

```bash
BASE=https://speed.example.net

curl -s $BASE/__meta | jq .colo          # which PoP served you
curl -s $BASE/hi                          # hello 2.11 (2.11.5) …
curl -s "$BASE/__down?bytes=1000000" -o /dev/null -w '%{size_download}\n'   # 1000000

# WS conformance against the real edge (token mode optional):
node test/conformance.mjs $BASE
node test/token-tests.mjs $BASE            # only if HYBRID_SHARED_SECRET is set
```

The local conformance battery runs unchanged against the deployed URL
(it auto-detects the base). The host-tester suite
(`smahud/SpeedtestHost-Tester`, z.ai CLI) can be aimed at the deployed
hostname for the full 10-check validation.

## 5. Operations notes

- **Observability**: `[observability] enabled = true` in `wrangler.toml`;
  JSONL events (sessions, downloads, uploads, errors) via `wrangler tail`.
- **Scaling**: Workers scale per-PoP automatically; for very high concurrent
  WS counts consider Durable-Object hibernatable sockets (not required for
  correctness — the engine is stateless).
- **Abuse control**: session tokens (HMAC, short `exp`) gate `/ws`,
  `/__down`, `/__up` once the secret is set; add WAF/Turnstile/rate-limiting
  rules on the zone for defense in depth.
- **Uploads**: keep chunks ≤ 25 MB per request (request-body cap is
  100 MB Free/Pro, 200 MB Business); WS `UPLOAD` commands of 1–4 MiB
  (as used in the validated host-tester flow) are the tested pattern.
- **Never** put the VPS's NetGauge TCP plane behind the Worker — the official
  CLI requires raw TCP (see the research report, experiments E-D/E-E).
