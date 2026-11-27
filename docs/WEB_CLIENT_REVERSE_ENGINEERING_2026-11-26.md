# WEB CLIENT REVERSE ENGINEERING 2026-11-26 — speedtest.net end-to-end (finding optimal server, pemilihan manual, koneksi)

> Reverse engineering menyeluruh **web client resmi speedtest.net** (bukan CLI):
> bagaimana "Finding optimal server" bekerja, bagaimana pemilihan server manual,
> bagaimana koneksi dibuka/dilayani, dan seluruh alur awal run — diverifikasi
> dengan (1) analisis statis JS bundle resmi, (2) **capture run nyata di Chromium
> headless via Playwright** (auto 1 run penuh + manual 2 run penuh + popup), dan
> (3) **probe protokol langsung ke 10 server target Surabaya**.
> Evidence lengkap: `docs/web-client-analysis/evidence/` (index di
> `docs/web-client-analysis/README.md`). Tools reproduksi: `tools/web-client-probe/`.

## Pertanyaan operator

> "lakukan reverse engineering pada website https://www.speedtest.net/ saat finding
> optimal server dan saat memilih server secara manual … cek bagaimana koneksi
> terjadi, bagaimana koneksi layani, dan semua hal terkait awal proses speedtest
> dijalankan di website tersebut secara komprehensif dan end to end" — dengan 10
> server target Surabaya (ID 74964, 61853, 62314, 66281, 65429, 68214, 73025,
> 72945, 48532, 55749).

## TL;DR — alur end-to-end web client

| Fase | Apa yang terjadi | Bukti |
|---|---|---|
| 0. Load halaman | `GET /api/js/config-sdk?engine=js&limit=10&https_functional=true` → geoIP klien + 10 server terdekat. UI spinner: *"Finding optimal server..."* | capture 3,2 s |
| 1. Pre-warm seleksi | **10 koneksi WSS paralel** `wss://<host>:8080/ws` (satu per server kandidat). Tiap koneksi: `HI [guid]` → `GETIP` → `CAPABILITIES` → `PING ` → 5× `PING <ms>` | capture 4,0 s; probe |
| 2. Sort & pilih | median/hasil ping → server terbaik; koneksi seleksi ditutup (~480 ms) | capture 4,5 s |
| 3. Manual (jika dipilih) | popup "Change Server" → `config-sdk?search=…&limit=100`; route `/server/<id|nama>` → `config-sdk?server_ids=<id>`; server `httpsFunctional!==1` DITOLAK di halaman https | capture manualui + manual |
| 4. Latency stage | WSS ke server terpilih: 10 sampel `PING <ms>` → `PONG` (idle latency) | capture manual 16,7 s |
| 5. Download | **XHR** `GET /download?size=25000000` — auto: **4 server paralel round-robin**; manual: 1 server. Tiap koneksi XHR baru diawali `GET /hello?guid=&nocache=`. Ukuran adaptif 25 MB → ~28 MB | capture 10,0 s |
| 6. Loaded latency | PING terus-menerus via WSS selama download+upload (~90–175 paket/detik, bufferbloat) | 3.003 PING tercatat |
| 7. Upload | `POST /upload` (octet-stream, byte acak) + `UPLOAD_STATS 15000 50 0` via WSS → stream JSON `{"b":..,"e":..,"i":..,"t":"u"}` per 50 ms (ukur remote) | capture 26,7 s |
| 8. Save | `POST /api/results.php` — payload JSON 25–26 KB (`serverid`, `testmethod:"wss,xhrs,xhrs"`, 10 pings, loaded-latency, byte attribution per koneksi) → `resultid` | capture 41,9 s |

## Metode

1. **Statis**: bundle `https://r.cdnst.net/assets/index-CUbMX1WR.js` (4,4 MB, Vite,
   React 19 + `speedtestJsEngine` SDK **3.1.3** commit `b6ba2b05…`) diekstrak per
   keyword (transport, settings, kalkulator, API client). Semua angka di bawah
   berasal dari kode asli yang dibaca langsung, bukan tebakan.
