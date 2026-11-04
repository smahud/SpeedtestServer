# Analisa Perilaku Speedtest CLI (Ookla) — Multi-Connection

> Tanggal uji: 2026-11-04 · Tool: `speedtest` CLI **1.2.0.84** (`ea6b6773cf`, Linux x86_64 musl)
> Installer: `https://install.speedtest.net/app/cli/ookla-speedtest-1.2.0-linux-x86_64.tgz`
> Lingkungan uji: sandbox Linux (jaringan keluar via Hong Kong, ISP terdeteksi: Alibaba)

> 📌 **Dokumen terkait dalam direktori ini**:
> [`KESIMPULAN-FINAL.md`](KESIMPULAN-FINAL.md) — jawaban akhir kelayakan kombinasi
> Worker + VPS (client resmi vs custom) dan analisa kontrol koneksi server-side ·
> [`hybrid-architecture/README.md`](hybrid-architecture/README.md) — analisa arsitektur lengkap
> (limit Cloudflare Workers, gap analysis kode, roadmap implementasi)

## Pertanyaan Awal

> "Lakukan testing speedtest cli apakah saat menggunakan multi connection.
> Cek apakah berbeda server atau koneksi simultan di server yang sama."

## Jawaban Singkat

**Multi-connection pada Speedtest CLI = banyak koneksi TCP simultan ke SATU server yang sama.**

Bukti kunci (`evidence/04_ss_samples.txt`, `evidence/08_connection_timeline.csv`):

- Client menyeleksi **satu** server terbaik di awal (fase discovery), lalu seluruh test
  (download & upload) diarahkan ke **satu IP:port yang sama**.
- Selama fase **download**: **koneksi TCP simultan di-scale dinamis** — 10 koneksi stabil
  pada run utama (bucket 1.5s–7.5s) menuju `219.76.98.50:8080`; lintas sesi teramati
  8–27 koneksi (batas engine: 32, lihat bagian Engine Config).
- Selama fase **upload**: **6–8 koneksi TCP simultan** (bucket 8.0s–17.0s) ke server yang sama.
- Total **17 local port berbeda** terpakai sepanjang run terhadap server tersebut.
- Server lain hanya tersentuh sesaat pada fase seleksi (`203.171.30.36:8080`, 2 sampel = probe latency), **bukan** untuk transfer data.

## Metodologi

1. Download & extract installer resmi Ookla (tgz), verifikasi versi (`--version` = 1.2.0.84).
2. `speedtest -L -f json` → daftar kandidat server terdekat.
3. `speedtest --selection-details -f json-pretty` → proses seleksi server (latency tiap kandidat).
4. `speedtest -f json` dijalankan **di background** sambil sampling `ss -tn state established`
   setiap ±100 ms (172 sampel / 18.1 detik) → profil koneksi TCP nyata.
5. Probe manual protokol port 8080 dengan socket Python: kirim `HI\n` dan `GET / HTTP/1.1`.
6. `curl https://www.speedtest.net/speedtest-config.php` → konfigurasi global yang dipakai client.

## Fase Kerja Speedtest CLI (hasil observasi)

| # | Fase | Bukti | Tujuan |
|---|------|-------|--------|
| 1 | **Config** | koneksi HTTPS ke `cli.speedtest.net` (di belakang Cloudflare: `104.17.148.22/147.22`); endpoint `api/cli/config` memberi engine config + server list — tercapture di `prior-session/verbose_engine_config.log`; endpoint legacy `speedtest-config.php` (geo, `threadcount="4"`, `ignoreids`) juga terverifikasi | client tahu parameter engine + kandidat server |
| 2 | **Server list** | `speedtest -L` mengembalikan 10 kandidat, semuanya `port: 8080` (`evidence/01_servers_list.json`) | daftar server kandidat terdekat |
| 3 | **Seleksi (latency probe)** | `--selection-details`: client mengukur latency ke tiap kandidat (ada yang gagal/timeout), memilih **satu** dengan latency terendah (`evidence/02_selection_details.json`) | pemilihan server terbaik — hanya ping, tanpa data |
| 4 | **Download** | **4–32 koneksi TCP simultan (dynamic scaling)** ke server terpilih — run utama: 10 koneksi selama ±6–7 detik (`evidence/08_connection_timeline.csv`); sesi sebelumnya: hingga 26–27 koneksi | saturasi bandwidth download via koneksi paralel |
| 5 | **Upload** | 6–8 koneksi simultan ke server yang sama selama ±10 detik | saturasi bandwidth upload |
| 6 | **Result** | `resultUrl` pada output JSON; koneksi HTTPS singkat ke speedtest.net | submit hasil |

