# FINAL_REPORT — audit/typescript-official-parity (2026-11-04, revision 2)

Scope: MASTER PROMPT **v6.0** (SpeedtestServer interoperability, TLS §9/§10,
configuration parity §11, external-flow audit §8, installer §13, README §14,
differential validation, autonomous remediation, open-source production
readiness). Supersedes the v3.0 report of `audit/official-cli-interoperability`
(whose evidence remains valid and committed).

## A. Repository state

- Baseline: `master` @ `f3ea41cdd2bb8b6ea7dff7b4bb552d7455710bf8`; prior
  deliverable `audit/official-cli-interoperability` @ `c54abf7`; **this
  revision: `audit/typescript-official-parity`** (created from c54abf7).
- Canonical implementation: `reverse-engineered/typescript` — `ServerCore`,
  `NetGaugeEngine`, `UdpLossEngine`, `HttpApi`, rewritten `OoklaServer`/
  `bin/ooklaserver.ts` (+`--validate-config`), and NEW this revision:
  `CertificateManager` (§9.2–§9.6 fail-closed resolution), `AcmeProvisioner`
  (standard ACME/HTTP-01), validated `ServerCore.reloadTls()` (§9.7),
  ConfigManager precedence/list-coercion/logging fixes. Legacy
  `TLSCertificateManager` stripped of invented Host-API endpoints and
  `rejectUnauthorized:false` (FINDINGS C-3). JS twin deprecated, frozen.
- Root `install.sh` (§13) added; README restructured (§14); validation
  package restructured to the §15 layout.

## B. Architecture

Corrected design (prior revision, unchanged): single-port multiplexing
(TLS/HTTP/WS/NetGauge per connection), fail-closed binds, one engine shared
by three transports, byte-parity HTTP surface, UDP LOSS/RECV with anti-spoof
binding, JSONL evidence logging. NEW: TLS material resolution is a
fail-closed §9 matrix; certificates hot-reload with validation; ACME
provisioning via the established `acme-client` library.

## C. Official binary reference

OoklaServer 2.11.5.2 `2026-06-04.1737.7d0993d`, tarball sha256 `ce180aa3…598159`;
official CLI 1.2.0.84 `ea6b6773cf`, tarball sha256 `5690596c…cfeeb7`, unmodified.
No vendor binaries committed. `REFERENCE_BINARY_MANIFEST.md` / `BASELINE.md`.

## D. Differential validation (re-run this revision)

Probe battery: **35/37 byte-identical** (2 expected: PONG timestamp, random
payload). Host tester v1.1.0: **10/10**. `evidence/gate-revision2/`.

## E. Genuine Speedtest CLI cross-validation ★

| Path | Outcome |
|---|---|
| Official CLI → official OoklaServer | 3/3 exit 0 (prior revision; protocol path unchanged) |
| Official CLI → **SpeedtestServer** (non-publishing, isolated) | **3/3 exit 0 · ping 0.041–0.077 ms · DL 17.96–18.53 Gbps · UL 12.38–13.44 Gbps · packetLoss 0 · persisted=false** |
| Official CLI → SpeedtestServer, publishing opt-in (rev2 battery) | 6 runs / 4 distinct server IDs; 4/6 zero-loss PASS with genuine public Result URLs (spot-verified live); 2 documented stochastic loopback-loss outliers (§5) |

Destination proof per run (comm-based official-daemon check + port owner via
/proc) and server-side byte corroboration captured for every run.

## F. TLS (§9/§10 — new this revision)

Strict validation battery **10/10** on the actual multiplexed listener:
trusted custom pair PASS; self-signed/expired/wrong-hostname strictly
REJECTED; mismatch/incomplete/LE-unconfigured/dead-ACME all abort startup;
§9.7 delayed activation + last-valid preservation verified;
minimumTLSProtocol enforcement verified. Real ACME issuance BLOCKED (no
operator domain in lab) — fail-closed paths verified, staging path
documented. `TLS_CERTIFICATES.md`, `evidence/tls/`.

## G. Configuration (§11 — new this revision)

