# MASTER PROMPT — LANJUTKAN SPEEDTEST SERVER + HYBRID CLOUDFLARE WORKERS FREE

**Versi prompt:** 2 (24 November 2026)
**Repository:** `smahud/SpeedtestServer` (branch `master`)
**VPS:** `speedtest.lumajangnetworks.my.id` → `45.126.249.250`
**Akses VPS:** UAEG (`smahudd/uaeg`)
**Spesifikasi utama:** `docs/SPEEDTEST_HYBRID_CLOUDFLARE_FREE.md`. Pastikan Anda membaca **versi 2** dokumen itu: baris ketiganya memuat teks "Versi 2 — 24 November 2026". Jika yang Anda temukan masih versi lama (basis `master@8912b07`), jalankan `git fetch` dulu. Jika versi 2 tetap tidak ada, laporkan ke operator sebelum lanjut.

---

## 0. Cara membaca prompt ini

1. Prompt ini adalah aturan kerja. Bila ada pertentangan, ikuti urutan prioritas berikut:
   1. Invariant dan larangan di §3 prompt ini.
   2. Kondisi aktual VPS dan Cloudflare yang Anda verifikasi sendiri.
   3. Kode dan evidence di `master` terbaru.
   4. `docs/SPEEDTEST_HYBRID_CLOUDFLARE_FREE.md` (versi 2).
   5. Dokumen lama: `hybrid/reports/*`, `hybrid/worker/DEPLOY.md`, `validation/HANDOFF.md`, dan README bagian hybrid.
2. Semua fakta di §2 adalah **kondisi terdokumentasi per 24 November 2026**. Fakta itu dipakai untuk mengarahkan pemeriksaan. Jangan memperlakukannya sebagai kebenaran sebelum Anda memverifikasinya di VPS.
3. Tugas ini mencakup produksi yang sedang melayani tes Ookla dan layanan lain. Bila ragu apakah sebuah langkah berisiko, anggap berisiko. Berhenti di titik STOP (§11).

---

## 1. Misi

Lanjutkan pekerjaan yang sudah ada, jangan mulai dari nol. Ada dua jalur kerja dan keduanya harus dijaga:

- **Jalur A — Speedtest Server Ookla di VPS.** Server ini sudah berjalan dan harus tetap lulus `speedtest.net/host-tester` untuk host terdaftar `speedtest.lumajangnetworks.my.id:8080`.
- **Jalur B — Hybrid Cloudflare Workers Free.** Ini mode pengukuran untuk client milik sendiri. Payload download/upload ditangani Worker di hostname terpisah. VPS hanya melayani kontrol, token, ping, dan penerimaan hasil.

Jalur B **tidak boleh** mengubah perilaku Jalur A. Host tester resmi menguji Jalur A. Worker bukan host Ookla. Worker tidak didaftarkan ke Ookla dan tidak bisa lulus host tester resmi. Alasan teknisnya ada di §2.4 dan di dokumen spesifikasi §2.

---

## 2. Fakta awal (terdokumentasi — WAJIB diverifikasi)

### 2.1 Layout VPS

| Komponen | Kondisi terdokumentasi | Sumber |
|---|---|---|
| Source build di VPS | `/opt/SpeedtestServer-src`, Node.js 24.22.3. **Belum diketahui** apakah ini git checkout dan di commit mana. | `validation/DEPLOYMENT_WILDCARD_2026-11-23.md` |
| Runtime | `/opt/speedtestserver/dist`. Konfigurasi di `/etc/speedtestserver/OoklaServer.properties`. | idem, `install.sh` |
| `speedtestserver.service` | Daemon TypeScript. Melayani TCP+UDP **5060** dan **8080**, dengan TLS, HTTP, WebSocket, dan NetGauge di port yang sama. | `README.md`, validation 11-23 |
| `speedtestserver-legacy.service` | Fallback HTTP/PHP legacy di port **80**. | `config/speedtestserver-legacy.service` |
| `layanan-lain.service` | Layanan lain milik operator, bukan bagian proyek ini. Port **8081/8443**, plus redirect **443** (`REDIRECT_PORT_443=1`). PID 1268 tercatat tidak berubah sampai deploy ketiga tanggal 23 Nov. Untuk deploy keempat dan kelima, PID tidak dicatat. | `validation/evidence/deploy-wildcard-20261123/runtime-state.json` |
| `ookla-capture.service` | tcpdump port 80/5060/8080 ke `/var/lib/ookla-capture/hosttester.pcapNN` (ring 20 × 100 MB). | `validation/OBSERVABILITY_AND_LEGACY_FIX_2026-11-23.md` |
| Evidence log daemon | `/var/lib/speedtestserver/evidence.jsonl` | idem |
| Sertifikat | Wildcard publik `*.lumajangnetworks.my.id`. Hampir pasti dipasang sebagai pasangan cert/key custom, bukan lewat ACME repo. Issuer, expiry, dan pemilik renewal **tidak terdokumentasi**. | `validation/REINVESTIGATION_2026-11-23.md` |
| Snapshot rollback | `/root/speedtestserver-rollback/` berisi `earlyanswer-1795452701` (terbaru), `obs-1795450142`, `max-upload-E64ODq`, `http-parity-eBSdzq`, `wildcard-L1N4cl`. | validation 11-23/24 |
| Port sementara lab | 8090 (daemon referensi) dan 18092 pernah dipakai. Tidak tercatat apakah sudah dimatikan. | idem |

Kode TypeScript server di `master` identik dengan commit `f1ed207` (deploy terakhir 23 Nov 23:51 WIB). Build `master` seharusnya menghasilkan `dist` yang sama dengan runtime, tetapi checksum pasca-deploy terakhir tidak tercatat.

### 2.2 Status host tester (Jalur A)

