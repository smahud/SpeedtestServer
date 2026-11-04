# PROTOCOL_CONTRACT — OoklaServer Compatibility Profile

**Profile:** OoklaServer 2.11.5.2 (build `2026-06-04.1737.7d0993d`), official
Speedtest CLI 1.2.0.84 (`ea6b6773cf`).
**Method:** authorized reference observation in an isolated lab — official CLI →
official daemon through a byte-level recording relay, plus controlled probes
against the daemon. All facts below were captured **first-hand on 2026-11-04**
unless marked otherwise. Cross-checked against SpeedtestHost-Tester findings
(`audit/z-ai-official-validation`, read-only).

Confidence labels: **[V]** verified by direct observation (capture/probe replay),
**[P]** verified in prior-agent captures and reproduced here,
**[D]** design decision for this implementation (documented deviation).

---

## 1. Transport model

- **One TCP port multiplexes everything**: plain HTTP, HTTPS/TLS, WebSocket,
  WSS and native NetGauge (plain and TLS-wrapped) — default ports
  `OoklaServer.tcpPorts = 5060,8080`. **[P+V]** (probe: HTTPS + WS + netgauge
  all answered on 8080)
- **UDP on the same port numbers** (`OoklaServer.udpPorts = 5060,8080`) serves
  the packet-loss/loaded-latency protocol. **[V]**
- Per-connection detection by first bytes: TLS ClientHello (`0x16 0x03…`),
  HTTP method (`GET|POST|HEAD|…` + space), anything else → NetGauge. **[V]**
- TLS floor 1.2 (1.0/1.1 → `protocol_version` alert). **[P]**

## 2. Native NetGauge command protocol (TCP, `\n`-terminated ASCII lines)

*(Revision 4, 2026-11-04: live differential probes against the reference
binary — `validation/evidence/rea-lab-rev4/` — tightened several previously
approximated rows; all deltas verified byte-exact.)*

