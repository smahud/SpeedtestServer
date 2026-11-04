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

| Client sends | Server responds | Notes |
|---|---|---|
| `HI` | `HELLO 2.11 (2.11.5) 2026-06-04.1737.7d0993d\n` | bare HI accepted **[V]** |
| `HI <UUID>` | same HELLO | UUID must be 8-4-4-4-12 shaped, else `ERROR` **[V]**; registers the session for packet-loss accounting |
| `GETIP` | `YOURIP <peer-ip>\n` | peer IP as seen by server (`::1` stays `::1`) **[V]** |
| `CAPABILITIES` | `CAPABILITIES SERVER_HOST_AUTH UPLOAD_STATS\n` | byte-exact **[V]** |
| `SERVERID` | `SERVERID <instance-uuid>\n` | daemon returns its instance UUID **[V]** |
| `UPTIME` | `UPTIME <seconds>\n` | **[V]** |
| `PING [x]` | `PONG <server-epoch-ms>\n` | **server** timestamp, not an echo **[V]** |
| `INITPLOSS` | `OK\n` | arms packet-loss accounting (daemon: requires a HI-with-UUID session; bare-HI sessions get `ERROR`) **[V]** |
| `PLOSS` | `PLOSS <count> <dupes> <maxseq>\n` | latest active session; `PLOSS 0 0 0` when none. loss = 1 − count/(maxseq+1) **[V]** (e.g. `PLOSS 172 0 171` → 0%) |
| `UPLOAD_STATS` | `ERROR\n` | daemon parity (verified by probe 2026-11-04) — clients tolerate it **[V]** |
| `DOWNLOAD <n>` | exactly **n bytes**, first 9 = ASCII `DOWNLOAD ` (counted in n), remainder = random pool data | **[V]** (pool: 2 MiB generated at startup) |
| `UPLOAD <n> [<ms> [<count>]]` | reads **n bytes INCLUSIVE of the command line**, then `OK <n> <epoch-ms>\n` | **[V]**: `UPLOAD 100\n`(11 B) + 89 B payload → `OK 100`; CLI sends `UPLOAD 32000000 15000 16` and 31,999,975 payload bytes = 32,000,000 total |
| `QUIT` | closes | (older NetGauge contracts) |
| anything else (incl. the CLI's encrypted-binary hello) | `ERROR\n` | **[V]**; garbage binary that cannot be framed → no response |

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

| Request | Status | Body (exact) |
|---|---|---|
| `GET /` | 200 `text/html` (109 B) | `<html><head><title>OoklaServer</title></head><body><h1>OoklaServer</h1><p>It worked!<br /></p></body></html>\n` |
| `GET /hi` | 200 `text/plain; charset=UTF-8` (44 B) | `hello 2.11 (2.11.5) 2026-06-04.1737.7d0993d\n` |
| `GET /speedtest/latency.txt` | 200 (10 B) | `test=test\n` |
| `GET /crossdomain.xml` | 200 `text/xml` (115 B) | `<?xml version="1.0"?>\n<cross-domain-policy>\n<allow-access-from domain="*" to-ports="8080"/>\n</cross-domain-policy>\n` |
| `GET/HEAD /speedtest/random{N}x{N}.jpg` (N ∈ {250,350,500,750,1000,1500,2000,2500,3000,3500,4000,5000,6000,7000}) | 200 `image/jpeg`, fixed sizes | deterministic size map (245388 / 505544 / … / 96912152 B); other N → 404 **[V]** |
| `POST /speedtest/upload.php` | 200 `text/plain; charset=UTF-8` | `size=<exact body byte count>\n`; GET → 404 **[V]** |
| any unknown path | 404, empty, `Connection: Close` | **[V]** |
| request without `User-Agent` | **500** (core daemon behavior, independent of `userAgentFilterEnabled`) | **[V]** |
| `Range` header | ignored (full 200) | **[V]** |
| `Origin: X` | `Access-Control-Allow-Origin: X` + `Vary: Origin` | **[V]** |

Security headers on 2xx/4xx (exact set, order-insensitive):
`Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
`Strict-Transport-Security: max-age=31536000; includeSubDomains`,
`Content-Security-Policy: default-src 'none'; frame-ancestors 'none'; script-src 'none'; object-src 'none';  connect-src *; upgrade-insecure-requests`.

Keep-alive: honored (pipelining works); 404s close.

## 5. WebSocket transport

- Upgrade **only** on `/ws` (101 + valid `Sec-WebSocket-Accept`); upgrade on
  `/` is answered like a normal GET (200 page); other paths → 404. **[P+V]**
- NetGauge-over-WS uses the same command lines as text frames (payload includes
  the trailing `\n`). Quirk: the HELLO reply frame carries **no trailing
  newline** (43 B), other replies do. **[P]** DOWNLOAD data streams as binary
  frames. **[D]** (implemented to match)
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