- Hasil host tester resmi terakhir yang dilaporkan operator (23 Nov, ±23:22 WIB): semua check lulus **kecuali `max_upload`**. Penyebabnya timeout PHP curl 10 detik pada jalur upload yang lambat.
- Perbaikan "slow-upload early answer" sudah di-deploy pukul ±23:51 WIB. Setelah itu **belum ada run hosted ulang yang tercatat**, jadi status `max_upload` resmi saat ini **belum diketahui**.
- Hasil clone independen (hasil ini **bukan** verdict Ookla):
  - Setelah early answer: gate publik `check-http-compatibility.py` 31/31 dan z.ai 10/10.
  - Clone chatgpt 19/19 terakhir tercatat pukul 20:01 WIB, **sebelum** deploy keempat dan kelima. Run itu memakai `legacy_port` default 80. Belum pernah ada run dengan `--legacy-port 8080`.
- Halaman `speedtest.net/host-tester` dilindungi verifikasi manusia (CAPTCHA). **Agent tidak bisa dan tidak boleh mengotomasinya.** Operator yang menjalankannya. Agent menyiapkan server, lalu menganalisis capture sesudahnya (§5 Fase 7).
- Capture repo menunjukkan host tester resmi hanya memakai **port 8080**. Check-nya: `/hi` HTTP; NetGauge TCP mentah (`HI`, `SERVERID`, `GETIP`); WebSocket `/ws`; crossdomain (HTTP/1.0); TLS di 8080; `latency.txt`; POST `upload.php` 515.699 B dan 1.980.899 B; HEAD 10 file `random*.jpg`; keep-alive.
- Discovery CLI resmi `--host speedtest.lumajangnetworks.my.id` mengembalikan `NoServersException`. Status registrasi dan visibilitas di Ookla berada di luar kode server. Jangan mencoba "memperbaikinya" lewat kode.

### 2.3 Status Hybrid (Jalur B)

- **Implementasi sudah ada di `master`.** Komponennya:
  - `hybrid/worker`: Worker TypeScript. Endpoint `/ws` (NetGauge-over-WSS), `/__down?bytes=N`, `POST /__up`, `/__meta`, dan salinan permukaan HTTP legacy.
  - `hybrid/gateway/src/gateway.mjs`: control plane di VPS. Endpoint `/api/servers`, `/api/sessions`, `/api/ping`, `/api/results`, `/api/health`.
  - `hybrid/probe-client`: client sesi hybrid.
  - `hybrid/lab`: harness dan evidence E-A sampai E-I.
  - Token: HMAC-SHA256 dengan shared secret `HYBRID_SHARED_SECRET`, format `v1~guid~expMs~ip~sig`.
- **Jangan membuat implementasi kedua** (misalnya `hybrid/edge`) dan jangan mengganti token ke Ed25519 untuk pilot. Dokumen versi 1 menyarankan keduanya karena ditulis sebelum `hybrid/` di-merge ke `master` (23 Nov). Kontrak yang berlaku adalah kontrak v1 di dokumen spesifikasi versi 2 §3.
- **Worker belum pernah di-deploy ke akun Cloudflare nyata.** Semua klaim (62/62 conformance, E-G 10/10, offload 1:16.000) hanya berasal dari lab lokal `wrangler dev`/workerd.
- `hybrid/worker/DEPLOY.md` versi lama menganggap **Workers Paid** sebagai asumsi produksi. Di Free (10 ms CPU per invocation), risikonya:
  - batas default ~2 GiB per perintah;
  - pembuatan pool 2 MiB dengan loop JS;
  - stream tanpa backpressure.

  Ketiganya sangat mungkin melampaui CPU atau memori. Pilihan transport dan ukuran chunk **harus ditentukan dari pengukuran di edge nyata**.
- Masalah yang sudah diketahui dan harus diselesaikan sebelum produksi:
  1. Gateway mengikat token ke IP socket. Di belakang proxy atau tunnel, atau pada client dual-stack (IPv4 ke VPS, IPv6 ke Cloudflare), semua token ditolak dengan `ip-mismatch`.
  2. Gateway hanya bind `127.0.0.1:8090` lewat HTTP biasa. Belum ada TLS, CORS, unit systemd, maupun deduplikasi hasil.
  3. Discovery gateway masih mengiklankan fallback STS `/ws` ke VPS. Ini bertentangan dengan aturan "tidak ada fallback massal ke VPS".
  4. Permukaan HTTP legacy Worker (`random*.jpg`, `upload.php`) **tidak dilindungi token**. Siapa pun bisa menghabiskan kuota harian.
  5. `test/token-tests.mjs` meng-hardcode secret `testsecret123` dan IP `127.0.0.1`. `test/run-tests.sh` meng-hardcode path wrangler `/home/z/...`.
  6. Klaim E-G di `hybrid/reports` perlu dikoreksi. Tester yang dipakai adalah z.ai v1.0.1, bukan v1.1.0. Upload berjalan lewat `upload.php` (213 POST), bukan WS UPLOAD. Tes itu memakai front lokal yang menyajikan TLS dan HTTP di satu port, sehingga hasilnya tidak bisa direproduksi di hostname Cloudflare nyata.

### 2.4 Mengapa hostname terdaftar tidak boleh lewat Cloudflare

Jika `speedtest.lumajangnetworks.my.id` dijadikan proxied (oranye), check host tester berikut pasti gagal:

- Edge Cloudflare membalas byte NetGauge TCP mentah dengan HTTP 400.
- Port 8080 pada proxy Cloudflare hanya HTTP, sehingga TLS di 8080 gagal.
- UDP (packet loss) dan ICMP tidak diteruskan.

CLI Ookla resmi juga tidak bisa memakai endpoint Cloudflare (eksperimen E-D/E-E: `Did not receive HELLO`, lalu `NoServers`).

### 2.5 Hal yang belum diketahui (harus Anda temukan, bukan diasumsikan)

