# Crossdomain / upload compatibility repair — 2026-11-23

## Confirmed defects

The operator reported crossdomain and upload failing in the hosted Ookla tester
after the wildcard deployment. The earlier 19-check clone did not test the full
configured port set or the native upload aliases/OPTIONS behavior, so its passing
verdict was insufficient. This pass used fresh observations of the unmodified
repo OoklaServer binary, plus inspection of earlier source and the actual PHP
fallback script from the tester repository.

The original binary was launched only as a temporary local reference process,
with **two TCP ports configured**. It established the following differences:

| Surface | Original binary | Deployed code before repair |
| --- | --- | --- |
| crossdomain `to-ports` | Entire configured TCP list on either listener | Only the incoming request's local port |
| `/speedtest/crossdomain.xml`, `/foo/crossdomain.xml` | 200, same policy | 404 |
| `POST /upload`, `/speedtest/upload`, `/foo/upload.php` | 200, exact raw-byte `size=` response | 404 |
| `OPTIONS /speedtest/upload.php` | 200, Content-Length 0 | 404 |

The old single-port fixture hid the policy error. Public production configuration
has both 5060 and 8080, while the previous body advertised only 8080 to clients on
that port. The native binary dispatches crossdomain/upload by final path component.
These are measured compatibility defects, not a capture of the hosted tester's
private backend requests; its exact failing request was not available.

## Source changes

`OoklaServer.ts` now passes `tcpPorts.join(',')`, and `HttpApi.ts` uses that full
list in policy entries. Crossdomain and native upload accept the verified path
aliases. OPTIONS upload uses the original daemon's bodyless 200 response.

Native upload continues to count raw POST bytes. The independent HTTP port-80
legacy fallback continues using its PHP-style form accounting; these two modes
were not incorrectly merged. A real PHP interpreter running the original script
was used locally as the fallback reference. Its differences from the daemon are
explicitly retained in the audit matrix.

New tests first reproduced **10 failures in 16 cases**. After the fix those tests
passed, and the complete suite passed **190/190**. The before and after logs are
in `evidence/http-repair-20261123/`.

## Deployment and verification

The VPS source at `/opt/SpeedtestServer-src` and runtime at
`/opt/speedtestserver` were updated; only `speedtestserver` was restarted.
Rollback snapshot: `/root/speedtestserver-rollback/http-parity-eBSdzq/dist`.
The fallback and layanan lain processes remained active with their original PIDs.

Runtime SHA-256 values match the local build:

- `dist/server/HttpApi.js`: `2bc969ee37a4f193bedcabbf83ba2564d1af93e689b081bbd101dc40b33ed33b`
- `dist/server/OoklaServer.js`: `98bfb43f31db58a5502917bbf5e0a1d3a8a5cd2cc17923fc34d5c0a704314085`

| Verification | Result | Evidence under `evidence/http-repair-20261123/` |
| --- | --- | --- |
| Fresh reference HTTP status/body matrix | 23/23 match after mapping only each backend's configured port numbers | `reference-route-matrix.json`, `reference-parity-summary.json` |
| New strict HTTP/HTTPS public checks before deployment | 5 pass, 16 fail | `public-before.json` |
| Same public checks after deployment | **21/21 pass** | `public-after.json` |
| Independent repo host tester, actual DNS, default legacy port 80 | **19/19 pass** | `host-tester-after.json` |
| Full source regression suite | **190/190 pass** | `regression-suite.log` |
| Official CLI, forced to the actual subdomain/IP | Exit 0, full result, no publishing | `official-cli-after/` |

The public check verifies both HTTP and strict HTTPS, requires **both** 5060 and
8080 in each default-domain policy entry, and exercises prefixed crossdomain,
upload aliases and OPTIONS. It also rechecks ordinary and maximum legacy uploads.
No DNS override or disabled TLS verification is used in the public acceptance tests.

The 23 reference comparisons concern status/body, not full header byte parity.
One row observes the original daemon's chunked-upload timeout; equal timeout
behavior does not mean a successful chunked upload. The original matrices,
including the PHP outcomes, remain available for inspection.

The official CLI result identifies `speedtest.lumajangnetworks.my.id:8080` at
`45.126.249.250`, with `persisted:false` and result submission blocked by the lab
proxy. This is a forced-endpoint protocol test, not proof of directory discovery
or server ID. Its observed packet loss was approximately **0.334%**, not zero;
that measurement is retained without substituting a more favorable run.

The hosted `speedtest.net/host-tester` remains behind Cloudflare human verification
in the available browser. The 19/19 and 21/21 outcomes above are independent
verification results, **not a newly observed verdict from the hosted page**.

## Reproduce

```sh
# Requires Node, Python, strace/OpenSSL as used by the existing lab, and PHP CLI
# for the original PHP fallback reference. Temporary certificates are generated
# and cleaned up by this harness; no preceding ignored lab files are needed.
python3 validation/harness/audit-http-reference.py
python3 validation/harness/check-http-compatibility.py --host speedtest.lumajangnetworks.my.id
python3 validation/harness/host-tester-check.py \
  --tester-dir ../SpeedtestHost-Tester/chatgpt --host speedtest.lumajangnetworks.my.id:8080
```

All reference processes are owned and stopped by the harness. No reference binary
or PHP server is installed as a service on this development machine or the VPS.
