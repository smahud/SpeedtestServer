# REPRODUCE — end-to-end reproduction guide

Environment used: Debian 13 x86_64, unprivileged user, Node ≥18 (v24 tested),
no root required. All commands run from the repo root unless noted.

## 1. Build the server

```bash
cd reverse-engineered/typescript
npm install
npm run build          # dist/bin/ooklaserver.js
npm test               # 44/44 protocol conformance tests must pass
```

## 2. Lab PKI

```bash
mkdir -p validation/harness/certs validation/harness/out
(cd validation/harness && ./gen-pki.sh)
```

## 3. Obtain official artifacts (never committed)

```bash
mkdir -p clients/speedtest
curl -sSL -o /tmp/cli.tgz \
  https://install.speedtest.net/app/cli/ookla-speedtest-1.2.0-linux-x86_64.tgz
tar -xzf /tmp/cli.tgz -C clients/speedtest
sha256sum /tmp/cli.tgz    # expect 5690596c…cfeeb7 (see REFERENCE_BINARY_MANIFEST.md)

# reference daemon (for baselines/differentials only):
mkdir -p lab/daemon && cd lab/daemon
curl -sSL -o o.tgz https://install.speedtest.net/ooklaserver/stable/OoklaServer-linux-x86_64-static-musl.tgz
tar -xzf o.tgz && sha256sum o.tgz   # expect ce180aa3…598159
# create OoklaServer.properties with: tcpPorts=18080 udpPorts=18080 useIPv6=true
#   enableAutoUpdate=false, openSSL.server.certificateFile/key = lab certs,
#   access-log block per validation/harness/run-official-baseline.sh docs
cp ../../validation/harness/certs/server.pem cert.pem
cp ../../validation/harness/certs/server.key key.pem
./OoklaServer &        # verify: ss -tlnp | grep 18080
```

## 4. Run the gates

```bash
cd validation/harness
# baseline: official CLI → official daemon (non-publishing enforced)
REF_PORT=18080 ./run-official-baseline.sh

# replacement: official CLI → SpeedtestServer (fails closed on wrong target!)
cd ../../reverse-engineered/typescript
node dist/bin/ooklaserver.js --ports 8080,5060 --udp-ports 8080,5060 \
  --evidence-log ../../validation/harness/out/sts-evidence.jsonl &
cd ../../validation/harness
STS_PORT=8080 ./run-replacement-test.sh

# differential + negative
REF_PORT=18080 STS_PORT=8080 ./run-differential-suite.sh
node negative-tests.mjs 8080
```

## 4b. Result-URL battery (publishing opt-in — optional)

The gates above are deliberately non-publishing. To reproduce the published
Result-URL battery (`PUBLISHED_RESULT_URLS.md`), which forces several distinct
server IDs at SpeedtestServer and captures a genuine public Result URL per run
(`results.speedtest.net` is tunneled instead of refused):

```bash
cd validation/harness
SERVER_IDS='60178 43356 35791 63143 48446 65463:human' \
  CLI=../../clients/speedtest/speedtest \
  OUT=./out/result-urls ./run-result-url-battery.sh
```

The script starts/stops SpeedtestServer per run (fresh evidence log each),
keeps the fail-closed preflight, and appends one machine record per run to
`battery-summary.json`. Run back-to-back batteries may show stochastic
loopback UDP-loss outliers — see `PUBLISHED_RESULT_URLS.md` §5.

## 5. What PASS looks like

- `out/replacement/cli.json`: `"type":"result"`, `server.host=localhost`,
  `packetLoss:0`, `result.persisted:false`, exit code 0.
- `out/replacement/process-inventory.txt`: target port owned by
  `node dist/bin/ooklaserver.js`; "official daemon: ABSENT".
- `out/sts-evidence.jsonl`: byte counters ≈ the client's reported volumes.
- Host tester (optional, from the SpeedtestHost-Tester repo, read-only):
  `node speedtest-host-tester.mjs 127.0.0.1:8080` → 10/10 PASS.

## 6. Manual spot checks

```bash
printf 'HI\nGETIP\nPING 1\n' | nc 127.0.0.1 8080
# → HELLO 2.11 (2.11.5) 2026-06-04.1737.7d0993d / YOURIP … / PONG …
curl -A x http://127.0.0.1:8080/hi              # hello 2.11 (…) 
curl -A x -X POST --data 12345 http://127.0.0.1:8080/speedtest/upload.php   # size=5
curl -k -A x https://127.0.0.1:8080/hi          # same over TLS on the SAME port
```

## Notes / gotchas

- The CLI needs both proxies set: `ALL_PROXY` and `HTTPS_PROXY` (the harness
  scripts export them).
- `--ca-certificate` **replaces** the trust store → always pass the combined
  bundle from `gen-pki.sh`.
- Run gate tests **directly** (no NAT'ing recorder in the path) — see
  `OFFICIAL_CLI_FAILURE_ANALYSIS.md` A-2.
- If the CLI's top-pick server list changes, the harness's rewrite-all mode
  keeps the lab self-contained (no fallback to production servers).
