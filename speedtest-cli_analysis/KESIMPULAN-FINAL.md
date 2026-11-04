# KESIMPULAN FINAL — Kelayakan Teknis Kombinasi Cloudflare Worker + VPS

> Dokumen penutup analisa untuk project [SpeedtestServer](../../README.md)
> Tanggal: 2026-11-04 · Basis: bukti empiris Speedtest CLI resmi 1.2.0 (`evidence/`),
> log engine (`prior-session/`), riset Cloudflare Workers (Okt 2026), dan kajian kode
> repo (master `f3ea41c` + branch `audit/official-cli-interoperability`).
> Dokumen pendukung: [`README.md`](README.md) (perilaku CLI) ·
> [`hybrid-architecture/README.md`](hybrid-architecture/README.md) (analisa arsitektur lengkap).

---

## Pertanyaan yang Dijawab

1. **Apakah kombinasi Cloudflare Worker + VPS untuk client speedtest RESMI (official Ookla)
   bisa dipakai secara teknis — apakah memungkinkan?**
2. **Apakah kontrol koneksi bisa di-handle oleh server side?**

---

## Jawaban Singkat (TL;DR)

| # | Pertanyaan | Jawaban | Kualifikasi |
|---|---|---|---|
| 1 | Worker + VPS untuk **client resmi Ookla**? | ❌ **TIDAK MUNGKINKAN** (untuk bagian Worker) | Dua penghalang keras: protokol biner NetGauge di TCP 8080 (Worker hanya bisa HTTP/WS) + server-list tertutup milik Ookla. Jalur satu-satunya untuk client resmi adalah **VPS-only** (sudah terbukti di branch audit, 3/3 sukses). Worker **tidak punya peran sama sekali** untuk client resmi. |
| 2 | Worker + VPS untuk **client buatan sendiri** (TypeScript/web)? | ✅ **MUNGKINKAN & LAYAK** | Preseden produksi: speed.cloudflare.com berjalan penuh di Workers. Semua limit terpenuhi (streaming tanpa batas durasi/ukuran respons; upload di-chunk ≤25 MB). |
| 3 | **Kontrol koneksi** oleh server side? | ⚠️ **SEBAGIAN (shared control)** | Server menguasai **policy & gatekeeping** (discovery, token, admission, rate limit, throttle, putuskan koneksi = *ceiling*). Client menguasai **inisiasi & scaling** jumlah koneksi paralel (*floor*). Untuk client resmi, knob policy-nya ada di tangan **Ookla**, bukan server Anda. |

---

## 1. Kelayakan Teknis untuk Client Speedtest RESMI (Official Ookla)

### 1.1 Verdict per Jenis Client

| Jenis client resmi | Bisa pakai Worker sebagai endpoint throughput? | Alasan teknis |
|---|---|---|
| **Speedtest CLI** (1.2.0, yang kami uji) | ❌ Mustahil | Berbicara protokol biner NetGauge (`HI\n` → `HELLO 2.11 (2.11.5)`) di **raw TCP 8080**. Worker hanya menerima HTTP/HTTPS/WebSocket — handshake biner akan ditolak sebagai HTTP malformed (error 400) sebelum protokol jalan. |
| **Aplikasi desktop/mobile Ookla** | ❌ Mustahil | Keluarga protokol yang sama (NetGauge/terenkripsi) di TCP 8080/5060; plus hanya memilih server dari daftar resmi Ookla. |
| **Web client HTML5** (speedtest.net) | ❌ Tidak bisa dimanfaatkan | Secara fisik memakai **WebSocket** (bisa berakhir di Worker), NAMUN payload WS tetap protokol NetGauge milik Ookla dan daftar server tetap diambil dari API resmi Ookla — endpoint custom Anda tidak akan pernah muncul di daftar itu. |
| **Client custom** (project Anda, TypeScript) | ✅ Sepenuhnya bisa | HTTP/HTTPS murni + streaming — persis model `__down`/`__up` speed.cloudflare.com. |

### 1.2 Penghalang Keras #1 — Protokol (bukti empiris)

Probe langsung ke server produksi Ookla (`evidence/07_protocol_probe.txt`):

```
Kirim: "HI\n"          → Jawab: "HELLO 2.11 (2.11.5) 2026-06-04.1737.7d0993d\n"   ← protokol biner Ookla
Kirim: "GET / HTTP/1.1" → Jawab: "307 Temporary Redirect" ke https://server-1536...  ← HTTP di-redirect
```

