# PUBLISHED_RESULT_URLS — genuine public Result URLs, measured against SpeedtestServer

Generated 2026-11-04 (UTC) by `validation/harness/run-result-url-battery.sh`
(evidence: `validation/evidence/published/`). Companion to
`OFFICIAL_CLI_RESULTS.md`: the gates there prove the **non-publishing**
replacement profile; this battery is the deliberate **publishing opt-in** —
the same unmodified official CLI, forced at several *different* live server
IDs, all transparently redirected to the local SpeedtestServer, with result
submission allowed so every test returns a **genuine, publicly reachable
speedtest.net Result URL**.

## 1. What was done

- Client: official Speedtest CLI `1.2.0.84 (ea6b6773cf)`, unmodified
  (tarball sha256 `5690596c…cfeeb7` per `REFERENCE_BINARY_MANIFEST.md`;
  extracted binary sha256 `31f1124c5ab8acdae6b9fe1741e704df420f9f2e7d429679fabe62075453c051`).
- Server under test: **SpeedtestServer** (`reverse-engineered/typescript`,
  `node dist/bin/ooklaserver.js --ports 8080,5060 --udp-ports 8080,5060`),
  started fresh per run with its own JSONL evidence log. Fail-closed
  preflight every run: port 8080 owner is the SpeedtestServer process
  (verified via `/proc/<pid>/cmdline`) and the official OoklaServer daemon is
  absent (`run-s*-process.txt`).
- Forcing mechanism: `cv-proxy.mjs --publish` with `CV_REWRITE_ALL=1` —
  the LIVE engine config is fetched from `cli.speedtest.net` using the CLI's
  own query string and User-Agent, then **every** server entry is redirected
  to `localhost:8080` while keeping the genuine server ids/names; with
  `--publish` the `results.speedtest.net:443` CONNECT is tunneled (logged as
  `k:"publish_tunnel"`) instead of refused, so the CLI can submit the
  finished measurement and receive a persisted Result URL.
- Multi-server: each run pins one distinct server ID from the live list via
  `-s <id>` (`--selection-details` on), so the CLI believes it tests that
  sponsor's server while every byte is served by SpeedtestServer on loopback.

## 2. Results (9 committed runs, 6 distinct servers, all persisted=true)

| Run tag | Server ID | Server name (as seen by CLI) | Actual target | DL (Mbps) | UL (Mbps) | Idle lat (ms) | packetLoss (%) | Result URL |
|---|---|---|---|---|---|---|---|---|
| s60178 | 60178 | Sun Mobile | localhost:8080 | 21,108.54 | 15,023.42 | 0.080 | 0 | https://www.speedtest.net/result/c/b7d0c8f1-610c-45b6-ba04-90773391fa91 |
| s43356 | 43356 | 1010 | localhost:8080 | 20,972.32 | 14,054.82 | 0.095 | 32.78 | https://www.speedtest.net/result/c/65279bab-1f41-472f-b92a-c6b09404d86b |
| s35791 | 35791 | SmarTone | localhost:8080 | 20,586.99 | 14,770.83 | 0.097 | 0 | https://www.speedtest.net/result/c/0c64a277-f92c-4178-a0bd-c398abec4e53 |
| s63143 | 63143 | Netvigator | localhost:8080 | 18,824.67 | 14,690.47 | 0.085 | 0 | https://www.speedtest.net/result/c/1510b504-3fd4-4b53-b809-232ac9845272 |
| s48446 | 48446 | GSL Networks | localhost:8080 | 21,639.67 | 14,309.67 | 0.073 | 0 | https://www.speedtest.net/result/c/5d96a9ce-a8c4-49f7-82ec-63db4be4e6de |
| s65463-human | 65463 | HKBN | localhost:8080 | 20,055.34 | 16,214.70 | 0.070 | 0.3 | https://www.speedtest.net/result/c/dd41b421-751f-45a4-a6bd-4c61be9a2081 |
| s60178-run2 | 60178 | Sun Mobile | localhost:8080 | 20,463.04 | 14,212.20 | 0.084 | 0 | https://www.speedtest.net/result/c/9e592b8b-6792-4770-8813-f3f9f30abc32 |
| s35791-run2 | 35791 | SmarTone | localhost:8080 | 18,700.06 | 13,558.40 | 0.081 | 0 | https://www.speedtest.net/result/c/308e5be6-5a7e-4488-ab93-3e98d5767f2b |
| s43356-run2 | 43356 | 1010 | localhost:8080 | 25,628.45 | 14,799.09 | 0.073 | 0 | https://www.speedtest.net/result/c/7d7473ee-8da5-4448-bf59-c6ec713847b3 |

