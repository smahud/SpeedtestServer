# BACKEND_DIVERSION_RESULTS — hasil matriks diversion backend (F0–F8, G)

> Format: setiap baris = satu skenario, dengan bukti per-run dan label status
> master prompt §12 (VERIFIED / PARTIALLY VERIFIED / FAILED / INCONCLUSIVE /
> NOT TESTED). Riwayat: **sesi-1** = 2026-11-04 (18:11–20:20 UTC, egress
> 47.57.232.232, kendala kuota setelah C1+F0); **sesi-2** = 2026-11-04/05
> (20:42 UTC→, egress 8.212.10.159, lab dibangun ulang + binari diverifikasi
> ulang vs manifest — `analysis/EVIDENCE_RECONCILIATION.md`).

## 0. Kendala eksekusi (transparan)

CLI resmi **wajib** menerima config live dari `cli.speedtest.net` (licenseKey
anti-tamper per-perangkat, umur ~±15 s — terverifikasi sesi-1 18:52 UTC).
Karakter kuota per egress IP (terukur):
- sesi-1 (47.57.232.232): 4 sukses lalu 429 terus (11 percobaan gagal 19:12–20:19 UTC).
- sesi-2 (8.212.10.159): 6 sukses beruntun ~25 menit (20:42–21:07 UTC), lalu
  jendela tersaturasi; 429 TIDAK memperpanjang blokir (aman retry berjarak
  ≥10–15 menit). curl lolos, Node https kena 429 (TLS fingerprint CDN).

## 1. Hasil terverifikasi — sesi-1 (kontrol, tetap berlaku)

### F1 / C1 — semua trafik → backend pengganti (STS) via instrumen diversion

| Aspek | Nilai |
|---|---|
| Run | `evidence/c1-all-b/` (2026-11-04 18:56:56 UTC, config live di-rewrite) |
| Exit / kelengkapan | **0; latency 0,095 ms + download 12,09 GB + upload 8,16 GB + packetLoss 0** |
| Non-publishing | `persisted:false` + `results.speedtest.net` DITOLAK proxy |
| Atribusi | 34 koneksi → 100% backend B; byte diverter ≈ laporan CLI (Δ framing <2%); STS: 373 download, 258 upload, 432 udp_recv |
| Status | **VERIFIED** (sesi-1) |

### F0 / F8c — semua trafik → daemon resmi via instrumen (middlebox NAT)

| Aspek | Nilai |
|---|---|
| Run | `evidence/f0-all-a/` (19:10:54 UTC) |
| Exit / kelengkapan | **0; download 17,18 GB + upload 16,99 GB + packetLoss 0** |
| Temuan 1 — enkripsi | Probe seleksi terenkripsi DITERIMA daemon → seluruh run terenkripsi |
| Temuan 2 — loss & NAT | UDP via diverter, RECV balasan melewati diverter (F-7), loss tetap 0 |
| Temuan 3 — kanal loss plaintext | Koneksi loss SELALU plaintext (`HI <UUID>`+`INITPLOSS`+`PLOSS`) |
| Status | **VERIFIED** (sesi-1) |

### S (validasi instrumen, klien sintetis) — `evidence/synth-validation/` (sesi-1)

S1 all:B; S2 phase+replay+swallow (PLOSS↔UDP keterikatan lintas-backend);
S3 cmd-level 16/16 UPLOAD OK; S4 firstN eksak. **VERIFIED (mekanisme instrumen,
bukan perilaku CLI).**

## 2. Hasil terverifikasi — sesi-2 (matriks cross-backend, CLI resmi)

### F2a — handshake/seleksi → daemon resmi (A), kanal loss + UDP → STS (B) ★ EKSPERIMEN INTI

Policy diverter: `phase:pre=A,enc=A,sel=A,ping=B,loss=B,dn=B,up=B,upctl=B`, UDP=B.