| Client sends | Server responds | Notes |
|---|---|---|
| `HI` | `HELLO 2.11 (2.11.5) 2026-06-04.1737.7d0993d\n` | bare HI accepted **[V]** |
| `HI <UUID>` | same HELLO | UUID must be 8-4-4-4-12 shaped, else `ERROR` **[V]**; registers the session for packet-loss accounting |
| `HI <UUID> <extra>` (2+ args, incl. trailing space) | **connection closed, no reply** | the daemon parses the second token as a client JWT — invalid → `Disconnect Exception: JWT parsing failed` **[V]** (console log) |
| `GETIP` | `YOURIP <peer-ip>\n` | peer IP as seen by server (`::1` stays `::1`) **[V]** |
| `GETIP<anything>` (space, `\r`, extra token) | **no reply, connection MUTES permanently** | strict raw-line match; verified silent-poison behavior **[V]** |
| `CAPABILITIES [args]` | `CAPABILITIES SERVER_HOST_AUTH UPLOAD_STATS\n` | byte-exact; extra arguments tolerated **[V]** |
| `SERVERID [args]` | `SERVERID <instance-uuid>\n` | daemon instance UUID is **lower-case** **[V]**; extra args tolerated |
| `UPTIME [args]` | `UPTIME <seconds>\n` | **[V]**; extra args tolerated |
| `PING <x>` | `PONG <server-epoch-ms>\n` | **server** timestamp, not an echo **[V]**; argument REQUIRED — bare `PING` → `ERROR`; any value accepted (even non-numeric) **[V]** |
| `INITPLOSS` | `OK\n` | arms packet-loss accounting (daemon: requires a HI-with-UUID session; bare-HI sessions get `ERROR`) **[V]** |
| `PLOSS` | `PLOSS <count> <dupes> <maxseq>\n` | latest active session; `PLOSS 0 0 0` when none. loss = 1 − count/(maxseq+1) **[V]** (e.g. `PLOSS 172 0 171` → 0%) |
| `UPLOAD_STATS` | `ERROR\n` | daemon parity (verified by probe 2026-11-04) — clients tolerate it **[V]** |
| `DOWNLOAD <n>` | exactly **n bytes**: `DOWNLOAD ` prefix (truncated for n<10) + max(0, n−10) pool bytes + trailing `\n` — **all counted in n**; `DOWNLOAD 0` → `\n` (1 byte); last byte is ALWAYS `0x0a` **[V]** | pool: 2 MiB generated at startup, **printable ASCII [0x20..0x7F]** (daemon charset, 96 values incl. DEL) **[V]**; extra arguments accepted **[V]**; unparsable/negative size → the daemon streams **unbounded data** (multi-GB, probe OOM-killed) — we reply `ERROR` instead (documented safety deviation) |
| `UPLOAD <n> [<ms> [<count>]]` | reads **n bytes INCLUSIVE of the command line**, then `OK <n> <epoch-ms>\n` | **[V]**: `UPLOAD 100\n`(11 B) + 89 B payload → `OK 100`; CLI sends `UPLOAD 32000000 15000 16` and 31,999,975 payload bytes = 32,000,000 total. **n < command-line length (incl. n=0) → `ERROR`** (connection continues) **[V]**; non-numeric/negative n → **silently ignored** (no reply, connection continues) **[V]** |
| `QUIT` | TCP: closes; WebSocket: `ERROR\n` reply, session stays open | transport-dependent **[V]** |
| anything else (incl. the CLI's encrypted-binary hello) | `ERROR\n` | **[V]**; garbage binary that cannot be framed → no response |
| empty line (`\n`) | `ERROR\n` | **[V]** |
| line of only `\r` (`\r\n`) | `ERROR\n` | the `\r` is stripped pre-dispatch, leaving an empty line **[V]** |

**CRLF tolerance (rev 4 [V]):** exactly one trailing `\r` is stripped before
command dispatch — `HI\r\n` → HELLO, `PING 1\r\n` → PONG,
`CAPABILITIES\r\n` → CAPABILITIES — EXCEPT GETIP, whose strictness check
runs on the raw line (`GETIP\r\n` → mute).

**"Three strikes" (rev 4 [V]):** a TCP connection is closed immediately after
its **3rd cumulative `ERROR` reply**. Valid commands do NOT reset the counter
(probe: `AAA BBB PING CCC` → PONG then close on the 3rd ERROR). The HI
bad-argument ERROR does **not** count (probe: 3× `HI nope` + `GETIP` → 3
ERRORs + YOURIP, connection alive). UPLOAD_STATS, bare-PING,
UPLOAD-too-small and unknown-command ERRORs all count. **WebSocket sessions
do not enforce the limit** (3× garbage + GETIP → 3 ERRORs + YOURIP, session
alive).

**Pre-session GETIP gate (rev 4 [V]):** before any `HI` on a connection, a
read whose FIRST line is exactly `GETIP` with trailing bytes in the same TCP
segment silences the connection permanently (no reply ever, socket kept
open — later commands get nothing). After `HI`, pipelined `GETIP\nGETIP\n`
is answered normally. Non-GETIP first commands (CAPABILITIES, PING, UPTIME)
process all lines in the segment normally.

### The encrypted-binary engine protocol (documented limitation)

The official CLI's measurement connections first attempt an **AES-encrypted
binary framing** (`Ookla::AESEncryptor` / `CommandEncryptor` in both binaries;
per-connection keys; anti-replay — replays of captured frames get randomized
rejections). **This implementation intentionally does not reproduce it.**
Instead it relies on the CLI's documented-in-practice fallback:

> binary hello → server answers `ERROR\n` → the CLI re-negotiates in the
> plaintext protocol above (`HI` → `GETIP` → `PING`…) and completes the full
> test (latency + download + upload + packet loss).

This fallback was verified end-to-end: three consecutive official-CLI runs
against SpeedtestServer completed with `packetLoss: 0` and exit code 0
(`validation/evidence/gate-cli2*.json`).

## 3. UDP packet-loss protocol

Client datagrams (to the UDP port, from the same IP as the TCP session):

| Form | Datagram | Server behavior |
|---|---|---|
| init | `LOSS <timer> <seq> <UUID>\n` | counted, **no response** **[V]** |
| loaded-latency | `LOSS <timer> <seq> <UUID> <timer>\n` | counted **and** answered |

Response (to the sender's source address): `RECV <seq> <clientTimer> [<count> <seq> <dupes>]\n` **[V]**

- Sessions are identified by client-supplied UUIDs; the daemon binds them to
  the TCP session peer IP and drops mismatches ("Mismatch address for UDP
  latency request" in the binary). **[V]** (controlled experiments)
- **[D]** This implementation auto-registers any well-formed UUID bound to the
  sender IP (more permissive than the daemon, which requires the UUID to be
  announced through `HI <uuid>` or the encrypted handshake). The official CLI's
  plaintext-fallback flow sends client-generated UUIDs that were never
  announced — the daemon itself would not count them, so this deviation is
  **required** for fallback-mode packet-loss accounting and is invisible to
  well-behaved clients.

## 4. HTTP/legacy surface (same port; exact bytes)

*(Revision 4, 2026-11-04: live differential probes — `validation/evidence/rea-lab-rev4/`
— established the Host validation, allowedDomains semantics, header order,
method matrix, minimal 500s and path normalization, all **[V]**.)*

### 4.1 Request-validation chain (order verified)

1. **Host header REQUIRED** — missing → minimal 500 (status line +
   `Connection: Close` only; no Date, no security headers, no body; status
   line always speaks HTTP/1.1 even for HTTP/1.0 requests). **[V]**
2. **Host must match a certificate SAN entry** (port stripped,
   case-insensitive) — anything else (including the machine's own hostname
   and interface IPs, and the certificate CN when it is not also a SAN) →
   **`307 Temporary Redirect`** with headers exactly `Date`, `Connection:
   Close`, `Content-Length: 0`, `Location:
   https://<cert-CN>:<listening-port><request-target>` (target includes
   query and fragment). Applies on plain HTTP **and** inside TLS. **[V]**
   `OoklaServer.allowedDomains` does NOT participate in this check (verified:
   `foo.speedtest.net` with `allowedDomains=*.speedtest.net` still 307s).
   The redirect target host is the certificate CN (verified with
   CN=cnhost.local + SANs=san1/san2: Location uses cnhost.local while only
   san1/san2 are accepted).
3. **User-Agent header REQUIRED** — missing → minimal 500; an EMPTY value
   (`User-Agent: `) counts as present (served). **[V]**
4. **`Authorization: Bearer <token>`** with a non-JWT-shaped token → minimal
   500; JWT-shaped tokens and other schemes (Basic, empty) are not
   inspected. **[V]**
5. `GET /ws` without an upgrade request → **silent close, no response**. **[V]**

### 4.2 Endpoint matrix (after validation passes)

| Request | Status | Body (exact) |
|---|---|---|
| `GET /` | 200 `text/html` (109 B) | `<html><head><title>OoklaServer</title></head><body><h1>OoklaServer</h1><p>It worked!<br /></p></body></html>\n` |
| `GET /hi` | 200 `text/plain; charset=UTF-8` (44 B) | `hello 2.11 (2.11.5) 2026-06-04.1737.7d0993d\n` |
| `GET /speedtest/latency.txt` (alias `/latency.txt`) | 200 (10 B) | `test=test\n` |
| `GET /crossdomain.xml` | 200 `text/xml` | **one `<allow-access-from domain="<d>" to-ports="<local-port>"/>` line per effective domain** (allowedDomains ∪ defaults; `*` when unset → the single classic `domain="*"` entry) **[V]** |
| `GET/HEAD/OPTIONS /speedtest/random{N}x{N}.jpg` (N ∈ {250,350,500,750,1000,1500,2000,2500,3000,3500,4000,5000,6000,7000}) | 200 `image/jpeg`, fixed sizes | deterministic size map (245388 / 505544 / … / 96912152 B); other N or NxM mismatch → 404 **[V]**; the `random{N}x{N}.jpg` suffix matches on any path prefix **[V]**; payload is the printable-ASCII pool **[V]** |
| `POST /speedtest/upload.php` (alias `/upload.php`) | 200 `text/plain; charset=UTF-8` | `size=<exact body byte count>\n`; GET/HEAD → 404 **[V]**; **chunked body → NO response at all** (connection held until timeout — daemon parser behavior) **[V]** |
| `PUT/DELETE/PATCH` on text endpoints | 404 | only GET/HEAD/OPTIONS serve content; POST is 404 outside upload.php **[V]** |
| `OPTIONS <endpoint>` | 200, headers only, `Content-Length: 0` | served like HEAD but with CL 0 **[V]** |
| `HEAD <endpoint>` | 200 with the real `Content-Length`, no body | **[V]** |
| any unknown path | 404, empty body, no `Content-Length`, no chunked framing, `Connection: Close` | **[V]** |
| `TRACE <anything>` | **not routed through HTTP at all** — falls to the encrypted-binary engine and gets an encrypted (binary garbage) reply | unreproducible (D-2); our server answers plaintext `ERROR` lines instead **[V]** |

### 4.3 Path handling (verified)

- Duplicate slashes collapse (`//hi` → `/hi` → 200) **[V]**
- `.`/`..` segments resolve (`/./hi`, `/a/../hi`, even `/HI/../hi` → 200;
  normalization happens BEFORE case-sensitive matching) **[V]**
- A trailing slash is NOT collapsed (`/hi/` → 404) **[V]**
- Absolute-form request targets use their path (`GET http://host/hi` →
  serves `/hi`) **[V]**
- Query strings and fragments are stripped for matching and echoed verbatim
  in 307 Locations **[V]**

### 4.4 Header order & casing (verified byte-exact)

Normal responses: `Date`, `Connection: Close|Keep-Alive` (daemon casing,
  capital C / capital K-A), `Cache-Control`, `X-Content-Type-Options`,
  `X-Frame-Options`, `Strict-Transport-Security`, `Content-Security-Policy`,
  `Content-Type`, `Content-Length`. Keep-alive responses carry
  `Connection: Keep-Alive` and **no** `Keep-Alive: timeout` header. 404s:
  same order minus Content-Type/Length. The response status line echoes the
  request's HTTP version (`HTTP/1.0 200 OK`). **[V]**

### 4.5 allowedDomains — verified semantics (rev 4)

One effective list drives THREE surfaces: `OoklaServer.allowedDomains`
(default `*` when the key is absent) ∪ `*.ookla.com, *.speedtest.net,
*.speedtestcustom.com` (appended unless `OoklaServer.excludeDefaultDomains =
true`, in order, no duplicates):

1. **CSP `connect-src`** — the header lists exactly those domains (`*` when
   unset) **[V]**
2. **crossdomain.xml** — one `allow-access-from` entry per domain **[V]**
3. **CORS Origin filter** — the `Origin` header is reflected into
   `Access-Control-Allow-Origin` ONLY when its host matches the list:
   `*.example.org` matches `foo.example.org` but NOT the bare `example.org`;
   ports are ignored; matching is case-insensitive; the reflection itself is
   verbatim (original case, port included); `Origin: null` never reflects;
   with the `*` default every parseable origin reflects **[V]**

Security headers on 2xx/4xx (exact set — see 4.4 for order):
`Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
`Strict-Transport-Security: max-age=31536000; includeSubDomains`,
`Content-Security-Policy: default-src 'none'; frame-ancestors 'none'; script-src 'none'; object-src 'none';  connect-src <effective-domains>; upgrade-insecure-requests`.

Keep-alive: honored (pipelining works); 404s close. `Range` header: ignored
(full 200).

## 5. WebSocket transport

- Upgrade **only** on `/ws` (101 + valid `Sec-WebSocket-Accept`); upgrade on
  `/` is answered like a normal GET (200 page); other paths → 404. **[P+V]**
- NetGauge-over-WS uses the same command lines as text frames (payload includes
  the trailing `\n`). Quirk: the HELLO reply frame carries **no trailing
  newline** (43 B), other replies do. **[P]** DOWNLOAD data streams as binary
  frames. **[D]** (implemented to match)
- **One command per frame (rev 4 [V]):** the daemon processes (at most) the
  FIRST command line of each frame and discards the rest — a `"HI\nGETIP\n"`
  text frame yields exactly one HELLO. A frame WITHOUT any newline is a
  complete command by itself (a bare `"HI"` frame gets its HELLO). Upload
  payload frames (while the engine is consuming `UPLOAD <n>` bytes) are exempt
  and count as data.
- **QUIT over WS → `ERROR\n` reply, session stays open (rev 4 [V])** — unlike
  TCP where QUIT closes the connection.
- **No "three strikes" over WS (rev 4 [V])** — see §2.
- Frame size limit 5 MiB (`OoklaServer.websocket.frameSizeLimitBytes`). **[P]**

## 6. Session lifecycle and limits (reference vs this implementation)

| Aspect | Reference daemon | SpeedtestServer |
|---|---|---|
| Download pool | 2 MiB random, generated at startup | same **[D]** |
| Idle/max connection | `OoklaServer.maxConnectionSeconds = 3600` | same (configurable) |
| Command line cap | n/a (binary framing) | 1 MiB, then drop **[D]** |
| Upload body cap (HTTP) | large | 512 MiB **[D]** |
| Per-IP connections | `maxConnPerIp = 500` | same |
| WS frame limit | 5 MiB | same |
