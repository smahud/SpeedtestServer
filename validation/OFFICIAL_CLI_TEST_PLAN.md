# OFFICIAL_CLI_TEST_PLAN — targeting, authorization and safety design

## Objective

Prove that the **unmodified official Speedtest CLI** completes a full
measurement (handshake, latency, download, upload, packet-loss) against
**SpeedtestServer**, with the official daemon absent, without publishing any
public result.

## Client authenticity (Gate CLI-0)

- Official tarball from `install.speedtest.net` (see `REFERENCE_BINARY_MANIFEST.md`),
  SHA-256 recorded; binary never patched. `--help`, version string and
  license conditions captured in evidence. Runtime deps: static musl binary
  (none). Notable options: `-s/--server-id`, `-o/--host`, `--ca-certificate`
  (replaces trust store), `-f json-pretty`, `--accept-license`, `--accept-gdpr`.
  The CLI honors `ALL_PROXY`/`HTTPS_PROXY`.

## Target selection method (Gate CLI-0/§3 feasibility decision)

The CLI cannot be pointed at an arbitrary address directly — it only tests
servers delivered by its engine-config API. Authorized lab method (no DNS or
system changes, no production endpoint touched):

1. Run the CLI with `ALL_PROXY=http://127.0.0.1:8888` and
   `--ca-certificate=<system store + lab CA>` (the flag *replaces* the store,
   so the bundle must contain both).
2. The proxy TLS-terminates exactly `cli.speedtest.net` with a lab cert and
   **fetches the live engine config using the CLI's own query string**
   (license, engine parameters, all other servers stay genuine), then
   redirects the server entries to the local test target.
3. **Non-publishing guarantee:** every `CONNECT results.speedtest.net` is
   refused by the proxy → the CLI reports `"persisted": false` and no lab
   measurement can ever become a public result.
4. Everything else is transparently tunneled and logged.

This is an isolated, fully user-space arrangement inside the lab; it does not
impersonate any operator (server entries keep their genuine ids; only the
connection target changes), does not alter system DNS/certs/routing, and
cannot pollute public data. `CLI_TARGET_SELECTION_BLOCKED` was **not**
triggered.

## Run protocol (per run)

1. **Pre-run (fail closed):** inventory processes and listeners; the
   replacement gate additionally verifies that the target port is owned by the
   SpeedtestServer process and that **no** official OoklaServer process exists
   anywhere on the host.
2. Start the config proxy (fresh log per run).
3. Run the CLI: `--accept-license --accept-gdpr --selection-details -f json-pretty`.
4. **Post-run attribution:** CLI JSON must show the local target as the
   selected server, `persisted:false`; the proxy log must show the config
   served and submission blocked; the server-side evidence log must show the
   session with byte counters matching the client-reported volumes.
5. Classify: PASS only if every element is present; otherwise **UNVERIFIED**.

## Repetition requirement (Gate CLI-5)

≥3 valid baseline runs (official daemon) and ≥3 valid replacement runs, plus
re-runs after any material networking change. Achieved: 3 + 3 (all exit 0;
baseline loss 0 on direct runs; replacement loss 0 ×3). Loopback-only topology
(the sandbox has a single non-loopback interface used only by the proxy for
the genuine config fetch — the measurement itself never leaves loopback, which
the proxy logs and server evidence demonstrate).

## Known pitfalls (from FAILURE_ANALYSIS.md)

- A NAT-ing recorder in the path distorts the reference daemon's UDP RECV
  responses (self-reported client address) — gate runs must be **direct**;
  use the recording relay only for protocol capture.
- With the proxy redirecting only one server entry, a failed local probe
  makes the CLI silently fall back to a *real* server — the harness redirects
  **all** entries and verifies the selected server post-run.
- `--ca-certificate` alone (lab CA only) breaks the genuine config fetch —
  the bundle must include the system store.
