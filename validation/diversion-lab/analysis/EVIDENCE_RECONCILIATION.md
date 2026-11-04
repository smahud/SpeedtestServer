# EVIDENCE_RECONCILIATION — Stage 1: rekonsiliasi evidence & koreksi label (2026-11-04/05, sesi lanjutan)

> Master prompt Stage 1: audit laporan sebelumnya, bedakan (a) observasi
> packet-level terverifikasi, (b) observasi application-level terverifikasi,
> (c) tes gateway sintetis, (d) inferensi dari perilaku protokol, (e) skenario
> cross-backend yang belum diuji, (f) klaim yang dikontradiksi evidence baru.
> Baseline audit: repo HEAD `449cb88c` (sesi diversion-lab 2026-11-04); update
> empiris: sesi ini (lab dibangun ulang, binari diverifikasi ulang vs manifest,
> CLI deviceId lab berbeda dari sesi lama: `df4fa611…` vs `e08a4aff…` — proxy
> live menangani secara transparan, desain konfigurasi-live terbukti benar).

## 1. Klasifikasi evidence yang ada sebelum sesi ini

### 1a. Observasi packet/byte-level TERVERIFIKASI (log instrumen, run CLI resmi)

| Klaim | Evidence | Status |
|---|---|---|
| Pola 34 koneksi CLI per run (11 zero-byte + 10 probe + 1 winner + 1 loss + 2 pingmon + 4 dn + 1 upctl + 4 up) | `c1-all-b/diverter.jsonl`, `f0-all-a/diverter.jsonl` | VERIFIED (direproduksi sesi ini: f2a/f5-n22 sama) |
| Probe seleksi dibuka hello biner terenkripsi; STS menjawab ERROR → fallback plaintext per koneksi probe | `c1-all-b/diverter.jsonl` conn 2–22 | VERIFIED |
| Daemon resmi MENERIMA hello terenkripsi → seluruh koneksi pengukuran run itu terenkripsi | `f0-all-a/analysis.json` (enc=true pada semua conn kecuali conn 23) | VERIFIED |
| Koneksi loss SELALU plaintext (`HI <UUID>`+`INITPLOSS`+`PLOSS`) bahkan pada run terenkripsi penuh | `f0-all-a/analysis.json` conn 23 | VERIFIED |
| UUID sesi tunggal diumumkan `HI <UUID>` pada winner-probe dan dipakai semua koneksi pasca-seleksi + datagram UDP | `c1-all-b/diverter.jsonl` + `cli.json:result.id` (cocok) | VERIFIED |
| UDP: 3 endpoint klien, endpoint tengah (UUID=result-id) tidak dibalas RECV | `c1-all-b/diverter.jsonl` summary | VERIFIED |
| Akuntansi byte diverter ↔ laporan CLI konsisten (Δ framing <2%) | `c1-all-b/analysis.json` | VERIFIED |
| Tepat 1 fetch config per run; tidak ada re-fetch/re-resolve di tengah run | semua proxy.jsonl | VERIFIED |
| licenseKey config anti-tamper per-perangkat, umur ~±15 s | percobaan 18:52 vs 18:56 UTC 2026-11-04 | VERIFIED |
| Rate-limit config API 429 IP-level; curl lolos, Node https kena 429 | log sesi lama + `harness/fetch-config.sh` | VERIFIED |
| NAT diverter tidak mendistorsi packet-loss di loopback | `f0-all-a` (F8c) | VERIFIED |

### 1b. Observasi application-level TERVERIFIKASI

- C1: exit 0, loss 0, DL 12,09 GB / UL 8,16 GB, persisted=false (semua→B).
- F0: exit 0, loss 0, DL 17,18 / UL 16,99 GB (semua→A via diverter).
- Repo gate: CLI→daemon 3/3, CLI→STS 3/3 (direct, tanpa diverter).
- Result-URL battery (opt-in publishing) — di luar lab diversion ini.

### 1c. Tes gateway sintetis (instrumen, BUKAN perilaku CLI)

- S1 (all:B), S2 (phase + replay/swallow), S3 (cmd-level 16/16 UPLOAD OK),
  S4 (firstN eksak) — membuktikan MEKANISME diverter, bukan bahwa CLI resmi
  menerima routing tersebut. Label [S] sudah dipakai benar di EVIDENCE_INDEX §synth.

### 1d. Inferensi dari perilaku protokol (PREDIKSI — tidak boleh dilabel verified)

- "F2a diprediksi lulus" (BACKEND_DIVERSION_RESULTS §2) — benar dilabel prediksi.
- "Titik belah firstN menarik N∈[13,22]" — analisis, benar sebagai hipotesis.
- "PLOSS↔UDP harus satu backend" — terindikasi sintetis (S2/S3) + kontrak
  protokol; pada CLI resmi = eksperimen F8a/F8b (saat itu belum dijalankan).

### 1e. Skenario cross-backend yang belum diuji (pada sesi lama)

F2a, F2b, F3, F4, F5(n), F5r, F7b, F7c, F8a, F8b, F8d, G1–G5 — semuanya BLOCKED
kuota. EXPERIMENT_MATRIX.md melabelinya dengan benar (⛔ BLOCKED / NOT TESTED).

### 1f. Klaim yang dilabel MELEBIHI evidence (DITEMUKAN & DIKOREKSI sesi ini)

