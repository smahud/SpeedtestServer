# HANDOFF — continuation instructions (no conversation history required)

## Where things stand (2026-11-05, revision 5 — HEAD of this commit series)

- Baseline re-verified on the final code: build clean, typecheck clean,
  **143/143 tests**, differential battery **89/103 byte-identical** (the
  same 14 as rev 4: 6 expected non-differences + 8 documented deviations),
  strict TLS battery 10/10, negative battery **7/7** (was 5/7 with the
  F-30 defect), installer dry-run PASS.
- New verified behaviors implemented this revision (FINDINGS.md §rev 5):
  - **F-26** `userAgentFilterEnabled` (11-pattern blocklist, 500-with-Date
    form, default OFF, Host checks win) — `HttpApi` step 3.5.
  - **F-27** `websocket.frameSizeLimitBytes` (accept payload ≤ limit;
    > limit → silent RST via per-frame FrameGuard) — `ServerCore`.
  - **F-29** `useIPv4`/`useIPv6` independent per-family listeners (TCP+UDP,
    `[::]` bound V6ONLY, 0.0.0.0+[::] two-socket default) — `ServerCore`
    + `UdpLossEngine` (`bindHosts`; no-`bindHosts` keeps the legacy
    dual-stack default).
  - **F-30** pre-existing rev-4 defect FIXED: >64 KiB header blocks drove
    `routeHttp` into unbounded recursion (OOM at >3.6 GB/s). The mid-stream
    hand-off is deferred via `setImmediate`. Two regression tests included.
  - **F-M1** reference-binary manifest corrected (tarball sha vs binary sha
    category error; committed x86_64 binary = official stable, verified
    byte-identical).
  - Deviation **D-9** added (`addresses`: documented intent vs the daemon's
    broken v4 handling).
- Probe tooling added: `validation/harness/probe-config-parity.mjs`
  (per-server behavioral snapshot: UA battery + WS frame battery + listener
  inventory + family connects). Per-variant differential evidence:
  `validation/evidence/rea-lab-rev5/`.

## Known gaps / next steps (ordered)

1. **Official CLI acceptance gate: BLOCKED (upstream)** —
   `cli.speedtest.net/api/cli/config` answers 429 for the official CLI
   User-Agent from this lab IP (5 attempts across 40+ minutes; plain-UA
   fetches return 200). Re-run `run-replacement-test.sh` when the upstream
   throttle clears; evidence of the blocked state is in
   `validation/harness/out/rev5/`. The CLI's plaintext-fallback paths are
   otherwise covered by the 103-probe differential against the live daemon.
2. Verify the four other committed vendor binaries against official
   sources (rev 5 only cross-checked the x86_64 stable binary —
   REFERENCE_BINARY_MANIFEST.md, corrected).
3. Decide the redistribution story for the five committed vendor binaries
   (exclusion from source releases is recommended — manifest updated).
4. `systemd` start verification on a real host (container-blocked, unit
   verified offline).
5. ACME real issuance on an operator-controlled domain (fail-closed paths
   tested).
6. Encrypted-binary engine (D-2) — only if a future CLI drops the plaintext
   fallback.
7. `ipTracking` metrics-bucket machinery remains decommissioned by design.

## How to re-verify from scratch

Follow `validation/REPRODUCE.md` (build → PKI → TLS cases → gates). The
differential and per-variant batteries: `node validation/harness/probe-diff.mjs 18080 18081`
and `probe-config-parity.mjs` (see the rev-5 FINDINGS section for the lab
layout). Expected: 89/103 differential, 143/143 unit, 7/7 negative.

## Files that hold the knowledge

- Protocol: `validation/PROTOCOL_CONTRACT.md` (single source of truth; §4.5
  and §5 updated with the rev-5 semantics).
- Configuration status: `validation/CONFIG_MATRIX.md` (rows updated to
  rev 5; `allowedDomains` row was stale pre-rev-5 — now IV).
- Why the design is what it is: `validation/DECISIONS.md` (D-1…D-9).
- What was found/fixed: `validation/FINDINGS.md` (P-*/C-*/F-1…F-30, F-M1).
- Raw evidence: `validation/evidence/` (`rea-lab-rev5/` is this revision).
- Harness: `validation/harness/` (fail-closed by design — do not weaken it).
