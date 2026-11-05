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

---

## Revision 4 findings (live differential lab vs the reference binary, 2026-11-04)

Method: the official `OoklaServer-linux-x86_64` daemon (2.11.5.2) was run
**live on this machine** next to the SpeedtestServer build (isolated ports,
identical lab certificates and `allowedDomains`), then a 103-case
differential battery plus targeted follow-up probes compared both servers
byte-for-byte. Evidence + probe scripts:
`validation/evidence/rea-lab-rev4/`. This supersedes the earlier
relay-capture approach for these rows: everything below was observed
**first-hand against the running daemon**.

New reference findings (F-8 … F-25) and their fixes:

- **F-8 [V]** `SERVERID` returns a **lower-case** instance UUID (daemon log +
  wire). Ours was upper-case. FIXED (`crypto.randomUUID()` without
  `toUpperCase()`; regression test).
- **F-9 [V]** `DOWNLOAD <n>` reply structure: `"DOWNLOAD "` prefix (truncated
  for n<10) + max(0, n−10) data bytes + **trailing `\n`** — all counted in n;
  `DOWNLOAD 0` → `"\n"`; the pool data is **printable ASCII [0x20..0x7F]**
  (96 values, uniform). Ours had no trailing newline and used binary random
  data. FIXED (engine + 2 MiB ASCII pool; the same pool feeds the
  `random{N}x{N}.jpg` endpoints — charset parity verified).
- **F-10 [V]** Command-argument strictness: bare `PING` → **ERROR**
  (argument required; any value accepted); `HI ` (empty arg) → ERROR;
  `HI <a> <b>` (incl. trailing space after the uuid) → **connection closed
  with no reply** (daemon: `JWT parsing failed` on the second token);
  `UPLOAD <n>` with n smaller than the command line (incl. 0) → **ERROR**,
  connection continues; non-numeric/negative n → **silently ignored**. All
  FIXED with regressions.
- **F-11 [V]** `GETIP` requires the line to be EXACTLY `GETIP`: any trailing
  bytes (space, `\r`, extra token) **silently mute the connection forever**
  (no reply, no further processing, socket kept open). CAPABILITIES/UPTIME/
  SERVERID tolerate extra arguments. FIXED (muted state + regressions).
- **F-12 [V]** Pre-session GETIP gate: before any `HI`, a read whose first
  line is `GETIP` **with trailing bytes in the same TCP segment** silences the
  whole connection (even later commands get nothing). After `HI` pipelined
  GETIPs answer normally. Replicated verbatim + regressions.
- **F-13 [V]** WebSocket processes **one command per frame** (first line
  only; a newline-less frame is one complete command). Upload payload frames
  are exempt. FIXED (first-line truncation + synthesized newline).
- **F-14 [V]** `QUIT` over WebSocket → **`ERROR\n` reply, session stays
  open** (TCP still closes). FIXED (`quitMode` per transport).
- **F-15 [V]** HTTP header order/casing: `Date`, `Connection: Close` /
  `Keep-Alive` (daemon casing), security headers, `Content-Type`,
  `Content-Length`; keep-alive responses have **no** `Keep-Alive: timeout`
  header; 404s have no `Content-Length` and **no chunked framing**; HEAD
  advertises the real body length; `OPTIONS` → `Content-Length: 0`. All
  FIXED (byte-exact, verified in the differential).
