# HANDOFF — continuation instructions (no conversation history required)

## Where things stand (2026-11-04, revision 2 — branch `audit/typescript-official-parity`)

- **The mandatory acceptance criterion remains MET and re-verified on the
  current code:** unmodified official Speedtest CLI 1.2.0.84 completes full
  measurements against SpeedtestServer (3/3 isolated gates, packetLoss 0,
  non-publishing) — `evidence/gate-revision2/`.
- **v6.0 scope now also delivered:** §9 TLS semantics (fail-closed
  CertificateManager + ACME provisioner + hot reload; strict battery 10/10),
  §11 configuration parity (precedence CLI>env>file>defaults fixed; template
  parity + logging wiring unit-verified; CONFIG_MATRIX.md complete),
  §8 external-flow audit (EXTERNAL_FLOWS.md), §13 installer (install.sh:
  dry-run/staged/idempotent/fail-closed verified; systemd start BLOCKED in
  this container — unit verified offline), §14 README (16 sections), §15
  validation package restructured (BASELINE/PARITY_MATRIX/CONFIG_MATRIX/
  TLS_CERTIFICATES/EXTERNAL_FLOWS/TEST_RESULTS + detail docs).
- Differential 35/37 (2 expected non-differences), host tester 10/10, unit
  66/66, negative 7/7, publishing battery rev2: 4 distinct server IDs with
  zero-loss public Result URLs (`PUBLISHED_RESULT_URLS.md` §0).
- Canonical implementation: `reverse-engineered/typescript` (ServerCore,
  NetGaugeEngine, UdpLossEngine, HttpApi + NEW CertificateManager,
  AcmeProvisioner, validated reloadTls). JS twin deprecated/frozen.

## How to re-verify from scratch

Follow `validation/REPRODUCE.md` top-to-bottom (build → PKI → TLS cases →
gates). Expected: 66/66 unit, 10/10 TLS battery, 7/7 negative, 3/3 isolated
CLI replacement runs exit 0 with `packetLoss: 0`, host tester 10/10,
differential 35/37. Installer: `./install.sh --dry-run` then
`./install.sh --staging-dir /tmp/sts`.

## Known gaps / next steps (ordered)

1. **systemd service start verification** on a real Debian 13 host (the
   container cannot run systemd; unit file is `systemd-analyze verify`-clean
   and the ExecStart command is directly verified).
2. **ACME real issuance** on a host with an operator-controlled domain
   (staging directory documented; lab path fail-closed and tested).
3. **Encrypted-binary engine protocol** (D-2): only relevant if a future CLI
   drops the plaintext fallback. Deep RE of `Ookla::AESEncryptor` — optional.
4. Enforce `allowedDomains` / `userAgentFilterEnabled` flag / wire
   `websocket.frameSizeLimitBytes` / explicit `addresses` binding — currently
   documented PNA/P in CONFIG_MATRIX.md with rationale.
5. CI wiring (`run-replacement-test.sh` as an acceptance stage; skips must be
   reported BLOCKED, never green).
6. Delete-or-archive the deprecated `javascript/` twin after one stable
   release cycle; same for the legacy `TLSCertificateManager`/
   `OoklaRequestHandler` pair (now dev-utility only).

## Files that hold the knowledge

- Protocol: `validation/PROTOCOL_CONTRACT.md` (single source of truth).
- TLS semantics + validation: `validation/TLS_CERTIFICATES.md`.
- Configuration status: `validation/CONFIG_MATRIX.md`.
- External flows / result-URL lifecycle: `validation/EXTERNAL_FLOWS.md`,
  `validation/PUBLISHED_RESULT_URLS.md`.
- Why the design is what it is: `validation/DECISIONS.md`.
- What was broken (and fixed) this revision: `validation/FINDINGS.md` §C-1…C-6.
- Raw evidence: `validation/evidence/` (tls/, installer/, gate-revision2/,
  published/, published-rev2/, + prior-revision files).
- Harness: `validation/harness/` (fail-closed by design — do not weaken it).
