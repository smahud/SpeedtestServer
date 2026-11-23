# DEPLOY — speedtest-hybrid-worker on the real Cloudflare edge

> **Revision 2 — 2026-11-24.** Revision 1 assumed Workers Paid. It also
> claimed that the token battery and the host-tester suite can be pointed
> at a deployed hostname. Both claims were wrong. The authoritative design
> and decisions now live in
> [`docs/SPEEDTEST_HYBRID_CLOUDFLARE_FREE.md`](../../docs/SPEEDTEST_HYBRID_CLOUDFLARE_FREE.md)
> (Versi 2). If the two documents disagree, the design document wins.
> Operator-specific commands (ports, units, rollback) belong in
> `docs/HYBRID_DEPLOYMENT_RUNBOOK.md`.

The Worker is stateless. It has no bindings and needs no build step beyond
wrangler's bundling. Everything it currently claims was validated locally
on workerd (wrangler 4.158.0, 62/62 conformance). **It has never been
deployed to a real Cloudflare account.** Known real-edge deltas are listed
in `../reports/WORKERS_LIMITS.md`. For example, D-W9: the real edge adds
`Connection: keep-alive` on HTTP/1.1 responses, which local workerd omits.

## 0. Hard rules for this operator's deployment

- **Never** attach this Worker to the registered Ookla host
  `speedtest.lumajangnetworks.my.id`. That covers routes, Custom Domains
  and orange-cloud proxying of the host, the apex, or an existing
  wildcard record. The official host tester needs raw NetGauge TCP and
  TLS on port 8080, and the Cloudflare edge cannot provide either.
- **Never** put the VPS's NetGauge TCP plane behind the Worker. The
  official CLI requires raw TCP (see experiments E-D/E-E).
- The pilot runs on `workers.dev`. A Custom Domain such as
  `bandwidth.lumajangnetworks.my.id` needs two things first: the zone must
  be active on Cloudflare, and the operator must approve.

## 1. Prerequisites

- A Cloudflare account on **Workers Free**. On Free each invocation gets
  10 ms CPU and the account gets 100,000 requests per day. Re-check these
  limits in the live Cloudflare docs at deploy time and record the date.
- Node.js and `npx wrangler@4`. Record the exact wrangler version you
  used.
- Non-interactive auth (VPS/headless). `wrangler login` needs a browser,
  so use environment variables instead. Confirm the variable names in the
  wrangler docs for your version.
  - Preferred: a scoped API token, `CLOUDFLARE_API_TOKEN` +
    `CLOUDFLARE_ACCOUNT_ID`.
  - Fallback: Global API Key, `CLOUDFLARE_API_KEY` + `CLOUDFLARE_EMAIL`.
  - Keep credentials in a `0600` file outside the repository and
    `source` it only for the commands that need it. Never `set -x`.
    Never echo the values.
- The account must already have a `workers.dev` subdomain. If it does
  not, registering one is an account-level change. Get operator approval
  first.

## 2. Configure

The secret never goes in `wrangler.toml`. Pipe it through stdin, never as
a command-line argument:

```bash
printf '%s' "$HYBRID_SHARED_SECRET" | npx wrangler secret put HYBRID_SHARED_SECRET
```

Use the same value as the VPS gateway.

Vars in `wrangler.toml`:

| Var | Default in code | Workers Free guidance |
|---|---|---|
| `VERSION_STRING` | `2.11 (2.11.5) 2026-06-04.1737.7d0993d` | keep |
| `ALLOWED_DOMAINS` | `*` | keep, or restrict to the portal origins |
| `WS_FRAME_LIMIT_BYTES` | `5242880` | keep |
| `MAX_DOWNLOAD_BYTES` / `MAX_UPLOAD_BYTES` | 2 GiB (0x7fffffff) | **must be set**. Start at 16–25 MiB, then fix the final value from real-edge CPU measurements. |
| `LEGACY_HTTP_ENABLED` (to be added, gap G-7) | `false` | `false` in production, `true` only for local tests and the test Worker |

Also set `workers_dev = true` and `preview_urls = false` for the pilot.
Define a separate `[env.test]` (name `speedtest-hybrid-worker-test`) for
open-mode conformance runs and CPU measurements. Environments do **not**
inherit `[vars]`, so `[env.test.vars]` must repeat every var it needs:

- caps of `33554432` (32 MiB), because conformance streams 25,000,000
  bytes and the measurements go up to 32 MiB;
- `LEGACY_HTTP_ENABLED = "true"`;
- write `preview_urls = false` explicitly under `[env.test]` as well.

See the full snippet in the design document §6 Fase C.

## 3. Deploy

```bash
cd hybrid/worker
npx wrangler deploy --env test   # open mode (no secret), conformance + CPU measurements
npx wrangler deploy              # production name, after the secret is set
# → https://speedtest-hybrid-worker.<your-subdomain>.workers.dev
```

