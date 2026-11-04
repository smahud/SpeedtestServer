# DIFFERENTIAL_MATRIX — four-way validation (MASTER PROMPT §5)

Run date 2026-11-04. Targets: reference daemon `2.11 (2.11.5.2) 2026-06-04.1737.7d0993d`
on 127.0.0.1:18080 (lab-CA cert) vs SpeedtestServer (canonical TS build,
commit on audit branch) on 127.0.0.1:8080 (same lab-CA cert).

| # | Test path | Result | Evidence |
|---|---|---|---|
| 1 | Official CLI → official daemon (**baseline**) | **PASS** ×3 (exit 0; loss 0 ×2 direct, 0.515 ×1 relayed — relay NAT artifact, see FAILURE_ANALYSIS F-7) | `evidence/baseline-cli-*.json` |
| 2 | Official CLI → **SpeedtestServer** (**primary proof**) | **PASS** ×3 (exit 0, loss 0, persisted=false) | `evidence/gate-cli2*.json` |
| 3 | Probe battery → daemon | 37 checks captured (reference behavior) | `evidence/diff-probe-daemon.json` |
| 4 | Probe battery → SpeedtestServer | **35/37 byte-identical; 2 expected non-differences** (PONG timestamp value; DOWNLOAD random payload after the constant `DOWNLOAD ` prefix — both by design) | `evidence/diff-probe-sts.json` |

## Probe-level differential (37 checks, grouped)

- **http (17):** `GET /`, `/hi`, `latency.txt`, `crossdomain.xml` bodies;
  upload.php GET→404/POST→`size=`; unknown→404; UA-less→500; Range ignored;
  CORS reflection; keep-alive; 10 image sizes — **all identical**.
- **netgauge-tcp (5):** `HI`→HELLO (identical string), `PING`→`PONG` (format
  identical; timestamp differs — expected), `DOWNLOAD 100000` → exact size
  incl. prefix (payload randomness differs — expected), garbage→`ERROR` — **behaviorally identical**.
- **ws (5):** `/ws` 101 upgrade, `/` → 200, other → 404, netgauge-over-WS
  `HI`→HELLO, WSS on same port — **all identical**.
- **tls (6):** TLS 1.0/1.1 rejected, 1.2/1.3 accepted, strict-CA verify OK
  (same lab CA), wrong-hostname fail, untrusted fail — **all identical**.
- **netgauge-udp (4):** naive text/zero probes → no response on both — **identical**.

## Host-tester differential (Level 2)

z.ai Speedtest Host Tester v1.1.0 (from SpeedtestHost-Tester
`audit/z-ai-official-validation`, run read-only):

| Target | Checks | Result |
|---|---|---|
| Reference daemon :18080 | 10 | **10 PASS / 0 FAIL** ("Server is publicly available and properly configured") |
| SpeedtestServer :8080 | 10 | **10 PASS / 0 FAIL** (same verdict) |

Per-check parity: hostname resolution, daemon detection (HTTP 200), version
banner, Netgauge/WS (wss, HI→HELLO, PING→PONG), HTTPS (TLSv1.3, CN=localhost,
issuer = lab CA), keep-alive, latency.txt, 10/10 download images, upload.php,
crossdomain.xml — identical outcomes on both servers.

## Interpretation

For every observable behavior in the compatibility profile, SpeedtestServer is
behaviorally identical to the reference daemon (the only differences are
inherently non-deterministic values: timestamps, random payload bytes, and
session UUIDs). The mandatory real-client rows (1 and 2) both PASS, so the
critical question of §5 — *can a client that works with the official server
complete the workflow on our replacement?* — is answered **yes, verified**.