2. **Dinamis**: Playwright + Chromium headless, semua request/response/frame
   WebSocket dicatat (JSONL). 4 sesi: run otomatis penuh, popup search tanpa run,
   run manual penuh 2× (server terpilih: XLSMART 61853 dan Tuxsindo 66281 —
   keduanya run **selesai** sampai `POST /api/results.php`).
3. **Probe langsung**: implementasi Python dari protokol hasil rekonstruksi,
   ditembakkan ke 10 server target (DNS, port 80/443/5060/8080, TLS, HTTP baru,
   legacy, WS plain+TLS) + quirk matrix.

Klien pengukuran: sandbox Alibaba HK (geoIP HK; RTT Surabaya ~60–140 ms) — jadi
"server terdekat" untuk run otomatis berada di HK, sementara run manual dipaksa
ke target Surabaya.

## 1. Stack client & engine

- speedtest.net = React SPA (MUI Joy). Engine = **Ookla JS SDK "speedtestJsEngine"**
  (nama internal; `stagesList: [latency, download, upload, save]`).
- Dua transport, dipilih per stage — `testmethod` di hasil: `"wss,xhrs,xhrs"`
  (latency=WSS, download=XHR, upload=XHR):
  - **WS**: `wss://<host>:8080/ws` (halaman https; `ws://` jika halaman http),
    `canPipeline: true` — banyak pesan per koneksi.
  - **XHR**: `{http|https}://<host>:8080/<path>?<params>&ct=<corsToken>`,
    `responseType: arraybuffer`, POST → `Content-Type: application/octet-stream`.
  - Fallback: WS tidak didukung → XHR; **XHR pada server versi < 2.5 → WS**
    (`version < 2.5 → setConnectionProtocol("ws")`).
- `useSecureConnections = (halaman === https)` → semua koneksi ke :8080 memakai
  TLS (wss/https).

## 2. "Finding optimal server" — detail presisi

1. **`_getServers`** memanggil API:
   `GET /api/js/config-sdk?engine=js&limit=<latency.maxServers=10>&https_functional=true[&isVpn=true]`
   → kandidat = 10 server terdekat berdasar geoIP klien (server-side).
2. **`Promise.all(servers.map(_pingServer))`** — SEMUA kandidat diping **paralel**.
   Setiap `_pingServer` membuat stage seleksi dengan setting
   `serverSelection: {numSamples: 5, maxFailedConnections: 1, maxAttempts: 1}`.
3. Koneksi seleksi per server = **WebSocket** (`sampling.connectionProtocol: "ws"`),
   path `/ws`, tanpa `ct` pada run anonim. Urutan pesan persis:
   ```
   C→S: HI <guid speedtest>            (atau "HI" tanpa guid)
   C→S: GETIP
   C→S: CAPABILITIES
   C→S: PING <ms-elapsed-monotonic>    (paket pertama "PING " tanpa argumen)
   S→C: HELLO 2.11 (2.11.x) <build>   (contoh: 2026-10-26.2035.bc130b4)
   S→C: YOURIP <ip publik klien>
   S→C: CAPABILITIES SERVER_HOST_AUTH UPLOAD_STATS
   S→C: PONG <epoch-ms-server>
   ```
   Lalu `PING <ms>` dikirim ulang sampai 5 sampel selesai (teramati: 6 PING
   termasuk paket pembuka; koneksi ditutup ±480 ms).
4. Hasil ping per server → `{latency, jitter, success, pings[5], version{…},
   externalIp}` — terekam di payload hasil sebagai `serverSelection.closestPingDetails` (10 entri).
5. Sort naik berdasar `latency` (median/iqm hasil 5 sampel) → server #1 dipakai.
   Server yang error dijatuhkan ke belakang daftar.
6. Setelah terpilih: **stage latency run** = 10 sampel (`latency.numSamples: 10`)
   ke server terpilih via WSS, lalu PING berlanjut **selama** download+upload
   (loaded latency / bufferbloat; teramati 3.003 paket PING pada run otomatis,
   213/223 sampel pada run manual Surabaya).