| Lokasi | Klaim salah | Koreksi |
|---|---|---|
| `MEASUREMENT_PHASE_MATRIX.md` §1 baris seleksi: "✅ ya (terbukti F2a)" | F2a belum pernah dijalankan saat ditulis | F2a kini BENAR-BENAR dijalankan 3× (f2a, f2a-r2, f2a-r3) — label diperbarui berdasar run nyata, bukan prediksi |
| `MEASUREMENT_PHASE_MATRIX.md` §2.3: "dibuktikan F2a/F4" (upload↔download backend beda) | F2a/F4 belum dijalankan; dan bentuk phase-nya tidak dapat mengaktifkan pemetaan dn/up (lihat §2.2 laporan ini) | Diuji via firstN:A:28 (F4-equivalent) — lihat BACKEND_DIVERSION_RESULTS |
| `MEASUREMENT_PHASE_MATRIX.md` §2.4: "dibuktikan F2a: ping→B saat download→B" | F2a belum dijalankan; pada F2a aktual pingmon terenkripsi → A (pemetaan ping=B inert) | Diperbarui dari run nyata |
| `EVIDENCE_INDEX.md` §Matriks diversion: baris F2a…G3 semua `[V]` | Dir evidence f2b/f3/f5-n*/f7b/f8a/f8b/g3 TIDAK ADA; f2a berisi hanya percobaan 429 | Label diperbarui ke evidence nyata sesi ini; baris tanpa run dilabel NOT TESTED |
| `FIRST_CONNECTION_ANALYSIS.md` §4: "gate repo membuktikan CLI pulih per koneksi" | Gate (all→STS) membuktikan fallback per koneksi hanya bila SEMUA koneksi mendapat ERROR sejak probe; kasus silang (probe terenkripsi SUKSES → backend pengukuran plaintext) belum teruji saat itu | Kini TERVERIFIKASI langsung: f5-n22 conn 24 = `«BIN 65B»` → `HI <UUID>` → `DOWNLOAD…` (fallback per koneksi SETELAH probe terenkripsi sukses di A) |
| `STAGE1_REPO_AUDIT.md` §5: "snapshot offline sebagai default… snapshot tetap autentik untuk seluruh matriks" | Dikontradiksi temuan berikutnya sesi lama sendiri (umur kunci ±15 s → InvalidLicenseKey) — sudah digantikan AGENT_HANDOFF §4, audit dibiarkan sebagai dokumen historis | Tidak diubah (historis); catatan reconciliasi ini yang menggantikan |
| `run-diversion.sh` header: "config proxy: offline snapshot" | Default aktual = live (`CONFIG_PROXY=live`) | Komentar header diperbarui |

## 2. Temuan recon eksperimental baru sesi ini (mengubah status 1e)

1. **F2a PASS 3/3** (`evidence/f2a`, `f2a-r2`, `f2a-r3`): CLI resmi menyelesaikan
   run penuh (exit 0, loss 0, DL 15,86/12,71/…, UL 13,26/16,80/…) dengan
   seleksi+enkripsi+bandwidth di daemon resmi (22 koneksi terenkripsi → A via
   enc-hello) DAN kanal loss (TCP `INITPLOSS`/`PLOSS` via replay prefix lintas
   backend DALAM SATU KONEKSI: prefix `HI <UUID>` dijawab A, fase loss dijawab B)
   + seluruh UDP di STS (B). packetLoss=0 — akuntansi loss konsisten di B.
2. **F5-n22 PASS 2/3 (reproduksi ke-3 berjalan)** (`evidence/f5-n22`, `f5-n22-r2`):
   arsitektur B murni level-indeks: probe+winner (1–22) → A terenkripsi;
   SELURUH pengukuran (loss, pingmon, 4 dn, upctl, 4 up) + UDP → B.
   **Bukti fallback per koneksi**: conn 24 = `«BIN 65B»` (hello terenkripsi,
   dibawa dari pembelajaran probe→A) → STS ERROR → `HI <UUID>` plaintext →
   `DOWNLOAD 32000000`×N. Worker upload berikutnya langsung plaintext
   (pembelajaran diperbarui CLI di tengah run). STS: 1205 perintah, 436
   download, 296 upload, 436 udp_recv — B melayani seluruh beban.
3. **Semantik phase-mode dengan enc=A (dibuktikan F2a)**: pemetaan dn/up/upctl/ping
   INERT untuk koneksi yang dibuka hello terenkripsi (routing enc mengikat koneksi
   seumur hidupnya; payload terenkripsi tidak bisa dipicu per-fase). Trigger fase
   hanya berlaku pada koneksi plaintext (kanal loss; koneksi pengukuran pasca-ERROR).
   Konsekuensi: F3/F4 bentuk phase enc=A runtuh menjadi ≈F0 (didokumentasikan;
   F4 diuji dalam bentuk firstN yang benar-benar membelah dn↔ul).
4. Quota karakteristik IP egress baru (8.212.10.159): 5 sukses beruntun dalam
  ~13 menit (20:42–20:55 UTC) lalu 429 — jendela bergeser; ≥15 menit jeda
   praktik aman antar eksperimen berikutnya.

## 3. Aturan label yang dipakai mulai sekarang

- VERIFIED hanya untuk run CLI resmi nyata dengan evidence dir lengkap + ≥3
  reproduksi untuk klaim inti (F2a ✅ 3/3; F5-n22 dalam proses).
- PREDICTED/INFERRED untuk ekspektasi berbasis F0/C1/S*.
- BLOCKED untuk percobaan yang gagal karena kuota (bukan kegagalan protokol).
- Semua angka pada laporan harus bisa dilacak ke diverter.jsonl/analysis.json.
