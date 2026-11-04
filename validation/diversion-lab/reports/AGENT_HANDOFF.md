# AGENT_HANDOFF — instruksi lanjutan untuk agent berikutnya (tanpa konteks percakapan)

> Dokumen ini ditulis agar agent mana pun dapat melanjutkan pekerjaan
> diversion-lab TANPA membaca histori percakapan. Terakhir diperbarui:
> 2026-11-04 ~19:35 UTC oleh sesi diversion-lab (audit + instrumen + F0/C1).

## 1. Konteks project (2 paragraf)

Repositori `smahud/SpeedtestServer` adalah implementasi open-source yang
kompatibel dengan OoklaServer (profil NetGauge + HTTP legacy + UDP loss + TLS),
sudah tervalidasi end-to-end terhadap CLI resmi (lihat `validation/README` + `validation/FINAL_REPORT.md`).
Pertanyaan riset yang sedang dikerjakan di direktori ini (`validation/diversion-lab/`):
**dapatkah CLI resmi yang tidak dimodifikasi melakukan koneksi/handshake awalnya
ke backend OoklaServer resmi sementara operasi latency/download/upload/packet-loss
berikutnya ditangani backend lain, dan di batas koneksi/protokol mana persisnya
diversion terjadi tanpa merusak pengukuran?**

Dua backend tersedia di lab: **A** = daemon OoklaServer resmi 2.11.5.2
(127.0.0.1:18080) dan **B** = SpeedtestServer TS (127.0.0.1:8080). CLI resmi
diarahkan ke **diverter** (127.0.0.1:9090) via config-proxy yang menimpa
`servers[].host` pada config asli (satu-satunya cara — CLI hanya menguji server
dari daftar config engine-nya, dan config dilindungi licenseKey anti-tamper).

## 2. Yang SUDAH selesai (jangan kerjakan ulang)

1. **Stage 1 audit** kedua repo → `analysis/STAGE1_REPO_AUDIT.md`
   (commit `7b58988b` SpeedtestServer, `bd490eb` SpeedtestHost-Tester).
2. **Verifikasi binari**: CLI `5690596c…cfeeb7` ✓, daemon `ce180aa3…598159` ✓
   (cocok `validation/REFERENCE_BINARY_MANIFEST.md`). Binari hidup di
   `/home/z/my-project/lab/` (LUAR repo — jangan pernah commit).
3. **Instrumen diverter** (`harness/diverter.mjs`) — 5 policy (all/firstN/
   phase/cmd/blackhole) + forward UDP + log audit JSONL; **tervalidasi 4 mode**
   dengan klien sintetis (`evidence/synth-validation/`).
4. **Orkestrator** (`harness/run-diversion.sh`) — 1 invocation = 1 eksperimen
   lengkap (backend fresh + diverter + config-proxy + CLI + analisis atribusi).
5. **Kontrol terverifikasi dengan CLI resmi**:
   - `evidence/c1-all-b/` — semua→B: **exit 0, loss 0, 12,09/8,16 GB** ✓
   - `evidence/f0-all-a/` — semua→A via diverter (NAT): **exit 0, loss 0,
     17,18/16,99 GB** ✓ → F8c terjawab: NAT diverter TIDAK mendistorsi loss
     (kontras dengan recording-relay F-7 repo; di loopback IP TCP==IP UDP).
   - F0 juga membuktikan: daemon resmi MENERIMA hello terenkripsi CLI dan
     seluruh run berjalan terenkripsi (C1 = fallback plaintext).
6. **Peta protokol per fase** dari run nyata → `reports/NETGAUGE_SESSION_MAP.md`
   (11 probe + 11 zero-byte + winner + loss + 2 pingmon + 4 dn + upctl + 4 up).
7. **Karakterisasi config API** (lihat §4 kendala).

## 3. Yang BELUM selesai (urutan prioritas)

| # | Eksperimen | Perintah (dari `harness/`) | Pertanyaan |
|---|---|---|---|
| 1 | **F2a** (INTI) | `EXP_ID=f2a POLICY="phase:pre=A,enc=A,sel=A,ping=B,loss=B,dn=B,up=B,upctl=B" UDP=B ./run-diversion.sh` | handshake→daemon resmi, pengukuran→STS: apakah test lengkap? Apa loss yang dilaporkan? |
| 2 | F2b | `EXP_ID=f2b POLICY="phase:pre=B,enc=B,sel=B,ping=A,loss=A,dn=A,up=A,upctl=A" UDP=A ./run-diversion.sh` | arah balik |
| 3 | F8a | `EXP_ID=f8a POLICY="all:A" UDP=B ./run-diversion.sh` | TCP→A, UDP→B: loss dari mana? |
| 4 | F7b | `EXP_ID=f7b POLICY="cmd:hi=A,getip=A,caps=A,ping=A,dn=B,up=B,upctl=B,loss=B,ploss=B" UDP=A ./run-diversion.sh` | split per-perintah |
| 5 | F3 | `EXP_ID=f3 POLICY="phase:pre=A,enc=A,sel=A,ping=A,loss=A,dn=B,up=B,upctl=B" UDP=A ./run-diversion.sh` | latency→A, beban→B |
| 6 | F5 sweep | `EXP_ID=f5-n1 POLICY="firstN:A:1" UDP=A …` (ulangi n=2,3,5,8,12,16,20) | peta batas indeks koneksi |
| 7 | F8b | `EXP_ID=f8b POLICY="all:B" UDP=A ./run-diversion.sh` | TCP→B, UDP→A |
| 8 | G3 | `EXP_ID=g3-udp-drop POLICY="all:B" UDP=drop ./run-diversion.sh` | UDP blackhole |
| 9 | G1/G2 | `SKIP_B=1 …` / `KILL_A_AT_MS=15000 …` | injeksi kegagalan |
| 10 | Repetisi ≥3× untuk skenario sukses kunci (F2a, F8a) — master prompt §12 | | |