7. Nilai yang dilaporkan: `calculateRTT` = `{iqm, mean, median, min, max}`
   (IQM = rata-rata interkuartil [n/4, 3n/4)), `jitter` = rata-rata |Δ| sampel
   berurutan (3 desimal). Contoh nyata run manual Tuxsindo:
   idle iqm 61,07 ms / median 61,6 / min 59,5 / max 62,9 / jitter 2,067;
   under-load download iqm 66,5 ms; upload iqm 65,3 ms.

## 3. Pemilihan server manual (3 jalur)

| Jalur | Mekanisme | Bukti |
|---|---|---|
| UI "Change Server" | popup → input search → `GET /api/js/config-sdk?engine=js&search=<teks>&https_functional=true&limit=100`; item `MuiListItemButton` "Surabaya - <sponsor>" diklik → state selected + `setSelectionMethod("manual")` | capture_manualui (tidak dipakai run), capture_manual2 |
| URL route `/server/:name` | `<id numerik>` → `getServers(server_ids=<id>)` (harus 1 hasil); `<nama>` → `searchServers(nama, 100)` cocok `sponsor` persis → `name` includes → pertama; **halaman https menolak `httpsFunctional !== 1`** (error `server_from_url_not_found`, redirect balik ke origin) | bundle + capture `/server/74964` (config-sdk `server_ids=74964` teramati) |
| Subdomain host `*.speedtest.net` | `fetchServerFromURL(hostSubdomain, "dns")` — ambil hasil pertama search | bundle |

Sifat penting run manual (teramati 2×): **tidak ada ping 10-kandidat** untuk
pemilihan (server sudah pasti), stage langsung: WSS latency 10 sampel ke server
terpilih → download XHR **hanya ke server itu** (multi-koneksi tapi 1 server) →
upload → save. Run otomatis: download menyebar **round-robin ke 4 server**
(`download.connectionStrategies: {default: {type:"round-robin", numServers:4}}`).

## 4. Download — bagaimana koneksi dilayani

- Auto: pool XHR ke **4 server** paralel (round-robin), awal 4 koneksi
  (`throughput.numInitialConnections: 4`), maksimum 32 koneksi/6 XHR per server.
- Tiap koneksi XHR **mengawali dengan handshake**:
  `GET /hello?guid=<guid>&nocache=<uuid>` → `200` body `hello 2.11 (2.11.x) <build>\n`
  (`text/plain; charset=UTF-8` — **huruf kecil** pada varian HTTP; WS memakai
  `HELLO` kapital). Server < 2.5 tanpa dukungan XHR otomatis di-fallback ke WS.
- Payload: `GET /download?size=<N>&guid=…&nocache=<uuid>` →
  `200 application/octet-stream`, `Content-Length: <N>` persis, `cache-control: no-store`,
  `access-control-allow-origin: https://www.speedtest.net` (CORS — server WAJIB
  mengizinkan origin speedtest.net).
- Ukuran adaptif: mulai `size=25000000` (25 MB — `startMessageSizeBytes: 25e6`
  XHR) lalu tumbuh mengikuti bandwidth (teramati 27,4–29,0 MB pada run 1 Gbps HK;
  25,0–33,9 MB pada run Surabaya ~330 Mbps). `messageLengthMillis: 5000` per pesan XHR.
- Ramp-down: menjelang akhir stage teramati request `size=26..29` **byte** lalu
  `net::ERR_ABORTED` (klien membatalkan koneksi sisa — jangan dihitung sebagai
  error server).
- Byte attribution per koneksi dikirim di payload hasil
  (`connections.download[]`: `bytes`, `openedAt`, `readyAt`, `closedAt`,
  `closedReason: "stopped"`).

## 5. Upload — pengukuran lokal vs remote

- `POST /upload?guid=…&nocache=<uuid>` — body = Blob `application/octet-stream`
  (byte acak; pada varian WS 7 byte pertama literal `"UPLOAD "`). Respons:
  `size=<total-byte-diterima>\n`.