## Hasil Numerik Run Utama (`evidence/03_default_run.json`)

| Metrik | Nilai |
|---|---|
| Server terpilih | `suntechspeedtest.com` (STC, id 1536, `219.76.98.50:8080`, Hong Kong) |
| Latency idle | 5.315 ms (jitter 0.045 ms) |
| Download | 158.82 MB/s ≈ **1.27 Gbps** (1.1 GB dalam 7.0 s) |
| Upload | 124.83 MB/s ≈ **0.999 Gbps** (1.23 GB dalam 9.7 s) |
| Packet loss | 0 % |

Run kedua (verbose) memilih server lain — `GSL Networks Hong Kong` (id 48446) — dan mencapai
download **3354 Mbps**: konfirmasi bahwa server terpilih bisa berbeda antar-run (yang
tercepat-latency menang), tetapi **pola satu-server-multi-koneksi selalu sama**.

## Engine Config CLI (temuan kunci dari sesi sebelumnya)

Log verbose sesi pengujian pertama (`prior-session/verbose_engine_config.log`)
menangkap konfigurasi engine yang diambil CLI 1.2.0 dari
`https://cli.speedtest.net/api/cli/config?deviceId=…&hid=…&sid=…&uname=…` (respons 200,
JSON). Poin penting:

| Parameter engine | Nilai | Makna |
|---|---|---|
| `engine.threadCount` | **4** | jumlah thread dasar |
| `engine.download.maxConnections` | **32** + `isScalingEnabled: true` | **koneksi download melakukan scaling dinamis hingga 32** |
| `engine.testDurationSeconds` | 15 | durasi maksimal per arah |
| `dynamic.stableStop.isEnabled` | true | test berhenti lebih awal bila hasil stabil (teramati: download selesai ±7 detik) |
| `engine.packetSizeBytes` | 32.000.000 | ukuran paket upload |
| `testStage.latency.pingCount` | 5 | jumlah ping untuk latency idle |
| `loadedLatency` | `enableUdp: true`, `enableTcp: true` | loaded latency diukur via UDP dan TCP |
| `saveTestResultUrl` | `https://results.speedtest.net/reports` | endpoint submit hasil |

Rentang koneksi simultan yang teramati lintas sesi — konsisten dengan scaling dinamis
(maks 32) di atas:

| Run | Server tujuan | Maks koneksi simultan | Sumber |
|---|---|---|---|
| Skenario A (sesi sebelumnya) | `202.165.70.3:8080` | **26** | `prior-session/monitoring_koneksi_skenario_A.log` (112 poll) |
| Skenario B (sesi sebelumnya) | `203.185.10.2:8080` | **8** | `prior-session/monitoring_koneksi_skenario_B.log` (184 poll) |
| Skenario C (sesi sebelumnya) | `202.165.70.3:8080` | **27** | `prior-session/monitoring_koneksi_skenario_C.log` (131 poll) |
| Run utama (sesi ini) | `219.76.98.50:8080` | **10** | `evidence/08_connection_timeline.csv` |

Catatan menarik: `cli.speedtest.net` resolve ke `104.17.148.22` / `104.17.147.22`
(blok Cloudflare) — **Ookla sendiri melayani config API CLI-nya lewat jaringan
Cloudflare**. Log sesi sebelumnya juga memuat atribusi proses langsung
(`users:(("speedtest",pid=…,fd=…))`) yang memastikan koneksi memang milik proses
speedtest, plus resolusi DNS A/AAAA tiap kandidat server sebelum seleksi
(`server selected: 28912` — fdcservers.net pada run tersebut).

## Protokol Server Ookla (bukti `evidence/07_protocol_probe.txt`)

Port **8080** pada server Ookla bersifat **multi-protokol (protocol sniffing)**:

1. **Protokol biner Ookla**: kirim `HI\n` → dijawab `HELLO 2.11 (2.11.5) 2026-06-04.1737.7d0993d\n`.
   Inilah protokol yang dipakai Speedtest CLI untuk transfer data (bukan HTTP biasa).