Record the wrangler version, the `compatibility_date`, the deployment ID
(`npx wrangler deployments list`) and the URL.

## 4. Post-deploy validation

```bash
BASE=https://speedtest-hybrid-worker-test.<subdomain>.workers.dev   # test Worker, open mode

curl -s $BASE/__meta | jq .colo                                         # which PoP served you
curl -s "$BASE/__down?bytes=1000000" -o /dev/null -w '%{size_download}\n'   # 1000000
node test/conformance.mjs $BASE                                          # open mode only
```

- `conformance.mjs` passes **only** against an open-mode deployment.
  Against a Worker that has a secret, every `/ws`, `__down` and `__up`
  check returns 401.
- `token-tests.mjs` hard-codes secret `testsecret123` and client IP
  `127.0.0.1`. It cannot pass against a real deployment until the secret
  and IP are parameterised via env (gap G-10). Against production, run
  the negative token checks: missing, malformed, wrong-secret and expired
  tokens must all return 401. Then run the positive path through the
  gateway with `hybrid/probe-client`.
- Measure CPU time per invocation with Workers Analytics or
  `npx wrangler tail --format json`. Measure each of these:
  - cold pool generation
  - `__down` at 1, 4, 16 and 25 MiB
  - `__up` at 4, 16 and 25 MiB
  - WS `DOWNLOAD` at 4, 8 and 32 MiB
  - WS `UPLOAD`

  Record every CPU-exceeded, 1102, 1027, 429 and 413 error. Store the
  evidence in `hybrid/lab/evidence/e-j-real-edge/`. Use `.jsonl`/`.txt`
  files, because the root `.gitignore` ignores `*.log`. Keep test traffic
  under 20,000 invocations per UTC day. Never exhaust the real account
  quota: test quota-error handling only with mocked responses on the
  client.
- **When the measurements are done, delete the test Worker**
  (`npx wrangler delete --env test`) or disable its URL. An open-mode
  Worker with the legacy surface on can be used by anyone to drain the
  account's daily quota.
- **The host-tester suite is not a deployment check for this Worker.**
  Experiment E-G got its "10/10" from the z.ai clone v1.0.1 in a lab setup:
  - It targeted a local front that served self-signed TLS and plain HTTP
    on one port and injected `Connection: keep-alive`.
  - Behind that front sat an open-mode workerd.
  - Uploads went through `upload.php` (213 POSTs), not WS UPLOAD.

  A real Cloudflare hostname cannot serve plain HTTP and HTTPS on the same
  port. With tokens enabled, `/ws` also returns 401 to a tokenless tester.

## 5. Rollback

- `npx wrangler deployments list`, then
  `npx wrangler rollback <version-id>` to return to a previous version.
- Fastest mitigation: stop issuing hybrid sessions at the VPS gateway, or
  lower `MAX_*` and redeploy.
- If a Custom Domain was attached, remove that binding. Do not touch any
  other DNS record.

## 6. Operations notes

- **Observability**: `[observability] enabled = true`, and JSONL events go
  to `wrangler tail`. Per-command `ng_cmd` logging is noisy and costs CPU,
  so reduce it before production.
- **CPU and memory on Free**: two known risks remain unmeasured on the
  real edge (gaps G-5 and G-6):
  - The 2 MiB pool is built with a ~2M-iteration JS loop per cold isolate.
  - `__down` and WS `DOWNLOAD` copy every chunk without backpressure.
- **WebSocket on Free**: according to the older design notes
  (`speedtest-cli_analysis/hybrid-architecture/README.md`), an upgrade
  counts as one request and messages are not counted. Re-verify that.
  How CPU is accounted over a long WS session is not yet verified. Do not make `/ws`
  the primary Free lane until it has been measured.
- **Abuse control**: HMAC session tokens (short `exp`) gate `/ws`,
  `/__down` and `/__up` once the secret is set. The legacy HTTP surface
  (`random*.jpg`, `upload.php`) is **not** token-gated. Disable it in
  production (G-7).
- **Token IP binding**: the gateway currently binds tokens to its socket
  peer address. Clients behind a proxy, or dual-stack clients (IPv4 to the
  VPS, IPv6 to Cloudflare), fail with `ip-mismatch`. Fix this in the
  gateway (G-1) before any external test.
- **Uploads**: keep each request at or below the configured cap (start
  at 16–25 MiB). The request-body cap is 100 MB on Free/Pro zones.
- **Lab harness**: `hybrid/lab/harness/run-hybrid-lab.sh` starts a lab
  daemon on TCP+UDP **8080** and writes into `hybrid/lab/evidence/`.
  Never run it on the production VPS until its ports and output
  directory are parameterised (gap G-10).
