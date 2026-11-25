# HOST_TESTER_RUNBOOK — Host tester resmi speedtest.net untuk Jalur A

**Dibuat:** 24 November 2026. **Target:** `speedtest.lumajangnetworks.my.id:8080` (VPS 45.126.249.250, DNS-only).

## 1. Daftar check host tester resmi (hasil capture 23 Nov 2026)

Tester resmi HANYA memakai **port 8080**. Urutan check yang terekam:

| # | Check | Transport | Detail |
|---|---|---|---|
| 1 | `GET /hi` | HTTP | User-Agent `Firefox/2.0.0.3` |
| 2 | NetGauge TCP mentah | TCP 8080 | `HI`, `SERVERID`, `GETIP` |
| 3 | WebSocket `/ws` | WS 8080 | User-Agent `websocket-client-php` |
| 4 | `/crossdomain.xml` + `/speedtest/crossdomain.xml` | HTTP/1.0 | `to-ports` harus memuat `5060,8080` |
| 5 | TLS di 8080 | TLS | SNI hostname, ALPN `h2`/`http/1.1`, minimum TLS 1.2 |
| 6 | `latency.txt` | HTTP | `test=test` |
| 7 | `POST /speedtest/upload.php` | HTTP | 515.699 B (`upload`) dan 1.980.899 B (`max_upload`), timeout PHP curl 10 detik |
| 8 | `HEAD` 10 file `random*.jpg` | HTTP | Ukuran persis dari `http_legacy_fallback.zip` |
| 9 | Keep-alive | HTTP | Tiga request pada satu socket |

## 2. Cara operator menjalankan

1. Pastikan status A1 (keempat unit layanan aktif) dan gate A2 lulus (agent yang memeriksa).
2. Pastikan `ookla-capture.service` aktif dan ruang disk cukup (`df -h /var/lib/ookla-capture`).
3. Buka `https://www.speedtest.net/host-tester` di browser, login, masukkan `speedtest.lumajangnetworks.my.id:8080`.
4. Halaman dilindungi verifikasi manusia (CAPTCHA) — **agent tidak boleh mengotomasinya** (§3.8 master prompt). Operator menyelesaikannya manual.
5. Catat jam mulai (WIB). Simpan hasil lengkap per check (teks/screenshot), termasuk status `max_upload`.
6. Kirim hasil + jam run ke agent untuk analisis capture.

**Selama jendela run operator: agent TIDAK menjalankan tes apa pun ke VPS** (sumber lalu lintas agent dan tester bisa sama-sama terlihat sebagai 45.126.249.249 karena NAT). Flow tester dikenali dari User-Agent (`Firefox/2.0.0.3` HTTP, `websocket-client-php` WS).

## 3. Yang dilakukan agent SEBELUM run

- Rekam `systemctl show speedtestserver speedtestserver-legacy layanan-lain ookla-capture -p MainPID,NRestarts` dan `ss -ltnup`.
- Pastikan gate A2: `check-http-compatibility.py` 31/31; `host-tester-check.py` default 19/19.
- Catat file ring capture terakhir: `ls -la /var/lib/ookla-capture/ | tail -5`.

## 4. Yang dilakukan agent SESUDAH run

1. **Segera salin** file `hosttester.pcapNN` yang relevan ke `/root/speedtest-hybrid-work/hosttester-<tanggal>/` (ring 20 × 100 MB bisa tertimpa cepat).
2. Analisis:
   - `python3 validation/harness/inspect-upload-pcap.py <pcap>`
   - `grep http_upload_early_response /var/lib/speedtestserver/evidence.jsonl | tail -20`
   - `journalctl -u speedtestserver -u speedtestserver-legacy --since "<jam run>"`
3. Perhatian khusus `max_upload`: risiko yang sudah diketahui adalah socket ditutup 30 ms setelah early answer — bisa memicu reset pada PHP curl di jalur lambat. Bila `max_upload` gagal lagi, periksa apakah reset terjadi sebelum body terkirim selesai.
4. Perbaikan Jalur A (bila perlu) WAJIB lewat prosedur isolasi §8 master prompt (snapshot → salin file dist yang berubah → cocokkan sha256 → restart unit terkait saja → cek PID unit lain → ulangi gate → rollback bila gagal).

## 5. Riwayat hasil

