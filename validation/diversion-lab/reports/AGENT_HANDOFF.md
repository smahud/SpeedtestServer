# AGENT_HANDOFF — instruksi lanjutan untuk agent berikutnya (tanpa konteks percakapan)

> Dokumen ini ditulis agar agent mana pun dapat melanjutkan pekerjaan
> diversion-lab TANPA membaca histori percakapan. Terakhir diperbarui:
> **2026-11-04 ~21:40 UTC oleh sesi-2** (F2a×3 + F5-n22×3 + F8a + F8b +
> F5-n28 TERVERIFIKASI; lab dibangun ulang dari nol setelah recycle sandbox).

## 1. Konteks project (2 paragraf)

Repositori `smahud/SpeedtestServer` adalah implementasi open-source yang
kompatibel dengan OoklaServer (profil NetGauge + HTTP legacy + UDP loss + TLS),
sudah tervalidasi end-to-end terhadap CLI resmi (lihat `validation/README` + `validation/FINAL_REPORT.md`).
Pertanyaan riset di direktori ini (`validation/diversion-lab/`): **dapatkah CLI
resmi yang tidak dimodifikasi melakukan koneksi/handshake awalnya ke backend
OoklaServer resmi sementara operasi latency/download/upload/packet-loss
berikutnya ditangani backend lain, dan di batas koneksi/protokol mana persisnya
diversion terjadi tanpa merusak pengukuran?**

**JAWABAN INTI SUDAH TERVERIFIKASI (sesi-2):** YA — 3/3 (F5-n22): seleksi+
handshake terenkripsi di daemon resmi (koneksi 1–22), SELURUH pengukuran
(koneksi 23–34) + UDP di SpeedtestServer TS; exit 0, loss 0, byte konsisten.
Batas paling tajam = **antara winner-probe (conn 22) dan koneksi pengukuran
pertama (conn 23)**. CLI membawa pembelajaran enkripsi dari probe (hello biner
di koneksi pengukuran) TAPI pulih per koneksi setelah ERROR (`«BIN»`→`HI
<UUID>`→perintah) dan berhenti mencoba enkripsi setelahnya. Laporan utama:
`reports/EXECUTIVE_CONCLUSION.md` + `reports/BACKEND_DIVERSION_RESULTS.md`.

## 2. Yang SUDAH selesai (jangan kerjakan ulang)

1. **Sesi-1** (2026-11-04 awal): audit repo, verifikasi binari, instrumen
   diverter + validasi sintetis S1–S4, kontrol C1 (all→B) + F0 (all→A),
   peta protokol, karakterisasi kuota. Laporan 9 + handoff lama (riwayat
   commit `fd40c37`).
2. **Sesi-2** (2026-11-04 20:42→): lab dibangun ulang dari nol (sandbox
   recycle — `lab/` di luar repo hilang; prosedur: `scripts/rebuild-lab.sh`
   di luar repo pada mesin sesi, atau ikuti REPRODUCE.md + README lab);
   binari diverifikasi ulang vs manifest; **F2a PASS 3/3** (`evidence/f2a{,-r2,-r3}`),
   **F5-n22 PASS 3/3** (`evidence/f5-n22{,-r2,-r3}` — arsitektur B), **F8a**
   (split loss TCP→A/UDP→B: exit 0, loss 0 SENYAP — akuntansi ter-DECouple),
   **F8b** (TCP→B/UDP→A: exit 0, **field packetLoss ABSENT** — daemon tanpa
   INITPLOSS tidak membalas RECV), **F5-n28** (dl→A enc, ul→B fallback, loss+UDP→A:
   exit 0 loss 0 — batas dl↔ul bersih).
3. **Stage-1 rekonsiliasi + koreksi label** — `analysis/EVIDENCE_RECONCILIATION.md`
   (mislabeled "dibuktikan F2a/F4" & "[V]" lama dikoreksi).
4. **Timeline generator** — `harness/gen-timeline.mjs` → `timeline.md` +
   `timeline.csv` per run (kolom wajib master prompt §11, basis fase eksplisit,
   tidak pernah menginfer perintah dari payload terenkripsi).
5. **Perbaikan instrumen**: `analyze-run.mjs` (bug label rewritten-ids);
   `run-diversion.sh` header (default live proxy).

## 3. Yang BELUM selesai (urutan prioritas, semua butuh 1 fetch config)

