# EVIDENCE_INDEX — indeks evidence → klaim

> Setiap klaim di laporan diversion-lab merujuk ke baris bukti di bawah.
> Konvensi: `[V]` = diverifikasi langsung sesi ini; `[P]` = bukti repo
# (2026-11-04, verifikasi silang); `[S]` = validasi instrumen sintetis.

## Kontrol & baseline (CLI resmi, exit 0)

| Evidence | Konfigurasi | Hasil kunci | Label |
|---|---|---|---|
| `evidence/c1-all-b/` | CLI→diverter(all:B)→STS; UDP→B; config live rewrite | exit 0; latency 0,095 ms; DL 12,09 GB; UL 8,16 GB; **loss 0**; persisted false; 34 koneksi; byte diverter↔CLI cocok; STS: 373 download, 258 upload, 432 udp_recv | [V] |
| `evidence/f0-all-a/` | CLI→diverter(all:A)→daemon resmi; UDP→A | exit 0; DL 17,18 GB; UL 16,99 GB; **loss 0** (NAT middlebox TIDAK mendistorsi loss di loopback — kontras F-7 repo); probe terenkripsi DITERIMA daemon; sesi pengukuran terenkripsi | [V] |
| `../../evidence/OFFICIAL_CLI_TO_OFFICIAL_SERVER.json` | repo: CLI→daemon direct | PASS 3/3 | [P] |
| `../../evidence/gate-cli2*.json` | repo: CLI→STS direct | PASS 3/3, loss 0 | [P] |

## Matriks diversion (F) — sesi-2 (2026-11-04/05, lab dibangun ulang)

| Evidence | Policy | Hasil | Label |
|---|---|---|---|
| `evidence/f2a/` | phase: seleksi/enc→A(daemon), loss→B(STS); UDP→B | **exit 0; DL 15,86/UL 13,26 GB; loss 0; persisted false; 22 conn enc→A + loss-conn→B (prefix replay lintas backend) + UDP→B** | [V] |
| `evidence/f2a-r2/` | idem | exit 0; DL 12,71/UL 16,80; loss 0; atribusi identik | [V] |
| `evidence/f2a-r3/` | idem | exit 0; DL 14,34/UL 12,06; loss 0; atribusi identik | [V] |
| `evidence/f5-n22/` | firstN:A:22; UDP→B | **exit 0; DL 14,12/UL 9,38; loss 0; seleksi→A terenkripsi, SELURUH pengukuran→B (conn 24: «BIN»→HI→DOWNLOAD = fallback per koneksi); STS 1205 cmd/436 dn/296 up** | [V] |
| `evidence/f5-n22-r2/` | idem | exit 0; DL 10,24/UL 7,16; **loss 9,09%** (teranalisis: 1 datagram drop kernel klien→gateway — diverter/STS 0 loss; lihat BACKEND_DIVERSION_RESULTS §2) | [V] |
| `evidence/f5-n22-r3/` | idem | exit 0; DL 17,19/UL 8,61; loss 0 | [V] |
| `evidence/f2a-attempt*-blocked/`, `f5-n22-attempt*-blocked/`, `f8a-attempt*-blocked/` | — | percobaan gagal kuota 429 (bukan kegagalan protokol) | [V] (kendala) |
| `evidence/f2b/`, `f3/`, `f5-n1/` … `f5-n20/`, `f7b/`, `f8a/` (berhasil), `f8b/`, `g3-udp-drop/` | — | **BELUM ADA run berhasil** (antre kuota; dir hanya berisi percobaan 429 bila ada) — JANGAN dirujuk sebagai bukti | NOT TESTED |

> Koreksi sesi-2 (lihat `analysis/EVIDENCE_RECONCILIATION.md` §1f): tabel lama
> melabel semua baris F2a…G3 `[V]` padahal dir evidence tidak ada / hanya 429.
> Label di atas adalah yang benar per status terkini.

## Validasi instrumen (klien sintetis — bukan CLI resmi)

| Evidence | Mode | Hasil | Label |
|---|---|---|---|
| `evidence/synth-validation/s1-diverter.jsonl` | all:B | 21 koneksi lengkap; PLOSS 3 0 2; RECV via diverter | [S] |
| `evidence/synth-validation/s2-diverter.jsonl` | phase (replay+swallow) | routing per fase benar; PLOSS 0 0 0 (loss-conn→A, UDP→B — keterikatan akuntansi) | [S] |
| `evidence/synth-validation/s3-diverter.jsonl` | cmd-level | 16/16 UPLOAD OK lintas backend | [S] |
| `evidence/synth-validation/s4-diverter.jsonl` | firstN:A:12 | koneksi 1–12→A, 13–23→B eksak | [S] |

## Config API & licenseKey

| Evidence | Klaim | Label |
|---|---|---|
| `evidence/c1-all-b/proxy.jsonl` (config_served live) | fetch live dengan query CLI (via curl) → kunci diterima CLI | [V] |
| snapshot 18:52 UTC (dibuat `config-snapshot.json`, kunci di-sanitasi) | kunci usia 15–20 s → `InvalidLicenseKey` (run `evidence/c1-all-b/` percobaan pertama, stderr tersimpan) | [V] |
| `harness/fetch-config.sh`, `warm-config-cache.sh` | pola rate-limit: ~3 sukses/jam geser per IP; 429 tidak memperpanjang blokir; curl lolos, Node https kena 429 (TLS fingerprint CDN) | [V] |
| `../../validation/evidence/*proxy*.jsonl` | repo: 1 config_req per run pada semua gate | [P] |

## Struktur per run eksperimen

Setiap dir `evidence/<EXP-ID>/` berisi: `process-inventory.txt` (preflight),
`proxy.jsonl` (config + blokir submission), `diverter.jsonl` (semua koneksi +
routing + perintah + byte + UDP), `cli.json` + `cli.stderr` (hasil + exit),
`sts-evidence.jsonl` (sisi backend B), `daemon-access.log` (sisi backend A),
`analysis.json`/`analysis.txt` (atribusi), `*-console.log`.
