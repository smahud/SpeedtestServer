# Wildcard fix deployment — 2026-11-23

The source fix from REINVESTIGATION_2026-11-23.md was deployed at the operator's
request to `45.126.249.250`, serving `speedtest.lumajangnetworks.my.id:8080`.
The earlier investigation report describes the state before this deployment.

The VPS source was updated under `/opt/SpeedtestServer-src`, built with its
existing Node.js 24.22.3 environment, and passed all eight wildcard regressions.
The installed runtime under `/opt/speedtestserver` was updated and
`speedtestserver.service` restarted. Configuration and TLS material were preserved.

Installed `dist/server/HttpApi.js` SHA-256 matches the local build:
`55fe7f1f1074657d91c1df7a8d4bf5c03a05ae902900d3b6054a96cc10ee247a`.
Backup runtime: `/root/speedtestserver-rollback/wildcard-L1N4cl/dist`.

## Acceptance checks

The independent `SpeedtestHost-Tester/chatgpt` engine ran from this development
machine against the public hostname, with default legacy port 80, normal DNS,
strict TLS verification, and **no target IP override**.

**19 passed / 0 failed:** NetGauge, WebSocket, daemon crossdomain, HTTPS,
legacy crossdomain, latency, upload, max_upload, all ten JPEG fingerprints,
and KeepAlive. The former 17/19 result is now 19/19.

Evidence: [host-tester-public.json](evidence/deploy-wildcard-20261123/host-tester-public.json).
This is the repository tester's result, not a separately executed verdict from
Ookla's CAPTCHA-protected hosted tester.

Public HTTPS `/hi` returned 200 instead of redirecting to the wildcard CN.
Speedtest, the legacy fallback and layanan lain remained active, with zero automatic
restarts. layanan lain's existing process remained unchanged; its HTTP 8081 returned
200. Speedtest continues to listen on TCP/UDP 5060/8080, legacy HTTP on 80,
and layanan lain on 8081/8443 with its existing 443 redirect.

Runtime-state evidence: [runtime-state.json](evidence/deploy-wildcard-20261123/runtime-state.json).

Reproduce the acceptance check from the repo root:

```sh
python3 validation/harness/host-tester-check.py \
  --tester-dir ../SpeedtestHost-Tester/chatgpt \
  --host speedtest.lumajangnetworks.my.id:8080
```
