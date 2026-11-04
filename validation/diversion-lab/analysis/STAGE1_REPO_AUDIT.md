# STAGE1_REPO_AUDIT — audit dua repositori (2026-11-04, sesi diversion-lab)

> Stage 1 dari strategi eksekusi master prompt: baca kedua repositori, identifikasi
> tools yang dapat dipakai ulang, evidence yang sudah ada, dan pertanyaan yang belum
> terjawab. Audit ini dilakukan SEBELUM eksperimen diversion apa pun dijalankan.

## 1. Identitas repositori (commit yang diaudit)

| Repo | Branch | Commit | Tanggal | Subjek |
|---|---|---|---|---|
| `smahud/SpeedtestServer` | master | `7b58988b8b9683c48843ade190ffd7ce5af44622` | 2026-11-04 14:15 UTC | "feat(protocol,http): revision 4 — live differential lab vs reference daemon: 25 new verified findings fixed (F-8…F-25)" |
| `smahud/SpeedtestHost-Tester` | main | `bd490eb` (HEAD) | 2026-11-04 | "arena.ai: record the completed delivery (PR #1)" |

Catatan penting: repo SpeedtestServer berisi **binari OoklaServer resmi untuk 4
platform di root** (`OoklaServer-linux-x86_64` dll., ~15,5 MB) — terdeteksi saat
audit. Ini inkonsisten dengan `.gitignore`/manifest repo itu sendiri yang
menyatakan binari vendor tidak di-commit. Agent berikutnya harus tahu: binari
tersebut ADA di repo dan TIDAK dipakai oleh lab ini (lab memakai salinan hasil
unduhan segar yang sha-nya cocok manifest `ce180aa3…`).

## 2. SpeedtestServer — apa yang sudah ada & dapat dipakai ulang

### 2.1 Implementasi & status

- `reverse-engineered/typescript/` — implementasi kanonik (ServerCore,
  NetGaugeEngine, UdpLossEngine, HttpApi, CertificateManager, AcmeProvisioner,
  ConnectionTracker, IpStatsManager). Build bersih (Node 24, `npm ci && npm run
  build` → sukses, diulang oleh sesi ini). Suite 125/125.
- Gate penting yang SUDAH terverifikasi repo (semua 2026-11-04, evidence
  `validation/evidence/`):
  - **CLI resmi 1.2.0.84 → daemon resmi** 3/3 (exit 0; run via relay menunjukkan
    artefak NAT loss 0,515 — F-7; run direct loss 0).
  - **CLI resmi 1.2.0.84 → SpeedtestServer** 3/3 non-publishing, loss 0,
    23 koneksi NetGauge, byte counter server ↔ klien cocok.
  - Battery publishing opt-in: Result URL publik asli (9 run / 6 server id).
  - Differential 103-probe: 89 byte-identical + 6 non-difference + 8 deviasi
    terdokumentasi.

### 2.2 Tools harness yang dipakai ulang oleh lab ini

| Tool | Fungsi | Dipakai ulang? |
|---|---|---|
| `validation/harness/cv-proxy.mjs` | config-proxy: MITM `cli.speedtest.net`, fetch live config dengan query CLI, rewrite entri server, tolak `results.speedtest.net` | **Ya** — pola/tekniknya (diadaptasi menjadi `offline-config-proxy.mjs` karena rate-limit) |
| `validation/harness/gen-pki.sh` | PKI lab (Root CA, server cert, MITM cert, bundle CA CLI) | **Ya** — langsung (symlink `certs/`) |
| `validation/harness/run-official-baseline.sh` | baseline CLI→daemon + verifikasi non-publishing | **Ya** — untuk F0 (satu kali sukses saat config live tersedia) |
| `validation/harness/run-replacement-test.sh` | gate CLI→STS fail-closed (daemon resmi wajib ABSEN) | Sebagian — untuk F1 murni; matriks diversion justru butuh KEDUA backend hidup, jadi orkestrator baru (`run-diversion.sh`) dibuat dengan preflight yang sesuai |
| `validation/harness/recording-relay.mjs` | perekam byte-level (NAT) | Tidak (relatif terhadap matriks; NAT-nya justru mengacaukan UDP — F-7) |
| `validation/harness/probe-*.mjs`, `negative-tests.mjs`, `tls-strict-check.mjs` | baterai differential/negative/TLS | Tidak berubah (di luar scope diversion) |

