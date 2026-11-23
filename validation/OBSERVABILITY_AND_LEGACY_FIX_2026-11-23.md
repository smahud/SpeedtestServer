# Host-tester observability deployment + legacy regression fixes — 2026-11-23 (session 3)

## Operator context

The operator re-ran the official hosted tester (`speedtest.net/host-tester`)
against `speedtest.lumajangnetworks.my.id:8080` and reported that `upload` and
`max_upload` still fail. The operator requested full traffic/packet capture so
the exact hosted-tester request set can be observed, and confirmed the official
OoklaServer binary currently serves the tester only via port 8080.

## What was found in the logs BEFORE any change

Since the 15:33 WIB restart, every connection came from `45.126.249.249`
(same AS as the server, PT Reload Media Telematika) plus loopback health
checks. Two distinct traffic classes were identified:

1. A monitor pattern every 1-7 minutes: one raw TCP NetGauge probe
   (`bytesDown:112, bytesUp:15, commands:2`) plus one WebSocket probe
   (`bytesDown:44, bytesUp:2`). The 44-byte reply is exactly
   `HELLO 2.11 (2.11.5) 2026-06-04.1737.7d0993d\n`.
2. A full measurement run at 19:40 WIB: 8 handshake connections, four raw-TCP
   download streams (64,000,000 ×2, 51,904,512, 2,621,440 bytes), two latency
   streams (287 and 252 PINGs), four upload streams (14.8 MB / 17.6 MB /
   10.2 MB / 11.5 MB received, closed client-side before the declared size —
   no `OK` reply expected on early close), one small upload that completed
   with `OK`, and a 23-command control channel. No HTTP request from the
   tester IP reached the multiplexed port during that run, and the port-80
   fallback service logged nothing because the deployed build had NO request
   logging at all.

TLS probes at 21:00 WIB (`unsupported protocol`, `version too low`,
`no suitable key share`) were reproduced against the unmodified official
binary: it also defaults to `minimumTLSProtocol = 1.2` and rejects the same
probes. These are not compatibility defects.

## Two real defects fixed in the working tree

The previous session left the PHP-8-parity rewrite of the port-80 fallback
uncommitted and BROKEN (it was never deployed — the deployed build predates it):

1. `LegacyFallback.ts` urlencoded branch never called `postPass.finish()`, so
   the final `key=value` pair never reached the counter's field map and EVERY
   POST answered the bare `size=500`. Fixed: `finish()` is called on `end`
   before responding (guarded, responds GET-only on counter failure).
2. `PhpFormCounter.mergedSize()` built its key set only from scalar `fields`,
   so an array-valued GET variable that POST did not override never triggered
   the PHP 8 `strlen()` fatal. Fixed: the key set now includes `arrays` from
   both passes.

Verification: `LegacyFallback` + `PhpFormCounter` suites 37/37 pass;
`Protocol`, `HttpRouteParity`, `HostWildcard`, `Hardening` suites 125/125 pass.

## Ground truth re-verified against the unmodified official binary

The official `OoklaServer` binary (version 2.11.5.2, build
2026-06-04.1737.7d0993d) was run in a temporary lab on port 8090 with a
generated certificate. Confirmed identical to the deployed TypeScript server:

| Probe | Official binary (8090) | TypeScript (8080) |
| --- | --- | --- |
| `POST /speedtest/upload.php` 515,798 B | `size=515798` | `size=515798` |
| `POST /speedtest/upload.php` 1,980,998 B | `size=1980998` | `size=1980998` |
| `UPLOAD_STATS` (bare, uuid, unknown) | `ERROR` ×3 | `ERROR` ×3 |
| `CAPABILITIES` | advertises `UPLOAD_STATS` | advertises `UPLOAD_STATS` |
| crossdomain / latency.txt / random*.jpg / `/` | 200, correct bodies | 200, correct bodies |
| Default minimum TLS | 1.2 | 1.2 |

The port-80 fallback answers the legacy PHP formula (`size=516300` /
`size=1981500`) by design; the native daemon ports answer raw
Content-Length parity.

## Observability now deployed (the operator's main request)

1. **tcpdump packet capture** — `ookla-capture.service` captures ALL traffic
   on ports 80, 5060, 8080 (`-i any`, full snaplen 65535, 100 MB × 20 rotating
   files) to `/var/lib/ookla-capture/hosttester.pcapNN`. Enabled at boot.
2. **Main daemon evidence log** — `OoklaServer.evidenceLogFile` is enabled in
   `/etc/speedtestserver/OoklaServer.properties`, recording every NetGauge
   command line (`ng_cmd`), HTTP request, and byte accounting as JSONL to
   `/var/lib/speedtestserver/evidence.jsonl`. The `http_` event family is now
   also logged to the journal (deployed `OoklaServer.js` update).
3. **Port-80 request logging** — the fixed `LegacyFallback.js` (with the
   PHP-8 parity rewrite and request logging) plus `PhpFormCounter.js` are
   deployed; every request is a `legacy_req` JSON line in
   `journalctl -u speedtestserver-legacy`.

Deployment followed the established isolation procedure with a rollback
snapshot at `/root/speedtestserver-rollback/obs-1795450142` (previous
`LegacyFallback.js`, `PhpFormCounter.js`, `OoklaServer.js` and properties).
Only those three dist files plus the properties file changed; both services
restarted cleanly and all 15 external checks pass via public DNS: netgauge
HI on 8080/5060/plain/TLS, crossdomain (to-ports `5060,8080`) on 8080 and 80,
latency.txt, upload.php 516,300/515,798 and max 1,981,500/1,980,998 on 80 and
8080, random images, `/hi`, and HTTPS `/`.

## What is still unknown — and how it will be resolved

The exact bytes the official hosted tester sends for the `upload` and
`max_upload` verdicts have never been observed directly (the previous
"passing" evidence used reproduced public endpoints, and the port-80 service
kept no logs). With the three capture layers above active, the next hosted
tester run will record the tester's complete request set — ports, paths,
headers, body sizes, TLS parameters and NetGauge command sequences — after
which any remaining divergence can be fixed against ground truth rather than
reconstruction.

No claim is made that the hosted tester now passes; the fixes above are
regression repairs plus observability, verified against the official binary
and the public endpoint surface.
