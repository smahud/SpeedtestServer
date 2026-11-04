# validation/harness — automated CLI cross-validation harness

Reproducible evidence generation for the OoklaServer-compatibility profile of
**SpeedtestServer**. Everything here is lab tooling; the server itself lives in
`reverse-engineered/typescript/`.

## Components

| File | Purpose |
|---|---|
| `gen-pki.sh` | Lab PKI: root CA, daemon/server cert (localhost + loopback IPs), MITM cert for `cli.speedtest.net`, CLI trust bundle (system store + lab CA) |
| `cv-proxy.mjs` | Config-level proxy that legitimately directs the **unmodified official CLI** at a local server: live `cli.speedtest.net` engine config is fetched with the CLI's own query string, every server entry is redirected to the local target, and `results.speedtest.net` is **REFUSED** (non-publishing guarantee). Zero dependencies. |
| `recording-relay.mjs` | TCP+UDP byte-level tap (replaces tcpdump in unprivileged labs). Logs every command-sized frame and UDP datagram as JSONL; aggregates bulk streams. Used to reconstruct the protocol contract. |
| `run-official-baseline.sh` | Official CLI → official OoklaServer reference baseline (+ non-publishing check). |
| `run-replacement-test.sh` | Official CLI → SpeedtestServer. **Fails closed**: aborts if the endpoint isn't owned by SpeedtestServer or any official daemon process is alive; verifies target + non-publishing post-run. |
| `run-differential-suite.sh` | Four-way differential probes (reference vs replacement). |
| `negative-tests.mjs` | Level-4 negative/stability battery (invalid commands, oversized lines/headers, malformed TLS, mid-download aborts, UDP garbage flood). |
| `summarize-results.mjs` | Builds the machine-readable gate summaries from evidence files. |

## Canonical evidence flow

```bash
# 0) one-time setup
./gen-pki.sh                                   # certs/ next to this dir
mkdir -p ../../clients/speedtest && tar -xzf <official-cli-tgz> -C ../../clients/speedtest
# reference daemon (authorized lab): see validation/REPRODUCE.md

# 1) baseline (official → official)
REF_PORT=18080 ./run-official-baseline.sh

# 2) start SpeedtestServer, then (official → replacement)
cd ../../reverse-engineered/typescript && npm install && npm run build
node dist/bin/ooklaserver.js --evidence-log ../../../validation/harness/out/sts-evidence.jsonl &
cd - && STS_PORT=8080 ./run-replacement-test.sh

# 3) differential + negative
REF_PORT=18080 STS_PORT=8080 ./run-differential-suite.sh
node negative-tests.mjs 8080
```

## Safety design

- The CLI's license, engine parameters and server list stay **genuine** — the
  proxy only redirects connection targets, using the CLI's own query string.
- **Non-publishing is enforced at the proxy**: `results.speedtest.net` is
  refused, so no lab measurement can become a public result
  (`"persisted": false` + `blocked` entries in the proxy log).
- The replacement test refuses to pass unless the CLI actually selected the
  local SpeedtestServer and the server-side evidence corroborates the run.