- Cara akses UAEG dan batas kemampuannya. Baca dokumentasi `smahudd/uaeg`. Evidence lama menunjukkan agent sebelumnya menjalankan perintah lewat tool remote bergaya JSON-RPC/MCP.
- Apakah `/opt/SpeedtestServer-src` adalah git checkout, di commit mana, dan apakah ada perubahan yang belum di-commit atau `git stash`.
- Aturan firewall aktual (nftables/iptables/ufw atau firewall provider) dan target redirect 443 milik layanan lain.
- Apakah zona `lumajangnetworks.my.id` aktif di Cloudflare (nameserver Cloudflare) atau di DNS lain. Ini menentukan apakah Custom Domain Worker bisa dipakai.
- Issuer dan tanggal kedaluwarsa sertifikat wildcard, serta path file cert/key di `OoklaServer.properties`.
- Apakah akun Cloudflare sudah punya subdomain `workers.dev`.

---

## 3. Invariant dan larangan keras

Melanggar salah satu poin ini dianggap kegagalan tugas, meskipun tujuan lain tercapai.

1. **DNS `speedtest.lumajangnetworks.my.id` tetap DNS-only (abu-abu) dan menunjuk ke `45.126.249.250`.** Jangan ubah record ini, record apex, atau record wildcard yang sudah ada. Jangan pasang Worker Route, Custom Domain, Page Rule, atau proxy pada hostname tersebut.
2. **Jangan ubah nameserver zona, mode SSL/TLS zona, atau pengaturan level zona/akun Cloudflare** (Always Use HTTPS, HSTS, WAF global, dan sejenisnya). Satu-satunya perubahan Cloudflare yang boleh dilakukan tercantum di §7.
3. **Port 80, 443, 5060, 8080, 8081, dan 8443 (TCP/UDP) bukan untuk Jalur B.** Jangan bind, redirect, atau proxy port tersebut. Jangan sentuh layanan lain, konfigurasinya, `REDIRECT_PORT_*`, maupun rule redirect-nya.
4. **Jalur B tidak menyentuh `/opt/speedtestserver/dist`, `speedtestserver.service`, `speedtestserver-legacy.service`, maupun `OoklaServer.properties`.** Perubahan pada Jalur A hanya boleh dilakukan untuk memperbaiki kegagalan host tester yang terbukti. Perubahan itu wajib mengikuti prosedur isolasi di §8.
5. **Jangan jalankan ulang `install.sh` atau `install-legacy.sh` penuh di VPS.** `install.sh` melakukan `rsync --delete` pada `dist`, menimpa unit systemd, dan membuka listener sementara 18080. `install-legacy.sh` me-restart layanan legacy.
6. **Jangan aktifkan ACME/Let's Encrypt** (`OoklaServer.ssl.useLetsEncrypt`). Fitur ini memakai HTTP-01 di port 80 yang dipakai layanan legacy, dan tidak bisa menerbitkan sertifikat wildcard.
7. **Jangan hentikan atau ubah `ookla-capture.service`** tanpa persetujuan operator.
8. **Jangan otomasi, bypass, atau mengakali CAPTCHA** `speedtest.net/host-tester`. Jangan pula mengirim hasil ke `results.speedtest.net` dari tes paksa (forced endpoint).
9. **Jangan menulis credential** (PAT, API key/token Cloudflare, `HYBRID_SHARED_SECRET`, private key) ke repo, dokumen, commit, log, output perintah, atau history shell. Jangan jalankan `set -x` saat credential ada di environment.
10. **Git: jangan `reset --hard`, `clean`, `push --force`, `checkout --` pada file yang berubah, atau `stash drop`.** Jangan push kecuali operator memerintahkannya secara eksplisit di sesi ini (lihat §6).
11. **Jangan habiskan kuota Workers Free.** Batas pemakaian uji adalah 20.000 invocation per hari UTC. Hentikan uji beban bila mendekati batas itu. Kegagalan karena kuota (1027/429) hanya disimulasikan di sisi client dengan respons tiruan. **Jangan pernah** menghabiskan kuota akun nyata, karena semua Worker di akun akan mati sampai 00:00 UTC.
12. **Jangan jalankan `hybrid/lab/harness/run-hybrid-lab.sh` (atau harness lab lain) di VPS dalam bentuk aslinya.** Script itu menyalakan daemon lab di TCP+UDP 8080 (port produksi), gateway di 8090, dan menulis ke `hybrid/lab/evidence/` sehingga menimpa evidence E-I. Jalankan di mesin non-produksi, atau di VPS hanya setelah port dan direktori output diparameterkan (misalnya 18080/18090 dan direktori sementara).
13. **Jangan menambah rule nftables/iptables** (termasuk rule counter) tanpa persetujuan operator.

---

## 4. Target dan definisi selesai

Gunakan label status ini secara konsisten di laporan dan dokumentasi:

- **IMPLEMENTED**: kode ada di repo dan lulus tes lokal.
- **DEPLOYED**: berjalan di VPS atau Cloudflare, dengan bukti versi atau hash.
- **VERIFIED-AUTO**: lulus pemeriksaan otomatis Anda terhadap endpoint publik.
- **VERIFIED-OPERATOR**: operator menjalankan host tester resmi dan memberikan hasilnya.
- **NOT TESTED** / **BLOCKED (alasan)**.