| Aspek | Run 1 (`evidence/f2a`) | Run 2 (`evidence/f2a-r2`) | Run 3 (`evidence/f2a-r3`) |
|---|---|---|---|
| Waktu (UTC) | 20:42:63 | 20:44 | 20:47 |
| Exit / kelengkapan | **0; semua fase lengkap** | **0; lengkap** | **0; lengkap** |
| Download / Upload | 15,86 / 13,26 GB | 12,71 / 16,80 GB | 14,34 / 12,06 GB |
| packetLoss | **0** | **0** | **0** |
| Non-publishing | ✓ (persisted:false + blocked) | ✓ | ✓ |
| Atribusi | 22 koneksi terenkripsi → **A** (semua probe + winner + pingmon + 4 dn + upctl + 4 up, via `enc-hello`); koneksi loss (23) → **B** via `phase:loss` **dengan replay prefix lintas backend**; UDP 3 endpoint → **B** | identik | identik |

**Temuan kunci F2a:**
1. **Run cross-backend DALAM SATU EKSEKUSI CLI selesai sempurna** — seleksi+
   enkripsi+bandwidth dilayani daemon resmi; akuntansi packet-loss (TCP
   `INITPLOSS`/`PLOSS`) + datagram UDP dilayani SpeedtestServer TS. Exit 0,
   loss 0, byte konsisten (A=15,98 GB be→cli ↔ CLI DL 15,86 GB, Δ framing).
2. **Cross-backend DALAM SATU KONEKSI terbukti** (koneksi loss 23): prefix
   `HI <UUID>` dijawab daemon A (HELLO), lalu `INITPLOSS` memicu re-route ke B
   dengan prefix di-replay (`replayed:true`, jawaban duplikat B ditelan) — CLI
   menerima HELLO dari A dan akuntansi PLOSS dari B pada koneksi yang sama.
3. **Semantik phase-mode dengan enc=A**: pemetaan dn/up/upctl/ping **inert**
   untuk koneksi yang dibuka hello terenkripsi — CLI membawa pembelajaran
   enkripsi dari probe→A ke SEMUA koneksi pengukuran (hello biner), dan payload
   terenkripsi tidak dapat dipicu per-fase (diverter hanya memipa byte).
   Pemetaan fase hanya aktif pada koneksi plaintext (kanal loss).
   → Konsekuensi: F3/F4 bentuk phase enc=A runtuh menjadi ≈F0 (lihat §2c).
4. **UUID sesi portabel lintas backend** — `result.id` CLI = UUID yang
   diumumkan di koneksi loss (B) maupun terenkripsi di winner-probe (A).

**Status: VERIFIED — PASS 3/3** (kriteria reproduksi master prompt terpenuhi).

### F5-n22 — firstN:A:22 ★ ARSITEKTUR B TERVERIFIKASI (bentuk paling penting)

Policy diverter: `firstN:A:22` (koneksi indeks 1–22 → A, 23+ → B), UDP=B.
Inilah "handshake→daemon resmi, pengukuran→backend lain" dalam bentuk murni
level-indeks — tanpa routing protocol-aware sama sekali.

| Aspek | Run 1 (`evidence/f5-n22`) | Run 2 (`evidence/f5-n22-r2`) | Run 3 (`evidence/f5-n22-r3`) |
|---|---|---|---|
| Exit / kelengkapan | **0; lengkap** | **0; lengkap** | **0; lengkap** |
| Download / Upload | 14,12 / 9,38 GB | 10,24 / 7,16 GB | 17,19 / 8,61 GB |
| packetLoss | **0** | **9,09%** (lihat analisis di bawah) | **0** |
| Latency (idle, dari probe→A) | 0,095 ms | 0,109 ms | 0,119 ms |
| Atribusi | koneksi 1–22 (11 zero-byte + 10 probe + winner) → **A terenkripsi**; koneksi 23–34 (loss, pingmon, 4 dn, upctl, 4 up) → **B**; UDP 3 endpoint → **B** | identik | identik |
| Korroborasi B (STS) | 14 koneksi NetGauge, 1205 perintah, 436 download, 296 upload, 436 udp_recv | 949 perintah, 315 dn, 226 up, 358 udp_recv | (lihat analysis.json) |