| Tanggal (WIB) | Sumber | Hasil | Catatan |
|---|---|---|---|
| 23 Nov ±23:22 | Operator (host tester resmi) | Semua lulus KECUALI `max_upload` | Timeout PHP curl 10 detik pada jalur upload lambat |
| 23 Nov ±23:51 | — | Deploy early answer (f1ed207) | Run ulang hosted BELUM ada setelah ini |
| 23 Nov 19:08 UTC | Clone (gate publik) | `check-http-compatibility` 31/31 | Baseline sesi 24 Nov |
| 23 Nov 19:09 UTC | Clone (chatgpt) | 19/19 (default `--legacy-port 80`) | Baseline sesi 24 Nov |
| 23 Nov 19:09 UTC | Clone (chatgpt, `--legacy-port 8080`) | 9/19 | Run pertama varian ini. 10 check gambar gagal HANYA pada validasi magic-byte JPEG (`ff d8`) karena daemon TS menyajikan byte pool ASCII. Ukuran/status/Content-Type benar. Tester resmi hanya melakukan HEAD pada gambar → magic byte tidak pernah diamati resmi. Deviasi clone-vs-resmi, bukan kegagalan Jalur A |
| 23 Nov 19:12–19:18 UTC | CLI resmi Ookla 1.2.0.84 (redirect hosts) | 9/9 server ID Surabaya selesai penuh ke VPS | 74964/61853/48532/55749/62314/66281/65429/68214/73025; contoh 74964: ping 62 ms, DL ~491 Mbps, UL ~141 Mbps, loss 0; semua `persisted:false` (results.speedtest.net diblokir) |
| 24 Nov (setelah deploy gateway) | Clone (gate publik + chatgpt) | 31/31 dan 19/19 | Setelah deploy gateway :8790 — tidak ada regresi |
| 24 Nov 01:45-01:52 UTC (sesi 2, baseline) | Clone (gate publik + chatgpt 2 varian) | 26/31; 4/19 (default); 9/19 (8080) | 5 kegagalan upload legacy port 80: respons `Server: layanan lain/2.2.11` body kosong - trafik port 80 dialihkan layanan lain oleh rule nftables baru `tcp dport 80 redirect to :8081` setelah restart layanan-lain (T-9, sisi operator). Port 8080: 26/26 lulus |
| 24 Nov 02:20-02:25 UTC (sesi 2, final) | Clone (gate publik + chatgpt 2 varian) | 26/31; 4/19 (default); 9/19 (8080) | Identik dengan baseline sesi 2 - seluruh kerja Jalur B (deploy Worker edge nyata, restart gateway) tidak menimbulkan regresi Jalur A |
| 24 Nov 19:40:07–19:41:58 WIB | Operator (host tester resmi, **4 run**) | Bukti sisi server: **seluruh check terlayani 4/4 run** — verdict layar tester menunggu konfirmasi operator | Analisis lengkap: `validation/evidence/hosttester-run-20261124.json`. Ringkas: `/hi` 200 OK 4/4; NetGauge TCP mentah 4/4 (HELLO 2.11/SERVERID/GETIP, FIN bersih); WS `/ws` 101 4/4; `/crossdomain.xml` + `/speedtest/crossdomain.xml` 200 OK 8/8; TLS 8080 handshake + `GET /hi` 4/4; `latency.txt` 200 OK 4/4 + keep-alive 3×/socket 4/4; `POST upload.php` 515.699 B & 1.980.899 B → 200 OK `size=<CL>` early-answer @2,50 s **8/8** (perbaikan max_upload 23 Nov 23:51 bekerja; respons HTTP lengkap jauh di bawah timeout PHP curl 10 s; RST server terjadi hanya setelah respons lengkap diterima); `HEAD` 10 `random*.jpg` → 200 OK + Content-Length resmi + `image/jpeg` **40/40**. PID keempat unit Jalur A + gateway tidak berubah (NRestarts=0). Pcap ring 20 file diawetkan ke `/root/speedtest-hybrid-work/hosttester-20261124/` + SHA256SUMS |
| 24 Nov 12:52 UTC | Clone (gate publik + chatgpt 2 varian, dari sandbox eksternal) | 26/31; 4/19 (default); 9/19 (8080) | Identik baseline sesi 2–5: 5+15 kegagalan = T-9 (redirect layanan lain port 80, pra-ada); 1 kegagalan 8080 = T-7 (magic-byte body, clone-only). Jalur A sehat pasca 4 run operator |

## 6. Registrasi/visibilitas di Ookla

- Discovery CLI resmi `--host speedtest.lumajangnetworks.my.id` masih mengembalikan `NoServersException` (23–24 Nov): host belum terlihat di daftar server CLI. Status registrasi ada di portal Ookla (speedtest.com/network / host-tester approval), di luar kode server — jangan "diperbaiki" lewat kode.
- Bukti bahwa server MELAYANI client resmi tanpa modifikasi: run CLI resmi §5 baris "9/9 server ID" (endpoint dipaksa lewat redirect hosts, protokol NetGauge murni, byte upload cocok dengan evidence.jsonl VPS).