| # | Kriteria | Status minimum untuk menyatakan selesai |
|---|---|---|
| A1 | Layanan existing (speedtestserver, legacy, layanan lain, capture) tetap aktif. PID layanan lain tidak berubah. Tidak ada restart yang tidak direncanakan. | VERIFIED-AUTO |
| A2 | `check-http-compatibility.py` 31/31 dan `host-tester-check.py` (chatgpt) lulus untuk `speedtest.lumajangnetworks.my.id:8080`, dengan **dua varian**: default (`--legacy-port 80`, pembanding historis) dan `--legacy-port 8080` (mendekati tester resmi). Hasil ini dibandingkan dengan baseline Fase 1. | VERIFIED-AUTO |
| A3 | Host tester resmi lulus semua check, termasuk `max_upload`. | VERIFIED-OPERATOR. Jika operator belum menjalankannya, tulis NOT TESTED. **Jangan** tulis Passed. |
| B1 | Worker di-deploy ke Workers Free (pilot di `workers.dev`). Versi, compatibility date, dan URL tercatat. | DEPLOYED |
| B2 | Pengukuran CPU dan invocation di edge nyata untuk setiap endpoint dan ukuran chunk. Batas `MAX_*` dan transport utama dipilih dari data itu. | VERIFIED-AUTO, dengan evidence di `hybrid/lab/evidence/e-j-real-edge/` |
| B3 | Gateway berjalan di VPS sebagai unit systemd terpisah, di port yang aman, dengan TLS publik valid. Masalah binding IP token sudah diperbaiki. | DEPLOYED |
| B4 | Sesi end-to-end dari client eksternal berjalan: token, ping VPS, transfer di edge, hasil tersimpan. Atribusi byte membuktikan VPS hanya melihat lalu lintas kontrol (counter interface VPS dan counter gateway dibandingkan dengan byte Worker/client). | VERIFIED-AUTO |
| B5 | Uji negatif token (hilang, rusak, kedaluwarsa, salah secret) ditolak di edge nyata. Endpoint legacy Worker tidak terbuka tanpa token di produksi. | VERIFIED-AUTO |
| C1 | Dokumentasi di `docs/` lengkap (§9), sehingga agent lain bisa deploy ulang tanpa investigasi ulang. | IMPLEMENTED |
| C2 | Commit lokal tersimpan di VPS, tanpa push. | IMPLEMENTED |

B1–B5 baru bisa dikerjakan setelah credential Cloudflare tersedia. Kerjakan dulu semua yang tidak butuh credential: hardening kode, tes lokal, gateway lokal, dan dokumentasi. Setelah itu tandai sisanya **BLOCKED (menunggu credential Cloudflare)**.

---

## 5. Fase kerja dan gate

Setiap fase punya output tertulis. Jangan lanjut ke fase berikutnya sebelum gate fase saat ini terpenuhi.

### Fase 0 — Akses dan snapshot keselamatan (read-only)

1. Baca dokumentasi UAEG dan gunakan metode akses paling sederhana yang disediakan. Jangan memasang SSH key permanen, agent, atau backdoor, dan jangan mengubah `sshd`.
2. Laporkan secara eksplisit: status koneksi UAEG, `hostname`, `whoami`, `uptime`, `date` (UTC dan WIB), serta OS (`/etc/os-release`).
3. Rekam baseline tanpa mengubah apa pun. Simpan di luar repo, misalnya `/root/speedtest-hybrid-work/baseline-<UTC>/`:
   - `systemctl status speedtestserver speedtestserver-legacy layanan-lain ookla-capture`
   - `systemctl show -p MainPID,NRestarts,ActiveState` untuk keempat unit
   - `ss -ltnup`
   - `nft list ruleset` (atau iptables/ufw yang dipakai)
   - `df -h`
   - `free -m`
   - `node -v`
   - sha256 seluruh `/opt/speedtestserver/dist`
   - salinan `OoklaServer.properties` (jangan salin isi private key; catat path cert/key saja)
   - `openssl x509 -noout -issuer -enddate` untuk sertifikat yang dipakai

**Gate 0:** koneksi terkonfirmasi dan baseline tersimpan.

### Fase 1 — Recon repo dan VPS

1. Di `/opt/SpeedtestServer-src`, jalankan `git status`, `git stash list`, `git log --oneline -15`, `git remote -v`, `git branch -a`, dan `git fetch origin`. Bandingkan dengan `origin/master`.
   - Jika direktori ini **bukan** repo git, jangan menghapus atau menimpanya. Buat clone baru di `/opt/SpeedtestServer-git` dan dokumentasikan keputusan itu.
2. Baca berurutan:
   - `docs/SPEEDTEST_HYBRID_CLOUDFLARE_FREE.md` (versi 2)
   - `hybrid/README.md`
   - `hybrid/worker/DEPLOY.md`
   - `hybrid/reports/WORKERS_LIMITS.md`
   - `validation/SLOW_UPLOAD_EARLY_ANSWER_2026-11-24.md`
   - `validation/OBSERVABILITY_AND_LEGACY_FIX_2026-11-23.md`
   - `validation/HTTP_COMPATIBILITY_REPAIR_2026-11-23.md`
   - `validation/DEPLOYMENT_WILDCARD_2026-11-23.md`
3. Build `master` di direktori sementara (jangan di runtime), lalu bandingkan sha256 `dist` hasil build dengan `/opt/speedtestserver/dist`. Catat jika identik atau berbeda. Jika berbeda, jangan deploy apa pun ke Jalur A sebelum perbedaannya dijelaskan.
4. Jalankan gate otomatis Jalur A sebagai **baseline**, dari luar VPS bila memungkinkan, atau dari VPS dengan DNS publik.
   - Clone `smahud/SpeedtestHost-Tester` di samping repo, di luar direktori runtime. Clone ini hanya dibaca, tidak diubah.
   - User-Agent bawaan script sudah bisa dibedakan dari tester resmi (`SpeedtestServerReferenceParity/1` dan `ChatGPTHostTester/1.0`). Catat jam setiap run (UTC dan WIB).
   ```
   python3 validation/harness/check-http-compatibility.py --host speedtest.lumajangnetworks.my.id
   python3 validation/harness/host-tester-check.py --tester-dir ../SpeedtestHost-Tester/chatgpt \
     --host speedtest.lumajangnetworks.my.id:8080
   python3 validation/harness/host-tester-check.py --tester-dir ../SpeedtestHost-Tester/chatgpt \
     --host speedtest.lumajangnetworks.my.id:8080 --legacy-port 8080
   ```
   Jika baseline **sudah gagal** sebelum Anda mengubah apa pun, catat sebagai temuan awal (bukan regresi Anda) dan analisis penyebabnya. Perbaikan hanya boleh lewat prosedur §8. Jangan lanjut ke deploy Jalur B sebelum operator mengetahui temuan itu.

