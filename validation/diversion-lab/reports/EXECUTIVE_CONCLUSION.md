# EXECUTIVE_CONCLUSION — jawaban atas pertanyaan riset diversion backend

> Basis: evidence terverifikasi **sesi-1** 2026-11-04 (C1, F0, validasi instrumen
> S1–S4; egress 47.57.232.232) + **sesi-2** 2026-11-04/05 (F2a ×3, F5-n22 ×3;
> egress 8.212.10.159; lab dibangun ulang, binari diverifikasi ulang vs manifest)
> + evidence repo (gate 3/3, differential 103-probe, protocol contract rev-4).
> Riwayat label & koreksi: `analysis/EVIDENCE_RECONCILIATION.md`. Keterbatasan
> kuota config API dibuka apa adanya (BACKEND_DIVERSION_RESULTS §0); klaim
> tidak pernah melebihi buktinya.

## Jawaban inti (satu paragraf)

**YA — terverifikasi eksperimental 3×3: CLI resmi yang tidak dimodifikasi dapat
menyelesaikan SATU run pengukuran penuh (exit 0, semua fase, loss terukur)
dengan handshake/seleksi terenkripsi di backend resmi DAN seluruh operasi
berikutnya (loss TCP+UDP, loaded-latency, download, upload) di backend lain,
dan batas diversion yang terbukti adalah BATAS KONEKSI — paling tajam tepat
di antara winner-probe (koneksi 22) dan koneksi pengukuran pertama (23).**
Mekanismenya: (1) CLI mengunci alamat sekali dari dokumen config (tidak pernah
re-resolve); (2) tiap fase berjalan pada koneksi TCP terpisah satu-fase; (3)
UUID sesi portabel — backend mana pun menerima `HI <UUID>` tanpa koordinasi;
(4) **pembelajaran enkripsi CLI mengikuti probe tapi CLI pulih per koneksi**:
hello terenkripsi yang dibawa dari probe→daemon resmi DITERIMA ERROR oleh
backend pengganti → CLI langsung fallback plaintext pada koneksi itu (bukti
`f5-n22` conn 24: `«BIN 65B»`→`HI <UUID>`→`DOWNLOAD…`) dan berhenti mencoba
enkripsi pada koneksi berikutnya; (5) kanal loss (`INITPLOSS`/`PLOSS` TCP +
datagram `LOSS` UDP) HARUS berakhir di backend yang sama — semua run sukses
memenuhinya (loss 0; satu outlier 9,09% teranalisis sebagai drop kernel
klien→gateway, bukan akuntansi lintas backend). Dua kualifikasi: (a) diversion
level-perintah hanya mungkin pada sesi plaintext (payload terenkripsi opaque —
terbukti pemetaan dn/up/upctl phase-mode INERT saat enc=A); (b) jalur MASUKNYA
diversion = dokumen config (licenseKey anti-tamper per-perangkat, umur detik)
— hanya mungkin dalam lab berotorisasi atau oleh operator host yang SAH
terdaftar (kendali penuh atas endpoint miliknya sendiri), bukan di jalur
produksi pihak ketiga.

## Jawaban 15 pertanyaan riset (master prompt §2)