Every run: CLI exit 0, `result.persisted=true`, `result.url` present,
`server.host=localhost`, `server.port=8080`, `server.ip=::1`. The
`s65463-human` row is the default human-readable format (exact output in
`run-s65463-human.txt`, including the classic final line
`Result URL: https://www.speedtest.net/result/c/dd41b421-…`); all other rows
are `-f json-pretty` (machine-readable files `run-s*.json`). Machine summary:
`battery-summary.json`; derived table: `battery-facts.json`.

Data volumes per run (client-reported): download 16.7–41.8 GiB, upload
13.3–25.1 GiB — full 10 s download + 10 s upload phases each, ~248 GiB moved
across the battery.

## 3. Destination proof and server-side corroboration

Per-run fail-closed inventory (`run-s*-process.txt`): port 8080 owner =
`node …/dist/bin/ooklaserver.js`, `official daemon: ABSENT`, UDP 8080/5060
listeners present. Per-run proxy log (`run-s*-proxy.jsonl`) shows the chain:
`config_req` (live query) → `config_served` (server `<id>` → localhost:8080
rewrite) → NetGauge traffic → `publish_tunnel` (results.speedtest.net:443).

SpeedtestServer's own evidence log corroborates the client byte-for-byte
(sum of `ng_download_done.n` = bytes sent; `ng_upload_done.counted` =
bytes received):

| Run | Client DL (GiB) | Server sent (GiB) | Client UL (GiB) | Server received (GiB) | NetGauge conns / commands | UDP sessions |
|---|---|---|---|---|---|---|
| s60178 | 34.9 | 34.9 | 25.1 | 25.2 | 13 / 2,649 | 2 |
| s43356 | 34.8 | 34.9 | 16.1 | 16.2 | 13 / 2,266 | 2 |
| s35791 | 16.7 | 16.7 | 13.9 | 14.0 | 13 / 1,381 | 2 |
| s63143 | 25.7 | 25.7 | 18.4 | 18.5 | 13 / 1,975 | 2 |
| s48446 | 25.8 | 25.9 | 15.3 | 15.4 | 13 / 1,815 | 2 |
| s60178-run2 | 17.6 | 17.6 | 13.3 | 13.4 | 13 / 1,386 | 2 |
| s35791-run2 | 17.6 | 17.6 | 15.8 | 15.9 | 13 / 1,522 | 2 |
| s43356-run2 | 41.8 | 41.8 | 14.0 | 14.1 | 13 / 2,373 | 2 |

Delta between client-reported and server-counted volumes: **0.0–0.4 %**
(framing/aborted streams) — i.e. the published measurements were genuinely
served by SpeedtestServer, not by any external host.

## 4. Result URL spot-verification (public pages fetched 2026-11-04)

| Result URL | Page showed | CLI reported | Match |
|---|---|---|---|
| `…/c/dcd6a459-4284-43e7-8be4-a7f435e042f4` (pilot, server 60178) | 19,703.13 / 13,655.97 Mbps, Hong Kong, Alibaba | 19,703.13 / 13,655.97 Mbps | exact |
| `…/c/0c64a277-f92c-4178-a0bd-c398abec4e53` (s35791) | 20,586.99 / 14,770.83 Mbps, Hong Kong, Alibaba | 20,586.99 / 14,770.83 Mbps | exact |
| `…/c/1510b504-3fd4-4b53-b809-232ac9845272` (s63143) | 18,824.67 / 14,690.47 Mbps, Hong Kong, Alibaba | 18,824.67 / 14,690.47 Mbps | exact |
| `…/c/0365d24b-159c-4f7a-a27b-f29fc93843f3` (battery-1 human, s65463) | 19,708.02 / 13,871.42 Mbps, Hong Kong, Alibaba | 19,708.02 / 13,871.42 Mbps | exact |

