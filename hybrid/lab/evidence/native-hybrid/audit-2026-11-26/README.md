# Evidence — audit native-hybrid, 26 November 2026

Run ID: `audit-2026-11-26` · Window: 15:05–15:16 UTC · Operator VPS: 45.126.249.250.

## What this is

Live read-only verification of the ACTUAL baseline (master prompt §3) performed
during the audit session — supplementing the historical evidence in
`e-m-official-cli-campaign/` etc. Nothing was mutated: probes are GET/HEAD/
single TCP handshake/PoS status queries only.

## Files

| File | Content |
|---|---|
| `live-baseline.json` | git baseline, TCP ports, daemon `/hi`, gateway `/api/health` `/api/pool` `/api/workers`, worker-1 `/__meta`, public DNS (DoH), uaeg MCP access |
| `cloudflare-state.json` | zone (Free, active), DNS records (speedtest A/AAAA DNS-only), 100 deployed worker scripts, zero zone routes, workers.dev subdomain |
| `vps-services.txt` | systemd state (daemon PID 4412, gateway PID 4465, autoupdate timer active), `ss -tlnp` listeners, VERSION 1.5.2 |
| `netgauge-handshake.json` | raw TCP `HI/GETIP/QUIT` handshake against :8080 — byte-exact with `validation/PROTOCOL_CONTRACT.md` |

## Verification highlights

1. **Repo**: master HEAD = `0ac51ac` (v1.5.2) — the audit reference snapshot is
   still the current HEAD; working tree clean.
2. **VPS**: daemon live on 8080/5060 (PID 4412), gateway live on 8790 (PID 4465,
   mode hybrid, pool target 100 / deployed 100 / deployStatus ok), auto-update
   timer active, VERSION file 1.5.2.
3. **Cloudflare**: zone Free/active; `speedtest.lumajangnetworks.my.id` →
   45.126.249.250 **DNS-only** (proxied=false, verified via API AND public DoH);
   exactly 100 worker scripts deployed (the Free per-account limit), no zone
   worker routes (edge only via *.workers.dev).
4. **Native protocol**: raw TCP handshake PASS — production daemon speaks
   OoklaServer 2.11.5.2 NetGauge byte-exact.
5. **Edge health**: worker-1 `/__meta` live (HKG); account quota usage 89/100.000
   (0.1%) per gateway quota guard.

## What this evidence does NOT contain

- No payload-transfer test against official native client (test matrix pending
  operator input — see `docs/NATIVE_HYBRID_VALIDATION.md`).
- No secrets: tokens, HMAC secrets and uaeg keys are never stored here; only
  non-secret identifiers (zone/account ids, IPs, worker names).