2. **HTTP**: `GET / HTTP/1.1` → `307 Temporary Redirect` ke
   `https://server-1536.prod.hosts.ooklaserver.net:8080/` (redirect ke HTTPS).

Artinya: satu port 8080 melayani (a) protokol biner Ookla untuk client native/CLI,
(b) HTTP→redirect, dan (c) setelah upgrade TLS, WebSocket untuk client HTML5.

## Mengapa Paralel, Bukan Server Berbeda?

- Throughput satu koneksi TCP dibatasi window/congestion control terhadap RTT;
  N koneksi paralel ke server yang sama meng-agregasi throughput (teramati: 1.27–3.35 Gbps
  dari 10 koneksi ≈ 127–335 Mbps per koneksi; jumlah koneksi di-scale dinamis 4→32).
- Server berbeda akan membuat hasil tidak deterministik (peering/path berbeda-beda) dan
  sulit dijadikan metrik; Ookla memilih **satu server = satu jalur jaringan yang konsisten**.
- Latency probe ke banyak kandidat hanya terjadi di fase seleksi (paket kecil), bukan bagian
  dari pengukuran throughput.

## Struktur Direktori

```
speedtest-cli_analysis/
├── README.md                       # dokumen ini (perilaku multi-connection CLI)
├── KESIMPULAN-FINAL.md             # JAWABAN AKHIR: kelayakan Worker+VPS (client resmi/custom)
│                                   #   + analisa kontrol koneksi server-side vs client-side
├── hybrid-architecture/
│   └── README.md                   # analisa arsitektur hibrida lengkap (limit Workers,
│                                   #   gap analysis kode, risiko, roadmap 5 tahap)
├── evidence/                       # pengujian sesi 2026-11-04 (run kedua)
│   ├── 01_servers_list.json        # daftar 10 server kandidat (speedtest -L)
│   ├── 02_selection_details.json   # proses seleksi: latency tiap kandidat + server terpilih
│   ├── 03_default_run.json         # hasil run utama (JSON lengkap, server + metrik)
│   ├── 04_ss_samples.txt           # sampel mentah ss (172 sampel @ ±100ms)
│   ├── 05_verbose_log.txt          # log verbose run kedua (server GSL Networks, 3.3 Gbps)
│   ├── 06_api_servers.json         # respons API servers (403 tanpa header client)
│   ├── 07_protocol_probe.txt       # probe protokol biner HI→HELLO + HTTP 307
│   └── 08_connection_timeline.csv  # timeline koneksi simultan per bucket 0.5 detik
└── prior-session/                  # artefak pengujian sesi pertama (2026-11-04, sebelum run kedua)
    ├── Laporan_Testing_Speedtest_CLI_MultiConnection.pdf  # laporan PDF sesi pertama
    ├── monitoring_koneksi_skenario_A.log  # ss monitoring skenario A (maks 26 koneksi)
    ├── monitoring_koneksi_skenario_B.log  # ss monitoring skenario B (maks 8 koneksi)
    ├── monitoring_koneksi_skenario_C.log  # ss monitoring skenario C (maks 27 koneksi)
    ├── verbose_engine_config.log          # log verbose + capture engine config dari cli.speedtest.net
    ├── cover_laporan.html                 # aset laporan (cover)
    └── diagram_arsitektur.html            # aset laporan (diagram arsitektur)
```

(Skrip pengujian berada di luar repo — environment sandbox.)

## Relevansi untuk Project SpeedtestServer

Temuan ini adalah dasar desain untuk arsitektur hibrida **VPS (ping/discovery) + Cloudflare
Worker (download/upload)** — analisa lengkap ada di
[`hybrid-architecture/README.md`](hybrid-architecture/README.md), dan jawaban akhir
kelayakan kombinasi tersebut (termasuk untuk client resmi Ookla) ada di
[`KESIMPULAN-FINAL.md`](KESIMPULAN-FINAL.md).

Poin penghubung:

1. Model Ookla = **satu endpoint throughput + N koneksi paralel** → pada arsitektur hibrida,
   endpoint throughput digantikan Worker (client tetap membuka N stream paralel ke SATU
   endpoint Worker).
2. Fase **discovery + seleksi latency** adalah fase paling ringan (paket kecil) → cocok
   dipertahankan di VPS.
3. Fase **download/upload** adalah fase berat (2.3 GB data untuk satu run!) → inilah beban
   yang ingin dialihkan ke Cloudflare Worker.
