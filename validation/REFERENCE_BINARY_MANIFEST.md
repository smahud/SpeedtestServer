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

### Relationship to the previously recorded baseline — CORRECTED 2026-11-05

The earlier text claimed two *different* 2.11.5.2 artifacts. That was a
category error, corrected during revision 5 (finding F-M1):

- `ce180aa3…598159` is the SHA-256 of the stable **tarball**.
- `f19e5ed2…d92f027a` is the SHA-256 of the **binary inside that tarball**.
- Verified 2026-11-05 by re-downloading the official stable tarball
  (`https://install.speedtest.net/ooklaserver/stable/OoklaServer-linux-x86_64-static-musl.tgz`,
  tarball sha256 `ce180aa3…`): the extracted `OoklaServer` binary is
  **byte-identical** (`cmp` = 0 differing bytes) to the binary committed in
  this repository as `OoklaServer-linux-x86_64` (sha256 `f19e5ed2…`).
  There are not two builds — there is one build in two wrappers.

All evidence across revisions was therefore produced against the SAME
build `2026-06-04.1737.7d0993d`, re-confirmed live in the rev-5 lab (daemon
log: "OoklaServer version 2.11 (2.11.5.2) build number 2026-06-04.1737.7d0993d").

## Official Speedtest CLI (the gate client)

- **URL:** `https://install.speedtest.net/app/cli/ookla-speedtest-1.2.0-linux-x86_64.tgz`
- **Tarball SHA-256:** `5690596c54ff9bed63fa3732f818a05dbc2db19ad36ed68f21ca5f64d5cfeeb7`
- **Version:** `Speedtest by Ookla 1.2.0.84 (ea6b6773cf) Linux/x86_64-linux-musl`
- ELF64 static, stripped. **Never modified, never patched.**
- License: proprietary Ookla EULA (accepted via `--accept-license` at runtime;
  personal/non-commercial use). No redistribution into this repository.

## Handling rules honored — corrected 2026-11-05, provenance complete

The earlier claim "no vendor binaries are committed to this repository" was
FALSE: the repository has tracked five vendor binaries since the initial
commit (`OoklaServer-linux-x86_64`, `OoklaServer-linux-aarch64`,
`OoklaServer-macosx`, `OoklaServer-windows-x86_64.exe`,
`OoklaServer-windows64.zip`). Recorded facts:

- **Provenance re-verification completed 2026-11-05 (revision 6): ALL FIVE
  committed vendor binaries were re-downloaded from the official channel
  (`install.speedtest.net/ooklaserver/stable/…`) and verified
  byte-identical:**
  - `OoklaServer-linux-x86_64` — tarball `ce180aa3…598159` → binary
    `f19e5ed2…d92f027a`, `cmp` = 0 differing bytes.
  - `OoklaServer-linux-aarch64` — tarball `c72b4f43…` → binary
    `f7fd93c3…a9780edaa`, `cmp` = 0 differing bytes.
  - `OoklaServer-macosx` — tarball `cb0d6b18…` → binary
    `04a1e383…5169badf`, `cmp` = 0 differing bytes.
  - `OoklaServer-windows64.zip` — `dd0b1baa…4e99efb75955` identical
    hash; the `OoklaServer.exe` inside it is `bc715e20…8344a8e9a4`,
    byte-identical to the committed `OoklaServer-windows-x86_64.exe`.
  Every committed vendor binary is therefore the unmodified official
  stable build of `2026-06-04.1737.7d0993d`.
- Redistribution authorization for ANY committed vendor binary is NOT
  established by this repository's MIT license (which covers this project's
  code only). Recommendation for the maintainers: exclude vendor binaries
  from future source releases or obtain explicit redistribution permission;
  do NOT rewrite existing Git history (per the handling rules).
- The reference daemon continues to be run only in the isolated lab for
  behavior observation and differential baselines; it is absent from the
  SpeedtestServer runtime and from all replacement-profile evidence.
- The reference daemon was run **only** in the isolated lab for behavior
  observation and differential baselines; it is absent from the
  SpeedtestServer runtime and from all replacement-profile evidence.
- MIT licensing of this repository's source covers only this project's code;
  it conveys no rights over Ookla binaries, protocol branding, or the
  `Speedtest`/`OoklaServer` trademarks. The default version banner
  (`OoklaServer.netgaugeVersionString`) is a **compatibility-profile string**
  and is configurable.