Setelah matriks: lengkapi `reports/BACKEND_DIVERSION_RESULTS.md` (tabel F0–F8),
`reports/EXECUTIVE_CONCLUSION.md` (15 pertanyaan), perbarui
`reports/EVIDENCE_INDEX.md`, `analysis/EXPERIMENT_MATRIX.md` (status), dan
`README.md` (tabel status).

## 4. KENDALA UTAMA yang harus kamu ketahui: kuota config API

- CLI resmi **wajib** menerima config engine dari `cli.speedtest.net`
  (licenseKey anti-tamper per-perangkat; kunci usia >±15 s atau kunci entitas
  lain → `InvalidLicenseKey` → exit 2). **Fetch HARUS live saat CLI meminta**
  (via `harness/live-config-proxy.mjs` — default `run-diversion.sh`).
- Karakter rate-limit yang terukur (2026-11-04, satu egress IP): **~3 fetch
  sukses per jendela geser 1 jam**; 429 TIDAK memperpanjang blokir (aman
  retry); **curl lolos, Node https kena 429** (TLS fingerprint CDN) — makanya
  proxy memanggil curl.
- Konsekuensi: ~3 eksperimen per jam. **Tunggu ≥240 s antar percobaan gagal**;
  jangan menghantam API dengan interval pendek (boros waktu saja, tidak
  memperparah blokir).
- deviceId+sid CLI stabil antar run (terverifikasi) — tidak perlu memakai
  ulang query berbeda; proxy selalu memakai query CLI yang sedang berjalan.

## 5. Cara kerja lab (ringkas tapi lengkap)

1. Semua komponen user-space, tanpa root, loopback-only:
   `run-diversion.sh` memulai: daemon A (:18080, `~/lab/lab/daemon/`),
   STS B (:8080, build `reverse-engineered/typescript`), diverter (:9090),
   live-config-proxy (:8888), lalu CLI (`~/lab/clients/speedtest/speedtest`)
   dengan `--ca-certificate=certs/cli-ca-bundle.pem --accept-license
   --accept-gdpr --selection-details -f json-pretty` + `ALL_PROXY`.
2. **Sandbox mendaur ulang proses antar sesi shell** → satu eksperimen = satu
   invocation penuh (semua lifecycle di dalam satu bash call).
3. Non-publishing: proxy MENOLAK `results.speedtest.net` → `persisted:false`
   (diverifikasi otomatis di analysis.json setiap run).
4. Atribusi: `analyze-run.mjs` menggabungkan diverter.jsonl (routing+byte),
   sts-evidence.jsonl (sisi B), daemon-access.log (sisi A), proxy.jsonl
   (config+blokir), cli.json (hasil) → `analysis.json/.txt`.
5. Build ulang server bila perlu: `cd reverse-engineered/typescript &&
   npm ci && npm run build` (Node 24 OK).
6. PKI: `validation/harness/gen-pki.sh` (certs lab-CA sudah ada; symlink
   `harness/certs`).

## 6. Jebakan yang sudah ditemukan (jangan ulangi)

- `nc` tidak ada (pakai probe node); `column` tidak ada.
- Daemon resmi perlu **probe kesiapan fungsional** (HI→HELLO) — listen ≠ siap
  (run-diversion.sh sudah menanganinya).
- Diverter: socket **udp6 tidak bisa mengirim ke literal IPv4** → socket
  upstream dibuat sesuai family alamat backend (sudah diperbaiki).
- Payload UPLOAD CLI = byte acak (ter-log «BIN») — klasifikasi fase harus
  mendahulukan perintah teks daripada deteksi biner (sudah diperbaiki di
  analyze-run.mjs).
- Koneksi zero-byte CLI (±11 per run) IKUT dihitung indeks firstN.
- `journalctl`/systemd tidak tersedia di container — log daemon via
  `daemon-access.log` (FileChannel Poco).

## 7. Deliverable & definisi selesai

- 9 laporan di `reports/` (CLI_CONNECTION_TIMELINE ✓, FIRST_CONNECTION_ANALYSIS ✓,
  NETGAUGE_SESSION_MAP ✓, DNS_AND_IP_BEHAVIOR ✓, MEASUREMENT_PHASE_MATRIX ✓,
  CLOUDFLARE_WORKERS_FEASIBILITY ✓, EVIDENCE_INDEX ✓ sebagian,
  BACKEND_DIVERSION_RESULTS ⏳, EXECUTIVE_CONCLUSION ⏳) + README + matriks.
- Setiap skenario sukses ≥3 pengulangan (master prompt); skenario gagal
  didokumentasikan dengan bukti.
- Commit + push (PAT milik owner; **jangan commit**: binari vendor, kunci
  lab-CA privat boleh (lab-only) tetapi JANGAN identitas perangkat asli —
  sanitasi licenseKey/deviceId pada artifact yang di-commit).
- Setelah selesai: pertimbangkan menghapus binari vendor 4-platform yang
  tidak disengaja ter-commit di root repo (lihat STAGE1_REPO_AUDIT §1).
