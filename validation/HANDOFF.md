# HANDOFF — continuation instructions (no conversation history required)

## Where things stand (2026-11-04)

- **The mandatory acceptance criterion is MET and evidenced:** the unmodified
  official Speedtest CLI (1.2.0.84) completes full measurements (latency,
  download, upload, packet-loss 0) against SpeedtestServer with the official
  daemon absent — 3/3 gate runs, non-publishing enforced
  (`validation/evidence/OFFICIAL_CLI_TO_SPEEDTESTSERVER.json` = PASS).
- **Published Result-URL battery (2026-11-04):** same forcing chain with
  publishing opted in — 9 runs / 6 distinct server IDs, all `persisted=true`
  with genuine public Result URLs (`PUBLISHED_RESULT_URLS.md`,
  `evidence/published/`, harness `run-result-url-battery.sh`; `cv-proxy.mjs`
  grew an opt-in `--publish` flag, default behavior unchanged).
- Host tester parity 10/10; differential probe parity 35/37 identical (2
  expected non-differences); unit suite 44/44; negative suite 7/7.
- Canonical implementation: `reverse-engineered/typescript` (new core:
  `ServerCore`, `NetGaugeEngine`, `UdpLossEngine`, `HttpApi`). JS twin
  deprecated. Deliverable branch: `audit/official-cli-interoperability`
  (push may require owner credentials — see FINAL_REPORT §J).

## How to re-verify from scratch

Follow `validation/REPRODUCE.md` top-to-bottom (build → PKI → gates). Expected:
44/44 unit, 7/7 negative, 3/3 CLI replacement runs exit 0 with
`packetLoss: 0`, host tester 10/10.

## Known gaps / next steps (ordered)

1. **Encrypted-binary engine protocol** (D-2): only relevant if a future CLI
   drops the plaintext fallback. Requires deep RE of `Ookla::AESEncryptor`
   key derivation (start: `reverse-engineering-batch/` artifacts + the CLI
   binary). Risky/legally sensitive — treat as optional, keep the fallback
   verified by CI instead.
2. **Enforce `allowedDomains` / `userAgentFilterEnabled`** in the canonical
   server (config keys are parsed but not applied; UA-less-500 core behavior
   is implemented). Small, well-scoped.
3. **Tighter idle-timeout default** (current 1 h mirrors the daemon).
4. **Cluster/multi-process mode** for >20 Gbps serving on a single host.
5. **Leak profiling** with `--expose-gc` + heap snapshots after N full CLI runs.
6. **CI wiring** (`run-replacement-test.sh` as an acceptance stage; skip must
   be reported as BLOCKED/SKIPPED, never green — MASTER PROMPT §14/§21).
7. **Delete-or-archive decision** for the deprecated `javascript/` twin after
   one release cycle with the TS core stable.

## Files that hold the knowledge

- Protocol: `validation/PROTOCOL_CONTRACT.md` (single source of truth; every
  row has a confidence label and is reproducible via the harness).
- Why the design is what it is: `validation/DECISIONS.md`.
- What was broken before: `validation/FINDINGS.md`, `CONTEXT_BASELINE.md`.
- Raw evidence: `validation/evidence/` (+ gate JSONs in the §12 schema).
- Harness: `validation/harness/` (fail-closed by design — do not weaken it).