**Gate 1:** laporan recon tertulis berisi commit VPS, status working tree, hasil perbandingan hash, dan baseline A2 untuk kedua varian.

### Fase 2 — Gap analysis (tulis dulu, baru coding)

Buat `docs/HYBRID_STATUS.md`. Untuk setiap requirement di dokumen spesifikasi §7 dan setiap kriteria A1–C2, tuliskan: status saat ini, bukti, perubahan minimum yang dibutuhkan, dan siapa yang menjalankannya (agent atau operator). Gunakan daftar celah G-1–G-12 di dokumen spesifikasi §3.3 dan langkah di §6 sebagai titik awal, bukan daftar Anda sendiri dari nol.

**Gate 2:** `docs/HYBRID_STATUS.md` ada dan sudah di-commit lokal.

### Fase 3 — Hardening kode hybrid (tanpa credential)

Kerjakan di `hybrid/` saja. Pertahankan semua tes yang ada; tambahkan tes untuk setiap perubahan. Urutan prioritas:

1. Gateway:
   - Perbaiki binding IP token. Default-nya mint dengan `ip='*'`, yang sudah didukung verifier, plus TTL 5 menit. Atau baca header forwarded hanya dari proxy tepercaya.
   - Tambahkan env bind-host dan opsi listener TLS (path cert/key lewat env).
   - Hapus fallback STS dari discovery, atau jadikan opt-in.
   - Tambahkan deduplikasi hasil per `guid`.
   - Tambahkan CORS hanya bila client browser memang dibuat.
2. Worker:
   - Batas `MAX_DOWNLOAD_BYTES`/`MAX_UPLOAD_BYTES` untuk Free di `[vars]`. Nilai awalnya 16–25 MiB; final mengikuti Fase 4.
   - Cek `Content-Length` lebih awal dan tolak upload di atas batas.
   - Stream download berbasis `pull()` (backpressure) dan `FixedLengthStream`.
   - `Cache-Control: no-store, no-transform`.
   - Terima `Authorization: Bearer`.
   - Pembuatan pool yang lebih murah CPU.
   - Kurangi log per perintah.
   - Flag env `LEGACY_HTTP_ENABLED` untuk permukaan HTTP legacy. Default di kode **`false`**. Tes lokal dan Worker uji men-set `true`.
   - Stream berhenti saat client membatalkan. Disconnect upload dicatat sebagai transfer gagal. Payload tetap sulit dikompresi. Hindari buffer acak besar per request.
   - `workers_dev = true` dan `preview_urls = false` untuk pilot.
3. Tes:
   - Parameterkan secret dan IP di `token-tests.mjs` lewat env.
   - `run-tests.sh` memakai `npx wrangler` secara default.
   - Parameterkan port dan direktori output `hybrid/lab/harness/run-hybrid-lab.sh` (lihat §3 poin 12).
   - Tambahkan cek untuk batas, Bearer, dan flag legacy.
   - Evidence baru disimpan sebagai `.jsonl`/`.json`/`.txt`, karena `.gitignore` root mengabaikan `*.log`.
4. Probe client:
   - Tambahkan mode HTTP `__down`/`__up` per chunk.
   - Simpan receipt dari Worker (`{bytes}` dan `OK n`).
   - Simpan output evidence JSON.
5. Tambahkan template unit systemd dan contoh env file **tanpa secret**, misalnya:
   - `hybrid/gateway/speedtest-hybrid-gateway.service.example`
   - `hybrid/gateway/gateway.env.example`

Alias endpoint `/v1/*` dan `/api/v1/*` bersifat **opsional**. Buat hanya jika client browser memang dikerjakan. Ed25519/JOSE, receipt bertanda tangan, dan halaman hasil publik `/r/<id>` berada di luar MVP. Catat sebagai pekerjaan lanjutan kecuali operator memintanya.

**Gate 3:** conformance Worker lokal dan token tests lulus. Sesi lab lokal (`run-hybrid-lab.sh` yang sudah diparameterkan, di port non-produksi) lulus. Commit lokal dibuat per topik.

### Fase 4 — Deploy Worker ke Cloudflare Free (butuh credential)

Minta credential **hanya saat Fase 3 selesai**. Ikuti §7.

1. Inventaris read-only: `wrangler whoami`, daftar zona, status zona `lumajangnetworks.my.id`, ekspor semua record DNS zona ke file backup di luar repo, daftar Worker dan route yang sudah ada, serta subdomain `workers.dev`.
2. Deploy pertama sebagai **Worker uji terpisah** (misalnya `[env.test]` dengan nama `speedtest-hybrid-worker-test`) dalam open mode. Isi `[env.test.vars]` dengan `LEGACY_HTTP_ENABLED = "true"` dan cap `33554432` (32 MiB). Cap ini cukup untuk conformance (25.000.000 byte) dan untuk pengukuran 32 MiB. Jalankan `conformance.mjs` terhadap URL `workers.dev`-nya.
3. Ukur CPU time dan error per invocation dengan Workers Analytics atau `wrangler tail` (JSON) untuk:
   - cold start pembuatan pool;
   - `__down` 1/4/16/25 MiB;
   - `__up` 4/16/25 MiB;
   - WS DOWNLOAD 4/8/32 MiB;
   - WS UPLOAD.

   Catat setiap error CPU-exceeded, 1102, 1027, 429, atau 413. Tentukan batas `MAX_*` dan transport utama untuk Free dari data ini. Simpan bukti di `hybrid/lab/evidence/e-j-real-edge/`.
