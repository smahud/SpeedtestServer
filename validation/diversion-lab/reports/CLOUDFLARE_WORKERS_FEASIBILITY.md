# CLOUDFLARE_WORKERS_FEASIBILITY — kelayakan Cloudflare Workers sebagai backend diversion (Eksperimen H)

> Dievaluasi SETELAH matriks diversion lokal terjawab sebagian (F0/C1/F2*),
> sesuai urutan master prompt. Metode: analisis berbasis kontrak protokol
> TERVERIFIKASI (bukan deployment — lab tidak memiliki akun Workers; klaim
> platform dibatasi pada kemampuan produk yang terdokumentasi publik dan
> pada bukti empiris lab ini). Label per klaim: [V] terverifikasi lab,
# [P] bukti repo, [D] dokumentasi publik platform.

## 1. Kesimpulan singkat

| Skenario | Layak? | Alasan kunci |
|---|---|---|
| Workers sebagai **backend pengukuran penuh** untuk CLI resmi (F1-style) | ❌ **TIDAK** | CLI berbicara TCP biner/NetGauge ke `host:port` dari config — bukan HTTP. Workers hanya menerima ingress HTTP/HTTPS/WebSocket [D]. Tidak ada listener TCP mentah di Workers. |
| Workers sebagai **backend salah satu fase** (diversion level koneksi, F2–F5-style) | ❌ **TIDAK** | Alasan sama: SEMUA fase memakai transport yang sama (TCP NetGauge/terenkripsi + UDP loss). Tidak ada fase yang "lebih HTTP" dari yang lain — semuanya non-HTTP. |
| Workers sebagai **relay level-perintah** (F7b-style, bridge antar-backend) | ⚠️ **HANYA via WebSocket-to-TCP di origin** — bukan murni Workers | Bridge WS↔TCP membutuhkan origin (VPS) yang tetap memegang TCP; Workers hanya menjadi hop HTTP tambahan; untuk sesi TERENKRIPSI (F0) isi perintah tak bisa diurai/dirote tanpa memecahkan enkripsi engine [V] → routing level-perintah mustahil di sesi terenkripsi. |
| Workers untuk **UDP packet-loss** (F8-style) | ❌ **TIDAK** | Workers tidak punya ingress UDP [D]; protokol LOSS/RECV adalah datagram UDP [V]. |
| Workers untuk **config/selection** (endpoint pertama CLI) | ❌ **TIDAK** | `cli.speedtest.net` adalah layanan Ookla + licenseKey anti-tamper per-perangkat [V] — tidak bisa digantikan entity lain. |
| Workers untuk **klien buatan sendiri** (bukan CLI resmi) | ✅ ya | Di luar scope pertanyaan ini; preseden speed.cloudflare.com [D]; sudah dianalisis repo (`speedtest-cli_analysis/hybrid-architecture/`). |

## 2. Bukti per batas

1. **Transport pengukuran CLI resmi = TCP biner + UDP** [V]:
   - F0 (`evidence/f0-all-a/`): probe seleksi CLI memakai hello biner
     TERENKRIPSI yang DITERIMA daemon resmi — seluruh run (seleksi, download,
     upload, loss) berjalan di atas sesi terenkripsi itu (bukti: `analysis.json`
     — probe terenkripsi sukses, koneksi pengukuran tanpa fallback plaintext).
   - C1 (`evidence/c1-all-b/`): fallback plaintext NetGauge (`HI`/`PING`/
     `DOWNLOAD`/`UPLOAD` baris ASCII) — tetap TCP mentah, bukan HTTP.
   - Loss: datagram UDP `LOSS`/`RECV` [V] + PLOSS via TCP.
   → Tidak ada satu pun fase yang bisa diakhiri di ingress HTTP-only.

2. **Diversion yang TERBUKTI bekerja adalah antar dua backend TCP/UDP penuh**
   (diverter lab): level koneksi (firstN), level fase (phase-aware), level
   perintah (plaintext saja) — SEMUANYA mensyaratkan listener TCP (dan UDP
   untuk loss) di alamat yang diklaim config [V].

3. **Sesi terenkripsi menutup level-perintah** [V]: kunci AES per koneksi
   (kontrak protokol repo §2 "encrypted-binary engine protocol"); diverter
   tidak bisa mengurai/merote perintah individual di dalamnya (hanya memipa
   byte). Bridge HTTP apa pun menghadapi batas yang sama.

4. **Alamat dikunci dari config** [V]: CLI tidak re-resolve/re-fetch antar
   fase (laporan DNS_AND_IP_BEHAVIOR) → Workers hanya bisa masuk kalau
   menjadi `host:port` di config — dan host itu harus bicara protokol
   non-HTTP di port yang sama.

## 3. Batas analisis (jujur)

- Tidak ada deployment Workers nyata di lab ini (tanpa akun) — klaim
  kemampuan platform mengacu pada dokumentasi publik produk Workers
  (ingress HTTP/HTTPS/WS; tidak ada TCP/UDP listener inbound).
- Spectrum (proxy TCP Enterprise) TIDAK dievaluasi — produk berbeda,
  memerlukan kontrak Enterprise, dan tetap hanya meneruskan ke origin
  (bukan mengeksekusi kode Worker di jalur TCP).
- Upload-to-Workers (Worker menginisiasi TCP KELUAR ke backend) secara
  teknis bisa [D] — tetapi arah itu tidak membantu: CLI tidak pernah
  menghubungi Workers (Workers tidak ada di config CLI).

## 4. Pernyataan arsitektur final (menjawab opsi D master prompt)

**D (Edge offload) TIDAK didukung untuk CLI resmi.** Bukti empiris lab:
setiap jalur diversion yang berhasil membutuhkan backend TCP (+UDP) penuh di
alamat config. Workers hanya relevan untuk klien non-Ookla (jalur produk
terpisah — lihat KESIMPULAN-FINAL.md repo dan hybrid-architecture/).