- Ukur **remote** (`uploadMeasurementMethod: "remote"`) bila server mengumumkan
  kapabilitas `UPLOAD_STATS` (semua server target mengumumkan
  `CAPABILITIES SERVER_HOST_AUTH UPLOAD_STATS`):
  koneksi WSS terpisah mengirim `UPLOAD_STATS 15000 50 0`
  (`<durasi-ms> <interval-ms> <index>`) dan server **mengalirkan balik**
  JSON newline-delimited tiap 50 ms:
  `{"b":<kumulatif-byte>,"e":<elapsed-ms>,"i":<index>,"t":"u"}`
  (302 frame pada run otomatis; `b` akhir 1.140.556.608 ≈ 606 Mbps).
  Ini yang membuat angka upload presisi walau XHR progress events kasar.

## 6. Save — `POST /api/results.php`

`Content-Type: application/json;charset=UTF-8` (web modern;
`saveType: "speedtestnet-react"`), payload 25–26 KB. Struktur terverifikasi
(`05_result_payload_tuxsindo.json`):

```
app{sdk{commit,version:3.1.3}} serverid testmethod source:"speedtestnet-react"
configs{engine, latency{maxServers:10}, loadedLatency{enabled:true},
  provider{countryCode,ipAddress,ispName,ispId,providerHash},
  serverList[50] (kandidat penuh hasil search/manual),
  server{selectionMethod:"manual"}, latencyProtocol:"ws",
  downloadProtocol:"xhr", uploadProtocol:"xhr", host, port:8080,
  serverVersion:"2.11.7", serverBuild}
ispName ping pings[10] jitter latency{connectionProtocol:"wss", tcp{jitter, rtt{iqm,mean,median,min,max}, count, samples[10]}}
guid serverSelectionGuid serverSelectionMethod uploadMeasurementMethod:"remote"
upload uploadSpeeds{local,remote} download downloadSpeeds
downloadLatency{tcp{…, count:213}} uploadLatency{tcp{…, count:223}}
servers{download[],upload[]} connections{download[]}
hash clientip serverSelection{closestPingDetails[10]{server,jitter,latency,success,pings[5],version,externalIp}}
```

Respons: `200` dengan `resultid` (remap `resultId`) + `hash_key_id` → halaman
hasil `speedtest.net/result/<resultid>` (contoh nyata: `19957977862`).

## 7. Peta protokol lengkap (rekonstruksi siap pakai)

Path XHR (port 8080) ↔ pesan WS — keduanya dilayani server yang sama:

| Fungsi | XHR (baru) | WS | Balasan server |
|---|---|---|---|
| handshake | `GET /hello?guid=<guid>&nocache=<uuid>` | `HI [guid]` | `hello 2.11 (b) build\n` / `HELLO 2.11 (2.11.x) <build>` |
| IP klien | `GET /getip` | `GETIP` | `<ip>\n` / `YOURIP <ip>` |
| kapabilitas | `GET /capabilities` | `CAPABILITIES` | `capabilities SERVER_HOST_AUTH UPLOAD_STATS\n` / `CAPABILITIES …` |
| ping | `GET /ping?nocache=…` | `PING <ms>` | `PONG <epoch-ms>` |
| download | `GET /download?size=<N>` | `DOWNLOAD <N>` (binary payload setelahnya) | `200 application/octet-stream` Content-Length persis N |
| upload | `POST /upload` (body N byte) | `UPLOAD ` + N-7 byte acak | `size=<N>\n` |
| statistik upload | `GET /upload-stats?testDurationMillis&updatePeriodMillis&index` | `UPLOAD_STATS <dur> <int> <idx>` | JSON stream `{"b","e","i","t":"u"}\n` per interval |
| legacy download | `GET /speedtest/random350x350.jpg` (245.388 B), `random1000x1000.jpg` (1.986.284 B) | — | image/jpeg acak |
| legacy ping | `GET /speedtest/latency.txt` | — | `test=test\n` |
| legacy upload | `POST /speedtest/upload.php` | — | `size=<N>\n` (GET → 404) |
| policy | `GET /speedtest/crossdomain.xml` | — | XML, `to-ports="5060,8080"` |
| root | `GET /` | — | HTML 109 B "OoklaServer" |