4. Deploy Worker produksi (`speedtest-hybrid-worker`): set secret lewat stdin (`wrangler secret put HYBRID_SHARED_SECRET`), legacy off, batas hasil Fase 4.3. Jalankan uji token positif dan negatif terhadap URL produksi.
5. **Wajib:** setelah pengukuran selesai, hapus Worker uji (`wrangler delete --env test`) atau matikan URL-nya (`workers_dev = false`, lalu deploy ulang). Worker uji tanpa token dan dengan legacy aktif yang dibiarkan terbuka bisa dipakai siapa saja untuk menghabiskan kuota akun.
6. Custom Domain (misalnya `bandwidth.lumajangnetworks.my.id`) **bukan bagian pilot**. Kerjakan hanya jika zona aktif di Cloudflare **dan** operator menyetujuinya (titik STOP).

**Gate 4:** URL Worker produksi tercatat dan B1, B2, serta B5 terpenuhi.

### Fase 5 — Deploy gateway di VPS

1. Pilih port yang bebas: cek `ss -ltnup`, nftables, dan port lab 8090/18092. Port publik gateway tidak boleh salah satu dari port terlarang di §3.
   - Jika membuka port baru membutuhkan perubahan firewall, siapkan perubahannya lalu **STOP** dan minta persetujuan operator.
   - Jika tidak ada firewall yang menghalangi, tetap laporkan bahwa ada port publik baru.
2. TLS gateway memakai sertifikat wildcard yang sudah ada (baca-saja; jangan memindah atau mengubah file cert/key). Akses dengan URL `https://speedtest.lumajangnetworks.my.id:<PORT>`. Tidak perlu record DNS baru.
3. Pasang file runtime di lokasi terpisah dari runtime Ookla, misalnya `/opt/speedtest-hybrid/gateway/`.
   - Unit: `speedtest-hybrid-gateway.service`.
   - `EnvironmentFile=/etc/speedtest-hybrid/gateway.env` dengan mode 0600.
   - State di `/var/lib/speedtest-hybrid/`.
   - Pakai user non-root yang bisa membaca cert, atau `LoadCredential=`.
4. Verifikasi:
   - `/api/health` dan `/api/ping` dari luar dengan TLS ketat.
   - PID speedtestserver, legacy, layanan lain, dan capture tidak berubah.
   - Gate A2 diulang dan tetap lulus.

**Gate 5:** B3 terpenuhi dan A1/A2 tetap lulus.

### Fase 6 — End-to-end dan atribusi byte

1. Dari client eksternal (bukan VPS), jalankan probe client dengan `HYBRID_GATEWAY_BASE` dan `HYBRID_WORKER_BASE` produksi. Jalankan mode HTTP-chunk dan mode WS bila keduanya diizinkan oleh hasil Fase 4.
2. Pada jendela waktu yang terisolasi, catat:
   - delta counter interface VPS (`/sys/class/net/<if>/statistics/{rx,tx}_bytes`). Counter nftables per port hanya boleh dipakai dengan persetujuan operator (§3 poin 13);
   - counter `/api/health` gateway;
   - receipt Worker;
   - byte yang dihitung client.
3. Ulangi dari jaringan dual-stack (IPv4 dan IPv6) untuk membuktikan masalah binding IP sudah selesai.

**Gate 6:** B4 terpenuhi, dengan evidence JSON di repo.

### Fase 7 — Host tester resmi (dijalankan operator)

1. Pastikan A1 dan A2 lulus. `ookla-capture` harus aktif dan ruang disk cukup.
2. Minta operator menjalankan `https://www.speedtest.net/host-tester` untuk `speedtest.lumajangnetworks.my.id:8080`. Minta operator mencatat jam mulai (WIB), menyimpan hasil lengkap per check (teks atau screenshot), lalu mengirimkannya ke Anda.
3. **Jangan jalankan tes apa pun ke VPS selama jendela run operator.** Sumber lalu lintas agent dan tester bisa sama-sama terlihat sebagai `45.126.249.249` karena NAT. Kenali flow tester dari User-Agent (`Firefox/2.0.0.3` untuk HTTP, `websocket-client-php` untuk WebSocket).
4. Segera setelah run operator selesai, **salin** file `hosttester.pcapNN` yang relevan ke direktori kerja di luar ring, sebelum menjalankan gate atau speed test apa pun. Ring capture 20 × 100 MB bisa tertimpa dengan cepat.
5. Analisis:
   - pcap dengan `validation/harness/inspect-upload-pcap.py`;
   - `/var/lib/speedtestserver/evidence.jsonl` (cari `http_upload_early_response`);
   - `journalctl -u speedtestserver -u speedtestserver-legacy`.

   Perhatikan risiko yang sudah diketahui: socket ditutup 30 ms setelah early answer. Ini bisa memicu reset pada PHP curl di jalur lambat.
6. Jika ada check yang gagal, perbaiki di Jalur A dengan prosedur §8, lalu minta operator menjalankan ulang.

**Gate 7:** A3 berstatus VERIFIED-OPERATOR, atau NOT TESTED disertai alasan.

### Fase 8 — Dokumentasi dan handover

Lengkapi dokumen sesuai §9. Commit lokal. Jalankan `git status` akhir. Tulis laporan akhir sesuai §10.

---

## 6. Workflow Git

