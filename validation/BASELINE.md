# BASELINE — reference versions, environment, and test scope (v6.0 §15 canonical index)

Detail sources: `REFERENCE_BINARY_MANIFEST.md` (checksums),
`CONTEXT_BASELINE.md` (repository baseline), `ARCHITECTURE_AS_IS.md` /
`ARCHITECTURE_TARGET.md` (design). This file is the v6.0 canonical index.

## Reference binaries (never committed; sha256 verified at download)

| Artifact | Version | sha256 (short) | Role |
|---|---|---|---|
| OoklaServer linux-x86_64 static-musl tgz | 2.11.5.2 `2026-06-04.1737.7d0993d` | `ce180aa3…598159` | behavioral reference (differentials only) |
| Ookla Speedtest CLI linux-x86_64 tgz | 1.2.0.84 `ea6b6773cf` | `5690596c…cfeeb7` | genuine unmodified client (all gates) |
| Speedtest Host Tester | v1.1.0 | — | independent diagnostics (10 checks) |
| Extracted CLI binary | — | `31f1124c…543c051` | as used in every run |

## Repository baseline

- `master` baseline at audit start: `f3ea41cdd2bb8b6ea7dff7b4bb552d7455710bf8`
- Prior deliverable branch: `audit/official-cli-interoperability` (3 commits,
  MASTER PROMPT v3.0 scope — implementation + validation package + Result-URL
  battery)
- **This revision branch:** `audit/typescript-official-parity` (v6.0 scope:
  TLS §9 semantics, config parity §11, external flows §8, installer §13,
  README §14, full re-verification). Final SHA: see HANDOFF.md.
- Secondary (read-only) reference: `smahud/SpeedtestHost-Tester`
  branch `audit/z-ai-official-validation` — untouched.

## Environment

| Component | Value |
|---|---|
| OS | Debian GNU/Linux 13 (trixie), x86_64, container (PID 1 = tini; systemd NOT running) |
| Node.js | v24.22.2 (engines: >=18) |
| OpenSSL | 3.5.7 |
| User | unprivileged (`z`, uid 1001) — server runs unprivileged throughout |
| Trust lab | Lab Root CA (gen-pki.sh) + CLI bundle (system store + lab CA) |

## Test scope (what the gates cover)

1. Protocol parity: 37-probe differential battery (daemon vs SpeedtestServer),
   host tester 10 checks, unit/protocol conformance suite.
2. Genuine official CLI: 3× non-publishing replacement gates (mandatory),
   official-baseline runs (previous revision, unchanged protocol path),
   multi-server publishing battery (opt-in) with public Result URLs.
3. TLS §9/§10: strict validation battery (10 scenarios) + unit matrix.
4. Configuration §11: template-parity + precedence + logging wiring (unit).
5. Negative/security battery: malformed protocol, oversized payloads, abuse
   survival (7/7).
6. Installer §13: dry-run, staged install, idempotency, invalid-config
   fail-closed; systemd unit verified offline (`systemd-analyze verify`).

## Out of scope (documented, not tested here)

Ookla host-network admission/certification, encrypted-binary engine protocol
(plaintext fallback verified), >20 Gbps multi-process serving, and any
proprietary backend behavior without a public contract (§8).
