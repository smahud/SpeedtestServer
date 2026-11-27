# Timeline run OTOMATIS (speedtest.net web client, Chromium headless)

Semua waktu relatif terhadap load halaman (ms). Sumber: capture_auto.jsonl (Playwright).

- **3181 ms** — `GET /api/js/config-sdk?engine=js&limit=10&https_functional=true` (geoIP: Alibaba HK, 10 server terdekat)
- **3991-4192 ms** — **10 koneksi WSS paralel** dibuka untuk SELEKSI server (satu per kandidat), `wss://<host>:8080/ws`; +4 koneksi WSS tambahan saat pengukuran (loaded-latency + UPLOAD_STATS)
- tiap koneksi mengirim berurutan: `HI` → `GETIP` → `CAPABILITIES` → `PING ` (kosong), lalu `PING <elapsed_ms>`
- tiap server menjawab: `HELLO 2.11 (2.11.x) <build>` → `YOURIP <ip>` → `CAPABILITIES SERVER_HOST_AUTH UPLOAD_STATS` → `PONG <epoch_ms>`
- jumlah TOTAL paket PING per koneksi WSS (seleksi 5 sampel + server terpilih melanjutkan ping sepanjang pengukuran = loaded-latency/bufferbloat): {'1010': 6, 'kami': 6, 'hk-hkg12': 3003, 'hkt': 6, 'hkspeedtest': 6, 'sunmobile': 6, 'suntechspeedtest': 6, 'hk1': 6, 'speedtest-hkg': 6, 'speedtest21': 6}
- **10052 ms** — fase DOWNLOAD dimulai: XHR `GET /download?size=25000000` ke **4 server sekaligus** (round-robin), tiap koneksi XHR baru diawali `GET /hello?guid=...&nocache=...`
- **26683 ms** — fase UPLOAD dimulai: `POST /upload` (octet-stream, byte acak) hanya ke server terpilih + `UPLOAD_STATS 15000 50 0` via WSS
- server membalas statistik upload sebagai stream JSON newline-delimited: `{"b":<kumulatif>,"e":<elapsed_ms>,"i":<index>,"t":"u"}` setiap ~50 ms (302 frame tercatat, terakhir `{"b":1140556608,"e":15027,"i":300,"t":"u`)
- **41852 ms** — `POST /api/results.php` (payload JSON ~25 KB) → 42174 ms `200`

## Statistik PING server terpilih (latency-under-load, WSS)
- `hk-hkg12.speed.misaka.one:8080`: 3003 paket PING terkirim selama download+upload (bufferbloat measurement), RTT ~5-6 ms