1. Repository sumber adalah `master` di GitHub. Repo ini publik, jadi `git fetch` tidak membutuhkan PAT. Gunakan PAT **hanya** jika fetch gagal karena autentikasi. Masukkan PAT lewat `GIT_ASKPASS` atau credential helper sementara. **Jangan** menaruhnya di URL remote atau di `.git/config`. Hapus setelah selesai.
2. Sebelum mulai:
   - Jika working tree bersih dan tertinggal dari `origin/master`, jalankan `git merge --ff-only origin/master`.
   - Jika ada perubahan yang belum di-commit, **amankan dulu**:
     1. Periksa diff-nya lebih dulu untuk secret, file `.env`, key, pcap, dan file besar. File seperti itu tidak di-commit; catat path-nya dan laporkan.
     2. Buat branch `preserve/vps-wip-<YYYYMMDD-HHMM>` dan commit sisa perubahan apa adanya, dengan pesan yang menjelaskan asalnya.
     3. Kembali ke `master` dan lanjutkan.
     4. Catat branch tersebut di laporan.
   - Jangan hapus atau `pop` stash lama. Cukup catat isinya.
3. Jika `master` lokal VPS punya commit yang tidak ada di origin dan fast-forward tidak bisa dilakukan, **jangan rebase atau reset**. Buat branch kerja `work/hybrid-free-<YYYYMMDD>` dari kondisi lokal, lalu laporkan divergensinya.
4. Commit kecil per topik, dengan pesan yang jelas (`feat(hybrid/gateway): ...`, `docs(hybrid): ...`). Pakai identitas per-perintah:
   ```
   git -c user.name="smahud" -c user.email="smahud@users.noreply.github.com" commit ...
   ```
   Jangan ubah konfigurasi git global.
5. Jangan commit `node_modules`, `.wrangler/`, `dist/`, pcap besar, file `.env`, atau secret. Evidence JSON boleh di-commit setelah token, secret, dan alamat IP pribadi client disensor. `.gitignore` root mengabaikan `*.log`, jadi simpan evidence sebagai `.jsonl`/`.txt`, atau `git add -f` setelah disensor.
6. **Tidak ada push.** Push dilakukan agent lain. Satu-satunya pengecualian: operator memerintahkan push secara eksplisit di sesi ini.

---

## 7. Cloudflare dan credential

1. Minta ke operator (sebutkan alasannya):
   - **Disarankan:** API Token terbatas, dibuat dari template "Edit Cloudflare Workers" dan dibatasi ke satu akun dan satu zona `lumajangnetworks.my.id`. Tambahkan `Zone › Zone: Read` dan `Zone › DNS: Read` untuk inventaris. `Zone › DNS: Edit` hanya ditambahkan bila Custom Domain sudah disetujui. Sertakan juga Account ID. Cocokkan nama izin dengan dashboard Cloudflare saat token dibuat.
   - **Alternatif:** Global API Key + email, sesuai rencana awal operator. Gunakan hanya untuk aksi di daftar poin 4.
2. Pakai credential lewat environment proses saja, misalnya file `0600` di luar repo yang di-`source` sesaat: `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`, atau `CLOUDFLARE_API_KEY` + `CLOUDFLARE_EMAIL` untuk Global Key. Verifikasi nama variabel ini di dokumentasi Wrangler versi yang dipakai. `wrangler login` (OAuth) tidak cocok untuk VPS headless.
3. Hapus file credential di akhir tugas dan laporkan bahwa file itu sudah dihapus.
4. Aksi Cloudflare yang **diizinkan**:
   - baca akun, zona, DNS, Worker, dan route;
   - deploy, update, atau rollback Worker `speedtest-hybrid-worker` dan `speedtest-hybrid-worker-test`;
   - menghapus Worker `speedtest-hybrid-worker-test` (tidak boleh menghapus Worker lain);
   - set atau ganti secret Worker tersebut;
   - baca Analytics dan `wrangler tail`.
5. Aksi yang **membutuhkan persetujuan operator (STOP)**:
   - mendaftarkan subdomain `workers.dev` bila akun belum punya;
   - membuat Custom Domain atau record DNS baru;
   - mengubah plan;
   - menambah produk berbayar;
   - aksi apa pun di luar Worker milik proyek ini.
6. Aksi yang **dilarang**: semua yang tercantum di §3 poin 1–2.
7. Verifikasi ulang batas Workers Free di dokumentasi resmi Cloudflare saat deploy, lalu catat tanggal verifikasinya. Batas yang perlu dicek: request per hari, CPU per invocation, body request, perlakuan CPU untuk WebSocket, dan kapan Worker route berjalan di port non-443. Angka di repo berasal dari verifikasi 6 November 2026.

---

## 8. Deploy dan rollback di VPS

**Perubahan Jalur A** (hanya bila diperlukan untuk host tester). Ikuti "prosedur isolasi" yang dipakai agent sebelumnya:

1. Build di source.
2. Jalankan tes terarah `jest --runInBand <suite>`. Kegagalan F-31 di VPS sudah diketahui dan terjadi di lingkungan itu saja.
3. Simpan snapshot file yang akan diganti ke `/root/speedtestserver-rollback/<nama>-<epoch>/`.
4. Salin hanya file `dist` yang berubah.
5. Cocokkan sha256.
6. Restart hanya unit terkait.
7. Pastikan PID unit lain tidak berubah dan `NRestarts=0`.
8. Jalankan ulang gate A2.
9. Lakukan rollback segera bila gate gagal.

**Jalur B:**

- Gateway:
  - Rollback dengan `systemctl disable --now speedtest-hybrid-gateway`.
  - Unit, env file, dan direktori `/opt/speedtest-hybrid` dihapus hanya dengan persetujuan operator.
  - Firewall yang dibuka untuk gateway dicatat bersama perintah pembaliknya.
- Worker:
  - Rollback dengan `wrangler deployments list` lalu `wrangler rollback <version-id>`, atau dengan menurunkan batas lewat vars.
  - Jika ada Custom Domain, hapus binding domainnya terlebih dahulu.
  - Matikan penerbitan sesi di gateway agar client berhenti diarahkan ke Worker.

Tulis semua perintah rollback yang benar-benar berlaku di `docs/HYBRID_DEPLOYMENT_RUNBOOK.md`.

