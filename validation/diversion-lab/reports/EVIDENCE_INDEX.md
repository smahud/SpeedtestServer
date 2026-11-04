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

## Matriks diversion (F)

| Evidence | Policy | Hasil | Label |
|---|---|---|---|
| `evidence/f2a/` | phase: seleksi/handshake→A(daemon), loss/ping/dn/up/upctl→B(STS); UDP→B | (lihat BACKEND_DIVERSION_RESULTS) | [V] |
| `evidence/f2b/` | kebalikan F2a | " | [V] |
| `evidence/f3/` | latency→A, dn/up→B | " | [V] |
| `evidence/f5-n*/` | firstN:A:n (n=1,12) | " | [V] |
| `evidence/f7b/` | cmd-level split | " | [V] |
| `evidence/f8a/` | TCP→A, UDP→B | " | [V] |
| `evidence/f8b/` | TCP→B, UDP→A | " | [V] |
| `evidence/g3-udp-drop/` | UDP blackhole | " | [V] |

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