| # | Pertanyaan | Jawaban | Status |
|---|---|---|---|
| 1 | Koneksi/handshake pertama ke backend — koneksi mana, protokol apa? | 11–12 probe seleksi pendek (~60 ms) ke `host:port` config: hello biner TERENKRIPSI; bila dijawab `ERROR` → fallback `HI`→`GETIP`→`PING`; probe pemenang menambah `HI <UUID>`+`PING×5`. | **VERIFIED** (C1, F0, f2a×3, f5-n22×3) |
| 2 | Kapan DNS pertama & perilaku resolusi? | Resolusi pertama = `cli.speedtest.net` (via proxy lab). Tidak ada resolusi lagi setelahnya; host pengukuran dari config. IPv6-first (`::1`) untuk localhost. | **VERIFIED** |
| 3 | Bagaimana config engine didapat? | SATU GET `/api/cli/config?deviceId&hid&sid&uname` (HTTPS) per run; dilindungi licenseKey anti-tamper (kunci asing/usang → `InvalidLicenseKey`; exit 2). | **VERIFIED** |
| 4 | Bagaimana discovery/seleksi server? | CLI hanya menguji entri `servers[]` dari config; probe semua kandidat (11 probe untuk 10 entri + winner), memilih hasil terbaik. | **VERIFIED** |
| 5 | Urutan negosiasi NetGauge? | ENC-hello → (ERROR →) `HI[ <UUID>]` → `GETIP` → `PING`; koneksi pengukuran: ENC-hello (bila dipelajari) → (ERROR →) `HI <UUID>` → `DOWNLOAD`/`UPLOAD`; loss: `HI <UUID>` → `INITPLOSS` → `PLOSS`×N (SELALU plaintext). | **VERIFIED** (diperkaya f5-n22: fallback per koneksi pasca-ERROR) |
| 6 | Berapa koneksi TCP & apakah di-reuse? | ±34 per run (11 zero-byte + 12 probe + 1 loss + 2 pingmon + 4 DL + 1 kontrol + 4 UL); TIDAK ada reuse lintas fase. | **VERIFIED** (direproduksi 6× sesi-2) |
| 7 | Koneksi mana untuk fase mana? | MEASUREMENT_PHASE_MATRIX §1 + `timeline.csv` per run (generator `gen-timeline.mjs`). | **VERIFIED** |
| 8 | Kapan hasil dikirim? | Di AKHIR run: CONNECT `results.speedtest.net` → POST; ditolak proxy lab → `persisted:false`, exit 0 tetap. | **VERIFIED** (semua run sesi-2) |
| 9 | **Bisakah handshake→resmi + pengukuran→backend lain?** | **YA — VERIFIED 3/3 (F5-n22): seleksi+handshake terenkripsi utuh di daemon resmi (koneksi 1–22), SELURUH pengukuran (koneksi 23–34) + UDP di SpeedtestServer TS; exit 0, loss 0 (1 outlier 9,09% = drop kernel klien, teranalisis), byte konsisten.** Sub-temuan: (i) F2a (phase-mode enc=A) memang mengarahkan semua koneksi terenkripsi ke daemon — pemetaan dn/up/upctl inert; diversion aktif justru pada kanal loss+UDP; (ii) CLI membawa pembelajaran enkripsi dari probe (hello biner pada koneksi pengukuran pertama → B) TAPI pulih per koneksi setelah ERROR dan berhenti mencoba enkripsi untuk koneksi berikutnya. | **VERIFIED (dulu PARTIALLY — kini 3/3 run nyata)** |
| 10 | Apakah DNS/alamat di-resolve ulang antar fase? | TIDAK — satu fetch config, satu resolusi per koneksi ke host config; tidak ada indikasi re-binding. | **VERIFIED** (bukti negatif kuat) |
| 11 | Apakah transport Workers kompatibel? | TIDAK untuk CLI resmi: semua fase = TCP biner/NetGauge + UDP; Workers ingress HTTP/WS saja; sesi terenkripsi menutup routing per-perintah. | **VERIFIED (analitis + bukti protokol)** |
| 12 | Apakah payload besar bisa bypass VPS via edge? | Untuk CLI resmi: TIDAK ADA peran edge. Payload besar (10–17 GB/run di lab) wajib melewati backend TCP penuh. | **VERIFIED** |
| 13 | Arsitektur yang didukung bukti? | **A (full origin)** VERIFIED (C1/F0/gate-repo). **B (handshake resmi + pengukuran backend pengganti)** **VERIFIED 3/3 (F5-n22)** — bentuk firstN level-indeks; bentuk phase enc=A runtuh ke A (F2a membuktikan mekanismenya). **C (phase-specific routing)** VERIFIED untuk kanal plaintext (F2a: loss TCP via prefix-replay lintas backend DALAM SATU KONEKSI + UDP; ping/upctl/dn/up pada sesi plaintext via instrumen S2) — TIDAK mungkin untuk koneksi terenkripsi (opaque). **D (edge offload)** DITOLAK untuk CLI resmi. **E** tidak berlaku. | **VERIFIED** |
| 14 | Yang belum diketahui / tidak teruji? | (i) F2b (handshake→B, pengukuran→A), F5 titik lain (n=1,12,16,20,28), F7b cmd-level pada CLI, F8a/F8b/F8d (split loss TCP↔UDP), G1–G5 (injeksi kegagalan) — antre kuota; (ii) DNS flip tengah-run (F6) INCONCLUSIVE-by-instrument; (iii) F7c jawaban lokal/synthetic-responder NOT TESTED (di luar batas otorisasi divert pasif). | **terdokumentasi** |
| 15 | Keamanan & batas lab? | Non-publishing terverifikasi SEMUA run sesi-2 (`persisted:false` + blokir submission); CLI tidak dimodifikasi (sha cocok manifest, diverifikasi ulang sesi-2); licenseKey tidak dipalsukan (fetch live dengan query CLI sendiri); semua user-space loopback; binari vendor tidak di-commit; identitas perangkat disanitasi pada artifact commit. | **VERIFIED** |

## Rekomendasi arsitektur (menjawab master prompt §16/§18)

1. **Jalur kompatibilitas client resmi**: **A (VPS-only)** atau **B (split
   level-koneksi)** — keduanya kini TERVERIFIKASI. B memberi nilai praktis:
   daemon resmi menangani handshake/seleksi terenkripsi + identitas host,
   backend pengganti (SpeedtestServer TS) melayani beban pengukuran. Syarat
   keras: (i) loss-conn (`INITPLOSS`/`PLOSS`) dan UDP `LOSS` ke backend YANG
   SAMA; (ii) backend beban harus menjawab ERROR (atau menerima) hello
   terenkripsi yang dibawa CLI — ERROR → CLI fallback plaintext per koneksi
   (terverifikasi); (iii) kendali routing ada di tangan operator endpoint
   yang terdaftar sah — bukan pihak ketiga.
2. **Jalur produk custom** = hibrida VPS+Workers (di luar CLI resmi) —
   `speedtest-cli_analysis/hybrid-architecture/`.
3. **Cloudflare Workers TIDAK relevan untuk CLI resmi** di titik mana pun.

## Langkah selanjutnya

1. Jalankan antrean matriks saat kuota pulih: F8a (TCP→A, UDP→B — diskriminatif
   loss), F8b, F2b, F5-n28 (=F4-equivalent belahan dl↔ul), F5 titik lain,
   F7b, G3 (lihat `analysis/EXPERIMENT_MATRIX.md` + `AGENT_HANDOFF.md`).
2. Sinkronisasi dokumen selesai untuk F2a/F5-n22 (sesi-2); baris antrean
   diperbarui saat jalan.
3. Housekeeping repo: binari vendor 4-platform di root (STAGE1_REPO_AUDIT §1).
