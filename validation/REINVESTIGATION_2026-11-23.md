# Official client / reference binary reinvestigation — 2026-11-23

## Scope and environment

The operator's actual endpoint is `speedtest.lumajangnetworks.my.id:8080`,
resolving to `45.126.249.250`. The apex hostname used in the earlier deployment
checks is a different destination. This pass performs local coding and temporary
lab experiments only; **no VPS configuration, files, or services were changed**.
The remote endpoint was contacted for normal measurement and HTTP/TLS probes.
All owned lab daemons/proxies were stopped after their runs; none was installed
as a service on this development machine.

Artifacts actually executed (not patched):

| Artifact | Identity |
| --- | --- |
| Repo `OoklaServer-linux-x86_64` | SHA-256 `f19e5ed240dc185bcaf6ca96e0fa40d5ee53e3a543f4c562082ac0d8d92f027a` |
| Sibling repo official Speedtest CLI | `1.2.0.84 (ea6b6773cf)`, SHA-256 `31f1124c5ab8acdae6b9fe1741e704df420f9f2e7d429679fabe62075453c051` |

REA ELF inspection records preserve these exact identities:
`ev_4a49aa7a5d2358ac0fe7d203db94c7622f65c2345a142ff39adf0b02ae22519a`
(server) and `ev_91832f3cfca7907141971b86a6b303d170ec18291d8262de40583bc29de0f422`
(CLI). Their scope is offline ELF metadata, not decompilation or runtime proof.
Runtime evidence comes from the actual binaries, strace, server events, and
controlled wire probes. REA MCP was not registered in this client; its installed
CLI supplied the two portable ELF inspections without changing registration.

All evidence paths below are relative to `evidence/reinvestigation-20261123/`.

## Fresh official CLI runs

| Run | Selected endpoint / observed IP | CLI exit | Packet loss | Published |
| --- | --- | --- | --- | --- |
| `reference-01` | Original daemon, `localhost:18080` / `::1` | 0 | 0 | No |
| `replacement-02` | TypeScript, `localhost:18081` / `::1` | 0 | 0 | No |
| `remote-forced-01` | Actual subdomain, port 8080 / `45.126.249.250` | 0 | 0 | No |
| `replacement-after-fix-02` | Fixed TypeScript, `localhost:18081` / `::1` | 0 | 0 | No |

Each directory has `cli.json`, `summary.json`, connection tracing and proxy logs.
The client binary was unmodified. A lab proxy fetched the real configuration
with the client's query/UA, rewrote candidate **endpoints**, and refused
`results.speedtest.net` submissions. Successful runs independently record both
`persisted:false` and the refusal. No result URL was published.

These are forced-endpoint interoperability tests. Server IDs/sponsors in these
results belong to candidate entries returned by the live API and are **not**
proof of the target's registered server identity. Loopback measurement speeds
are also not production throughput benchmarks.

`official-cli-session-map.json` derives phase observations from 2,643 server
events in `replacement-02/server-events.jsonl`: 23 command-bearing connections,
including selection/latency, four download workers, four upload workers,
packet-loss control, capabilities, and monitoring. Observed commands include
`HI`, `GETIP`, `PING`, `DOWNLOAD`, `UPLOAD`, `INITPLOSS`, `PLOSS`, `CAPABILITIES`
and `UPLOAD_STATS`. Initial non-text probes are followed by plaintext fallback
on TypeScript. This records the client behavior; it does not decrypt/reconstruct
the original daemon's proprietary encrypted engine.

## Discovery is a separate unresolved observation

The CLI's `--host=speedtest.lumajangnetworks.my.id` lookup received an empty
server list (`remote-01/proxy.jsonl`), producing `NoServersException`. A direct
CLI listing with `--host=speedtest.lumajangnetworks.my.id:8080` also returned
`No servers defined` (`official-host-with-port.*`). DNS resolution succeeded.

This observation does not establish that the operator's registration is absent:
directory visibility, API filtering and registration state are outside the
local server implementation. No registration, admission, server ID or global
visibility claim is made from the forced-endpoint tests.

## Confirmed HTTP wildcard defect and local fix