### 2.3 Evidence lama yang menjadi bekal (leads, bukan pengganti verifikasi)

- `validation/evidence/gate-cli2-sts-evidence.jsonl` — **peta alur perintah CLI
  resmi per koneksi** (dianalisis ulang oleh sesi ini dengan
  `analyze-conn-flows.mjs`; hasilnya menjadi dasar klasifikasi fase diverter).
- `speedtest-cli_analysis/` — analisis sesi sebelumnya (multi-koneksi, verbose
  engine config, hybrid architecture, KESIMPULAN-FINAL).
- `validation/evidence/published*/` — bukti siklus Result URL (persisted=true,
  hanya opt-in).

### 2.4 KESIMPULAN-FINAL.md (sesi sebelumnya) vs master prompt kali ini

Dokumen lama menjawab dua pertanyaan berbeda (Worker+VPS untuk client resmi →
TIDAK MUNGKINKAN di sisi Worker; kontrol koneksi → hybrid server-policy /
client-eksekusi). **Pertanyaan master prompt kali ini lebih spesifik dan belum
dijawab oleh repo**: pada batas koneksi/protokol mana diversion antar-backend
bisa terjadi TANPA merusak pengukuran. Matriks F2–F8 lab ini yang mengisinya.

## 3. SpeedtestHost-Tester — hasil audit singkat

- Struktur: 4 direktori agent independen (`chatgpt/`, `arena.ai/`, `mistral.ai/`,
  `z.ai/`) — **root README bukan implementasi final**, hanya indeks perbandingan.
- Setiap agent membawa: web tester + CLI + engine + audit + hasil. Versi CLI
  tester berbeda (mis. mistral v1.1.0, z.ai nol-dep CLI).
- Relevansi bagi lab ini: host tester memvalidasi SERVER (bukan diversion);
  tidak dipakai ulang langsung. Yang dipakai hanya pembandingan perilaku
  (`validation/HOST_TESTER_COMPARISON.md` di repo SpeedtestServer, 10/10).
- Kontradiksi antar-agent yang perlu dicatat: tidak ada kontradiksi protokol
  material yang memengaruhi matriks diversion (semua agent mengonfirmasi
  NetGauge text-line + fallback plaintext + UDP LOSS/RECV).

## 4. Pertanyaan terbuka yang dibawa ke eksperimen (output Stage 1)

1. Apakah CLI "belajar" fallback plaintext per-server (setelah probe seleksi
   menjawab ERROR untuk hello terenkripsi) sehingga koneksi pengukuran berikutnya
   langsung plaintext? → diuji F2a (probe seleksi→daemon resmi yang BISA
   terenkripsi, pengukuran→STS): apakah koneksi pengukuran tetap mencoba
   terenkripsi dan jatuh ke fallback per koneksi?
2. Apakah ada state lintas-koneksi yang dipegang SERVER (di luar UUID sesi)
   yang membuat split handshake/pengukuran gagal? → F2/F3.
3. Di indeks koneksi mana tepatnya batas "masih jalan" pada split first-N? → F5.
4. Apakah akuntansi packet-loss (INITPLOSS/PLOSS over TCP vs datagram UDP)
   harus satu backend? → F8 (indikasi awal dari validasi sintetis: YA).
5. Apakah CLI mengirim ulang query config di tengah run (re-resolusi DNS/
   alamat antar fase)? → observasi proxy log setiap run (hanya SATU
   `config_req` per run pada semua evidence lama; konfirmasi ulang di tiap run).

## 5. Keputusan desain lab yang diambil dari audit

- **Dua backend loopback** (daemon resmi :18080, STS :8080) + **diverter :9090**
  + **config-proxy :8888** — semuanya user-space, tanpa root, tanpa sentuhan
  DNS/hosts/firewall.
- **Config snapshot offline** (first-hand) sebagai default penggantian fetch-live
  per-run — alasan: (a) rate-limit 429 IP-level teramati; (b) reproducibility;
  (c) deviceId+sid CLI terverifikasi stabil antar-run sehingga satu snapshot live
  yang valid tetap autentik untuk seluruh matriks.
- **Backend di-restart per eksperimen** → evidence terisolasi per run di KEDUA
  sisi (sts-evidence.jsonl fresh + daemon-access.log fresh) + diverter log
  menutup rantai atribusi.
- **Non-publishing by default** (results.speedtest.net ditolak) — konsisten
  dengan semua gate repo.
