# EXECUTIVE_CONCLUSION — jawaban atas pertanyaan riset diversion backend

> Basis: evidence terverifikasi sesi diversion-lab 2026-11-04 (C1, F0,
> validasi instrumen S1–S4) + evidence repo (gate 3/3, differential 103-probe,
> protocol contract rev-4). Keterbatasan kuota config API dibuka apa adanya
> (BACKEND_DIVERSION_RESULTS §0); klaim tidak pernah melebihi buktinya.

## Jawaban inti (satu paragraf)

**Ya — secara protokol, CLI resmi yang tidak dimodifikasi dapat melakukan
handshake awalnya ke backend resmi sementara operasi berikutnya dilayani
backend lain, dan batas diversion yang terbukti aman dari sisi protokol adalah
BATAS KONEKSI (per koneksi, dikelompokkan per fase), bukan batas perintah
dalam satu koneksi, dan bukan batas alamat/DNS.** Buktinya: (1) CLI tidak
pernah mengikat kesetiaan ke endpoint — alamat dikunci sekali dari dokumen
config dan tidak pernah di-resolve ulang; (2) setiap fase pengukuran berjalan
pada koneksi TCP terpisah yang murni satu-fase (peta sesi terverifikasi);
(3) satu-satunya state lintas-koneksi di server adalah UUID sesi yang
diumumkan ulang per koneksi (`HI <UUID>`) — sehingga backend mana pun dapat
melayani koneksi mana pun tanpa koordinasi; (4) diversion penuh ke backend
pengganti terverifikasi end-to-end (C1: exit 0, loss 0, volume cocok), dan
diversion penuh ke daemon resmi MELALUI middlebox juga utuh (F0: exit 0,
loss 0). Dua kualifikasi penting: (a) kanal packet-loss adalah satu-satunya
fase yang menyatukan TCP (`INITPLOSS`/`PLOSS`, selalu plaintext) dan UDP
(datagram `LOSS`) — keduanya harus berakhir di backend yang sama, jika tidak
akuntansi loss pecah (terverifikasi pada instrumen; uji diskriminatif pada
CLI = F8a/F8b, BLOCKED kuota); (b) jalur MASUKNYA diversion adalah dokumen
config — yang tidak bisa disintesis (licenseKey anti-tamper per-perangkat,
umur detik) — jadi diversion selalu membutuhkan config asli yang di-rewrite
padanya, dan itu hanya mungkin dalam lab ber otorisasi, bukan di jalur
produksi publik.

## Jawaban 15 pertanyaan riset (master prompt §2)

