# HTTPS WEB CLIENT SUPPORT 2026-11-27 — koneksi ter-encrypt dari website speedtest.net

> Lanjutan langsung dari reverse engineering web client
> (`docs/WEB_CLIENT_REVERSE_ENGINEERING_2026-11-26.md`). Repo sebelumnya melayani
> jalur **CLI (NetGauge TCP :5060/:8080, plaintext-fallback)** dan **HTTP polos**
> — sedangkan web client speedtest.net (halaman https) **hanya berbicara
> WSS/HTTPS ke :8080** (`wss://<host>:8080/ws` + `https://<host>:8080/...`).
> Upgrade ini membuat daemon melayani web client end-to-end: discovery ping,
> latency, download (XHR), upload (XHR + remote stats), sampai hasil valid
> disimpan ke `POST /api/results.php` speedtest.net.

## ⚠️ NOTE PENTING UNTUK OPERATOR & AGENT BERIKUTNYA (dari operator, 2026-11-27)

> **speedtest.net via WEB tidak mendukung mock IP seperti pengujian via CLI.**
> Target uji HARUS server yang **sudah ter-publish** di peta server Ookla.
> Jadi untuk menguji project ini dari website speedtest.net: **install project
> ini ke VPS yang memang sudah menjadi host resmi OoklaServer** (hostname
> ter-publish, entri server map aktif) **dengan HTTPS aktif** — hanya lewat
> itu project `smahud/SpeedtestServer` bisa diuji dari web dengan HTTPS
> tersebut. Mock `/etc/hosts` (dipakai pada kampanye CLI) TIDAK berlaku untuk
> web client: `config-sdk` mengembalikan host hasil registrasi Ookla (lihat
> pola `.prod.hosts.ooklaserver.net` di bawah), bukan hasil resolusi lokal.

Mengapa: web client mengambil daftar server dari
`GET https://www.speedtest.net/api/js/config-sdk?engine=js&limit=10&https_functional=true`
(geoIP server-side) — klien memakai **host persis dari API itu** untuk WSS/XHR,
dan browser memvalidasi **sertifikat** untuk host tersebut. Tidak ada titik
injeksi IP seperti lane CLI.

## TL;DR — apa yang berubah

| Area | Sebelum | Sesudah |
|---|---|---|
| `GET /hello` | 404 (hanya `/hi`) | **alias `/hi`** — `hello <version>\n` (terverifikasi produksi) |
| `GET /getip` | 404 | `<peer-ip>\n` text/plain |
| `GET /capabilities` | 404 | `capabilities SERVER_HOST_AUTH UPLOAD_STATS\n` |
| `GET /ping` | 404 | `pong\n` (lowercase, tanpa timestamp) |
| `GET /download?size=N` | 404 | **N byte persis**, `application/octet-stream`, CL persis, no-store + CORS |
| `GET /upload-stats` | 404 | 400 Bad Request (paritas produksi; web pakai jalur WS) |
| WS frame `"UPLOAD " + bytes` | diparse sebagai command → **rusak** | **raw upload frame**: seluruh frame dihitung, balas `OK <frame-len> <epoch>` |
| WS `UPLOAD_STATS` | **ERROR** | **stream JSON penuh** `{"b","e","i","t":"u"}` per interval + close 1000 (butuh sesi `HI <uuid>`) |
| Akuntansi upload lintas transport | tidak ada | `UploadSessionRegistry` per GUID: XHR `?guid=` + WS frame + CLI `UPLOAD` |
| WS `CAPABILITIES` balasan | trailing `\n` | **tanpa trailing `\n`** (quirk produksi; regex client `$`-anchored) |
| WS `DOWNLOAD 0` | `"\n"` | **ERROR** (quirk produksi WS; TCP tetap `"\n"`) |

