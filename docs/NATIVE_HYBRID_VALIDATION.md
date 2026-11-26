# NATIVE HYBRID VALIDATION — Test Matrix, Bukti, dan Keputusan Rilis

**Tanggal:** 26 November 2026 · **Basis:** `master@0ac51ac` (v1.5.2) · **Status akses uji:** shell VPS tersedia (uaeg MCP, read-only), Cloudflare API tersedia, lingkungan client eksternal tersedia (sandbox, egress 45.126.249.249). **Input operator yang masih pending: daftar server ID untuk matrix pengujian pra-publikasi** (tidak diberikan setelah master prompt → matrix ID ditandai sesuai).

---

## 1. Status matrix pengujian (ID minimum §10)

| ID | Pengujian | Status | Bukti / catatan |
|---|---|---|---|
| **B0** | Binary resmi → baseline VPS-only | **PASS (live + historis)** | Live 26 Nov: handshake raw TCP byte-exact `HELLO 2.11 (2.11.5)` + `/hi` HTTPS (`netgauge-handshake.json`). Historis: 9/9 server ID exit 0 (E-M A-mode, 24 Nov) + lab 3/3 run vs binary resmi (4 Nov). Tidak ada Worker payload — konsisten (jalur native memang tidak menyentuh edge) |
| **B1** | Gateway & Worker health | **PASS (live)** | `/api/health` mode hybrid v1.5.2; pool 100/100 deployed, deployStatus ok; worker-1 `/__meta` live HKG; kuota 0,1%; TLS sah (CA publik); bukan bukti native assist (sesuai definisi) |
| **N1** | Native client, edge enabled, DL | **BLOCKED_BY_PROTOCOL** (dan BLOCKED_BY_FREE_PLAN) | Gate F gugur: tidak ada mekanisme client native menuju edge (0 wreq E-M). Bukan sekadar "belum diuji" — mekanismenya tidak ada dalam protokol & platform Free |
| **N2** | Native client, edge enabled, UL | **BLOCKED_BY_PROTOCOL** (+ FREE_PLAN) | Idem N1; UL native = `UPLOAD <n>` pada koneksi TCP yang sama ke endpoint server-list |
| **N3** | Native full session (N1+N2) | **BLOCKED_BY_PROTOCOL** | Idem; sesi native selalu VPS-only dalam constraint ini |
| **N4** | Worker unavailable → VPS-only native tetap jalan | **PASS by design + live-partial** | Jalur native tidak bergantung edge (bukti E-M A; desain fallback v1.5). Test formal penuh (edge dimatikan disengaja) NOT_TESTED — butuh otorisasi perubahan produksi |
| **N5** | Worker fails mid-session | **NOT_TESTED** (tidak berlaku utk native: edge tidak pernah dipakai sesi native) | Untuk lane custom: deflection/fallback teruji lokal (suite worker 90/90, e2e-pool) |
| **N6** | Quota guard simulated | **PASS (design) + live-partial** | Quota guard aktif live (usedPct 0,1%, soft 80/hard 95); simulasi ambang teruji lokal; penghabisan kuota produksi disengaja dilarang §8 |
| **N7** | Mixed/concurrent sessions | **NOT_TESTED hari ini** | Historis: atribusi per-sesi (guid) tercatat `results.jsonl` (E-M, 11 run); uji konkurensi formal pending input operator |
| **N8** | IPv4/IPv6, TLS, DNS | **PARTIAL PASS** | IPv4 + TLS + DNS live terverifikasi (cert CA publik; DoH → 45.126.249.250; AAAA ada). Koneksi IPv6 efektif NOT_TESTED; resolver client native (musl statis) di lab sebelumnya terbukti via bind-mount namespace |
| **N9** | Platform resmi lain (web/mobile/desktop) | **NOT_TESTED** | Web resmi butuh server terdaftar di direktori (BLOCKED_BY_REGISTRATION); tidak ada handshake resmi ke endpoint eksternal |
| **N10** | Post-registration (DNS normal) | **BLOCKED_BY_REGISTRATION** | Server belum terdaftar; validasi pasca-registrasi menunggu persetujuan Ookla (G10-G11) |
| **R1** | Regression suites existing | **PASS (historis 26 Nov)** | Gateway 18/18; full-stack e2e 12/12; worker 90/90; installer staged smoke — semua tercatat commit `b629642`/`0ac51ac`. Regression BARU hari ini: tidak ada perubahan source (audit docs-only) |
| **R2** | Host Tester | **PASS (historis 24 Nov)** | 10/10 klien & 10/10 clone; 4 run operator dikonfirmasi; terpisah dari klaim offload. Ulang pasca-registrasi direkomendasikan |
| **C1** | Probe custom hybrid | **tersedia (diagnostik)** | TIDAK dihitung sebagai N1-N10 (sesuai batasan); dipakai hanya sebagai pembanding atribusi |