| # | Pertanyaan | Jawaban | Status |
|---|---|---|---|
| 1 | Koneksi/handshake pertama ke backend — koneksi mana, protokol apa? | 11–12 probe seleksi pendek (60 ms) ke `host:port` config: hello biner TERENKRIPSI; bila dijawab `ERROR` → fallback `HI`→`GETIP`→`PING`; probe pemenang menambah `HI <UUID>`+`PING×5`. | **VERIFIED** (C1, F0, gate-repo) |
| 2 | Kapan DNS pertama & perilaku resolusi? | Resolusi pertama = `cli.speedtest.net` (via proxy lab). Tidak ada resolusi lagi setelahnya; host pengukuran diambil dari config. IPv6-first (`::1`) untuk localhost. | **VERIFIED** |
| 3 | Bagaimana config engine didapat? | SATU GET `/api/cli/config?deviceId&hid&sid&uname` (HTTPS) per run; dilindungi licenseKey anti-tamper (kunci asing/usang → `InvalidLicenseKey`; exit 2). | **VERIFIED** |
| 4 | Bagaimana discovery/seleksi server? | CLI hanya menguji entri `servers[]` dari config (tidak ada discovery lain); probe semua kandidat (11 probe untuk 10 entri + winner), memilih hasil terbaik. | **VERIFIED** |
| 5 | Urutan negosiasi NetGauge? | ENC-hello → (ERROR →) `HI[ <UUID>]` → `GETIP` → `PING`; koneksi pengukuran: `HI <UUID>` → langsung `DOWNLOAD`/`UPLOAD`; loss: `HI <UUID>` → `INITPLOSS` → `PLOSS`×N. | **VERIFIED** |
| 6 | Berapa koneksi TCP & apakah di-reuse? | ±34 per run (11 zero-byte + 12 probe + 1 loss + 2 pingmon + 4 DL + 1 kontrol + 4 UL); TIDAK ada reuse lintas fase — tiap fase membuka koneksi sendiri (worker DL ≠ worker UL). | **VERIFIED** |
| 7 | Koneksi mana untuk fase mana? | Lihat MEASUREMENT_PHASE_MATRIX §1 — matriks lengkap per fase/perintah/transport. | **VERIFIED** |
| 8 | Kapan hasil dikirim? | Di AKHIR run (setelah PLOSS terakhir): CONNECT `results.speedtest.net` → POST; bila ditolak → `persisted:false`, exit 0 tetap. | **VERIFIED** |
| 9 | **Bisakah handshake→resmi + pengukuran→backend lain?** | **Ya secara protokol (lihat jawaban inti); boundary = per-koneksi/per-fase.** Verifikasi penuh pada CLI (F2a) BLOCKED oleh kuota config API di sesi ini — prediksi berbasis F0+C1+gate-repo: lulus (fallback plaintext tersedia per koneksi; UUID sesi portabel; kanal loss plaintext dapat dilayani backend mana pun). Risiko terbuka: apakah CLI menolak fallback setelah "belajar" enkripsi dari probe→daemon (F2a adalah eksperimen penentu). | **PARTIALLY VERIFIED** (arsitektur terverifikasi; skenario silang eksak menunggu kuota) |
| 10 | Apakah DNS/alamat di-resolve ulang antar fase? | TIDAK — satu fetch config, satu resolusi per koneksi ke host config; tidak ada indikasi re-binding. | **VERIFIED** (bukti negatif kuat) |
| 11 | Apakah transport Workers kompatibel? | TIDAK untuk CLI resmi: semua fase = TCP biner/NetGauge + UDP; Workers ingress HTTP/WS saja; sesi terenkripsi menutup routing per-perintah. | **VERIFIED (analitis + bukti protokol)** |
| 12 | Apakah payload besar bisa bypass VPS via edge? | Untuk CLI resmi: TIDAK ADA peran edge (jawaban #11). Payload besar (12–17 GB/run di lab) wajib melewati backend TCP penuh. | **VERIFIED** |
| 13 | Arsitektur yang didukung bukti? | **B (connection-level split)** didukung penuh oleh bukti protokol + instrumen; **C (protocol-aware split)** didukung untuk sesi plaintext (instrumen S2/S3; untested pada CLI); **A (full origin)** terverifikasi (C1/F0/gate-repo); **D (edge offload)** DITOLAK untuk CLI resmi; **E** tidak berlaku. | **VERIFIED** |
| 14 | Yang belum diketahui / tidak teruji? | (i) F2a–F8 pada CLI (kuota) — perintah siap; (ii) perilaku `packetLoss` CLI saat PLOSS-backend ≠ UDP-backend (F8a/F8b diskriminatif); (iii) apakah CLI menolak fallback setelah probe terenkripsi sukses (tercakup F2a); (iv) DNS flip tengah-run (butuh kontrol DNS — bukti tidak langsung menunjukkan tidak relevan). | **terdokumentasi** |
| 15 | Keamanan & batas lab? | Non-publishing terverifikasi semua run (`persisted:false` + blokir submission); CLI tidak dimodifikasi (sha cocok manifest); binari vendor tidak di-commit; semua user-space loopback; licenseKey tidak dipalsukan (pemalsuan = melampaui otorisasi — DILARANG oleh batas riset). | **VERIFIED** |

## Rekomendasi arsitektur (menjawab master prompt §16)

1. **Jalur kompatibilitas client resmi** = **VPS-only** (A) atau **split
   level-koneksi B** (handshake+seleksi di daemon resmi; beban di backend
   pengganti) — B terverifikasi aman secara protokol sepanjang: loss-conn
   (`INITPLOSS`/`PLOSS`) dan UDP `LOSS` dikirim ke backend YANG SAMA, dan
   backend beban menjawab fallback plaintext per koneksi.
2. **Jalur produk custom** = hibrida VPS+Workers (di luar CLI resmi) —
   lihat `speedtest-cli_analysis/hybrid-architecture/` repo.
3. **Cloudflare Workers TIDAK relevan untuk CLI resmi** di titik mana pun.

## Langkah selanjutnya (prioritas)

1. Jalankan F2a saat kuota pulih (perintah 1 baris — AGENT_HANDOFF §3),
   lalu F8a, F7b, F3, F5-sweep — masing-masing 1 fetch config.
2. ≥3 repetisi untuk F2a/F8a (master prompt §12).
3. Isi tabel BACKEND_DIVERSION_RESULTS dengan hasil run.
4. Pertimbangkan housekeeping repo: binari vendor 4-platform di root
   (STAGE1_REPO_AUDIT §1) — keluarkan dari git history bila memungkinkan.
