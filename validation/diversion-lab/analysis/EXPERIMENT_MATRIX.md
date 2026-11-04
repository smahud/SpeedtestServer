# EXPERIMENT_MATRIX — matriks eksperimen diversion backend (F0–F8, G, H)

> Definisi operasional setiap eksperimen + status eksekusi. Label status:
> **PASS / FAILED / INCONCLUSIVE / NOT TESTED / BLOCKED** (master prompt §12:
> skenario yang tidak dieksekusi TIDAK BOLEH dilabel VERIFIED/PASS).

## Topologi lab (sama untuk semua eksperimen)

```
CLI resmi 1.2.0.84 (unmodified)
  │  ALL_PROXY → localhost:8888 (offline-config-proxy, non-publishing)
  │    └─ cli.speedtest.net (MITM lab-CA) → snapshot config, SEMUA servers[] → localhost:9090
  │    └─ results.speedtest.net → DITOLAK (403)   [jaminan non-publishing]
  ▼
diverter :9090 (TCP+UDP, policy per eksperimen)
  ├─ Backend A = daemon OoklaServer resmi 2.11.5.2  (127.0.0.1:18080, TCP+UDP)
  └─ Backend B = SpeedtestServer TS (repo ini)       (127.0.0.1:8080, TCP+UDP)
```

Setiap eksperimen = 1 invocation `run-diversion.sh` (backend di-restart fresh,
evidence terisolasi: diverter.jsonl + proxy.jsonl + sts-evidence.jsonl +
daemon-access.log + cli.json + analysis.json). Kriteria sukses umum:
exit 0, latency+download+upload+packetLoss terlapor, persisted=false,
atribusi fase sesuai kebijakan (analysis.json), ≥3 pengulangan untuk skenario sukses.

## F — Matriks diversion

| ID | Skenario | Policy diverter | UDP | Pertanyaan spesifik | Status |
|---|---|---|---|---|---|
| F0 | Semua → A (kontrol via instrumen) | `all:A` | A | Instrumen transparan vs baseline direct repo? Loss via NAT middlebox? (uji ulang F-7) | ✅ **PASS** (exit 0, loss 0 — NAT diverter TIDAK mendistorsi; RECV melewati diverter tapi PLOSS tetap mengalir) |
| F1 | Semua → B (kontrol via instrumen) | `all:B` | B | Sama seperti gate-cli2 repo tetapi lewat diverter | ✅ **PASS** (exit 0, DL 12,09 GB, UL 8,16 GB, loss 0) |
| F2a | Seleksi+handshake → A, pengukuran → B | `phase:pre=A,enc=A,sel=A,ping=B,loss=B,dn=B,up=B,upctl=B` | B | Apakah CLI tetap selesai bila HELLO/latency datang dari daemon dan beban dari STS? Apakah CLI "belajar" enkripsi dari probe seleksi (→daemon) lalu kacau saat pengukuran → STS? | ✅ **PASS 3/3** (sesi-2: f2a/f2a-r2/f2a-r3) — run penuh exit 0 loss 0; SEMUA koneksi terenkripsi (probe+beban) → A via enc-hello (pembelajaran enkripsi dibawa CLI); kanal loss plaintext → B via replay prefix DALAM SATU KONEKSI; UDP → B. Pemetaan dn/up/upctl/ping inert (koneksi terenkripsi tak bisa dipicu per-fase) — jawaban atas pertanyaan "kacau?": TIDAK, CLI tidak menolak apa pun |
| F2b | Handshake → B, pengukuran → A | `phase:pre=B,enc=B,sel=B,ping=A,loss=A,dn=A,up=A,upctl=A` | A | Kebalikan: apakah daemon menerima koneksi pengukuran tanpa pernah melihat probe seleksi? | ⛔ BLOCKED (kuota; antre sesi-2) |
| F3 | Latency → A, download+upload → B | `phase:pre=A,enc=A,sel=A,ping=A,loss=A,dn=B,up=B,upctl=B` | A | Batas fase-latency vs fase-bandwidth | ⚠️ **RUNTUH ke ≈F0** (terbukti F2a: enc=A mengikat SEMUA koneksi pengukuran terenkripsi ke A; dn/up/upctl tidak pernah terpicu). Pertanyaan risetnya justru terjawab oleh F5-n22 (seleksi+latency→A terenkripsi, beban→B fallback plaintext) |
| F4 | Latency+download → A, upload → B | `phase:pre=A,enc=A,sel=A,ping=A,loss=A,dn=A,up=B,upctl=B` | A | Batas download↔upload | ⚠️ **RUNTUH** (mekanisme sama dgn F3). Bentuk pengujian yang benar-benar membelah dl↔ul = firstN (F5-n28, antre kuota) |
| F5 | N koneksi pertama → A, sisanya → B (sweep) | `firstN:A:<n>` untuk n ∈ {1,2,3,5,8,12,16,20} | A→B mengikuti mayoritas TCP | Di indeks koneksi mana test masih "lengkap"? Peta batas granularitas koneksi | ✅ **n=22: PASS 3/3** (sesi-2: f5-n22{,-r2,-r3}) — belahan tajam seleksi↔pengukuran; seleksi→A terenkripsi, SELURUH pengukuran→B (fallback plaintext per koneksi setelah ERROR). Titik lain (n=1,12,16,20,28) antre kuota |
| F5r | N koneksi pertama → B, sisanya → A (arah balik, sampel) | `firstN:B:<n>` n ∈ {1,12} | B | Simetri arah split | ⛔ BLOCKED (kuota) |
| F6 | Diversion level DNS/alamat | — (analisis) | — | Apakah CLI re-resolve alamat server antar fase / re-fetch config di tengah run? (bukti: 1 config_req per run; host:port dikunci entri config) | INCONCLUSIVE (analisis log: 1 config_req/run; DNS kontrol penuh tak dimungkinkan tanpa root — lihat laporan DNS) |
| F7a | Split protocol-aware level KONEKSI | = F2/F3/F4 (phase mode) | — | Routing per koneksi berdasar perintah fase pertama | ⛔ BLOCKED pada CLI — VERIFIED pada instrumen (S2) |
| F7b | Split level PERINTAH (satu koneksi, 2 backend) | `cmd:hi=A,getip=A,caps=A,ping=A,dn=B,up=B,upctl=B,loss=B,ploss=B` | A | Apakah test tetap utuh bila SETIAP perintah dilayani backend berbeda? (substitusi jawaban lintas-backend) | ⛔ BLOCKED (kuota) |
| F7c | Jawaban lokal (tanpa backend) | `blackhole` + varian synthetic-responder | A | Apakah CLI menerima jawaban buatan diverter? (batas integritas pengukuran vs validitas protokol) | ⛔ BLOCKED (kuota) |
| F8a | TCP semua → A, UDP → B | `all:A` | B | Loss dilaporkan dari mana bila PLOSS dijawab A (tak melihat UDP) sementara RECV datang dari B? | ⛔ BLOCKED (kuota) |
| F8b | TCP semua → B, UDP → A | `all:B` | A | Kebalikan; daemon tanpa INITPLOSS → apakah RECV berhenti? (indikasi sintetis: ya) | ⛔ BLOCKED (kuota) |
| F8c | TCP+UDP → A via diverter (NAT) | `all:A` | A | Re-verifikasi F-7: apakah middlebox mendistorsi loss vs direct? (loopback: IP sama) | ✅ PASS (tergabung F0) |
| F8d | Loss-conn → A, UDP → B, lainnya → B | `phase:pre=B,enc=B,sel=B,ping=B,loss=A,dn=B,up=B,upctl=B` | B | Kombinasi ekstrem: hanya akuntansi loss di daemon | ⛔ BLOCKED (kuota) |

