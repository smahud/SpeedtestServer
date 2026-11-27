# Timeline run MANUAL (pilih server via UI 'Change Server' → Surabaya → PT. Tuxsindo Cyber Networks, id 66281)

Sumber: capture_manual2.jsonl. Server terpilih: speedtest.tuxsnet.id.prod.hosts.ooklaserver.net:8080 (OoklaServer 2.11.7).

- **1290 ms** — load homepage → `config-sdk?engine=js&limit=10&https_functional=true` (daftar 'nearby' untuk UI)
- **15300 ms** — tombol GO diklik (server sudah dipilih manual dari popup; popup search memanggil `config-sdk?engine=js&search=Surabaya&https_functional=true&limit=100`)
- **16505 ms** — WSS `wss://speedtest.tuxsnet.id.prod.hosts.ooklaserver.net:8080/ws` untuk stage LATENCY
  - `16568: HI 5d016376-1911-47e9-ac4c-8f7ed2c80fd5`
  - `16569: GETIP`
  - `16569: CAPABILITIES`
  - `16569: PING `
  - `16630: HELLO 2.11 (2.11.7) 2026-10-26.2035.bc130b4`
  - `16630: YOURIP 47.57.232.232
`
  - `16630: CAPABILITIES SERVER_HOST_AUTH UPLOAD_STATS`
  - `16630: PONG 1795728654225
`
  - `16632: PING 16510.700000000186`
  - `16691: PONG 1795728654286
`
  - `16691: PING 16570.30000000028`
  - `16753: PONG 1795728654347
`
  - `16753: PING 16631.80000000028`
  - `16815: PONG 1795728654409
`
- **18706 / 35490 ms** — WSS tambahan untuk loaded-latency (ping selama download/upload)
- **18775 ms** — download: 24 XHR `GET /download` (semua hanya ke server terpilih; ukuran adaptif 25.000.000 → ~28 MB), tiap koneksi diawali `GET /hello` (total 11)
- **35412 ms** — upload: 25 XHR `POST /upload` + `UPLOAD_STATS` via WSS
- **50633 ms** — `POST /api/results.php` → `200`; payload lengkap tersimpan sebagai `05_result_payload_tuxsindo.json`

## Hasil terukur (dari payload results.php)
- ping (idle, 10 sampel): median 61.6 ms, iqm 61.07000000000001, min 59.5, max 62.9, jitter 2.067
- download: 327.2 Mbps (583 MB), latency-under-load iqm 66.468 ms (213 sampel)
- upload: 299.5 Mbps (547 MB, ukur metode `remote`), latency-under-load iqm 65.274 ms (223 sampel)
- testmethod: `wss,xhrs,xhrs` (latency=wss, download=xhrs, upload=xhrs), serverVersion 2.11.7 (2026-10-26.2035.bc130b4)