TLS/HTTPS :8080 sendiri sudah didukung ServerCore (multiplexer per-port:
ClientHello → TLS → HTTP/WSS; teks lain → NetGauge). Yang hilang selama ini
adalah **permukaan protokol web** di atas multiplexer itu.

## Metode & ground truth

Setiap perilaku baru diverifikasi terhadap **server Ookla produksi** (bukan
asumsi): probe langsung 2026-11-27 ke
`speedtest-sby.xl.co.id:8080` (OoklaServer **2.11.5**, 2026-06-04.1737.7d0993d)
dan `speedtest.tuxsnet.id.prod.hosts.ooklaserver.net:8080` (**2.11.7**,
2026-10-26.2035.bc130b4), plus capture run nyata speedtest.net dari laporan RE
(playwright, payload `POST /api/results.php` lengkap, 302 frame UPLOAD_STATS).
Semua angka di bawah berasal dari probe/capture tersebut.

## Perilaku terverifikasi yang diimplementasikan

### 1. Permukaan XHR (semua `https://host:8080/...`, header CORS + no-store)

| Permintaan | Balasan produksi (terverifikasi) |
|---|---|
| `GET /hello?guid=…&nocache=…` | 200 `hello 2.11 (…) build\n`, `text/plain; charset=UTF-8`, CL 44, ACAO, no-store — **alias persis `/hi`** |
| `GET /getip` | 200 `<ip>\n` (CL 14 dari sandbox HK) |
| `GET /capabilities` | 200 `capabilities SERVER_HOST_AUTH UPLOAD_STATS\n` (CL 43) |
| `GET /ping?nocache=…` | 200 `pong\n` (CL 5) — **bukan** `PONG <epoch>` |
| `GET /download?size=1000` | 200 `application/octet-stream`, CL **persis N**, data acak, no-store, `access-control-allow-origin` mencerminkan Origin |
| `HEAD /download?size=N` | 200, CL = N, tanpa body |
| `GET /download` (tanpa size) | produksi: CL **0**; `size=abc`/`size=-5` → produksi CL **10737418240** (default 10 GiB) → **deviasi terdokumentasi**: kita jawab CL 0 (keamanan, rasional sama dengan penolakan cap `DOWNLOAD` TCP) |
| `GET /upload-stats?…` | **400 Bad Request** kosong (semua varian parameter) — web client mengukur upload via WS `UPLOAD_STATS`, bukan HTTP ini |
| `POST /upload?guid=…&nocache=…` | 200 `size=<N>\n` (sudah ada; kini byte-nya diatribusikan ke sesi GUID) |
| OPTIONS (semua path) | 200, CL 0 (sudah ada; terverifikasi ulang — run web nyata TIDAK pernah preflight OPTIONS, 0 observasi di 4 capture) |

### 2. WS raw upload frame (jalur upload web)

Frame WS yang **7 byte pertamanya** ASCII `"UPLOAD "` adalah **data upload
utuh** — TIDAK ada bentuk command `UPLOAD <n>` di WS:

- produksi menjawab `OK <panjang-frame> <epoch-ms>\n` **per frame**
- frame 9 byte `"UPLOAD 50"` → `OK 9 <epoch>` (bukti bentuk command CLI tidak
  ada di WS) — frame berikut tanpa prefix → `ERROR` (bukan payload phase)
- web client mengirim frame biner persis begini (bundle: byte 0..6 =
  85,80,76,79,65,68,32 lalu byte acak), dan menghitung byte upload dari
  balasan `OK` + stream stats

### 3. WS `UPLOAD_STATS` — pengukuran upload remote

```
C→S: HI <run-guid>                       # WAJIB — sesi; tanpa ini (bare HI) → ERROR
C→S: UPLOAD_STATS <durasi-ms> <interval-ms> [<index>]
S→C: {"t":"u"}\n                          # ack langsung
S→C: {"b":<byte sesi sejak stream mulai>,"e":<i*interval>,"i":<index+i>,"t":"u"}\n   # tiap interval
... sampai durasi habis → WS CLOSE code 1000
```

