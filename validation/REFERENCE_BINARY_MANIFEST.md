# REFERENCE_BINARY_MANIFEST — official artifacts used in this audit

## Official OoklaServer reference daemon (authorized lab observation)

- **URL:** `https://install.speedtest.net/ooklaserver/stable/OoklaServer-linux-x86_64-static-musl.tgz`
- **Downloaded:** 2026-11-04 (artifact last-modified 2026-06-18)
- **Tarball SHA-256:** `ce180aa3ed9b3c099713cf37ea2ded48c1f799f47c534ab732e21cea61598159`
- **Version (from daemon log + `hello` banner):** `2.11 (2.11.5.2) build 2026-06-04.1737.7d0993d`
- ELF64 x86-64 static-pie, stripped (15,550,832 B).
- Lab config: `OoklaServer.tcpPorts=18080`, `OoklaServer.udpPorts=18080`, `useIPv6=true`,
  `enableAutoUpdate=false`, lab-CA cert, access logging enabled (full file in the
  session's lab notes; reproduced in `REPRODUCE.md`).

### Relationship to the previously recorded baseline

MASTER PROMPT v3.0 §4 recorded a *different* tarball SHA-256
(`f19e5ed240dc185bcaf6ca96e0fa40d5ee53e3a543f4c562082ac0d8d92f027a`, also
labeled 2.11.5.2) as the earlier baseline. The current stable artifact
(sha `ce180aa3…`) does **not** match it — the stable channel was updated
(2026-06-18). Per §4 rules both are recorded separately; **all evidence in
this audit was produced against `ce180aa3…` / build `2026-06-04.1737.7d0993d`**
and is labeled as such. If the old artifact is re-obtained, reference tests
should be re-run and labeled separately.

## Official Speedtest CLI (the gate client)

- **URL:** `https://install.speedtest.net/app/cli/ookla-speedtest-1.2.0-linux-x86_64.tgz`
- **Tarball SHA-256:** `5690596c54ff9bed63fa3732f818a05dbc2db19ad36ed68f21ca5f64d5cfeeb7`
- **Version:** `Speedtest by Ookla 1.2.0.84 (ea6b6773cf) Linux/x86_64-linux-musl`
- ELF64 static, stripped. **Never modified, never patched.**
- License: proprietary Ookla EULA (accepted via `--accept-license` at runtime;
  personal/non-commercial use). No redistribution into this repository.

## Handling rules honored

- No vendor binaries are committed to this repository (`.gitignore`d / kept in
  the lab only); this manifest is the provenance record.
- The reference daemon was run **only** in the isolated lab for behavior
  observation and differential baselines; it is absent from the
  SpeedtestServer runtime and from all replacement-profile evidence.
- MIT licensing of this repository's source covers only this project's code;
  it conveys no rights over Ookla binaries, protocol branding, or the
  `Speedtest`/`OoklaServer` trademarks. The default version banner
  (`OoklaServer.netgaugeVersionString`) is a **compatibility-profile string**
  and is configurable.
