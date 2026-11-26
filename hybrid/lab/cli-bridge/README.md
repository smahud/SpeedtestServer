# cli-bridge — DIPENSIUNKAN → `hybrid/speedtest-bridge/`

> Eksperimen lab `cli-bridge` (27 Nov 2026) telah **dipromosikan menjadi
> komponen produksi** `hybrid/speedtest-bridge/` (rename + hardening,
> 27 Nov 2026): env `BRIDGE_*` → `SPEEDTEST_BRIDGE_*`, unit systemd permanen
> `speedtest-bridge.service` (auto-start + auto-restart), mux TLS daemon-parity
> di :8080 (gateway hybrid pindah ke loopback — hanya port native OoklaServer
> yang terbuka), guard rate-limit per-IP. Baterai uji:
> `hybrid/speedtest-bridge/test/` (225/225).
>
> - Kode + README + unit produksi: **`hybrid/speedtest-bridge/`**
> - Kontrak proyek: **`CONTRACT.md`** (root repo)
> - Laporan eksperimen asli: `docs/CLI_BRIDGE_REPORT_2026-11-27.md`
> - Evidence run b0–b4: `hybrid/lab/evidence/cli-bridge-2026-11-27/`
>   (dibuat dengan versi lab pada commit `9b43b59` — untuk reproduksi
>   persis, `git checkout 9b43b59 -- hybrid/lab/cli-bridge/`)
>
> Enam commit lab eksperimen (4b69193..9b43b59) membangun logika yang kini
> di-serve produksi; README historis versi lab tersedia di riwayat git
> (`git show 9b43b59:hybrid/lab/cli-bridge/README.md`).
