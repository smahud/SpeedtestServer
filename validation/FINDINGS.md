# FINDINGS — defect register (baseline audit → remediation)

Format: `ID | Severity | Reproduction | Root Cause | Fix | Regression Test | Result`

All baseline findings verified against commit `f3ea41c` on 2026-11-04 by code
inspection (TS file `reverse-engineered/typescript/src/server/…`; JS twin has
the same defects). Every fix is in the canonical implementation and covered by
`src/server/Protocol.test.ts` (44 tests) unless noted.

---

## P0-1 — HTTP and HTTPS bind overlapping ports; EADDRINUSE swallowed
- **Severity:** P0 (startup correctness)
- **Reproduction:** default config → `httpPorts=[8080]`, `tcpPorts=[5060,8080]`; both
  servers bind 8080; `listenOnPort` resolves the second bind on `EADDRINUSE`
  and the server logs "All servers started successfully".
- **Root cause:** two competing listeners per port + error swallowing
  (`OoklaRequestHandler.ts:250-258`).
- **Fix:** `ServerCore` creates **one** listener per TCP port with per-connection
  protocol multiplexing (TLS/HTTP/WS/NetGauge); bind errors reject `start()`
  (fail closed). Non-root paths only.
- **Regression:** `Protocol.test.ts` "HTTP and netgauge on the SAME port";
  harness `run-replacement-test.sh` fails closed if the port is missing.
- **Result:** FIXED (verified: dual-stack listeners on 8080/5060, all transports
  answer on both).

## P0-2 — No native NetGauge TCP protocol
- **Severity:** P0 (the actual product gap)
- **Reproduction:** any Speedtest client connects to 8080 and speaks
  `HI/PING/DOWNLOAD/UPLOAD` → old code had no parser (no `net`-based command
  handling anywhere).
- **Root cause:** implementation was an HTTP/JSON toy; the protocol was never built.
- **Fix:** `NetGaugeEngine` implements the verified command contract
  (`PROTOCOL_CONTRACT.md §2`), including `HI/GETIP/CAPABILITIES/SERVERID/UPTIME/
  PING/INITPLOSS/PLOSS/UPLOAD_STATS/DOWNLOAD/UPLOAD/QUIT/ERROR`, inclusive
  UPLOAD byte counting, streaming DOWNLOAD with backpressure.
- **Regression:** 13 protocol unit tests + three official-CLI end-to-end PASSes.
- **Result:** FIXED (official CLI completes full tests; packetLoss 0).

## P0-3 — /ws sent random data
- **Severity:** P0 (WebSocket transport)
- **Root cause:** handler ignored received commands and pushed `crypto.randomBytes`.
- **Fix:** `/ws` upgrade in `ServerCore.handleUpgrade` → NetGauge-over-WS via the
  same engine (text frames; HELLO no-newline quirk; DOWNLOAD as binary frames).