Catatan: protokol native TCP :5060 (CLI, NetGauge binary `HI\n`→`HELLO…`) sudah
terdokumentasi di bukti lama repo (`speedtest-cli_analysis/evidence/07_protocol_probe.txt`)
— **protokol web :8080 ini adalah kembaran teks-nya** dengan build server identik
(`2.11 (2.11.5) 2026-06-04.1737.7d0993d` teramati baik via CLI lama maupun web).

## 8. Temuan per server target (probe langsung 2026-11-26)

| ID | Sponsor | Host (API) | DNS A / AAAA | :8080 | TLS | Kelas | Versi (ws HELLO) |
|---|---|---|---|---|---|---|---|
| 74964 | somedigit.net | speedtest.somedigit.net | 103.134.66.6 ✓ | OK | **self-signed CN=localhost,O=OoklaServer** | C | 2.11.5 (2026-06-04.1737.7d0993d) |
| 61853 | PT XLSMART | speedtest-sby.xl.co.id | 112.215.223.4 + 2400:9800:b010:120::4 ✓ | OK | OK `*.xl.co.id` | A | 2.11.5 (2026-06-04.1737) |
| 62314 | PT. Pratama Hasta | speedtest.patas.id | 103.1.51.67 ✓ | OK | OK | A | 2.11.7 (2026-10-26.2035) |
| 66281 | PT. Tuxsindo | speedtest.tuxsnet.id [.prod.hosts.ooklaserver.net] | 160.25.58.7 ✓ | OK | OK (hanya via .prod) | B | 2.11.7 (2026-10-26.2035) |
| 65429 | Atharva | ookla.sub.atharva.co.id [.prod…] | 222.167.229.10 + 2001:df1:7340:396::83 ✓ | OK | OK (hanya via .prod) | B | 2.11.7 (2026-10-26.2035) |
| 68214 | PT. ERA NETWORK | speedtest.era.net.id | 157.20.239.243 ✓ | OK | OK | A | 2.11.7 (2026-10-26.2035) |
| 73025 | LINTAS MEDIA | speedtest2.lintasmediasolusindo.com [.prod…] | 160.22.217.82 + 2001:df4:cc0:3:20c:29ff:fe8b:c0b2 ✓ | OK | OK (hanya via .prod) | B | 2.11.7 (2026-10-26.2035) |
| 72945 | BLiP | ookla-sby.blip.co.id | 43.252.159.5 | **timeout** | — | D (mati) | — |
| 48532 | Faznet | v137170.faznet.co.id | 103.111.137.170 ✓ | OK | OK `*.faznet.co.id` | A | 2.11.1 (2024-02-13.1456.91c4f93) |
| 55749 | RingNet | sby.speedtest.ring.net.id [.prod…] | 103.202.226.242 + 2401:13e0:2:1::2 ✓ | OK | OK (hanya via .prod) | B | 2.11.7 (2026-10-26.2035) |

- Semua IP pada daftar operator **terverifikasi benar** (termasuk entri yang
  di operator masih `unknown` — BLiP: `ookla-sby.blip.co.id` → 43.252.159.5,
  port 8080 **down**; inilah penyebab status "Latency test failed" di daftar operator).
- `GET /ping` RTT dari sandbox HK: 122–142 ms (tuxsnet), 128–294 ms (somedigit) —
  konsisten dengan pengukuran browser (~60–66 ms via egress lain; egress Alibaba
  berbeda-beda per tujuan/protokol — lihat `08_server_quirks.md` §8).

## 9. Quirk implementasi server (penting untuk kompatibilitas)

1. **HEAD → 500**; **request tanpa User-Agent → 500** (semua path). Probe/monitoring wajib GET + UA.
2. HTTP GET polos pada server kelas B (cert Ookla) → **307** ke
   `https://server-<id>.prod.hosts.ooklaserver.net:8080/<path+query>` — tapi
   **WS upgrade polos tetap diterima (101)** di host sponsor.
3. `POST /speedtest/upload.php` **hidup** (200 `size=N`), `GET`-nya **404** — routing per-method.
4. `https_functional=1` di API **belum tentu** TLS benar (somedigit: cert
   self-signed localhost hasil auto-generate boot server) → klien web https gagal.
