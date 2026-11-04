# DECISIONS — architecture and scope decisions (with rationale)

## D-1 — Canonical implementation: TypeScript (`reverse-engineered/typescript/`)

**Decision:** the TypeScript tree is the single canonical implementation.
**Why:** it already had the build/test/lint toolchain, the richer type model,
and every recent feature commit landed there first; the JS tree was a 1:1 port
with the same defects and could not even load (`ws` missing). Maintaining two
divergent copies of a protocol engine is exactly the anti-pattern MASTER
PROMPT §17 warns about.
**Migration:** the new core (`ServerCore`, `NetGaugeEngine`, `UdpLossEngine`,
`HttpApi`) is transport-agnostic TypeScript; `javascript/` is frozen and marked
deprecated (`javascript/DEPRECATED.md`). No code was deleted.

## D-2 — Do NOT reimplement the encrypted-binary engine protocol

**Decision:** answer the CLI's encrypted-binary hello with `ERROR` and serve
the plaintext protocol.
**Why:** the binary protocol uses per-connection AES with anti-replay
(`Ookla::AESEncryptor`/`CommandEncryptor` in both binaries; replay of captured
frames yields randomized rejections — verified). Reproducing it would require
extracting proprietary key material, adding fragility and legal risk for zero
interop gain: the CLI's **plaintext fallback completes the full measurement**
(latency + download + upload + packet-loss 0), verified in 3/3 official-CLI runs.
**Trade-off documented:** a hypothetical future CLI without the fallback would
need that work; tracked in `FINAL_REPORT.md` (future work).

## D-3 — Be more permissive than the daemon on packet-loss session registration

**Decision:** auto-register client-supplied UUIDs from UDP `LOSS` packets
(bound to the sender IP) instead of requiring prior announcement.
**Why:** in fallback mode the CLI sends client-generated UUIDs that were never
announced (`HI` is bare); the daemon itself would silently ignore them, so
without this deviation fallback clients would always see 100% loss. The
deviation is invisible to well-behaved clients and preserves the anti-spoof
property (UUID↔IP binding).
**Where:** `PROTOCOL_CONTRACT.md §3 [D]`.

## D-4 — Single-port multiplexing, fail-closed binds

**Decision:** one TCP listener per port; protocol detected per connection;
any bind failure aborts startup.
**Why:** matches the reference deployment model (8080 = HTTP+WS+NetGauge+TLS),
fixes P0-1, and satisfies "never report success when a mandatory listener
failed". Verified: all transports answer on both 8080 and 5060.

## D-5 — Decommission mock/unused subsystems instead of faking them

**Decision:** `BinaryManager` (mock), `MetricsUploader` (no-op),
`TracerouteManager` (hardcoded fake hops), `InstanceLocker` (root paths), the
ACME client and the legacy `OoklaRequestHandler` are out of the startup path,
kept on disk with deprecation notes.
**Why:** they were mock data or unsafe (`rejectUnauthorized:false` outbound);
the independence requirement (§16) forbids pretending to call Ookla services.
The canonical server makes zero outbound connections.

## D-6 — Compatibility-profile version banner, configurable

**Decision:** default `netgaugeVersionString` =
`2.11 (2.11.5) 2026-06-04.1737.7d0993d` (byte-identical to the reference
profile), overridable via `OoklaServer.netgaugeVersionString`.
**Why:** clients and testers parse the banner; exact parity maximizes
interop; configurability + clear branding (README, startup log line
"INDEPENDENT open-source implementation — not an Ookla product") keep the
project honest about what it is.

## D-7 — Evidence-first harness, fail-closed gates

**Decision:** every gate script records process inventories, refuses to run
against an unverified target, and requires post-run corroboration (target
selected by the CLI + `persisted:false` + server-side counters).
**Why:** MASTER PROMPT §11/§12 — never let an unrelated-server run or a
missing target count as PASS.

## D-8 — Evidence logs built into the server

**Decision:** `--evidence-log` / `OoklaServer.evidenceLogFile` emits JSONL
connection/command/byte-counter events.
**Why:** server-side corroboration of client runs (Gate CLI-3/4) without
packet capture privileges; this is how 24.65 GB sent / 19.11 GB received were
attributed to SpeedtestServer during the passing CLI run.