Precedence fixed to CLI > env > file > defaults (C-1); list coercion (C-2);
logging wired; template-parity unit-verified. Full property matrix in
`CONFIG_MATRIX.md` — every key classified IV/P/PNA/N-A/EXT with rationale;
no silent acceptance.

## H. External communication (§8 — new this revision)

`EXTERNAL_FLOWS.md`: the CLIENT fetches engine config from cli.speedtest.net,
measures against the server, and submits results to results.speedtest.net
(publishing = opt-in; non-publishing gates refuse it and still pass). Result
URLs are produced by the Ookla result service, NOT by the speedtest server;
the independent server makes ZERO outbound connections; invented private
endpoints removed (C-3).

## I. Installer (§13 — new this revision)

`install.sh` deploys the TypeScript server to Debian 13 + systemd: OS/deps
checks, reproducible deps (committed package-lock.json; isolated prod
install), build, `--validate-config` validation, /opt install, dedicated
non-root user, hardened systemd unit (`systemd-analyze verify` OK),
config/cert preservation, idempotent re-runs, direct launch + protocol probe
verification. Verified via dry-run + full staged install + invalid-config
fail-closed. **systemd service start itself: BLOCKED in this container**
(PID 1 = tini) — the only unverified installer step, documented with exact
commands. `evidence/installer/`.

## J. Automated tests

Unit/protocol conformance **66/66** (44 + 22 new §9/§11). TLS battery 10/10.
Negative battery 7/7. Differential 37 probes (35 identical/2 expected).
Official CLI gates 3/3 isolated (+ battery 6 runs). Installer 4 scenarios.
Mocks never substitute the mandatory real-client runs.

## K. Remaining compatibility gaps

| Gap | Severity | Blocks replacement objective? |
|---|---|---|
| Encrypted-binary engine protocol not implemented (plaintext fallback verified 3/3; D-2) | Low | No — verified client profile |
| systemd start + real ACME issuance need a real host (lab BLOCKED, commands documented) | Operational | No — verified by direct-launch + fail-closed tests |
| allowedDomains / UA-filter flag / frameSizeLimit / explicit addresses binding documented PNA/P (CONFIG_MATRIX) | Low | No — standalone profile |
| Throughput ~30–37 % of native daemon on loopback (single-threaded Node) | Informational | No |

## L. Security assessment

`SECURITY_AUDIT.md` mitigations still hold; this revision additionally
removed the disabled-verification outbound client and the invented
credential-bearing endpoints (C-3), and made TLS misconfiguration fatal
instead of silently degrading (C-4). No known critical unresolved
vulnerabilities in the release scope.

## M. Documentation

README restructured to §14's 16 sections with commands actually executed;
validation package matches code and evidence (`TEST_RESULTS.md` index).

## N. Git delivery

Branch `audit/typescript-official-parity`, coherent commits (implementation
+ harness + evidence + docs). `master` untouched; no proprietary binaries or
credentials committed; harness scripts now carry the executable bit.

## O. Release verdict

### **CONDITIONAL PASS — VERIFIED STANDALONE REPLACEMENT PROFILE (v6.0)**

All mandatory gates verified with independent evidence on the current code:
genuine unmodified official CLI completes authorized end-to-end tests against
SpeedtestServer with the official daemon absent (3/3, packetLoss 0,
non-publishing); protocol/byte parity 35/37 with only documented
non-differences; host tester 10/10; TLS §9/§10 semantics fail-closed and
strictly validated (10/10); configuration precedence and parity unit-verified
with a complete honest matrix; external flows accurately classified with the
server making zero outbound connections; installer verified end-to-end as far
as the container allows. **Conditions** (documented, non-blocking): systemd
service start and real ACME issuance require a real Debian 13 host with an
operator domain; §G/§K low-severity items remain documented rather than
implemented. This is **not** Ookla certification, **not** host-network
admission, and applies only to the verified compatibility profile.

## P. Future-session handoff

`HANDOFF.md` (self-contained: re-verify steps, ordered next steps, knowledge
map). `REPRODUCE.md` reproduces every claim from a clean checkout.