5. File random legacy berukuran **deterministik** antar server (245.388 /
   1.986.284 byte) tapi isinya acak per permintaan; `random4000x4000x4.jpg` tidak ada.
6. Respons XHR wajib CORS: `access-control-allow-origin` mencerminkan origin,
   `cache-control: no-store`, `Content-Length` persis sesuai `size`.

## 10. Relevansi untuk SpeedtestServer (jalur B / front gateway)

Untuk melayani **web client speedtest.net** (selain CLI yang sudah 1:1), front
gateway minimal harus mengimplementasikan:

1. `GET /hello`, `/getip`, `/capabilities`, `/ping`, `/download?size=`,
   `POST /upload`, `/upload-stats` (JSON stream) **+ path legacy**
   `/speedtest/{latency.txt, upload.php, random*.jpg, crossdomain.xml}` —
   dengan header CORS benar (origin speedtest.net) dan `Content-Length` persis.
2. Endpoint **WS `/ws`** dengan protokol teks
   `HI/GETIP/CAPABILITIES/PING/PONG/DOWNLOAD/UPLOAD/UPLOAD_STATS` (kembaran
   NetGauge TCP :5060 yang sudah diimplementasi daemon — parsing bisa
   dibagi).
3. Sertifikat TLS :8080 yang **valid untuk host yang diumumkan API**
   (pola Ookla: SAN `server-<id>.prod.hosts.ooklaserver.net` +
   `<sponsor>.prod.hosts.ooklaserver.net`) — tanpa ini, web client https
   menolak/menjatuhkan server.
4. Balas `UPLOAD_STATS` capability + stream `{"b","e","i","t":"u"}` agar angka
   upload diukur remote (metode yang dipakai web sekarang).
5. Terima `guid`/`nocache` di query (diabaikan/dipakai untuk logging), balas
   `size=<N>\n` pada upload.
6. HEAD tidak perlu didukung browser, tapi jika ingin kompatibel monitoring,
   jangan tiru quirk 500-nya.

## Index evidence

`docs/web-client-analysis/evidence/`:

| File | Isi |
|---|---|
| `01_sdk_default_settings.json` | Settings default SDK hasil ekstraksi bundle (sampling/latency/throughput/connectionProtocols) |
| `02_api_config-sdk.md` | Spesifikasi endpoint API + contoh response |
| `03_capture_auto_timeline.md` | Timeline run otomatis (annotasi) |
| `04_capture_manual_tuxsindo_timeline.md` | Timeline run manual Tuxsindo + hasil terukur |
| `05_result_payload_tuxsindo.json` | Payload penuh `POST /api/results.php` (25,9 KB) |
| `06_ws_protocol_transcripts.txt` | Transkrip mentah frame WS (probe + run nyata) |
| `07_server_probes_surabaya.json` | Probe lengkap 10 server target (DNS/port/TLS/HTTP/WS/legacy) |
| `08_server_quirks.md` | Matriks quirk implementasi server |
| `09_api_config-sdk_server_ids_response.json` | Response API `server_ids` (10 target) |
| `10_capture_auto_full.jsonl` | Log jaringan mentah run otomatis (Playwright) |
| `11_capture_manual_tuxsindo_full.jsonl` | Log mentah run manual Tuxsindo |
| `12_capture_manualui_popup_search.jsonl` | Log mentah popup "Change Server" (search API) |

Tools reproduksi: `tools/web-client-probe/` (`capture_speedtest.mjs` — Playwright
capture; `probe_servers.py` + `probe_followup.py` — probe protokol mandiri).

## Reproduksi

```bash
# capture run nyata (butuh network + Chromium; ~1 GB trafik per run penuh)
node tools/web-client-probe/capture_speedtest.mjs auto  out_auto.jsonl
node tools/web-client-probe/capture_speedtest.mjs manual out_manual.jsonl "Tuxsindo"

# probe protokol langsung ke 10 target (ringan, <1 MB per server)
python3 tools/web-client-probe/probe_servers.py
```

Pengukuran dilakukan 26 Nov 2026, 21:00–21:45 UTC dari sandbox Alibaba HK
(egress teramati: 8.212.10.159 / 47.57.232.232 / 47.57.242.119).
