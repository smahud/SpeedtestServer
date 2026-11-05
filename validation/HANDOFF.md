# HANDOFF — continuation instructions (no conversation history required)

## Where things stand (2026-11-05, revision 6 — HEAD of this commit series)

- Baseline re-verified from scratch on rev-6 code: build clean, typecheck
  clean, lint **0 errors**, **160/160 tests** (143 rev-5 + 17 rev-6).
- Revision 6 (master prompt v8.0 §6 security/reliability audit): six
  source-inspection hypotheses were each CONFIRMED by bounded reproduction
  probes, fixed, and covered by regression tests
  (`src/server/HardeningRev6.test.ts`): **F-31** global connection limit
  now counts pre-protocol/mid-TLS/mid-upgrade sockets; **F-32** WS sessions
  count once (no double conns/per-IP/connectionsTotal); **F-33**
  `LossRegistry` bounded (64/IP, 2048 global, LRU eviction; CLI contract
  intact); **F-34** failed startup closes every partially-bound listener
  (TCP+UDP, allSettled + `abortPartialStartup()`); **F-35** bounded
  graceful shutdown (`OoklaServer.shutdownGraceSeconds`, default 10 s;
  force-destroy after the grace; evidence flush bounded 2 s); **F-36**
  evidence-log backlog cap (`OoklaServer.evidenceMaxBacklogBytes`, default
  32 MiB; degrade to OFF, keep serving). Plus **F-37** (HttpApi):
  `Origin: null` is never reflected, even under the default wildcard.
- **Official CLI acceptance gate: PASS 7/7 isolated runs** (rev 5's
  upstream 429 has cleared). Unmodified CLI 1.2.0.84, sha256-verified,
  non-publishing, target-attributed, byte-counter-corroborated
  (ratios 1.002/1.009). packetLoss 0 in 5/7; 2 stochastic loopback
  outliers with server-side zero-gap evidence (documented phenomenon —
  the official daemon's own historical baseline shows a 51.5% outlier).
  Evidence: `validation/evidence/rea-lab-rev6/gate-runs/`.
- Differential battery on default-config servers: **89/103 byte-identical**
  — same 14 as rev 5 (6 expected non-differences + 8 documented
  deviations); no new mismatches after F-37. Evidence:
  `validation/evidence/rea-lab-rev6/probe-diff-results.json`.
- Strict TLS battery 10/10, negative battery 7/7, installer dry-run +
  staged install PASS — all re-run on rev-6 code.
- All five committed vendor binaries re-verified byte-identical against
  official sources (manifest updated).

## Known gaps / next steps (ordered)

1. **systemd real service lifecycle: BLOCKED** — no systemd in the audit
   container. The unit file passes `systemd-analyze verify` and the staged
   install answers a live protocol probe, but a real `systemctl start/
   stop/restart/recovery` cycle on a Debian host remains untested.
2. **ACME real issuance: BLOCKED** — no operator-controlled domain from
   this environment (fail-closed paths are covered by TLS battery N6/N7;
   challenge/renewal machinery needs a real domain + DNS).
3. The UDP-loss loopback outlier (kernel-side drop under saturated
   multi-Gbps loopback load; affects the official daemon too) could be
   probed further on real hardware with a real NIC — not reproducible
   meaningfully in this container.
4. `ipTracking` metrics-bucket machinery remains decommissioned by design.
5. Encrypted-binary engine (D-2) — only if a future CLI drops the
   plaintext fallback (the 1.2.0.84 CLI gate passes without it).
6. Potential future hardening (NOT a verified defect): raise the UDP
   socket receive buffer (default 212 992 B, kernel-clamped to 425 984)
   if loss-probe quality under extreme load matters on real deployments.

## How to re-verify from scratch

Follow `validation/REPRODUCE.md`. Revision-6 additions:

```bash
cd reverse-engineered/typescript
npm ci && npm run build && CI=true npm test   # expect 160/160
NODE_OPTIONS="--max-old-space-size=256" npx jest src/server/ConfigParityRev5.test.ts  # F-30 under memory pressure
node ../../../scripts-equivalent: the §6 probes are now jest tests (HardeningRev6.test.ts)

cd ../../../validation/harness
./gen-pki.sh && ./gen-tls-cases.sh
./run-tls-validation.sh                       # expect 10/10
# differential: BOTH servers need a cert with SAN san1.local (probe corpus
# sends Host: san1.local) — generate one from the lab CA, give it to BOTH
# the reference daemon and SpeedtestServer, then:
node probe-diff.mjs 18080 18081               # expect 89/103
node negative-tests.mjs <port>                # expect 7/7
# CLI gate (upstream 429 cleared as of 2026-11-05):
#   official CLI 1.2.0.84 → clients/speedtest/speedtest (never committed)
#   server with lab cert on 8080, then:
STS_PORT=8080 OUT=./out/<name> ./run-replacement-test.sh   # expect PASS ×3
```

## Files that hold the knowledge

- Protocol: `validation/PROTOCOL_CONTRACT.md` (single source of truth).
- Defect register incl. F-31…F-37 and the rev-6 gate summary:
  `validation/FINDINGS.md` (revision 6 section).
- Configuration status: `validation/CONFIG_MATRIX.md` (new independent
  safety keys documented there).
- Why the design is what it is: `validation/DECISIONS.md` (D-1…D-10).
- Raw evidence: `validation/evidence/rea-lab-rev6/`.
- Harness: `validation/harness/` (fail-closed by design — do not weaken it).