## G — Injeksi kegagalan (satu variabel per run)

| ID | Skenario | Mekanisme | Status |
|---|---|---|---|
| G1 | Backend tujuan menolak koneksi | `SKIP_B=1` (B tidak dijalankan) dengan policy yang mengarahkan mayoritas → B | ⛔ BLOCKED (kuota) |
| G2 | Backend mati di tengah run | `KILL_A_AT_MS=15000` / `KILL_B_AT_MS=15000` | ⛔ BLOCKED (kuota) |
| G3 | UDP blackhole | `--udp drop` | ⛔ BLOCKED (kuota) |
| G4 | Semua koneksi blackhole | `blackhole` | ⛔ BLOCKED (kuota) |
| G5 | Jawaban HELLO salah versi | varian synthetic-responder (F7c) | NOT TESTED |

## H — Cloudflare Workers (SETELAH matriks lokal)

Analisis berbasis kontrak protokol terverifikasi (bukan deployment — tidak ada
akun Workers di lab): ingress Workers hanya HTTP/WS; engine protocol CLI resmi
= TCP biner terenkripsi / NetGauge teks — keduanya bukan HTTP. → laporan
`CLOUDFLARE_WORKERS_FEASIBILITY.md`.

## Kontrol kualitas instrumen (pra-matriks, dengan klien sintetis)

| ID | Mode diverter | Hasil | Status |
|---|---|---|---|
| S1 | `all:B` | 21 koneksi; DL 12×1MB ✓; UL 8/8 ✓; PLOSS 3 0 2 (loss 0%) ✓; RECV via diverter ✓ | ✅ PASS (synthetic) |
| S2 | `phase:pre=A,sel=A,ping=A,loss=A,dn=B,up=B,upctl=B` | routing per fase sesuai peta; replay+swallow bekerja (klien melihat sesi konsisten); PLOSS 0 0 0 (loss-conn→A, UDP→B → akuntansi lintas-backend tidak cocok — SESUAI PREDIKSI F8) | ✅ PASS (synthetic) |
| S3 | `cmd:hi=A,getip=A,caps=A,ping=A,dn=B,up=B,upctl=B,loss=B,ploss=B` | 16/16 UPLOAD OK lintas 2 backend; DL ✓; PLOSS dari B = 0 0 0 (UDP→A, INITPLOSS→B) | ✅ PASS (synthetic) |
| S4 | `firstN:A:12` | koneksi 1–12→A, 13–23→B eksak; run lengkap | ✅ PASS (synthetic) |

Bukti: `evidence/synth-validation/`. Validasi sintetis membuktikan MEKANISME
instrumen, bukan perilaku CLI resmi — matriks F tetap memakai CLI resmi.

## Log status eksekusi

(diperbarui saat matriks berjalan — lihat `../reports/BACKEND_DIVERSION_RESULTS.md`)
