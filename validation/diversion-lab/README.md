# diversion-lab — Backend Diversion Investigation (authorized lab)

> **Pertanyaan riset (master prompt):** *Dapatkah CLI resmi Ookla Speedtest yang
> TIDAK dimodifikasi melakukan koneksi/handshake awalnya ke backend OoklaServer
> resmi, sementara operasi latency, download, upload, atau packet-loss berikutnya
> ditangani backend lain — dan bila ya, di batas koneksi/protokol mana persisnya
> diversion bisa terjadi tanpa merusak pengukuran?*

Direktori ini berisi investigasi lengkap: instrumen baru (diverter), matriks
eksperimen diversion, evidence per-run, dan 9 laporan sesuai format master prompt.

## Status singkat (diperbarui per tahap)

| Komponen | Status |
|---|---|
| Audit dua repositori (Stage 1) + rekonsiliasi evidence & koreksi label | ✅ selesai — `analysis/STAGE1_REPO_AUDIT.md` + **`analysis/EVIDENCE_RECONCILIATION.md`** (sesi-2) |
| Verifikasi binari resmi (SHA-256 vs manifest) | ✅ CLI `5690596c…cfeeb7`; daemon `ce180aa3…598159` (diverifikasi ulang sesi-2 setelah lab dibangun ulang) |
| Instrumen **diverter.mjs** (TCP+UDP, 5 policy, replay+swallow) | ✅ tervalidasi 4 mode via klien sintetis (`evidence/synth-validation/`) |
| Konfig-proxy live-curl + offline (non-publishing) | ✅ live-curl = satu-satunya yang lolos rate-limit CDN |
| **Kontrol F0** — semua→daemon resmi via diverter | ✅ **PASS** (sesi-1) |
| **Kontrol F1/C1** — semua→STS via diverter | ✅ **PASS** (sesi-1) |
| **F2a** — handshake/enc→resmi, loss+UDP→STS (phase) | ✅ **PASS 3/3** (sesi-2) — cross-backend DALAM SATU KONEKSI (prefix replay) |
| **F5-n22** — firstN: seleksi→resmi, SELURUH pengukuran→STS | ✅ **PASS 3/3** (sesi-2) ★ **arsitektur B terverifikasi**; fallback plaintext per koneksi setelah probe terenkripsi sukses |
| **F8a** — TCP→A, UDP→B (split loss) | ✅ run exit 0 loss 0 — **temuan: akuntansi loss ter-DECouple senyap** (PLOSS backend tak melihat UDP; 0% tak didukung pengukuran nyata) |
| F2b, F5 titik lain (n=28/20/12/…), F7b, F8b, G | ⛔ antre kuota (karakter: ~5–6 sukses per ~30–45 menit per egress IP) |
| 9 laporan + handoff + timeline generator | ✅ ditulis/diperbarui sesi-2 (`harness/gen-timeline.mjs` + `timeline.md`/`timeline.csv` per run) |

## Struktur

```
harness/
  diverter.mjs              ★ instrumen utama — gateway diversion level koneksi &
                             per-perintah (policy: all / firstN / phase / cmd /
                             blackhole; UDP A|B|drop; JSONL audit log penuh)
  live-config-proxy.mjs     config-proxy fetch LIVE via curl (default — satu-satunya
                             yang lolos rate-limit CDN; licenseKey harus segar)
  offline-config-proxy.mjs   varian snapshot (hanya untuk smoke test — kunci snapshot
                             usang → InvalidLicenseKey)
  run-diversion.sh          orkestrator 1 eksperimen = 1 siklus penuh
                             (preflight → backend fresh → diverter → proxy → CLI → atribusi)
  analyze-run.mjs           analisis atribusi pasca-run (diverter+STS+proxy+CLI)
  analyze-conn-flows.mjs    rekonstruksi urutan perintah NetGauge per koneksi
  gen-timeline.mjs          timeline lengkap per-run (master prompt §11) →
                             timeline.md + timeline.csv (kolom wajib + basis fase)
  netgauge-synth.mjs        klien sintetis peniru pola koneksi CLI (validasi instrumen)
  fetch-config.sh           pengambil config live dengan query persis CLI (retry/backoff)
  certs -> ../../harness/certs   (PKI lab yang sama dengan validation/harness)
evidence/
  config-snapshot.json      snapshot config asli (first-hand 2026-11-04, sanitized utk commit)
  synth-validation/         bukti validasi instrumen (S1–S4)
  <EXP-ID>/                 evidence per eksperimen matriks (diverter.jsonl, proxy.jsonl,
                             cli.json, sts-evidence.jsonl, daemon-access.log, analysis.*)
analysis/
  STAGE1_REPO_AUDIT.md      hasil audit kedua repositori (tools, evidence, pertanyaan terbuka)
  EXPERIMENT_MATRIX.md      definisi lengkap matriks F0–F8/G/H + status
reports/                    9 laporan sesuai master prompt (lihat bawah)
```