- Argless → **ERROR** bahkan dengan sesi (produksi 2.11.5 & 2.11.7).
- Bentuk 2-arg valid (index default 0).
- `b` = byte upload kumulatif sesi **sejak stream dimulai** (baseline saat
  command) — XHR `?guid=` dan frame WS mentransfer di sesi yang SAMA (dibuktikan
  run nyata: stream menghitung 1.140.556.608 byte upload XHR selama 15 s).
- `e` = `i * interval` (nominal); run nyata: 302 frame untuk `15000 50 0`
  (ack + i=0..300, e=0..15000).

### 4. Quirk newline WS (load-bearing untuk web client!)

Produksi (2.11.5 + 2.11.7 + capture run nyata): balasan WS **`HELLO` dan
`CAPABILITIES` TANPA trailing newline**; `YOURIP`, `PONG`, `OK`, baris stats
**dengan** `\n`. Regex client (`^CAPABILITIES (.*)$` dsb.) `$`-anchored —
trailing `\n` membuat **balasan tidak dikenali client**.

### 5. `DOWNLOAD` over WS

- `DOWNLOAD <n>` → **satu frame biner tepat n byte**, prefix `"DOWNLOAD "`
  (terverifikasi n=100 & n=250000 → 1 frame; byte terakhir produksi bukan
  `\n` — deviasi kosmetik kita: byte terakhir `\n` seperti TCP, client hanya
  menghitung byte).
- `DOWNLOAD 0` → **ERROR** over WS (TCP tetap `"\n"`).

## Implementasi (per file)

| File | Perubahan |
|---|---|
| `src/server/NetGaugeEngine.ts` | `UploadSessionRegistry` (bounded 4096, kunci UUID); `feedRawUploadFrame()`; `startUploadStats()` stream + timer + close; opsi `transport: 'tcp'\|'ws'` (quirk `DOWNLOAD 0`); atribusi byte upload sesi di jalur CLI; `destroy()` membersihkan timer stream |
| `src/server/HttpApi.ts` | rute `/hello`, `/getip`, `/capabilities`, `/ping`, `/download?size=`, `/upload-stats`→400; atribusi body upload `?guid=`; opsi `uploadSessions`, `maxDownloadBytes` |
| `src/server/ServerCore.ts` | registry bersama (HttpApi + engine TCP + engine WS); deteksi prefix `"UPLOAD "` di `ws.on('message')` **sebelum** aturan satu-command-per-frame; `transport:'ws'` untuk engine WS; quirk newline `CAPABILITIES` |
| `src/server/Protocol.test.ts` | kontrak baru (raw frame, UPLOAD_STATS happy/argless/tanpa-sesi/malformed/b-semantik, DOWNLOAD 0 ws, registry bound) + integrasi WS klien nyata (ws package) + permukaan XHR |
| `src/server/HttpRouteParity.test.ts` | parity 6 endpoint XHR baru + atribusi `?guid=` |

## Verifikasi

1. **Type-check + build**: `npm run typecheck` / `npm run build` — bersih.
2. **Suite test**: **257/257 PASS** (10 suite; +±22 test baru).
3. **Verifikasi protokol end-to-end lokal** (`tools/web-client-probe/verify_local_daemon.py`,
   daemon lokal + self-signed TLS :18080): **24/24 PASS** — alur penuh web
   client direkonstruksi: HTTPS `/hello → /getip → /capabilities → /ping →
   /download?size= → POST /upload?guid=` + WSS `HI → GETIP → CAPABILITIES →
   PING → UPLOAD_STATS (ack + tick b=100 dari raw frame + close 1000)` +
   DOWNLOAD frame biner + quirk `UPLOAD 50`→`OK 9` + jalur plain (legacy CLI)
   tetap hidup.