Port 8080 server Ookla melakukan *protocol sniffing*: biner Ookla untuk client native,
HTTP/WebSocket setelah upgrade TLS untuk client HTML5. Inilah protokol yang dipakai CLI
untuk seluruh transfer data download/upload — **bukan HTTP**.

Cloudflare Worker hanya punya *inbound* HTTP/HTTPS/WebSocket. Tidak ada produk Workers
yang menerima *raw TCP listener* (socket TCP di Workers hanya untuk koneksi **keluar**).
Cloudflare Spectrum bisa mem-proxy TCP mentah, tetapi Spectrum adalah produk Enterprise
yang meneruskan ke origin (VPS) — bukan mengeksekusi kode Worker. Artinya:

> **Tidak ada jalur teknis apa pun bagi client resmi Ookla untuk melakukan transfer
> throughput melalui Cloudflare Worker.** Batasan ini fundamental (arsitektur platform),
> bukan soal tuning/limit/kapasitas.

### 1.3 Penghalang Keras #2 — Discovery Tertutup (bukti empiris)

Log engine CLI (`prior-session/verbose_engine_config.log`) menunjukkan seluruh siklus
penentuan server dikendalikan infrastruktur Ookla:

- Client mengambil **config + server list** dari `https://cli.speedtest.net/api/cli/config`
  (respons berisi `servers: [...]` — 10 kandidat, semuanya `host: ...:8080` milik jaringan Ookla).
- Opsi CLI `-s <id>` / `-o <hostname>` **hanya memilih dari daftar itu** (man page:
  *"Specify a server from the server list"*). Hostname di luar daftar tidak akan dikenali.