## 9 laporan (master prompt §13)

1. `reports/CLI_CONNECTION_TIMELINE.md` — timeline peristiwa koneksi lengkap CLI resmi
2. `reports/FIRST_CONNECTION_ANALYSIS.md` — operasi pertama yang menyentuh jaringan + koneksi pertama ke server terpilih
3. `reports/NETGAUGE_SESSION_MAP.md` — peta siklus hidup koneksi NetGauge per fase
4. `reports/DNS_AND_IP_BEHAVIOR.md` — perilaku DNS/alamat tujuan (dalam batas lab)
5. `reports/MEASUREMENT_PHASE_MATRIX.md` — matriks fase ↔ koneksi ↔ protokol
6. `reports/BACKEND_DIVERSION_RESULTS.md` — hasil matriks diversion F0–F8 ★
7. `reports/CLOUDFLARE_WORKERS_FEASIBILITY.md` — kelayakan Workers (H)
8. `reports/EVIDENCE_INDEX.md` — indeks seluruh evidence → klaim
9. `reports/EXECUTIVE_CONCLUSION.md` — jawaban 15 pertanyaan riset

Ditambah: `reports/AGENT_HANDOFF.md` — instruksi lanjutan untuk agent berikutnya
(tanpa konteks percakapan), mencakup apa yang sudah/belum dikerjakan dan
cara melanjutkan.

## Temuan kunci yang sudah terverifikasi (evidence di tempat)

1. **Config engine dilindungi token anti-tamper per-perangkat** — CLI memvalidasi
   `app.licenseKey` terhadap identitasnya (deviceId/hid/sid); config tanpa kunci →
   `NoLicenseKey`; kunci asing → `InvalidLicenseKey`. Konsekuensi: diversion
   level-config HARUS memakai respons API asli (teknik cv-proxy), dan satu
   tangkapan live cukup karena deviceId+sid CLI stabil antar-run (terverifikasi
   dari 2 run berbeda).
2. **CLI resmi memakai koneksi terpisah per fase** (dari evidence gate-cli2):
   11 probe seleksi (hello terenkripsi → ERROR → HI → GETIP → PING×3 → close),
   1 probe pemenang (`HI <UUID>` + PING×5), 1 koneksi loss (`HI <UUID>`+INITPLOSS
   → PLOSS tiap 500 ms), monitor ping per fase, 4 worker download, 1 kontrol
   upload (CAPABILITIES+UPLOAD_STATS), 4 worker upload. Semua koneksi pasca-
   seleksi membawa UUID sesi yang sama. → **fase adalah objek diversion yang
   layak pada granularitas koneksi.**
3. **Instrumen diverter tervalidasi** (klien sintetis): policy `phase` melakukan
   routing per-fase dengan replay prefix (jawaban duplikat ditelan, klien melihat
   sesi konsisten); policy `cmd` memecah sampai level perintah (16/16 UPLOAD OK
   lintas 2 backend); policy `firstN` membelah berdasarkan indeks koneksi secara
   eksak; forward UDP berfungsi (RECV kembali via diverter).
4. **Akuntansi packet-loss terikat backend** — INITPLOSS/PLOSS (TCP) dan aliran
   UDP LOSS harus berakhir di backend yang sama; bila dipisah (PLOSS→A, UDP→B),
   backend yang menjawab PLOSS melaporkan 0/0/0 karena tidak pernah menerima
   datagram (diverter-mediated, terverifikasi sintetis; daemon resmi juga tidak
   membalas RECV bila INITPLOSS tidak sampai padanya).
5. **Rate-limit endpoint config** (429, IP-level, pesan resmi Ookla: penggunaan
   personal satu komputer) adalah kendala lingkungan lab; diatasi dengan
   snapshot first-hand + retry/backoff.

## Keamanan & batasan yang dipegang

- CLI resmi TIDAK dimodifikasi (sha terverifikasi, hanya flag runtime).
- Non-publishing by default: `results.speedtest.net` DITOLAK proxy; `persisted:false`
  diverifikasi per-run; tidak ada hasil lab yang menjadi hasil publik.
- Binari proprietary TIDAK di-commit (hanya di `lab/` luar repo, sesuai
  `.gitignore` dan REFERENCE_BINARY_MANIFEST).
- Tidak ada perubahan DNS/routing/firewall sistem — semuanya user-space di loopback.
- Token/identitas perangkat di-sanitasi pada artifact yang di-commit.