**Analisis pembacaan loss 9,09% pada run 2 (transparan, bukan disembunyikan):**
9,09% = tepat 1/11 — satu datagram hilang dalam satu interval PLOSS. Bukti
menunjukkan hilangnya BUKAN akibat diversion: (i) diverter mem-forward semua
datagram yang diterima dan menghitung balasan RECV — kedua stream loss
187/187 dan 171/171 (0 hilang di jalur gateway); (ii) STS menerima 358/358
datagram stream yang diteruskan (udp_recv=358) dan menjawab semuanya;
(iii) karenanya datagram yang hilang jatuh di jalur **klien→gateway level
kernel** (socket buffer di bawah beban ~1–2 GB/s loopback) — tak terlihat oleh
counter gateway/backend, terlihat hanya oleh aritmetika CLI (kirim-sendiri vs
counter PLOSS backend `PLOSS <count> <dupes> <maxseq>`). Kelas artefak yang
sama sudah terdokumentasi repo (`REPRODUCE.md` §4b: "stochastic loopback
UDP-loss outliers"). **Akuntansi loss tetap 100% di backend B (PLOSS+UDP
sama-sama di B) — state sesi benar; CLI jujur melaporkan loss yang benar-benar
terjadi di jalur egress-nya sendiri.** Run diulang → 0% (r3), konsisten dengan
outlier stokastik lingkungan, bukan kegagalan protokol.

**Temuan kunci F5-n22 (menjawab pertanyaan penentu master prompt Stage 2):**
1. **Probe terenkripsi yang SUKSES di daemon resmi TIDAK mematahkan diversion
   pengukuran ke backend plaintext-capable.** Bukti langsung — koneksi 24
   (worker download pertama → B): `«BIN 65B»` (hello terenkripsi, dibawa dari
   pembelajaran probe→A) → STS menjawab `ERROR` → CLI **fallback plaintext
   per koneksi** (`HI <UUID>` → `DOWNLOAD 32000000`×N). Run tetap exit 0.
2. **CLI memperbarui pembelajaran enkripsi di tengah run**: worker upload
   (koneksi 29+) membuka **langsung plaintext** (tanpa percobaan biner) —
   setelah ERROR dari B pada koneksi download pertama.
3. **Batas belah tepat di indeks 22→23** (antara winner-probe dan koneksi
   loss/pengukuran pertama): seleksi+handshake utuh di A, SELURUH pengukuran
   (loss TCP+UDP, loaded-latency, download, upload) utuh di B — tanpa
   koneksi aktif yang pindah backend (diverter tidak memigrasi stream;
   master prompt: "never assume TCP streams can migrate" — terbukti memang
   tidak perlu).

**Status: VERIFIED — PASS 3/3.**

### 2c. Skenario phase-mode enc=A lainnya (F3/F4 bentuk asli) — PREDIKSI RUNTUH (dibuktikan F2a)

F3 (`phase:pre=A,enc=A,sel=A,ping=A,loss=A,dn=B,up=B,upctl=B`) dan F4
(`…,dn=A,up=B,upctl=B`) memakai enc=A → seluruh koneksi pengukuran dibuka
hello terenkripsi (pembelajaran dari probe→A) dan terikat ke A seumur
koneksi; pemetaan dn/up/upctl tidak pernah terpicu. Hasil yang diharapkan =
replika F0. **Ini bukan kegagalan protokol melainkan konsekuensi terbukti
dari pembelajaran enkripsi CLI** (F2a temuan 3). Pertanyaan riset F3/F4
(batas fase-latency vs beban; batas download↔upload) dijawab dalam bentuk
yang benar-benar membelah: firstN (lihat F5-n28 = F4-equivalent, §3).

## 3. Tabel ringkas status (diperbarui sesi-2)

