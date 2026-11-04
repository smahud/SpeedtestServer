# DNS_AND_IP_BEHAVIOR — perilaku DNS dan alamat tujuan (dalam batas lab)

> Metode lab: CLI diarahkan via proxy HTTP (CONNECT) + config rewrite; CLI
> TIDAK pernah meresolve nama host pengukuran sendiri dalam mode ini (host
> di config = `localhost:9090` → resolusi lokal oleh stack klien).
> Kontrol DNS penuh (flip A-record di tengah run) tidak dimungkinkan tanpa
> root di sandbox ini — batasan instrumen yang DILAPORKAN apa adanya, dengan
> substitusi observabel yang setara (lihat §3).

## 1. Apa yang teramati langsung

| Perilaku | Hasil | Bukti |
|---|---|---|
| Jumlah fetch config per run | **tepat 1** (tidak ada re-fetch antar fase, bahkan saat fase berjalan menit) | 1× `config_req` di SEMUA proxy log run (C1, F0, F2*…, dan semua evidence repo) |
| Alamat tujuan pengukuran | `host:port` dari ENTRI CONFIG (tidak dari DNS terpisah, tidak hard-coded) | semua 10 entri diarahkan ke `localhost:9090` → CLI menguji 9090 (diverter log) |
| Resolusi `localhost` | **IPv6 diprioritaskan** (`::1`) — semua koneksi klien datang dari `::1`/`::ffff:127.0.0.1` | diverter `conn_open.peer` |
| TCP dan UDP ke alamat yang sama | ya — entri `host:port` dipakai untuk koneksi TCP DAN datagram UDP (port sama) | diverter udp_map dari endpoint `::1:xxxxx` ke port 9090 |
| Perilaku A/AAAA/TTL | tidak teramati di jalur pengukuran (host = localhost); di jalur config, resolusi dilakukan PROXY (bukan CLI) — `cli.speedtest.net` → Cloudflare (A-only; AAAA CNAME tanpa alamat → tidak ada jalur IPv6) | `dig +short AAAA cli.speedtest.net` → CNAME tanpa AAAA |
| Re-resolusi antar fase | TIDAK ADA — alamat dikunci dari config saat seleksi; tidak ada operasi DNS di tengah run (proxy melihat semua koneksi CLI; hanya CONNECT config + blokir result yang lewat proxy; koneksi pengukuran langsung ke alamat config) | proxy.jsonl + diverter.jsonl semua run |

## 2. Konsekuensi diversion alamat (jawaban Eksperimen E/F6)

1. **Titik kendali alamat = dokumen config** (sekali di awal run). Karena CLI
   tidak pernah re-fetch atau re-resolve, mengubah alamat efektif server di
   tengah run TIDAK MUNGKIN lewat DNS — satu-satunya jendela adalah SEBELUM
   fetch config (rewrite proxy) — inilah yang dilakukan lab.
2. **Diversion level-DNS murni (flip A-record tengah-run) tidak teruji di
   sandbox ini** (butuh kontrol authoritative DNS + CLI meresolve nama remote;
   CLI di lab ini memakai `localhost` yang di-resolve via /etc/hosts).
   Karena bukti menunjukkan alamat dikunci dari config (bukan dari resolusi
   berulang), flip DNS pun hanya berdampak pada koneksi BARU yang resolve
   ulang — dan CLI tidak melakukan resolve ulang. Status F6: **INCONCLUSIVE
   secara eksperimen langsung; bukti tidak langsung (tidak ada re-resolusi)
   menunjukkan DNS bukan batas diversion yang berguna untuk CLI resmi**.
3. **GETIP tidak dipakai untuk validasi alamat**: `YOURIP` dijawab backend
   (melalui diverter menjawab `127.0.0.1`, tanpa diverter `::1`) — CLI
   melanjutkan tanpa peduli (kedua run F0/C1 exit 0) → tidak ada binding
   klien-ke-alamat-terlihat yang mematahkan diversion.

## 3. Substitusi observabel: pembelian alamat per koneksi

Karena DNS tidak bisa dibalik di tengah run, "re-binding alamat" diuji pada
lapisan yang setara dan terkontrol penuh — **diverter** (koneksinya tetap ke
`localhost:9090`, tetapi backend hulu berbeda per koneksi/perintah). Ini
mengisolasi pertanyaan riset dengan lebih presisi daripada flip DNS, karena
DNS hanyalah cara mendapat alamat; pertanyaan sesungguhnya adalah apakah
CLI mengikat kesetiaan ke sebuah ENDPOINT (alamat) atau ke SESI (protokol).
Jawaban matriks F: CLI mengikat ke sesi protokol (UUID), bukan ke endpoint —
diverter memindahkan backend di bawah satu alamat tanpa CLI menolak.

## 4. Catatan IPv4/IPv6

- CLI memilih `::1` untuk `localhost` (IPv6-first) — diverter dual-stack
  menerima; backend upstream diverter menggunakan `127.0.0.1` (IPv4) →
  GETIP melaporkan `127.0.0.1` pada run yang melewati diverter (vs `::1`
  pada run direct). CLI menerima keduanya (tidak ada validasi).
- Daemon resmi mendengar di `0.0.0.0` + `[::]`; STS dual-stack — keduanya
  kompatibel dengan jalur IPv4 diverter.