- **F-16 [V]** **Host validation**: the Host header (port stripped,
  case-insensitive) must match a **certificate SAN** entry; anything else —
  including the machine hostname, interface IPs and even the certificate CN
  when it is not also a SAN — gets `307 Temporary Redirect` to
  `https://<cert-CN>:<port><target>` (query/fragment echoed; applies to plain
  HTTP and inside TLS). A MISSING Host → minimal 500. `allowedDomains` does
  NOT feed this check. IMPLEMENTED (cert SAN/CN parsing + hot-reload refresh;
  Node's own Host-less 400 is preempted by a multiplexer-level header sniff).
- **F-17 [V]** The minimal 500 is exactly `HTTP/1.1 500 Internal Server
  Error\r\nConnection: Close\r\n\r\n` (no Date, no security headers, no body,
  HTTP/1.1 status line even for HTTP/1.0 requests). Triggers: missing Host,
  missing User-Agent (**empty value counts as present → served**),
  `Authorization: Bearer <non-JWT-shaped>` (Basic/JWT-shaped pass). All
  FIXED with regressions.
- **F-18 [V]** `Authorization: Bearer <token>` with a non-JWT-shaped token →
  minimal 500 (see F-17). IMPLEMENTED.
- **F-19 [V]** Path handling: `//hi`, `/./hi`, `/a/../hi`, `/HI/../hi` →
  serve `/hi` (normalize before case-sensitive matching); **trailing slash is
  preserved** (`/hi/` → 404); absolute-form targets use their path. FIXED
  (`normalizePath` + regressions).
- **F-20 [V]** Method matrix: only GET/HEAD/OPTIONS serve content (OPTIONS
  with `Content-Length: 0`); PUT/DELETE/PATCH and POST outside upload.php →
  404. `TRACE` is **not routed through HTTP at all** (falls to the encrypted
  engine — unreproducible, D-2). FIXED.
- **F-21 [V]** `GET /ws` without an upgrade request → **silent close** (no
  response). Chunked POST to upload.php → **no response, connection held**.
  Both replicated.
- **F-22 [V]** **`allowedDomains` semantics found**: one effective list
  (`allowedDomains` ∪ `*.ookla.com, *.speedtest.net, *.speedtestcustom.com`
  unless `excludeDefaultDomains`, default `*` when the key is absent) drives
  **CSP `connect-src`**, the **crossdomain.xml entries** and the **CORS
  Origin filter**. IMPLEMENTED (previously PNA).
- **F-23 [V]** CORS Origin filter: the Origin header is reflected ONLY when
  its host matches the effective domain list (`*.example.org` matches
  `foo.example.org` but not the bare `example.org`; ports ignored;
  case-insensitive matching, verbatim reflection; `Origin: null` never
  reflects; the `*` default reflects every parseable origin). IMPLEMENTED.
- **F-24 [V]** **"Three strikes"**: a TCP connection is closed right after
  its 3rd cumulative `ERROR` reply. Valid commands do NOT reset the counter;
  the HI bad-argument ERROR does NOT count; UPLOAD_STATS / bare-PING /
  UPLOAD-too-small / unknown-command ERRORs do. **WebSocket sessions do not
  enforce it.** IMPLEMENTED (`errorStrikeLimit` per transport).
- **F-25 [V]** Exactly one trailing `\r` is stripped before command dispatch
  (`HI\r\n` → HELLO, `PING 1\r\n` → PONG) — except GETIP, whose strictness
  check uses the raw line. IMPLEMENTED.

Hardening fixes from the code audit (not daemon divergences):

- **R-1 (A-1)** Explicit `--config` that is missing/unreadable/unparsable or
  `.ts` is now **fatal** (exit 2) instead of silently falling back to the
  search path/defaults.
- **R-2 (A-2)** **Prototype pollution** blocked in `setNestedProperty` and
  `mergeConfig` (`__proto__`/`constructor`/`prototype` keys rejected; a
  `__proto__.polluted = true` properties line no longer poisons the process).
- **R-3 (A-3/A-4)** Evidence WriteStream is error-watched (graceful degrade
  instead of a crash) and **fully flushed before exit**; the HTTP servers are
  closed on `stop()` (fixes the lingering "Jest did not exit" handle).
- **R-4 (A-5)** UDP bind failures are now **fatal** (async `start()`,
  awaited binds, `listen_udp` emitted per successful bind).
- **R-5 (A-23)** Per-IP connection limits use exact IP keys (the old
  string-prefix match counted `1.2.3.45` against the `1.2.3.4` limit).
- **R-6 (A-11/A-22)** Single signal-handler shutdown path with conventional
  exit codes (130/143) and non-zero on failed stop; the certificate
  hot-reload debounce timer is cleared on `stop()` and guarded.
- **R-7** `allowedDomains` default corrected to the daemon built-in `*`
  (key absent), which the CSP/crossdomain/Origin surfaces now reflect.

Differential result after remediation: **89/103 raw byte-identical**; the
remaining 14 = 6 expected non-differences (PONG/UPTIME timestamps, random
payload content, each server's own listening port in crossdomain.xml) +
8 documented deviations (D-2 encrypted-engine replies; D-3 UDP
permissiveness; the deliberate refusal to stream unbounded data for
unparsable DOWNLOAD sizes). DOWNLOAD reply STRUCTURE (length, prefix,
trailing newline, ASCII charset) verified byte-exact for 100/1000/100000
bytes. Full evidence: `validation/evidence/rea-lab-rev4/probe-diff-results.json`.

---

## Revision 5 findings (config-parity lab, 2026-11-05)

Method: the official stable reference daemon (`ce180aa3…` tarball / binary
`f19e5ed2…`, see REFERENCE_BINARY_MANIFEST.md for the corrected provenance)
was run live next to the current SpeedtestServer build (daemon TCP/UDP 18080,
SpeedtestServer 18081/18082) under matched per-variant configurations, then
compared probe-for-probe. Evidence: `validation/evidence/rea-lab-rev5/`
(probe JSON per variant) + the harness scripts
`validation/harness/probe-config-parity.mjs` (new). Baseline re-verified
first: build clean, **143/143 tests**, differential battery **89/103
byte-identical** (identical to the rev-4 record — zero regression).

New reference findings and their implementation status:

- **F-26 [V]** `OoklaServer.userAgentFilterEnabled` — semantics fully
  recovered. Default OFF (the official template ships the key commented;
  verified live: with the key absent every UA string is served). When ON, the
  daemon's built-in blocklist applies — located as 11 ordered regex literals
  in the reference binary's .rodata (`libcurl-.*`, `AndroidSpeedtest`,
  `Wi-Fi Maximiser`, `SPEEDTEST_CLIENT`, `Python-urllib`, `ubnt-test`,
  `check_http`, `curl/.*`, `LuaSocket.*`, `showwin/speedtest-go.*`,
  `Go-http-client/.*`) and verified live: each is a case-sensitive
  FULL-STRING regex match on the OWS-trimmed UA value (literal entries match
  only the exact string; `.*` entries any continuation). Rejection is a
  500 **with Date header** (`HTTP/1.1 500 Internal Server Error\r\nDate:
  …\r\nConnection: Close\r\n\r\n`) — a DIFFERENT form from the minimal
  (no-Date) 500; it applies to every endpoint, and the Host checks win
  (missing Host → minimal 500; Host mismatch → 307). IMPLEMENTED
  (`HttpApi.isFilteredUserAgent` + step 3.5; TS default corrected false;
  the repo template now ships the key commented like the official one).
- **F-27 [V]** `OoklaServer.websocket.frameSizeLimitBytes` — default 5242880
  (verified), accept iff frame payload ≤ limit, reject iff > limit; rejection
  = NO reply frame, NO close frame, the TCP connection is RESET (client sees
  ECONNRESET; the daemon logs "WebSocket Exception: Payload too big").
  Note: the earlier rev-5 lab note claiming an "accept ≤ limit+1" boundary
  was an artifact of a probe helper off-by-one (`'PING 1\n'` is 7 bytes, not
  8) — corrected with exact-size payloads; both boundaries (64/65 at
  limit 64, and 5242880/5242881 at the default) re-verified against the live
  daemon. IMPLEMENTED (per-frame `FrameGuard` in ServerCore that sees each
  chunk before ws's own data listener, RST via `resetAndDestroy()`; ws
  `maxPayload` = limit retained as the message-level bound; ws-error path
  terminates with RST).
- **F-28 [V]** `OoklaServer.addresses` — the daemon's own handling is broken:
  a listed IPv4 address is NEVER bound (even a real system IP), setting the
  key at all removes the IPv4 wildcard entirely, listed v6 literals get their
  own sockets, and the v6 wildcard `[::]` appears whenever any listed entry
  does not itself produce a v6 literal bind (`127.0.0.1` → `[::]` only;
  `127.0.0.1, ::1` → `[::]` + `[::1]`; `::1` → `[::1]` only). The documented
  intent ("only listen on these addresses") is violated. DEVIATION D-9:
  SpeedtestServer implements the documented intent exactly (bind the listed
  addresses, both families; empty/absent → the useIPv4/useIPv6 wildcards).
  Differential evidence: `rea-lab-rev5/config-daemon-addrs.json` vs
  `config-sts-addrs.json` (listener shapes captured side by side).
- **F-29 [V]** `OoklaServer.useIPv4` / `useIPv6` — honored independently by
  the daemon for TCP and UDP: `useIPv4=false` leaves only `[::]` (v4 refused
  on connect AND for UDP datagrams — verified live); `useIPv6=false` leaves
  only `0.0.0.0`. Default (both true): TWO sockets per port (0.0.0.0 + [::]).
  IMPLEMENTED (ServerCore binds per family with `[::]` V6ONLY; UdpLossEngine
  binds per host with `ipv6Only` — the legacy no-`bindHosts` default keeps
  the old dual-stack `[::]` socket; the UDP v4/V6ONLY layout matches the
  daemon exactly).
- **F-30 [V]** Pre-existing rev-4 defect (reproduced on a clean rev-4 HEAD
  worktree): a request whose header block crosses 64 KiB before terminating
  (e.g. a single ~65 KB+ header value) drove `routeHttp` into its
  `total > CAP` branch from inside a data handler; `sock.unshift()` then
  synchronously re-emits 'data' to the still-attached handler → infinite
  recursion → >3.6 GB/s Buffer.concat allocations → OOM-kill (observed at
  3.6 GB RSS; the kernel OOM-killer terminated the process). Consequence:
  the rev-4 "negative battery 7/7" claim did NOT reproduce in a
  memory-constrained lab (the rev-4 lab machine had enough headroom to
  survive the leak long enough to pass the 1.2 s liveness checks). Root
  cause captured via inspector pause (stack: attempt → unshift → emit →
  onData → attempt …). FIXED: the mid-stream hand-off now defers via
  `setImmediate` (outside the data emission); the first-event path is
  unchanged. Regression tests: segmented 68 KB header (forced 3-phase
  segmentation) + single-write 70 KB header — minimal 500, server alive,
  memory bounded. Post-fix negative battery: **7/7 PASS** (previously
  5/7 with the server dying on the oversized-header case).
- **F-M1 [V]** REFERENCE_BINARY_MANIFEST.md recorded two "different"
  2.11.5.2 artifacts — a category error: `ce180aa3…` is the SHA-256 of the
  stable TARBALL, `f19e5ed2…` is the SHA-256 of the binary INSIDE it; they
  are the same build (`cmp` = 0 differing bytes, verified 2026-11-05 by
  downloading the official stable tarball). The committed
  `OoklaServer-linux-x86_64` is byte-identical to the official stable
  reference. The manifest also claimed "no vendor binaries are committed"
  while the repository tracks five of them — corrected in this revision.
  Manifest updated with the verified provenance.

Post-revision-5 gate summary (all re-run on the final code):

- Build/typecheck/lint: clean (3 pre-existing lint errors in decommissioned
  legacy files, unchanged by this revision).
- Unit/protocol/conformance: **143/143 PASS** (125 rev-4 + 16 rev-5 + 2
  F-30 regressions; `ConfigParityRev5.test.ts`).
- Differential battery: **89/103 raw byte-identical** — identical to the
  rev-4 record; the 14 = 6 expected non-differences + 8 documented
  deviations (D-2/D-3 + safety refusals).
- Per-variant differential (new): ua-on / ws-64 / ipv4-off / ipv6-off —
  **0 mismatches** on every battery (21-UA, WS boundary 63/64/65/4096,
  family connects, listener inventories) —
  `validation/evidence/rea-lab-rev5/`.
- Negative battery: **7/7 PASS** (was 5/7 with the F-30 defect).
- Strict TLS battery: 10/10 PASS (re-run).
- Installer dry-run: PASS.
- Official CLI acceptance gate: **BLOCKED (upstream)** — the live config
  endpoint (`cli.speedtest.net/api/cli/config`) answers **429** for the
  official CLI User-Agent from this lab IP (40+ minutes of retries, 5
  attempts; a plain-UA fetch returns 200, so the throttle is per-UA+IP from
  the earlier revisions' heavy gate usage). Evidence:
  `out/rev5/*/proxy.jsonl` (`config_error: live config status 429`) and
  `out/rev5/*/cli.stderr`. NOT counted as PASS; the pre-flight machinery
  itself was re-verified (fail-closed daemon detection + port ownership).
  The CLI's plaintext-fallback paths remain covered by the 103-probe
  differential against the live reference daemon.

---

# Revision 6 — security/reliability hardening + gate re-opened (2026-11-05)

Baseline for this revision: commit `d3098bbb` (rev 5 HEAD), Node v24.22.2,
Linux x86_64 (container). Audit driven by MASTER PROMPT v8.0 §6: every
hypothesis was first reproduced with a bounded local probe
(`6/6 confirmed defects pre-fix`), then fixed in the canonical
implementation, then covered by regression tests
(`src/server/HardeningRev6.test.ts`, 17 tests) and the full suite re-run.

## New findings (F-31…F-37)

- **F-31 [V]** Global connection limit blind to pre-protocol sockets —
  `onRawConnection()` checked `conns.size`, but registration only happened
  at protocol routing. Sockets that connected and never sent (or drip-fed
  a header/ClientHello) were invisible to `maxConnections`: probe showed
  10/10 silent sockets accepted with `maxConnections=5` (per-IP limit
  caught single-source floods, the global cap did not). FIXED: every
  accepted socket is registered immediately (transport refined on routing);
  `conns.size` == live sockets (pre-protocol, mid-TLS, mid-upgrade,
  HTTP/NetGauge/WS all counted, none double-counted).
- **F-32 [V]** WebSocket sessions double-counted — the WS upgrade minted a
  SECOND registration (new id + `connectionsTotal` + per-IP slot) on top of
  the TCP connection's entry: one live WS session showed
  `activeConnections=2`, `connectionsTotal=2`, and consumed 2 per-IP slots
  (halving effective limits; 2 WS sessions were refused under
  `maxConnections=2`). FIXED: the session REUSES the accept-time
  registration (`streamIds` maps the raw socket and its TLSSocket wrapper
  to one id); the raw socket's close handler performs the single decrement
  and emits `conn_close` with the session's FINAL byte counters.
- **F-33 [V]** `LossRegistry` unbounded — client-supplied UUIDs were
  auto-registered without any capacity bound: 100k distinct UUIDs from ONE
  source IP → +20.5 MB heap, all retained (a distinct-UUID UDP flood at
  50k pps ≈ multi-GB steady state between GC sweeps). FIXED: per-source-IP
  cap (default 64) + global cap (default 2048) with least-recently-seen
  eviction (Map-recency order, O(1) amortized; per-IP bookkeeping map).
  Official CLI behavior preserved (1 uuid per test; the CLI's
  LOSS/RECV/PLOSS contract re-verified end-to-end in the acceptance gates
  and by unit tests).
- **F-34 [V]** Partial startup left orphaned listeners — `start()` used
  `Promise.all`, which rejected on the FIRST bind failure while other binds
  completed afterwards: with portA occupied, `start()` rejected but portB's
  listener still accepted connections (verified: PING answered on the
  "failed" server). FIXED: all binds settle (`allSettled`) — on ANY failure
  every bound TCP listener, UDP socket, accepted-but-unrouted socket and
  accounting entry is closed/cleared before the error propagates
  (`abortPartialStartup()`); `UdpLossEngine.start()` got the same
  all-settled cleanup. A failed `start()` is now fully retriable.
- **F-35 [V]** Graceful shutdown could hang forever — `stop()` awaited
  `net.Server`/`http.Server` close callbacks that wait for ALL connections
  to end: with an in-flight trickle upload `stop()` did not complete within
  5 s (unbounded). FIXED: bounded graceful shutdown — listeners' close
  callbacks join a race against `shutdownGraceMs` (default 10 000 ms,
  configurable via `OoklaServer.shutdownGraceSeconds`); the grace phase
  closes idle HTTP connections and starts WS close handshakes; after the
  bound everything still open is force-destroyed (incl. idle NetGauge
  sessions, which no HTTP-layer close ever touched). stop() is idempotent
  and always resolves (verified: 1 502 ms with grace 1 500 ms).
- **F-36 [V]** Evidence-log backlog unbounded — the JSONL WriteStream
  buffered without bound when the sink stalled (slow disk, unread pipe):
  1.7 MB queued for 20k events, linear growth, no cap. FIXED: backlog cap
  (default 32 MiB, `OoklaServer.evidenceMaxBacklogBytes`) — past the cap
  the stream is destroyed and evidence logging degrades to OFF while the
  measurement service keeps serving; `stop()`'s evidence flush is also
  bounded (2 s window, then destroy — an unopenable sink used to hang
  shutdown too).
- **F-37 [V]** `Origin: null` reflected under the DEFAULT config —
  `originAllowed()` short-circuited on the wildcard before the null rule,
  so with `allowedDomains` unset ("*") we answered
  `Access-Control-Allow-Origin: null` where the daemon never reflects
  "null" (newly exposed by running the differential with BOTH servers on
  default config; the rev-5 lab had `allowedDomains=*.example.org` on both,
  which masked the 307-vs-200 path entirely). FIXED: the null rejection now
  runs before the wildcard check. Note: pre-existing logic, not a rev-6
  regression; the same differential also re-exposed that 307 responses are
  `Connection: Close` in our implementation while the daemon honors
  keep-alive on the first pipelined request — left as a DOCUMENTED
  deviation (harmless to clients; the CLI never follows HTTP redirects),
  see DECISIONS.md D-10.

## Post-revision-6 gate summary (all on the final code)

- Build/typecheck: clean. Lint: **0 errors** (was 3 errors — unused
  imports in `OoklaRequestHandler.ts`, `require()` in
  `TLSCertificateManager.ts`; 16 pre-existing stylistic warnings remain).
- Unit/protocol/conformance/hardening: **160/160 PASS** (143 rev-5 + 17
  rev-6: 15 in `HardeningRev6.test.ts` + 2 F-37).
- F-30 memory-bounded re-verification: ConfigParityRev5 suite under
  `--max-old-space-size=256` — 18/18 PASS (both F-30 regressions included).
- Differential battery (both servers on DEFAULT config, same lab CA):
  **89/103 byte-identical** — the same 14 as rev 5 (6 expected
  non-differences + 8 documented deviations), NO new mismatches after the
  F-37 fix (the one new mismatch found pre-fix was F-37 itself).
  Evidence: `validation/evidence/rea-lab-rev6/probe-diff-results.json`.
  Lab note: the probe corpus sends `Host: san1.local` — the server
  certificate must carry that SAN or every HTTP probe takes the 307 path
  and the comparison degrades to port artifacts (rev-5 evidence was
  generated with a san1.local-SAN cert; `gen-pki.sh` does not include it —
  regenerate a cert with SAN `san1.local` for differential reproduction).
- Official CLI acceptance gate: **PASS 7/7 isolated runs** (unmodified
  Speedtest CLI 1.2.0.84, sha256-verified tarball, lawfully downloaded from
  install.speedtest.net; fail-closed preflight: target port owned by
  SpeedtestServer, official daemon ABSENT — the preflight itself refused
  twice in this session when a lab daemon was left alive, working as
  designed). All runs: exit 0, `type:result`, `server.host=localhost`,
  `persisted=false` (non-publishing enforced at the proxy), full
  latency+download+upload+packetLoss measurements.
  `packetLoss=0` in 5/7 runs; 2 runs showed 14–26% — the documented
  stochastic loopback UDP-loss outlier (PUBLISHED_RESULT_URLS.md §5; the
  historical official-daemon baseline itself shows a 51.5% outlier —
  `evidence/baseline-cli-1.json`). Server-side evidence for the outlier
  runs: contiguous LOSS seq ranges, zero gaps, zero evictions — datagrams
  were dropped kernel-side before delivery, not by the server.
  Byte-counter corroboration: server evidence bytes ≈ CLI-reported volumes
  (ratios 1.002/1.009). Evidence:
  `validation/evidence/rea-lab-rev6/gate-runs/{run1,run2,run3,final,run6,run7}/`.
  The rev-5 upstream 429 throttle has cleared (config endpoint HTTP 200
  with the CLI UA via the proxy).
- Negative battery: **7/7 PASS** (re-run on rev-6 code).
- Strict TLS battery: **10/10 PASS** (re-run on rev-6 code).
- Installer: dry-run PASS + full staged install PASS (`--staging-dir`;
  `systemd-analyze verify` OK + live protocol probe of the staged server).
- Reference-binary provenance: ALL FIVE committed vendor binaries
  re-verified byte-identical against official sources on 2026-11-05
  (x86_64 tarball+binary, aarch64, macosx, windows64.zip incl. the exe
  inside it) — REFERENCE_BINARY_MANIFEST.md updated.
- systemd real service lifecycle: **BLOCKED** (no systemd in the audit
  container; unit file statically verified).
- ACME real issuance: **BLOCKED** (no operator-controlled domain from this
  environment; fail-closed paths covered by TLS N6/N7).