---

## 9. Dokumentasi (deliverable utama)

Semua di `docs/`, berbahasa Indonesia. Identifier, perintah, dan nama file tetap dalam bentuk aslinya. Jangan menyebar dokumen ke banyak file.

| File | Isi |
|---|---|
| `docs/SPEEDTEST_HYBRID_CLOUDFLARE_FREE.md` | Arsitektur dan spesifikasi (versi 2). Perbarui bagian status, keputusan, dan bukti uji. Jangan menulis ulang analisisnya. |
| `docs/HYBRID_STATUS.md` (baru) | Gap analysis (Fase 2) dan status akhir per kriteria A1–C2 dengan label §4. |
| `docs/HYBRID_DEPLOYMENT_RUNBOOK.md` (baru) | Prasyarat, versi (Node, wrangler, compatibility date), env/vars/secret (nama saja), konfigurasi VPS (port, unit, path, firewall), konfigurasi Cloudflare (Worker, URL, route/DNS bila ada), instalasi dari nol, update versi, verifikasi, rollback, troubleshooting (401 `ip-mismatch`, 1102/CPU, 1027/kuota, 413, CORS, TLS). |
| `docs/HOST_TESTER_RUNBOOK.md` (baru) | Daftar check host tester resmi beserta port-nya. Cara operator menjalankan tes. Apa yang dicatat agent sebelum dan sesudah run. Cara menganalisis capture. Riwayat hasil per tanggal, dengan sumber (operator atau clone). |

Selain itu:

- Koreksi errata di `hybrid/reports/WORKERS_LIMITS.md` (W-9), `hybrid/reports/HYBRID_RESEARCH_REPORT.md` (E-G), dan `hybrid/README.md` (label "research branch", klaim 10/10). Gunakan catatan errata bertanggal; jangan menghapus teks lama tanpa jejak.
- Perbarui `validation/HANDOFF.md` atau tambahkan penunjuk ke dokumen baru. Isinya masih revisi 6, tanggal 5 November.
- Jangan menulis credential atau IP pribadi client.

---

## 10. Laporan akhir (format wajib)

1. **Connection Status**: UAEG (metode, berhasil atau gagal) dan akses VPS (user, host, waktu).
2. **Initial Findings**: commit dan kondisi working tree VPS sebelum mulai, hasil perbandingan hash `dist`, status layanan, port, firewall, sertifikat (issuer dan expiry), serta zona DNS.
3. **Implementation**: perubahan per file dan fungsinya, plus daftar commit.
4. **Deployment Status**: apa yang di-deploy (dengan versi/hash/ID deployment Worker), layanan yang tersentuh, PID sebelum dan sesudah, kondisi VPS akhir.
5. **Testing Results**: tabel kriteria A1–C2 dengan label §4, angka CPU/invocation Free, hasil E2E dan atribusi byte. Status host tester resmi ditulis **Passed / Failed / Not Tested** sesuai hasil operator, dan dipisahkan dari hasil clone.
6. **Documentation**: daftar file `docs/` yang dibuat atau diubah.
7. **Git Status**: branch aktif, commit yang dibuat, branch `preserve/*` (jika ada), `git status` akhir, konfirmasi bahwa semua perubahan tersimpan di VPS, dan konfirmasi **tidak ada push**.
8. **Credential**: credential apa yang dipakai, untuk aksi apa, dan konfirmasi file credential sudah dihapus.
9. **Outstanding Tasks**: pekerjaan yang belum selesai, akses yang masih dibutuhkan, keputusan yang menunggu operator, dan langkah berikutnya.

---

## 11. Titik STOP — berhenti dan tanya operator

Berhenti, jelaskan situasinya dalam beberapa kalimat, tawarkan opsi, lalu tunggu jawaban bila:

- Akses UAEG gagal atau ternyata memerlukan perubahan pada VPS.
- Working tree VPS menyimpang dari `origin/master` dengan cara yang tidak bisa diamankan sesuai §6.
- `dist` runtime berbeda dari hasil build `master` dan perbedaannya tidak bisa dijelaskan.
- Pekerjaan membutuhkan port terlarang, perubahan firewall, perubahan layanan lain, atau perubahan sertifikat.
- Pekerjaan membutuhkan perubahan DNS, Custom Domain, pendaftaran subdomain `workers.dev`, atau perubahan apa pun di level zona/akun Cloudflare.
- Pengukuran menunjukkan Workers Free tidak sanggup melayani transfer yang berguna. Sajikan angkanya dan opsinya, misalnya chunk kecil dengan lebih banyak invocation, Workers Paid, atau menunda Jalur B.
- Gate A2 gagal setelah perubahan Anda dan rollback tidak memulihkannya.
- Anda membutuhkan credential (minta sekali, dengan daftar izin minimum).

Di luar titik-titik ini, jangan bertanya hal yang bisa dijawab dengan memeriksa repo atau server.

---

## 12. Prinsip kerja

- **Lanjutkan, jangan mulai ulang.** `hybrid/` adalah basis kode yang dipakai.
- **Periksa dulu, baru ubah.** Mulai dari Fase 0 yang read-only.
- **Jaga layanan yang berjalan.** Jalur A dan layanan lain lebih penting daripada fitur baru.
- **Perubahan minimal tetapi lengkap.** Tidak ada UI browser, Ed25519, atau halaman hasil publik kecuali diminta.
- **Klaim hanya yang terbukti.** Bedakan IMPLEMENTED, DEPLOYED, VERIFIED-AUTO, dan VERIFIED-OPERATOR. Hasil lab bukan hasil edge nyata, dan hasil clone bukan verdict Ookla.
- **Dokumentasikan untuk direproduksi.** Agent berikutnya harus bisa deploy ulang hanya dari `docs/`.

Mulailah dari Fase 0. Jangan menulis kode sebelum Gate 2 terpenuhi.