| ID | Skenario | Status | Bukti |
|---|---|---|---|
| F0 | semua→A via diverter (=F8c NAT) | **VERIFIED — PASS** (sesi-1) | `evidence/f0-all-a/` |
| F1/C1 | semua→B via diverter | **VERIFIED — PASS** (sesi-1) | `evidence/c1-all-b/` |
| F2a | handshake/enc→A, loss+UDP→B (phase) | **VERIFIED — PASS 3/3** (sesi-2) | `evidence/f2a`, `f2a-r2`, `f2a-r3` |
| F2b | handshake→B, pengukuran→A | ⛔ BLOCKED (kuota; antre sesi-2) | — |
| F3 | latency→A, beban→B (phase enc=A) | **RUNTUH ke ≈F0** (pemetaan inert — dibuktikan F2a temuan 3; bentuk firstN = F5-n22 sudah menjawab pertanyaan risetnya) | `evidence/f2a` (basis semantik) |
| F4 | lat+dl→A, ul→B (phase enc=A) | **RUNTUH** (idem); bentuk firstN F5-n28 menguji belahan dl↔ul sungguhan | lihat F5-n28 |
| F5-n22 | firstN 22: seleksi→A, pengukuran→B | **VERIFIED — PASS 3/3** (sesi-2) ★ arsitektur B | `evidence/f5-n22{,-r2,-r3}` |
| F5-n28 | firstN 28: seleksi+dl→A, ul→B (F4-equivalent) | antre (kuota) | — |
| F5 (titik lain: n=1,12,16,20) | sweep batas indeks | antre (kuota) | — |
| F6 | DNS | INCONCLUSIVE (bukti tak ada re-resolusi — sesi-1) | proxy logs |
| F7a | phase level koneksi | VERIFIED instrumen (S2); pada CLI setara F2a (trigger hanya plaintext) | `synth-validation/s2`, `f2a` |
| F7b | per-perintah | antre (kuota; diperkirakan hanya koneksi loss yang terlibat cmd-routing) | — |
| F7c | jawaban lokal | NOT TESTED | — |
| F8a | TCP→A, UDP→B | antre (kuota) — eksperimen diskriminatif loss | — |
| F8b | TCP→B, UDP→A | antre (kuota) | — |
| F8c | NAT loss | **VERIFIED — PASS** (tergabung F0) | `evidence/f0-all-a/` |
| F8d | loss→A saja | antre (kuota) | — |
| G1–G5 | injeksi kegagalan | antre (kuota) | — |
| H | Cloudflare Workers | **VERIFIED (analitis)** | `reports/CLOUDFLARE_WORKERS_FEASIBILITY.md` |

## 4. Perbandingan volume (atribusi byte)

| Run | CLI laporkan (DL/UL GB) | Diverter ukur (A be→cli / B be→cli) | Δ |
|---|---|---|---|
| C1 (→B, sesi-1) | 12,09 / 8,16 | 0 / 12,12 (+8,30 cli→be) | 0,3% / 1,7% (framing) |
| F0 (→A, sesi-1) | 17,18 / 16,99 | (lihat analysis.json) | konsisten |
| f2a (A=enc+beban, B=loss) | 15,86 / 13,26 | 15,98 / 0,00 (B: loss 405 B + UDP) | 0,8% (framing) |
| f5-n22 (A=seleksi, B=beban) | 14,12 / 9,38 | 0,00 / 14,14 (+STS: 296 upload) | 0,1% (framing) |
| f5-n22-r2 | 10,24 / 7,16 | 0,00 / 10,26 | 0,2% (framing) |
| f5-n22-r3 | 17,19 / 8,61 | 0,00 / 17,28 | 0,5% (framing) |

## 5. Ringkasan batas diversion (jawaban sementara matriks — diperbarui setelah antrean selesai)

1. **Level koneksi = batas yang terbukti aman** — termasuk belahan tajam
   seleksi↔pengukuran (indeks 22→23) dan belahan per-fase pada kanal plaintext.
2. **Dalam koneksi (per-perintah) terbukti bekerja untuk prefix stateless**
   (`HI <UUID>` replay lintas backend, jawaban duplikat ditelan) — koneksi loss
   F2a. Perintah fase tidak dapat dirote pada sesi terenkripsi (payload opaque).
3. **Pembelajaran enkripsi CLI = pengungkung utama**: probe→backend-terenkripsi
   membuat SEMUA koneksi pengukuran berikutnya mencoba hello terenkripsi;
   backend tujuan harus menjawab ERROR (→ fallback plaintext per koneksi,
   CLI pulih — F5-n22) atau menerima enkripsi (→ koneksi terikat ke backend
   itu seumur hidup — F2a).
4. **Packet-loss = satu-satunya kanal dengan keterikatan backend ganda**
   (TCP PLOSS + UDP LOSS harus backend sama) — terverifikasi konsisten pada
   semua run sukses (loss 0); uji diskriminatif split (F8a/F8b) antre.