Yang TIDAK bisa diverifikasi dari sandbox ini (butuh VPS host ter-publish,
lihat NOTE PENTING): browser sungguhan dari `https://www.speedtest.net`
menyelesaikan run penuh dan `POST /api/results.php` diterima. Struktur payload
hasil yang client kirim sudah terekonstruksi penuh di
`docs/web-client-analysis/evidence/05_result_payload_tuxsindo.json`.

## Runbook deployment (VPS host resmi Ookla)

1. Pastikan host ter-publish di peta server Ookla dan catat **hostname persis
   yang diumumkan API** (`config-sdk` → field `host`). Dua pola produksi:
   - **kelas A**: host sponsor sendiri (mis. `speedtest-sby.xl.co.id:8080`)
     dengan sertifikat sponsor (`*.xl.co.id`) — HTTP polos :8080 juga 200.
   - **kelas B**: host `<sponsor>.prod.hosts.ooklaserver.net` — HTTP polos
     GET di-307 ke `https://server-<id>.prod.hosts.ooklaserver.net:8080/…`;
     sertifikat SAN ganda `server-<id>.prod.hosts.ooklaserver.net` +
     `<sponsor>.prod.hosts.ooklaserver.net`.
2. Sertifikat :8080 harus **valid untuk hostname yang diumumkan API itu**
   (SAN di atas). Browser menolak `wss://` bila sertifikat tidak cocok —
   contoh produksi: `somedigit` (74964) memasang cert self-signed
   `CN=localhost, O=OoklaServer` → **tidak bisa dipakai dari halaman https**
   meski API menandai `https_functional=1`.
   Konfigurasi daemon:
   ```properties
   OoklaServer.tcpPorts = 8080,5060
   openSSL.server.certificateFile = /path/fullchain.pem
   openSSL.server.privateKeyFile = /path/privkey.pem
   openSSL.server.useLetsEncrypt = false
   ```
   (`useLetsEncrypt=true` + ACME juga didukung — lihat `CertificateManager`.)
3. Jalankan daemon, lalu uji dari web: buka
   `https://www.speedtest.net/server/<server-id>` (atau popup "Change Server"),
   pilih host Anda, klik GO. Fase yang harus lewat: *Finding optimal server*
   (WSS ping) → latency → download → upload → hasil tersimpan
   (`speedtest.net/result/<id>`).
4. Verifikasi protokol tanpa publish: `python3
   tools/web-client-probe/verify_local_daemon.py` (daemon lokal, self-signed;
   24 check end-to-end).

## Deviasi terdokumentasi (aman, dengan alasan)

1. `GET /download` size tak-valid → CL 0 (produksi: 10 GiB default) — batas
   abuse; sama rasionalnya dengan penolakan cap `DOWNLOAD` TCP yang sudah ada.
2. `size > maxDownloadBytes` (default 2 GiB−1) → minimal 500 (produksi: tidak
   teramati punya cap).
3. Stream `UPLOAD_STATS`: `e` nominal `i*interval` (produksi: baris terakhir
   kadang overshoot aktual, mis. 15027) — client menghitung Δb/Δe, setara.
4. `DOWNLOAD <n>` WS: byte terakhir `\n` (produksi: byte pool) — kosmetik.
5. `UPLOAD_STATS` idle/no-upload: kita terus men-tick sampai durasi habis lalu
   close (produksi: kadang close lebih awal pada sesi tanpa trafik —
   kondisi persisnya tidak konsisten antar probe; jalur client nyata selalu
   ada trafik sehingga tidak relevan).

## Reproduksi ground truth

```bash
# probe semantik WS ke server produksi (yang dipakai menutup desain ini)
python3 tools/web-client-probe/probe_ws_session.py
python3 tools/web-client-probe/probe_stats_matrix.py
python3 tools/web-client-probe/probe_ws_download.py
# verifikasi daemon lokal (24 check end-to-end, self-signed TLS)
python3 tools/web-client-probe/verify_local_daemon.py
```