The real subdomain reached the deployed TypeScript server with a valid wildcard
certificate, but `/hi` redirected to the literal wildcard CN:
`https://*.lumajangnetworks.my.id:8080/hi`.

The independent host tester against the **real subdomain**, with default legacy
port 80 and real DNS, passed **17/19**. Its failures were daemon crossdomain and
HTTPS, both consistent with the empty 307 response. Upload/max_upload, images
and KeepAlive on the separate legacy service passed. Evidence:
`live-subdomain-host-tester.json`. This is the repo tester's verdict, not a fresh
verdict from Ookla's CAPTCHA-protected hosted tester.

Controlled lab comparisons used the same self-generated wildcard certificate
on both backends (`wildcard-host-comparison.json`), then compared exact-SAN and
wildcard-SAN reference fixtures (`reference-host-identity-matrix.json`).
The original binary accepted the legitimate subdomain; the old TypeScript
comparison accepted only exact SAN strings, so it returned 307.

`HttpApi.hostMatches` now accepts single-label wildcard SAN matches, including
case-insensitive names and explicit request ports. Unrelated, lookalike and
multi-label names remain rejected. In the tested wildcard fixture, the original
binary also accepted unrelated Hosts; retaining the narrower certificate scope
is deliberate decision D-12, not a claim of byte-for-byte wildcard parity.

Eight new regression cases first reproduced three legitimate-host failures and
then passed. The built listener independently returned **HTTP 200 and strict
TLS 200** for the legitimate subdomain while rejecting unrelated hosts:
`wildcard-fix-live-validation.json`. This fix remains local; the VPS was not
redeployed during this pass.

## Differential battery and its boundaries

The first 103-case battery used the historical `Host: san1.local` while the
current lab certificate did not contain that SAN. It therefore exercised 307
responses for most HTTP cases: 57 comparison matches. That is a fixture mismatch,
not evidence of 46 server regressions. The original records remain retained.

The corrected harness explicitly uses certificate-covered `Host: localhost`,
accepts an output path, and no longer writes into the original author's absolute
home directory. The corrected run is retained in `valid-host-battery/`:

| Classification | Cases |
| --- | --- |
| Identical according to the harness's declared normalization | 89 |
| Expected varying payload, timestamp or listener-port fields | 6 |
| Protocol/safety deviations already represented by this compatibility profile | 8 |
| Total | 103 |

The six variable cases are two native DOWNLOAD payloads, two HTTP measurement
payloads, the crossdomain listening port, and the WS PONG timestamp. The eight
deviations are bare INITPLOSS, three invalid/unbounded DOWNLOAD requests,
TRACE routed into the binary engine, and three sessionless UDP/PLOSS cases.
These are **not** 103 identical responses or complete encrypted-engine parity.
See `valid-host-battery/protocol-differential.json`, the classification file,
and `reference-protocol.trace` for bounded original-daemon syscall observations.

## Verification and reproduction

The first full suite had 173/174 passes, with one `EADDRINUSE` caused by a random
test port overlapping a live lab socket. The hardening fixture now obtains an
unused port from the OS and avoids reusing its own selections. Focused wildcard
and hardening tests passed 25/25; the final complete suite passed **174/174**.
The final log is `final-suite.log`. Build and syntax/diff checks also passed.

From the repo root (Node/npm, Python, OpenSSL and strace; CLI in sibling repo):

```sh
cd reverse-engineered/typescript && npm ci && npm run build && npm test -- --runInBand
cd ../..
bash validation/harness/gen-pki.sh
python3 validation/harness/reinvestigate-cli.py reference --out /tmp/re-reference-new
python3 validation/harness/reinvestigate-cli.py replacement --out /tmp/re-replacement-new
python3 validation/harness/reinvestigate-cli.py remote --out /tmp/re-discovery-new
python3 validation/harness/reinvestigate-cli.py remote --force-target --out /tmp/re-remote-new
python3 validation/harness/run-differential-lab.py --out /tmp/re-differential-new
```

Use fresh output directories. The CLI runner distinguishes discovery from
forced endpoint selection, waits for listeners, bounds execution, and cleans up
owned process groups. Lab CA keys stay ignored locally and are never evidence
artifacts. No command above installs a service or deploys to the VPS.