- **Regression:** host tester "Netgauge / WebSocket" check PASS (both ws:// and wss://).
- **Result:** FIXED (10/10 host-tester).

## P0-4 — UDP was a blind echo
- **Severity:** P0 (UDP protocol)
- **Root cause:** `if (msg.length >= 8) server.send(msg, …)` — no session, no accounting.
- **Fix:** `UdpLossEngine` + `LossRegistry`: `LOSS` 4-field (count-only) and
  5-field (count + `RECV` response), UUID sessions bound to sender IP
  (anti-spoof), `PLOSS` reporting for the TCP side.
- **Regression:** LossRegistry unit tests + UDP integration test + CLI packetLoss 0.
- **Result:** FIXED.

## P1-1 — Legacy endpoints missing/mismatched
- **Fix:** `HttpApi.ts` implements the byte-exact surface (`/`, `/hi`,
  `/speedtest/latency.txt`, `/crossdomain.xml`, `random{N}x{N}.jpg` size map,
  POST `upload.php` → `size=N\n`, 404-empty-close, UA-less → 500, CORS
  reflection, Range ignored, security headers).
- **Regression:** differential probe battery 35/37 identical (2 expected
  non-differences: PONG timestamp, random payload).
- **Result:** FIXED.

## P1-2 — JSON serialization of text/XML bodies
- **Root cause:** `createResponse` did `Buffer.from(JSON.stringify(body))` for
  every string (e.g. `/ping` → `"pong"` with quotes; `crossdomain.xml` mangled).
- **Fix:** legacy `HttpApi` responses are raw strings/buffers with correct
  Content-Type.
- **Result:** FIXED (probe battery byte-parity).

## P1-3 — Unbounded buffering / huge synchronous allocations
- **Root cause:** request bodies buffered without cap; `crypto.randomBytes(min(size,100MB))`
  per request; byte-by-byte `Math.random()` file generation.
- **Fix:** HTTP body cap (512 MiB, 413 on overflow), NetGauge line cap (1 MiB),
  download from a 2 MiB startup pool streamed with backpressure, upload
  consumed as a stream (never buffered).
- **Regression:** negative tests (oversized line → drop; oversized headers →
  survives; 7/7 PASS).
- **Result:** FIXED.

## P1-4 — False-positive test scripts
- **Root cause:** JS `npm test` = `echo … && exit 0`; TS suite tested 1 of 13
  components.
- **Fix:** `Protocol.test.ts` (44 assertions) is the conformance suite; JS
  package deprecated. `npm test` now runs real tests.
- **Result:** FIXED (44/44 green).

## P1-5 — Config behavior broken
- **Root cause:** `--config` parsed and discarded; startup required
  `/var/lock/ooklaserver` and `/etc/ooklaserver/certs` (root-only) so the
  server could not start unprivileged; cert self-generation unconditional.
- **Fix:** `--config` honored via `OOKLA_SPEEDTESTSERVER_CONFIG_FILE`; lock file
  requirement removed; certs from config or generated into `./certs`;
  new keys `OoklaServer.netgaugeVersionString`, `OoklaServer.evidenceLogFile`.
- **Result:** FIXED (runs unprivileged; config verified in differential runs).

## P1-6 — Mock update path + unnecessary external services in the hot path
- **Root cause:** `BinaryManager` returned mock data / threw; `MetricsUploader`
  POST was commented out; startup wired them anyway; ACME client with
  `rejectUnauthorized:false` existed behind unreachable config.
- **Fix:** all decommissioned from the startup path (kept on disk for history,
  `DECISIONS.md` documents this); the canonical server makes **zero outbound
  connections**.
- **Result:** FIXED (independence requirement met).

## P1-7 — TLS verification disabled on outbound requests
- **Severity:** P1 security (would be P0 if the ACME path were reachable)
- **Root cause:** `TLSCertificateManager.ts:373` `rejectUnauthorized:false` on
  the Host-API client carrying Basic-auth credentials.
- **Fix:** legacy component no longer used; no outbound HTTP exists in the
  canonical server. 
- **Result:** FIXED by decommissioning.

## New findings (reference behavior, discovered this session)

- **F-1 [V]** The official CLI first speaks an encrypted-binary engine protocol;
  an `ERROR` reply triggers a **plaintext fallback** that completes full tests.
  This is the interoperability keystone of the independent implementation.
- **F-2 [V]** `UPLOAD <n>` counts the command line within `n` (inclusive):
  `UPLOAD 100\n` + 89 B → `OK 100`. Prior agents had this ambiguous.
- **F-3 [V]** UDP `LOSS` has two forms (4-field init: silent; 5-field loaded:
  answered with `RECV …`); `PLOSS <count> <dupes> <maxseq>`; loss = 1 − count/(maxseq+1).
- **F-4 [V]** The daemon rejects `HI <non-uuid>` and `INITPLOSS` after bare `HI`;
  the independent implementation is deliberately more permissive on session
  registration so fallback-mode clients get packet-loss accounting
  (documented deviation, `PROTOCOL_CONTRACT.md §3 [D]`).
- **F-5 [V]** `GETIP` → `YOURIP <ip>`, `CAPABILITIES` → `CAPABILITIES SERVER_HOST_AUTH
  UPLOAD_STATS`, `SERVERID`, `UPTIME` — all previously undocumented in this repo.
- **F-6 [V]** Image endpoints serve a fixed 14-size map (250…7000); non-canonical
  sizes 404; the `random{N}x{N}.jpg` suffix matches on any path prefix.
- **F-7 [V]** A NAT-ing relay in the path breaks the reference daemon's UDP
  `RECV` responses for encrypted-protocol sessions (client self-reports its
  address) — measured packetLoss jumped 0 → 0.515 with the relay, 0 without.
  Lesson: run gate tests **directly**, use the relay only for protocol capture.

---

## Revision findings (v6.0 audit, branch audit/typescript-official-parity, 2026-11-04)

Format as above. All fixes are in the canonical TypeScript implementation and
covered by `ConfigParity.test.ts` (22 new tests) and the TLS harness.

## C-1 — CLI flags silently clobbered by any discovered config file (§11)
- **Severity:** P1 (configuration correctness)
- **Reproduction:** start with `--udp-ports 18080` while a properties file in
  the search path sets `OoklaServer.udpPorts = 5060,8080` → server listens on
  5060/8080; the flag is silently lost (found by the installer's own
  verification probe).
- **Root cause:** `ConfigManager` merged the file ON TOP of constructor
  overrides; precedence was file > CLI instead of CLI > file.
- **Fix:** overrides are stored and re-applied after every file/env load.
  Precedence now CLI > `OOKLA_SERVER_POCO_CONFIG` > file > defaults.
- **Regression:** "CLI-flag style overrides take precedence over the loaded
  file" (unit).
- **Result:** FIXED.

## C-2 — Single-value list properties parsed as scalars (§11)
- **Severity:** P2 (configuration correctness)
- **Reproduction:** `OoklaServer.tcpPorts = 9999` (one port, no comma) parsed
  to the number `9999`, not `[9999]`; same for `httpPorts`, `addresses`,
  `allowedDomains`, `acme.domains`.
- **Root cause:** the properties value converter only produced arrays for
  comma-separated values.
- **Fix:** list-field coercion pass (`LIST_FIELDS`) after parsing.
- **Regression:** template-parity + mixed-mapping unit tests.
- **Result:** FIXED.

## C-3 — Invented "Ookla Host API" Let's-Encrypt endpoints + disabled outbound TLS verification in legacy component
- **Severity:** P1 security/compliance (RULE 4 violation; decommissioned code)
- **Reproduction:** `TLSCertificateManager.ts` (legacy, not in the startup
  path) POSTed to `host-api.speedtest.net/api/le/certificate` — endpoints with
  no verified public contract — with `rejectUnauthorized:false` and Basic-auth
  credentials.
- **Root cause:** earlier revision invented the vendor API (violates RULE 4)
  and disabled certificate verification on the credential-carrying client.
- **Fix:** code REMOVED. Automatic issuance now uses standard public ACME
  (`acme-client`, HTTP-01) in the canonical `AcmeProvisioner`/
  `CertificateManager`; the legacy file is reduced to a self-signed dev
  utility with a clear header. No outbound HTTP exists in the canonical
  server.
- **Regression:** TLS matrix unit tests + harness N6/N7 (fail-closed paths).
- **Result:** FIXED (removed).

## C-4 — TLS semantics: silent self-signed fallback and unenforced §9 matrix
- **Severity:** P1 (production TLS correctness; v6.0 §9.2–§9.6)
- **Reproduction (before):** configuring only `certificateFile` silently fell
  back to a self-signed certificate; `useLetsEncrypt=true` did nothing;
  `minimumTLSProtocol` was parsed but the listener hardcoded TLSv1.2;
  custom-certificate changes after startup were never activated.
- **Fix:** canonical `CertificateManager` implements the §9.2–§9.6 matrix
  (fail-closed; see CONFIG_MATRIX + TLS_CERTIFICATES); `ServerCore` gained a
  validated hot `reloadTls()` and configurable `tlsMinVersion`; custom-cert
  watcher + ACME renewal schedule implement §9.7.
- **Regression:** 10/10 strict TLS battery + TLS unit matrix.
- **Result:** FIXED.

## C-5 — Harness false positive: own process detected as "official daemon"
- **Severity:** P2 (harness correctness — would have blocked legitimate gates)
- **Reproduction:** `run-replacement-test.sh` inventory used a broad
  `grep ooklaserver` that matched our own `node dist/bin/ooklaserver.js`
  process → "official daemon still present" FATAL. Conversely the narrow
  pattern missed a renamed `./OoklaServer` binary.
- **Fix:** comm-based detection (`ps -eo pid=,comm=` matching `OoklaServer*`
  process names) in both gate and battery scripts — never matches `node`,
  catches renamed official binaries. (Strictness increased, not weakened.)
- **Result:** FIXED.

## C-6 — Harness CA-bundle path inconsistency
- **Severity:** P2 (harness)
- **Reproduction:** gate scripts passed `--ca-certificate=../certs/...`
  (validation/certs) while `gen-pki.sh` writes `certs/...` (harness dir) —
  CLI failed with "Problem with the SSL CA cert".
- **Fix:** both gate scripts now reference `certs/cli-ca-bundle.pem`.
- **Result:** FIXED.