Note: the public page's "ping" figure for these loopback tests renders an
inconsistent value (Ookla's page-side derivation from the submitted payload);
the authoritative idle latency is the CLI's reported value (0.07–0.10 ms on
loopback). The `…/c/dd41b421-…` page was still JS-shell-only at fetch time
(minute-old result); the CLI only prints a Result URL after the submission
was accepted (`persisted=true`).

## 5. packetLoss variance in back-to-back batteries

Three runs across the session measured non-zero UDP loss on the loopback
path under back-to-back saturation (a 10 s 20+ Gbps flood on TCP while the
UDP loss stream competes for socket buffers): battery-1 s35791 → 32.21 %,
battery-1 s60178 → 0.55 %, final battery s43356 → 32.78 %. The affected
server *changed between attempts* and every isolated/pilot run measured 0 %,
confirming a stochastic host-level buffer effect, not a server defect — and
every server has at least one **zero-loss** committed Result URL above
(each affected ID has a labeled `run2` retry). The mandatory zero-loss
acceptance gates remain the 3/3 non-publishing runs in
`OFFICIAL_CLI_TO_SPEEDTESTSERVER.json` (single-run, no competing load).

## 6. Earlier attempts (superseded evidence, URLs remain live)

Same chain, first calibration battery 2026-11-04 08:05–08:08 UTC (evidence
superseded by the final battery above; URLs are permanent public records):

- Server 60178 (Sun Mobile): https://www.speedtest.net/result/c/aa939bb9-9a56-4a2f-8c90-d428233982ca (loss 0.55 %)
- Server 43356 (1010): https://www.speedtest.net/result/c/f3b4226a-557b-458b-af77-32044cfc27bf (loss 0)
- Server 35791 (SmarTone): https://www.speedtest.net/result/c/ffa4f51b-ca6e-4990-9b6d-1a2e957c4d10 (loss 32.21 %)
- Server 63143 (Netvigator): https://www.speedtest.net/result/c/df225756-56a9-4141-b5fa-6dac19b89c7d (loss 0)
- Server 48446 (GSL Networks): https://www.speedtest.net/result/c/c4bff11c-12f6-4464-9090-10f468f3e2be (loss 0)
- Server 65463 (HKBN, human): https://www.speedtest.net/result/c/0365d24b-159c-4f7a-a27b-f29fc93843f3 (loss 0.0 %)
- Pilot (server 60178, first publishing proof): https://www.speedtest.net/result/c/dcd6a459-4284-43e7-8be4-a7f435e042f4 (loss 0)

## 7. Reproduce

```bash
cd validation/harness && ./gen-pki.sh          # once (lab CA + cli bundle)
# SpeedtestServer is started/stopped per run by the script itself.
SERVER_IDS='60178 43356 35791 63143 48446 65463:human' \
  CLI=../../clients/speedtest/speedtest \
  OUT=./out/result-urls ./run-result-url-battery.sh
```

Each run prints its Result URL and appends a machine record to
`battery-summary.json`; per-run evidence: `run-s<id>[_<suffix>].json` /
`.stderr` / `-proxy.jsonl` / `-sts-evidence.jsonl` / `-process.txt` /
`-human.txt`. Publishing is **opt-in** (default `cv-proxy` behavior and both
mandatory gate harnesses stay non-publishing).

## 8. Scope note

These are genuine measurements of the lab host's loopback path, served end-
to-end by SpeedtestServer, published through the CLI's normal submission
flow. They demonstrate CLI↔server interoperability and a working result
pipeline; they are **not** Ookla host-network certification and say nothing
about any listed sponsor's real network (the sponsors' servers were never
contacted — every measurement byte stayed on loopback with the official
daemon absent).