- Menjadi bagian daftar resmi mensyaratkan mengikuti **Ookla Hosting Program** (perjanjian
  lisensi + menjalankan biner OoklaServer resmi — di-approve oleh Ookla). Repo ini memang
  punya integrasi Ookla Host API (ACME/Let's Encrypt), tetapi penerimaan ke daftar publik
  tetap keputusan komersial Ookla, bukan kendali teknis Anda.
  Branch audit menembusnya hanya untuk **pengujian lab** (intersepsi config endpoint),
  bukan untuk produksi publik.

### 1.4 Yang Justru TERBUKTI BISA: Mode VPS-Only untuk Client Resmi

Branch `audit/official-cli-interoperability` (2026-11-04) mengimplementasikan
`NetGaugeEngine.ts` (protokol biner `HI`/`HELLO`, single-port multiplexing
TLS/HTTP/WS/NetGauge) dan **tervalidasi 3/3 run sukses** melawan CLI resmi 1.2.0.84:
download 18,4–21,7 Gbps, upload 13,6–15,7 Gbps, packet loss 0%, exit code 0
(`validation/FINAL_REPORT.md`, `OFFICIAL_CLI_RESULTS.md`).

Jadi untuk client resmi, pola yang feasible adalah:

```
Client resmi Ookla ──(protokol biner NetGauge, TCP 8080)──▶ VPS Anda (satu-satunya endpoint)
                                                              ├── ping/latency    ✓
                                                              ├── download        ✓
                                                              └── upload          ✓
   Cloudflare Worker: TIDAK IKUT SERTA (tidak ada perannya)
```

Catatan jujur dari audit: engine terenkripsi (mode TLS-biner penuh) masih gap kecil
(severity Low, plaintext fallback dipakai saat ini), dan throughput Node single-threaded
baru ±30–37% dari daemon native OoklaServer — argumen tambahan bahwa beban throughput
memang sebaiknya tidak dipikul Node/VPS (lihat §3).

### 1.5 Kesimpulan Q1

> **Tidak, kombinasi "VPS + Cloudflare Worker" tidak bisa dipakai untuk client speedtest
> resmi Ookla — secara teknis mustahil di sisi Worker (protokol biner + discovery tertutup),
> bukan sekadar sulit.** Yang memungkinkan hanyalah dua jalur ini:
>
> 1. **Client resmi → VPS-only** (protokol biner NetGauge di VPS; sudah terbukti di branch
>    audit; Worker tidak dilibatkan sama sekali), atau
> 2. **Client custom → hibrida VPS + Worker** (VPS: ping/discovery/token/hasil;
>    Worker: download/upload; preseden speed.cloudflare.com).
>
> Kombinasi keduanya (client resmi memanfaatkan Worker) **tidak ada di ruang solusi**.

---

## 2. Apakah Kontrol Koneksi Bisa Di-handle Server Side?

Jawaban berlapis: kontrol koneksi **terbagi** antara client dan server. Memahami pembagiannya
penting karena menentukan apa yang bisa dan tidak bisa Anda atur dari VPS/Worker.

### 2.1 Peta Kendali per Lapisan

| Lapisan | Siapa yang menguasai | Bukti / mekanisme | Bisa dipindah ke server Anda? |
|---|---|---|---|
| **L1. Isi discovery** (endpoint apa yang ditawarkan) | Server | `speedtest -L` hanya menampilkan apa yang dikirim server list; CLI `--host` hanya memilih dari daftar | ✅ Untuk client custom: `GET /api/servers` Anda menentukan segalanya (URL Worker, alamat ping VPS). ❌ Untuk client resmi: daftar milik Ookla |
| **L2. Parameter engine client** (jumlah thread, durasi, max koneksi) | **Server config → client patuh** | Config CLI dikirim server: `threadCount: 4`, `testDurationSeconds: 15`, `download.maxConnections: 32`, `isScalingEnabled: true` (`prior-session/verbose_engine_config.log`); legacy `threadcount="4"` di `speedtest-config.php` | ✅ Untuk client custom: `/config` Anda memprogram engine client (kooperatif). ❌ Untuk client resmi: yang memprogram adalah server **Ookla** |
| **L3. Inisiasi koneksi TCP** | **Client** (mutlak) | Log engine: "Opening socket to …" — semua koneksi dibuka client; server hanya listen/accept | ❌ Tidak pernah — arsitektur TCP: yang connect selalu client |
| **L4. Jumlah koneksi paralel aktual** | **Client engine** (dynamic scaling) | Teramati 4→32 scaling, 10 stabil di run utama, 8–27 lintas sesi (`evidence/08_connection_timeline.csv`) — keputusan ada di engine client berdasar throughput terukur | ⚠️ Hanya secara kooperatif via L2 (client patuh) atau dibatasi dari L5 |
| **L5. Admission & enforcement** (terima/tolak, cap, throttle, putuskan) | **Server** (mutlak) | `ConnectionTracker` (maxConnections, timeout), `IpStatsManager` (rate limit per IP) sudah ada di repo; server bisa reject/close/pacing kapan pun | ✅ Selalu — ini hak kodrati sisi server |
| **L6. Routing anycast Worker** (PoP mana yang melayani) | **Cloudflare (BGP)** | Worker = anycast 330+ kota; client selalu diteruskan ke PoP terdekat | ❌ Tidak bisa dipin; hanya bisa di-observasi (`cf-ray`/colo) |

### 2.2 Interpretasi Praktis

**Ya, server side bisa meng-handle kontrol koneksi dalam arti:**

1. **Gatekeeping** — siapa yang boleh test (token sesi HMAC, validasi `ClientAuthTokenValidator`
   sudah ada), dari IP berapa (`IpStatsManager`), berapa lama (token `exp` pendek).
2. **Ceiling / batas atas** — `maxConnections` di `ConnectionTracker` (repo: 10.000 default),
   batas sesi simultan per IP, throttle/pacing per koneksi, penutupan paksa (`connectionTimeout`).
   Server selalu bisa menurunkan/memutus; client hanya bisa mencoba.
3. **Programming engine** — untuk client custom, endpoint `/config` Anda secara efektif
   *memprogram* perilaku koneksi client (jumlah stream awal, max, durasi, ramp-up) —
   persis pola Ookla yang terbukti di evidence: `threadCount 4 / maxConnections 32 /
   scaling / stableStop` semuanya datang **dari server**, dan client mematuhinya.
4. **Arahkan ke endpoint mana** — isi `/api/servers` menentukan client memukul Worker,
   VPS, atau fallback keduanya (Skenario C di `hybrid-architecture/` §6).

**Tidak, server side TIDAK bisa meng-handle kontrol koneksi dalam arti:**

1. **Memaksa client membuka koneksi** — inisiasi TCP selalu dari client (L3). Server hanya
   bisa menerima atau menolak.
2. **Menentukan jumlah paralel final secara sepihak** — keputusan scaling 4→32 diambil
   engine client berdasar throughput yang dia ukur sendiri (L4). Server bisa membatasi
   (L5) tapi tidak bisa menambah di luar kemauan client.
3. **Mengubah perilaku client resmi** — untuk client resmi Ookla, semua knob L1–L2 milik
   infrastruktur Ookla (`cli.speedtest.net`). VPS Anda tidak bisa mengubah `threadCount`,
   `maxConnections`, durasi, atau urutan fase client resmi; satu-satunya interaksi Anda
   adalah menjawab protokol biner dengan benar (dan menolak/memutus bila perlu).
4. **Mengunci PoP Worker** — anycast membuat keputusan routing ada di jaringan Cloudflare.

### 2.3 Kesimpulan Q2

> **Kontrol koneksi bersifat hybrid: server menguasai *policy* (discovery, admission,
> token, batas, throttle, pemutusan), client menguasai *eksekusi* (inisiasi dan scaling
> jumlah koneksi).** Server adalah penentu *ceiling*, client penentu *floor*.
>
> - Untuk **client custom** project ini: kontrol server-side sangat kuat dan cukup —
>   pola "config dari server → client patuh → server enforce" identik dengan model
>   yang terbukti dipakai Ookla sendiri (bukti L2), ditambah hak enforcement mutlak (L5).
> - Untuk **client resmi Ookla**: kontrol yang tersedia bagi server Anda hanyalah L5
>   (terima/tolak/batasi/putus). Semua knob perilaku client ada di tangan Ookla.

---

## 3. Rekomendasi Arsitektur Akhir (Dua Jalur / Two-Lane)

```
JALUR 1 — Client custom (TypeScript)          JALUR 2 — Client resmi Ookla
─────────────────────────────────────         ──────────────────────────────
CLIENT (TS/web)                               Speedtest CLI / apps resmi
  │ (1) GET /api/servers                        │ (1) config+server-list dari Ookla
  │ (2) ping TTFB + UDP echo ────────▶ VPS      │ (2) latency probe
  │ (3) POST /api/sessions (token)              │ (3) protokol biner NetGauge TCP 8080
  │ (4) N× GET /__down ────────────▶ WORKER     │     ────────────────────────▶ VPS ONLY
  │ (5) M× POST /__up (chunk) ──────▶ WORKER    │        (NetGaugeEngine dari branch audit;
  │ (6) POST /api/results ──────────▶ VPS       │         merge ke master = prasyarat)
  ▼                                             ▼
Hasil: metrik komposit (label jujur)          Hasil: setara server Ookla asli
```

| Aspek | Jalur 1 (custom + hibrida) | Jalur 2 (resmi + VPS-only) |
|---|---|---|
| Kelayakan teknis | ✅ Terbukti (preseden speed.cloudflare.com) | ✅ Terbukti (branch audit 3/3) |
| Peran Worker | Download/upload (hemat egress VPS ±2,3 GB/test) | — (tidak ada) |
| Peran VPS | Discovery, ping/jitter/loss (UDP+TTFB), token, hasil | Semua fase (termasuk protokol biner) |
| Kendala utama | Metrik komposit harus dilabeli jujur; body limit 100–200 MB → upload di-chunk | Throughput Node 30–37% dari native; engine terenkripsi belum; daftar resmi = persetujuan Ookla |
| Prioritas | **Utama** (sesuai visi project) | Sekunder (kompatibilitas) |

**Keputusan desain untuk owner:** jalur 1 adalah jalur produk utama yang memenuhi visi
"VPS untuk ping/discovery + Worker untuk download/upload"; jalur 2 dikerjakan terpisah
(merge branch audit) hanya bila dukungan client resmi menjadi kebutuhan — dan pada jalur
itu Worker memang tidak relevan.

---

## 4. Indeks Bukti

| Klaim kunci | Bukti |
|---|---|
| Multi-connection = banyak TCP ke SATU server (bukan multi-server) | `evidence/04_ss_samples.txt`, `evidence/08_connection_timeline.csv` |
| Protokol transfer client resmi = biner NetGauge, bukan HTTP | `evidence/07_protocol_probe.txt` (`HI`→`HELLO 2.11.5`; HTTP → 307) |
| Server list & parameter engine dikirim dari server (Ookla) | `prior-session/verbose_engine_config.log` (`threadCount 4`, `maxConnections 32`, `servers[10]`) |
| Versi protokol live == biner referensi repo (2.11.5 / 7d0993d) | `evidence/07_protocol_probe.txt` vs branch audit |
| Scaling koneksi dinamis oleh engine client | 8–27 koneksi lintas sesi (`prior-session/monitoring_*.log`), 10 stabil run utama |
| VPS-only valid untuk client resmi | branch `audit/official-cli-interoperability`: `validation/FINAL_REPORT.md` (3/3) |
| Worker layak untuk throughput | `hybrid-architecture/README.md` §3 (limit & preseden speed.cloudflare.com) |
| Enforcement server-side sudah tersedia di kode | `reverse-engineered/typescript/src/server/ConnectionTracker.ts`, `IpStatsManager.ts` |
