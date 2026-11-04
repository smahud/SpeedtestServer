# OFFICIAL_CLI_RESULTS — the primary evidence

All runs 2026-11-04, official CLI `1.2.0.84 (ea6b6773cf)` (unmodified), lab
config-proxy targeting (see `OFFICIAL_CLI_TEST_PLAN.md`). Full JSON in
`validation/evidence/`.

## Row 1 — Official CLI → official OoklaServer (`OFFICIAL_CLI_TO_OFFICIAL_SERVER`)

| Run | Target | Exit | Ping (ms) | Download | Upload | packetLoss | persisted |
|---|---|---|---|---|---|---|---|
| baseline-cli-1 (via recording relay) | daemon :18080 | 0 | 0.232 | 13.64 Gbps / 15.82 GB | 12.16 Gbps / 17.27 GB | 0.515 * | false |
| baseline-cli-2 (direct) | daemon :18080 | 0 | 0.055 | 67.01 Gbps / 64.95 GB | 37.58 Gbps / 56.29 GB | 0 | false |
| baseline-cli-3 (direct) | daemon :18080 | 0 | 0.051 | 68.8 Gbps | 42.3 Gbps | 0 | false |

\* relay NAT artifact (F-7) — the reference daemon's encrypted-protocol UDP
sessions carry a client self-reported address, so RECV replies bypass a NAT'ing
relay. Direct runs show the true 0%. This is exactly why gate runs are direct.

## Row 2 — Official CLI → **SpeedtestServer** (`OFFICIAL_CLI_TO_SPEEDTESTSERVER`) ★ primary proof

| Run | Target | Exit | Ping (ms) | Jitter (ms) | Download | Upload | packetLoss | persisted |
|---|---|---|---|---|---|---|---|---|
| gate-cli2 | STS :8080 | **0** | 0.047 | 0.077 | **20.27 Gbps / 24.56 GB / 10.1 s** | **15.66 Gbps / 18.95 GB / 10.1 s** | **0** | false |
| gate-cli2-run2 | STS :8080 | **0** | 0.034 | — | 21.7 Gbps | 14.6 Gbps | **0** | false |
| gate-cli2-run3 | STS :8080 | **0** | 0.033 | — | 18.4 Gbps | 13.6 Gbps | **0** | false |

### Destination and process proof (gate-cli2)

- Pre-run `ss -tlnp`: `*:8080 users:(("MainThread",pid=4605))` —
  `node dist/bin/ooklaserver.js` (SpeedtestServer, canonical build).
- All OoklaServer daemon processes explicitly killed and verified absent;
  port 18080 not listening during the run.
- CLI result `server.host = localhost`, `server.ip = ::1`, `port = 8080`.

### Server-side corroboration (SpeedtestServer's own evidence log)

`evidence/gate-cli2-sts-evidence.jsonl`: 23 NetGauge connections, 1,883
commands, 770 completed downloads, 596 completed uploads,
**24,651,035,453 bytes sent** and **19,107,443,639 bytes received** — matching
the client-reported 24.56 GB down / 18.95 GB up (delta = protocol framing),
i.e. the session was handled entirely by SpeedtestServer. Zero HTTP requests
during the run (pure NetGauge, daemon parity).

### Non-publishing proof

- Every run: `"result": { "persisted": false }` in the CLI JSON.
- Proxy log: `results.speedtest.net:443` CONNECT refused ("blocked",
  non-publishing guarantee) while the genuine engine config was fetched with
  the CLI's own query string.
- No public result URL was produced; no Ookla submission endpoint was ever
  contacted.

### Phase completion checklist (Gate CLI-4)

handshake ✔ (23 sessions, HI→HELLO) · server selection ✔ (localhost chosen)
· latency ✔ (ping/jitter reported) · jitter ✔ · download ✔ (24.56 GB)
· upload ✔ (18.95 GB) · packet-loss ✔ (0, via UDP LOSS/RECV + PLOSS)
· correct completion + exit 0 ✔ · valid structured result ✔
· resource cleanup ✔ (connections closed, no leaks — see PERFORMANCE_REPORT)
· accurate server association ✔ (byte-counter match above).

## Machine-readable gate files

- `evidence/OFFICIAL_CLI_TO_SPEEDTESTSERVER.json` — status **PASS** (schema per MASTER PROMPT §12)
- `evidence/OFFICIAL_CLI_TO_OFFICIAL_SERVER.json` — status **PASS**

## Row 3 — Official CLI → SpeedtestServer with **publishing opt-in** (Result URLs)

Same forcing chain as Row 2, but `cv-proxy.mjs --publish` tunnels
`results.speedtest.net` so the CLI's submission is accepted and returns a
genuine public Result URL. 9 committed runs / 6 distinct server IDs, all
`persisted=true` — full table, corroboration and reproduction in
**`PUBLISHED_RESULT_URLS.md`** (evidence: `evidence/published/`, harness:
`harness/run-result-url-battery.sh`). The non-publishing guarantee of Rows 1–2
is unchanged; publishing is opt-in only for this battery.