Penjelasan label: N1–N3 adalah **BLOCKED** (bukan NOT_TESTED) karena mekanisme yang diujikan tidak ada pada client/protokol/platform — menjalankan "eksperimen" akan menghasilkan angka kosong/relatif dan berisiko dianggap bukti palsu.

## 2. Tabel hasil run historis (format minimum §12; sumber: E-M campaign, 24 Nov 2026)

| Run ID | Server ID | Client/platform/version | Mode | DL Mbps | UL Mbps | Ping ms | VPS DL/UL bytes | Edge DL/UL bytes | Overlap DL/UL | Exit | Gate | Evidence |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| E-M/a-74964 … a-55749 (9 run) | 74964, 61853, 62314, 66281, 65429, 68214, 73025, 48532, 55749 | CLI resmi Ookla 1.2.0.84 (Linux, musl) | A — native VPS (mock DNS lab) | 455–508 | 59–148 | 59–64 | penuh sesi (mis. 74964: 722,3/221,7 MB) | **0 / 0** | n/a (edge tak dipakai) | 0 (9/9) | B0 | `e-m-official-cli-campaign/a-*.cli.json` + `attribution.txt` |
| E-M/iso-a-66281 (run terisolasi) | 66281 | CLI resmi 1.2.0.84 | A — native VPS (isolated, celah hening CF) | ±506 (cli dl 511,9 MB total) | ±224 (ul 224,2 MB) | 63,7 | 511,9 MB / 224,2 MB (eth0 penuh) | **0 / 0** (GraphQL: tanpa baris) | n/a | 0 | B0 (bukti kunci) | `iso-a-66281.cli.json`, `attribution.txt` |
| E-M/b-74964 … b-55749 (9 run) | idem | klien hybrid custom (engine sivel + transport hybrid) | B — custom hybrid | 405–622 | 230–758 | 124–129 | 0,45–0,49 MB total (kontrol) | 387,7 MB DL / 151,5 MB UL per run | ya (lane paralel client) | 0 (9/9) | C1 (bukan native) | `b-*.cli.json`, `attribution.txt` |
| audit-2026-11-26 (run audit ini) | n/a | probe protokol (bukan client uji) | read-only | n/a | n/a | n/a (GETIP/HELLO saja) | 0 (probe) | 0 | n/a | PASS | B0/B1 | `hybrid/lab/evidence/native-hybrid/audit-2026-11-26/` |

Nilai N/A disisakan apa adanya sesuai aturan ("tidak tersedia harus N/A/UNKNOWN"); Mbps pada run E-M diambil dari dokumen `Result_Comparison.md` §2 (median per-server tidak dihitung ulang — bukan sampel baru).

## 3. Bukti atribusi (ringkas)

- **Run resmi terisolasi 66281** (bukti kunci N1=N0): selama 05:46:57–05:47:21 UTC, CF GraphQL `workersInvocationsAdaptive` = **0 baris** (tidak ada request Worker) sementara eth0 VPS membawa seluruh 736 MB sesi (511,9 DL + 224,2 UL) → payload CLI resmi 100% VPS, 0% edge. Tiga sumber independen (counter eth0, journal daemon, GraphQL) konsisten.
- **Run mode B (custom)**: VPS eth0 delta < 0,5 MB vs 539 MB payload di edge (91–364 request Worker per uji) → offload nyata untuk lane custom saja (CUSTOM_CLIENT_ONLY).
- **Live hari ini**: `vpsDlShare=0.15` aktif pada front; pool 100 worker deployed+healthy; kuota 0,1%.