| # | Eksperimen | Perintah (dari `harness/`) | Pertanyaan |
|---|---|---|---|
| 1 | **F2b** (6× percobaan 429 sepanjang 21:33–21:59 UTC — kuota sesi-2 habis; evidence percobaan di `evidence/f2b-attempt*-blocked/`) | `EXP_ID=f2b POLICY="phase:pre=B,enc=B,sel=B,ping=A,loss=A,dn=A,up=A,upctl=A" UDP=A ./run-diversion.sh` | arah balik: seleksi plaintext di STS, pengukuran di daemon — apakah daemon menerima koneksi pengukuran tanpa pernah melihat probe? (prediksi: ya — UUID stateless) |
| 2 | F7b | `EXP_ID=f7b POLICY="cmd:hi=A,getip=A,caps=A,ping=A,dn=B,up=B,upctl=B,loss=B,ploss=B" UDP=A ./run-diversion.sh` | split per-perintah pada CLI — diperkirakan hanya koneksi loss (plaintext) yang terlibat cmd-routing; koneksi enc → def=A |
| 3 | G3 | `EXP_ID=g3-udp-drop POLICY="all:B" UDP=drop ./run-diversion.sh` | UDP blackhole — apa yang dilaporkan CLI tanpa backend UDP sama sekali? |
| 4 | F5-n20 | `EXP_ID=f5-n20 POLICY="firstN:A:20" UDP=A ./run-diversion.sh` | winner-probe→B (mixed learning: 10 probe enc sukses di A + winner fallback plaintext di B) |
| 5 | F5-n12, n16 | `firstN:A:12` / `firstN:A:16` | titik tengah sweep (belahan di tengah probe) |
| 6 | Reproduksi F8a/F8b/F5-n28 (≥3× untuk klaim inti; F2a & F5-n22 sudah 3/3) | | |
| 7 | G1/G2 (SKIP_B/KILL_*_AT_MS), F8d, F7c (batas etis: hanya yang pasif) | | |

## 4. KENDALA UTAMA: kuota config API (karakter terukur sesi-2)

- CLI **wajib** config live dari `cli.speedtest.net` (licenseKey anti-tamper,
  umur ~±15 s; snapshot → InvalidLicenseKey — SUDAH DIBUKTIKAN, jangan coba
  lagi). Proxy live (`live-config-proxy.mjs`) memakai query CLI sendiri —
  deviceId beda antar sandbox tidak masalah.
- Egress sesi-2 (8.212.10.159): **token-bucket bursty** — 3 sukses beruntun
  bisa terjadi dalam 2 menit, lalu 429 ~10–15 menit. Strategi: 1 attempt per
  ~7–10 menit; jangan hammer. Total sesi-2: 9 sukses + 8 blocked.
- curl lolos, Node https kena 429 (TLS fingerprint CDN) — proxy sudah pakai curl.
- `lab/` DI LUAR REPO hilang saat sandbox recycle → jalankan rebuild dulu
  (lihat §2 butir 2 / REPRODUCE.md). **Daemon resmi punya child `--ward`
  watchdog**: selalu hard-clean port 18080/8080/9090/8888 + `pkill -f
  OoklaServer` sebelum tiap run (loop sampai port bebas — lihat pola
  `scripts/run-exp.sh` sesi ini, di luar repo).

## 5. Cara kerja lab (ringkas)

1. `run-diversion.sh` = 1 eksperimen penuh (backend fresh + diverter +
   config-proxy + CLI + analisis). Semua user-space, loopback-only, non-publishing.
2. Atribusi: `analyze-run.mjs` menggabungkan diverter.jsonl + sts-evidence.jsonl
   + daemon-access.log + proxy.jsonl + cli.json → analysis.json/.txt.
3. Timeline: `node gen-timeline.mjs ../evidence/<EXP_ID>` → timeline.md/csv.
4. Build ulang STS: `cd reverse-engineered/typescript && npm ci && npm run build`.
5. PKI: `validation/harness/gen-pki.sh` + symlink `harness/certs`.
6. Commit: sanitasi deviceId/hid/sid pada proxy.jsonl yang di-commit; binari
   vendor & kunci JANGAN di-commit; `*.log` ter-gitignore (daemon-access.log
   disalin ke evidence sebagai pengecualian? — TIDAK, gitignored; simpan
   salinan `.txt` bila ingin commit).

## 6. Deliverable & definisi selesai

- 9 laporan `reports/` — SEMUA sudah disinkronkan sesi-2 (EXECUTIVE_CONCLUSION,
  BACKEND_DIVERSION_RESULTS, EVIDENCE_INDEX, MEASUREMENT_PHASE_MATRIX,
  CLI_CONNECTION_TIMELINE, README lab, matriks).
- Skenario sukses inti ≥3×: F2a ✅ 3/3, F5-n22 ✅ 3/3. F8a/F8b/F5-n28 1×
  (temuan diskriminatif — reproduksi bila kuota).
- Commit + push (PAT milik owner). Setelah selesai: pertimbangkan housekeeping
  binari vendor 4-platform di root repo (STAGE1_REPO_AUDIT §1).
