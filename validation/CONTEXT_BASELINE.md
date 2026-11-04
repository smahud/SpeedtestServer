# CONTEXT_BASELINE — where this audit started

- **Date:** 2026-11-04 (all times UTC)
- **Repository:** `github.com/smahud/SpeedtestServer`, branch `master`,
  baseline commit `f3ea41cdd2bb8b6ea7dff7b4bb552d7455710bf8`
  ("feat: Sync JavaScript ConfigManager property parsing with TypeScript").
- **Secondary reference (read-only):** `github.com/smahud/SpeedtestHost-Tester`
  @ `main` (`eab16976a4db48f36b0d81da5413cf2860e3cfa`) and branch
  `audit/z-ai-official-validation` (`f0f3f0e`) — prior-agent diagnostics and
  protocol findings; used as an oracle and cross-check, never as a substitute
  for first-hand evidence.
- **Lab host:** Debian 13 (trixie) x86_64, unprivileged user, Node v24.22.2.
  No tcpdump/strace/root available → byte-level evidence collected with a
  purpose-built TCP+UDP recording relay (`validation/harness/recording-relay.mjs`).

## State of the two implementations at baseline

| | `reverse-engineered/typescript/` | `javascript/` |
|---|---|---|
| Role | primary (per README) | 1:1 port |
| Listeners | separate HTTP + HTTPS servers; both bind 8080 by default; **EADDRINUSE silently resolved** (P0.1) | same defects |
| Native NetGauge | **absent** (P0.2) | absent |
| `/ws` | sends random bytes (P0.3) | same |
| UDP | blind echo (P0.4) | same |
| Legacy endpoints | partial, JSON-mangled bodies (P1.1/P1.2) | same |
| Runtime | required `/var/lock/ooklaserver` + `/etc/ooklaserver/certs` (root-only, P1.5) | could not even load (`ws` not installed) |
| Tests | 1 component unit-tested; JS `npm test` = `echo && exit 0` (P1.4) | none |
| Outbound TLS | `rejectUnauthorized:false` on Host-API client (P1.7) | same |

README claimed a "fully functional speedtest server compatible with Ookla's
Speedtest clients" — **not supported by the code** (no client could complete
any measurement). The repo's own `reverse-engineered/PROJECT_SUMMARY.md`
"Pending Work" list contradicted the README.

## What this audit changed

The canonical implementation is a **new listener + protocol core** in
`reverse-engineered/typescript/src/server/`:

- `ServerCore.ts` — single-port multiplexing listeners (TLS/HTTP/WS/NetGauge), fail-closed binds, evidence counters
- `NetGaugeEngine.ts` — the native command protocol (incl. inclusive UPLOAD counting, streaming DOWNLOAD with backpressure)
- `UdpLossEngine.ts` — UDP `LOSS`/`RECV` packet-loss protocol
- `HttpApi.ts` — byte-parity legacy HTTP surface
- `OoklaServer.ts` — rewritten facade (no root paths, no mock updaters, TLS from config or generated into a writable dir)

The JavaScript twin is deprecated (see `javascript/DEPRECATED.md`); the legacy
`OoklaRequestHandler.ts` is kept, clearly marked deprecated and unused.

Full rationale: `DECISIONS.md`. Defect register: `FINDINGS.md`.