## 4. Gates keputusan rilis (G1–G11)

| Gate | Status | Catatan |
|---|---|---|
| G1 client resmi tak diubah | **PASS** | Tidak ada helper client; hosts override tidak dipakai pada audit ini (probe protokol murni) |
| G2 identitas/latency VPS valid | **PASS** | DNS A direct (DoH terverifikasi), banner server, latensi native via daemon; endpoint tidak disamarkan |
| G3 native DL edge assist | **FAIL (BLOCKED_BY_PROTOCOL)** | Tidak ada kontribusi byte edge pada fase DL sesi native — 0 teramati & mekanisme tidak ada |
| G4 native UL edge assist | **FAIL (BLOCKED_BY_PROTOCOL)** | Idem fase UL |
| G5 satu sesi dua kontribusi | **FAIL** | Tidak pernah terjadi pada client resmi (bukan "belum", melainkan tidak mungkin dalam constraint) |
| G6 edge non-transit VPS + tanpa throttle | **PASS untuk lane custom** (edge via workers.dev langsung, terbukti 1:1.200; lane VPS uncapped sejak v1.4) | Tidak berlaku utk native (edge tak dipakai) |
| G7 utilisasi terbukti | **N/A** (mengikuti G3/G4) | Baseline VPS-only terbukti 470,9/448,8 Mbps jalur NetGauge |
| G8 Free penuh + quota/health/fallback | **PASS** | Plan Free terverifikasi API; quota guard live; fallback vps-only teruji desain+historis |
| G9 regression/security/deploy/rollback | **PASS** | Tidak ada perubahan source (PR docs-only); suites historis hijau; rollback trivial |
| G10 ketentuan platform & hosting | **BLOCKED_BY_REGISTRATION** | Perlu persetujuan program hosting Ookla sebelum deployment publik |
| G11 validasi pasca-registrasi | **BLOCKED_BY_REGISTRATION** | Menunguti G10 + N10 |

## 5. Keputusan rilis

> **Status project (pemisahan ketat lima kategori §12):**
> 1. **Layak deployment lab: YA** (stack sehat, dua-lane teruji, dokumentasi lengkap).
> 2. **Layak native VPS-only: YA** — jalur aktif produksi, terverifikasi live (NATIVE_VPS_ONLY).
> 3. **Native hybrid parsial (DL saja): TIDAK** (label NATIVE_DL_ASSIST_ONLY tidak dapat dicapai — mekanisme sama-sama tidak ada untuk DL maupun UL).
> 4. **Native hybrid penuh: TIDAK — BLOCKED_BY_PROTOCOL + BLOCKED_BY_FREE_PLAN.**
> 5. **Siap publik: TIDAK — BLOCKED_BY_REGISTRATION** (G10-G11 belum mungkin sebelum persetujuan Ookla).
>
> Klaim yang tidak boleh dibuat: `NATIVE_HYBRID_VERIFIED_IN_LAB`, `PRODUCTION_READY_FOR_PUBLIC_OOKLA`, "Worker membantu client resmi", "pool 100 = 100× bandwidth", "mode=hybrid gateway = edge aktif pada sesi native".
> Klaim yang sah: dua-lane NATIVE_VPS_ONLY + CUSTOM_CLIENT_ONLY dengan offload nyata terukur pada lane custom.

## 6. Input yang dibutuhkan operator (untuk melanjutkan tahap yang terblokir input)

| Input | Untuk |
|---|---|
| Daftar server ID (± hostname/port, kepemilikan/otorisasi) yang diizinkan untuk uji pra-publikasi | Menjalankan matrix N-series pada client resmi di lab terisolasi (host override) — B0 formal 3–5 run per mode |
| Otorisasi perubahan produksi (jika ingin uji N4 formal: edge dimatikan sementara) | N4 formal |
| Keputusan pendaftaran ke program hosting Ookla | G10 → G11 → N10 |
| (Opsional) rotasi key uaeg yang pernah ditampilkan di chat | hygiene |
