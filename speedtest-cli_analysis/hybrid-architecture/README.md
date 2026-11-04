# Analisa Arsitektur Hibrida: VPS (Ping/Discovery) + Cloudflare Worker (Download/Upload)

> Dokumen analisa untuk project [SpeedtestServer](../../README.md)
> Tanggal: 2026-11-04 · Basis bukti: pengujian empiris Speedtest CLI 1.2.0
> ([`speedtest-cli_analysis/`](../README.md)) + riset dokumentasi
> Cloudflare Workers (Oktober 2026) + kajian kode project saat ini.

---

## Ringkasan Eksekutif (Verdict)

**Target kombinasi "VPS untuk ping/pencarian koneksi + Cloudflare Worker untuk
download/upload" BISA dipenuhi — dengan dua kondisi besar:**

1. **Client harus client buatan sendiri** (TypeScript/web app milik project).
   Client resmi Ookla (CLI/app/website) **tidak mungkin** memakai Worker sebagai
   endpoint throughput, karena client resmi hanya berbicara protokol biner Ookla
   di TCP 8080 (bukti empiris: [`evidence/07_protocol_probe.txt`](../evidence/07_protocol_probe.txt))
   dan hanya mau server yang terdaftar di server-list resmi Ookla.
2. **Hasil pengukuran harus dipahami sebagai metrik komposit**: latency diukur ke VPS,
   throughput diukur ke edge Cloudflare (PoP terdekat via anycast). Ini dua jalur jaringan
   yang berbeda — sah untuk mengukur "kualitas internet pengguna" (preseden:
   [speed.cloudflare.com](https://speed.cloudflare.com)), tetapi **bukan** mengukur
   "kecepatan menuju VPS Anda".

Untuk mode kompatibel client resmi Ookla, satu-satunya jalan adalah VPS melayani sendiri
seluruh protokol — termasuk protokol biner `HI`/`HELLO`. Di **master** protokol biner ini
**belum** ada (yang ada baru HTTP/HTTPS/WebSocket/UDP-echo), namun branch
**`audit/official-cli-interoperability`** (2026-11-04) sudah mengimplementasikannya
(`NetGaugeEngine.ts`, single-port multiplexing) dan tervalidasi 3/3 run sukses dengan CLI
resmi 1.2.0.84 (lihat §4 dan §6).

---

## 1. Breakdown Konsep

### 1.1 Arsitektur Target

```
                                  ┌─────────────────────────────┐
                                  │   VPS (SpeedtestServer TS)  │
                                  │  - node ringan, bandwidth   │
                                  │    kecil sudah cukup        │
                                  └───────────┬─────────────────┘
                                              │
   (1) GET /api/servers  ────────────────▶    │ discovery: daftar endpoint per peran
   (2) GET /latency.txt (TTFB) + UDP echo ▶   │ ping/jitter (jalur ke VPS)
   (3) POST /api/sessions ───────────────▶    │ terbitkan token sesi (HMAC)
                                              │
        ┌─────────────────────────────────────┘
        │
        ▼
┌──────────────────┐        (4) N × GET  /__down?bytes=…   ┌──────────────────────┐
│  CLIENT (TS/web) │ ────────────────────────────────────▶ │  Cloudflare Worker   │
│  engine ramp-up  │        (5) M × POST /__up (chunked)   │  (anycast, 330+ kota)│
│  N koneksi par.  │ ◀──────────────────────────────────── │  streaming murni,    │
└────────┬─────────┘        hasil: jumlah byte/μs          │  tanpa origin server │
         │                                                  └──────────────────────┘
         │  (6) POST /api/results (+token)
         ▼
   kembali ke VPS: agregasi hasil, statistik (IpStatsManager), MetricsUploader
```

### 1.2 Prinsip Pembagian Kerja

| Fase | Beban jaringan | Kenapa ditaruh di VPS / Worker |
|---|---|---|
| Discovery (server list) | Paket kecil, jarang | Perlu kontrol penuh (endpoint mana yang ditawarkan), state di satu tempat |
| Ping / jitter / packet loss | Paket kecil, frekuensi tinggi | Harus **jalur yang stabil dan terukur ke lokasi tetap** (VPS). Worker anycast membuat "ping ke Worker" = ping ke PoP terdekat, bukan ke server Anda |
| Download throughput | **Sangat berat** (bukti: 1.1 GB per run) | Worker: streaming tanpa batas ukuran respons, tanpa biaya egress, terdistribusi ke PoP terdekat client |
| Upload throughput | **Sangat berat** (bukti: 1.23 GB per run) | Worker: menelan request body secara streaming; VPS hemat bandwidth ingress |
| Result intake | Kecil | VPS: sentralisasi data + statistik |

Intuisi biaya: pada model Ookla murni, satu run test menghabiskan ±2.3 GB melalui SATU
server (bukti: `../evidence/03_default_run.json` — 1,106,797,998 byte down + 1,232,900,097
byte up). Dengan arsitektur hibrida, 2.3 GB itu melewati jaringan Cloudflare, bukan
uplink VPS Anda.

---

## 2. Cara Kerja Speedtest Client (Evidence) dan Implikasi Desain

Hasil pengujian empiris CLI 1.2.0 (detail lengkap di
[`speedtest-cli_analysis/README.md`](../README.md)):

| # | Fase (teramati) | Bukti | Implikasi untuk arsitektur hibrida |
|---|---|---|---|
| 1 | Ambil config global + server list dari `cli.speedtest.net/api/cli/config` (di belakang Cloudflare); legacy: `speedtest-config.php` (geo, `ignoreids`) | `../prior-session/verbose_engine_config.log`, `../evidence/06_api_servers.json` | Gantikan dengan `GET /config` di VPS — client custom tidak butuh config Ookla |
| 2 | Ambil server list (10 kandidat, semua port 8080) | `../evidence/01_servers_list.json` | Gantikan dengan `GET /api/servers` di VPS: daftar berisi **endpoint Worker (throughput) + alamat VPS (ping)** — pemisahan per-peran |
| 3 | Probe latency ke tiap kandidat → pilih SATU terbaik | `../evidence/02_selection_details.json` (ada kandidat gagal/timeout, dipilih latency terendah) | Di model hibrida, "seleksi" menjadi sederhana: ping ke VPS (dan opsional TTFB ke Worker sebagai "edge latency"); tidak ada pemilihan server throughput — Worker otomatis anycast |
| 4 | Download: **koneksi TCP simultan di-scale dinamis (4→32)** ke server yang sama, ±7 detik (early-stop saat stabil) | `../evidence/08_connection_timeline.csv` (10 koneksi stabil pada run utama, bucket 1.5–7.5s); sesi sebelumnya: 8–27 koneksi; engine config `maxConnections: 32, isScalingEnabled: true` | Client custom membuka **N stream paralel ke endpoint Worker yang sama** dengan scaling adaptif (mis. mulai 4, naik sampai 16–32 sesuai throughput terukur) — meniru pola agregasi & dynamic-scaling Ookla |
| 5 | Upload: **6–8 koneksi simultan**, ±10 detik | bucket 8–17s pada timeline | Sama: POST paralel ber-chunk ke `/__up` |
| 6 | Submit hasil (resultUrl) | output JSON run | `POST /api/results` ke VPS + token sesi |

**Temuan protokol paling menentukan** (`../evidence/07_protocol_probe.txt`): port 8080 server
Ookla melakukan *protocol sniffing* —

- Kirim `HI\n` → dijawab `HELLO 2.11 (2.11.5) 2026-06-04.1737.7d0993d\n` (protokol biner,
  dipakai CLI untuk transfer data);
- Kirim `GET / HTTP/1.1` → `307 Temporary Redirect` ke
  `https://server-<id>.prod.hosts.ooklaserver.net:8080/` (HTTP diarahkan ke HTTPS).

Cloudflare Worker **hanya bisa menerima HTTP/WebSocket** (lihat §3), sehingga Worker
secara fundamental tidak dapat mengemulasi protokol biner Ookla — inilah akar batasan
"client resmi tidak didukung".

Catatan kecil: engine config CLI (tercapture di `../prior-session/verbose_engine_config.log`)
memuat `threadCount: 4` dan `download.maxConnections: 32` dengan `isScalingEnabled:
true` + `stableStop` — observasi koneksi nyata lintas sesi (8–27, run utama 10) konsisten
dengan scaling dinamis tersebut; untuk desain client custom, gunakan angka hasil
observasi/penyetelan sendiri (4–32). Endpoint config CLI (`cli.speedtest.net`)
bahkan dilayani dari jaringan Cloudflare — preseden langsung bahwa infrastruktur
Cloudflare dipakai Ookla untuk API ringan berlatensi sensitif.

---

## 3. Kajian Cloudflare Worker (Fakta Terdokumentasi, Okt 2026)

### 3.1 Limit yang Relevan untuk Speed Test

| Aspek | Nilai | Dampak ke desain |
|---|---|---|
| **Duration (wall-clock) HTTP** | **Tidak ada batas** — selama client terkoneksi, Worker boleh terus streaming | ✅ Streaming download 10–30 detik aman |
| **Response body size** | **Tidak dibatasi** (streaming) | ✅ Download sebesar apa pun (Ookla mengirim 1.1 GB/run) |
| **Request body size** (upload ke Worker) | 100 MB (Free/Pro), 200 MB (Business), s.d. 5 GB (Enterprise, self-serve) | ⚠️ Upload **wajib di-chunk** (mis. 25 MB/chunk) — sama persis pola speed.cloudflare.com |
| **CPU time per request** | 10 ms (Free); default 30 s, maks 5 menit (Paid) — rata-rata Worker ±2.2 ms | ⚠️ Jangan `crypto.randomBytes()` besar per request; pakai buffer tetap + `ReadableStream` |
| **Memori per isolate** | 128 MB | ⚠️ Dilarang men-buffer response/request utuh di memori |
| **Request/hari (Free)** | 100.000 | ✅ 1 test ≈ 10–30 request (stream & chunk) → ±3.000–10.000 test/hari gratis |
| **Subrequest per request** | 50 (Free) / 10.000 (Paid) | ✅ Tidak dibutuhkan bila token diverifikasi lokal (HMAC) |
| **Koneksi keluar simultan** | 6 per request | ✅ Tidak relevan untuk serving (client→Worker tak dihitung) |
| **WebSocket** | Upgrade awal dihitung 1 request; **pesan tidak dihitung** | ✅ Opsi protokol WS gaya client HTML5 Ookla bisa jalan di Worker |
| **Biaya egress** | Tidak ada biaya bandwidth untuk Worker (bayar per request + CPU) | ✅ Motivasi utama offload throughput dari VPS |

### 3.2 Port yang Didukung Jaringan Cloudflare

- **HTTP**: 80, **8080**, 8880, 2052, 2082, 2086, 2095
- **HTTPS**: 443, 2053, 2083, 2087, 2096, 8443

Kecocokan yang menarik: **8080 tersedia** (port kebiasaan Ookla), tetapi hanya untuk
**HTTP** — bukan protokol biner. Untuk produksi tetap disarankan **443/HTTPS**.
Semua port non-standar (2052 dst.) memiliki caching dinonaktifkan; untuk endpoint test
kita set `Cache-Control: no-store` di semua kasus supaya tidak tercache.

### 3.3 Preseden: speed.cloudflare.com (Bukti Kelayakan Terkuat)

Cloudflare sendiri menjalankan speed test **sepenuhnya di atas Workers** di 330+ kota
(sumber: [halaman About resmi](https://speed.cloudflare.com/about) dan
[blog engineering](https://blog.cloudflare.com/how-does-cloudflares-speed-test-really-work)):

- Endpoint API: `GET /__down?bytes=N` (download) dan `POST /__up` (upload) —
  dikonfirmasi di [repo open-source cloudflare/speedtest](https://github.com/cloudflare/speedtest).
- Metodologi: **ramp-up** ukuran file progresif, bandwidth dihitung dari **persentil ke-90**;
  ping = **TTFB** (permintaan `bytes=0`); jitter = delta antar-ping; ada pengukuran
  *loaded latency* (latency saat jalur sedang dipakai transfer).
- Konsumsi data per test: **sampai ±200 MB** (footer resmi speed.cloudflare.com).
- Client-nya punya opsi `downloadApiUrl`/`uploadApiUrl` yang bisa diarahkan ke Worker sendiri.

Artinya: **pola "Worker sebagai server throughput" sudah terbukti di produksi skala global**
— yang baru di project Anda hanyalah memindahkan fase ping/discovery ke VPS sendiri.

### 3.4 Hal yang TIDAK Bisa Dilakukan Worker

1. **Protokol biner Ookla** (raw TCP di 8080) — Worker hanya menerima HTTP/WebSocket.
2. **UDP echo** untuk ping/jitter — tidak ada UDP masuk ke Worker (packet loss di
   speed.cloudflare.com pun memakai TURN server). → Ping UDP **harus tetap di VPS**
   (sudah ada implementasi UDP-echo di project ✓).
3. **Anycast = tidak bisa menarget lokasi**: client selalu diteruskan ke PoP terdekat.
   Ping ke Worker bukan ping ke lokasi tetap Anda.

---

## 4. Kondisi Project Saat Ini vs Target (Gap Analysis)

Kajian atas `reverse-engineered/typescript/src/server/*` **master** (commit `f3ea41c`)
dan branch `audit/official-cli-interoperability`:

| Komponen | Status | Gap untuk target hibrida |
|---|---|---|
| `OoklaRequestHandler.ts` — HTTP/HTTPS/WS server | ✅ Ada | Perlu endpoint baru: `/api/servers`, `/api/sessions`, `/api/results` |
| UDP echo (latency/jitter) di `OoklaRequestHandler.ts` | ✅ Ada (master); audit branch punya `UdpLossEngine` dengan anti-spoof session binding | Sudah pas untuk peran ping VPS |
| `ClientAuthTokenValidator.ts` | ✅ Ada | Dipakai untuk terbitkan/validasi token sesi; perlu varian **HMAC stateless** agar Worker bisa verifikasi tanpa subrequest ke VPS |
| `IpStatsManager.ts` (rate limit per IP) | ✅ Ada | Pertahankan di VPS; di sisi Worker tambahkan rate-limit sederhana (mis. berbasis token exp) |
| `handleDownload` (`OoklaRequestHandler.ts`, handler `GET /download`) | ⚠️ **Buffer penuh** `crypto.randomBytes(size)` maks 100 MB, dikirim sekali `res.end()` | Harus jadi **streaming** (loop `res.write` dari buffer 64 KB reuse, hormati backpressure) — pola yang sama persis dibutuhkan di Worker. (Audit branch sudah memperbaiki ini: "backpressure-aware streaming") |
| `handleUpload` (handler `POST /upload`) | ⚠️ `Buffer.concat` seluruh body di memori | Harus **streaming count** (`req.on('data')` increment saja, jangan disimpan) |
| Protokol biner Ookla/NetGauge (`HI`→`HELLO` di 8080) | ❌ **Belum ada di master** · ✅ **Sudah ada di branch `audit/official-cli-interoperability`** (`NetGaugeEngine.ts`, single-port multiplexing TLS/HTTP/WS/NetGauge, tervalidasi 3/3 dengan CLI resmi; engine terenkripsi belum — masih plaintext fallback) | Untuk client resmi Ookla (mode VPS-only). **Tidak mengubah posisi Worker**: Worker tetap tidak bisa bicara protokol ini |
| Endpoint discovery gaya `api/js/servers` | ❌ Belum ada | Dibutuhkan client custom (berisi URL Worker + alamat ping VPS) |
| Worker Cloudflare (`worker/`) | ❌ Belum ada di repo | Komponen baru: `__down`, `__up`, verifikasi token, CORS |
| ACME/Let's Encrypt (`TLSCertificateManager.ts`) | ✅ Ada | HTTPS VPS siap |
| `MetricsUploader.ts`, `Logger.ts`, `ConnectionTracker.ts` | ✅ Ada | Intake hasil & observabilitas tinggal disambungkan |

**Catatan performa dari audit branch** (`PERFORMANCE_REPORT.md`): throughput Node.js
single-threaded hanya mencapai **±30–37% dari daemon native OoklaServer** pada loopback.
Ini justru **memperkuat argumen offload throughput ke Cloudflare Worker**: VPS Node
adalah bottleneck throughput, sementara Worker edge terbukti (preseden
speed.cloudflare.com) mampu melayani throughput skala besar di banyak lokasi sekaligus.

**Cross-validasi versi**: probe live server Hong Kong pada pengujian kami menghasilkan
`HELLO 2.11 (2.11.5) 2026-06-04.1737.7d0993d` — **identik** dengan biner referensi
OoklaServer 2.11.5.2 `2026-06-04.1737.7d0993d` yang dipakai branch audit. Artinya bukti
perilaku protokol pada `speedtest-cli_analysis/` berlaku langsung untuk baseline
reverse-engineering project ini.

---

## 5. Pemetaan Fase → Komponen (Desain Rujukan)

| Fase test | Pelaksana | Endpoint (usulan) | Protokol | Catatan teknis |
|---|---|---|---|---|
| 1. Config | VPS | `GET /config` | HTTPS | Versi, opsi test, URL semua peran |
| 2. Server list / discovery | VPS | `GET /api/servers` | HTTPS | `{ ping: [vps], throughput: [worker-url] }` |
| 3. Token sesi | VPS | `POST /api/sessions` | HTTPS | Balas HMAC token `{guid, ip, exp}` (kunci sama dengan Worker) |
| 4. Ping idle + jitter | VPS | `GET /latency.txt` (TTFB) + UDP echo | HTTPS + UDP | Ukur RTT; jitter dari deret sampel |
| 4b. (opsional) Edge latency | Worker | `GET /__down?bytes=0` | HTTPS | TTFB ke PoP terdekat — pembanding, gaya speed.cloudflare.com |
| 5. Download | **Worker** | `GET /__down?bytes=N` × N paralel, ramp-up | HTTPS | Stream dari buffer tetap; `no-store`; hitung byte & waktu di client |
| 6. Upload | **Worker** | `POST /__up` × M paralel, chunk ≤25 MB | HTTPS | Worker hanya menguras & menghitung byte; balas `{bytes}` |
| 7. Loaded latency | Worker | `GET /__down?bytes=0` selama transfer | HTTPS | Interval ±400 ms (pola cloudflare/speedtest) |
| 8. Submit hasil | VPS | `POST /api/results` | HTTPS | +token; masuk ConnectionTracker/IpStats/MetricsUploader |

Sketsa inti Worker (ilustrasi, bukan implementasi final):

```typescript
// worker/src/index.ts — pola streaming hemat CPU & memori
const CHUNK = new Uint8Array(64 * 1024);        // buffer tetap, di-generate sekali saat init
crypto.getRandomValues(CHUNK);

export default {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/__down") {            // download: streaming N bytes
      const bytes = Number(url.searchParams.get("bytes") || 0);
      if (bytes === 0) return new Response(null, { headers: H });   // ping via TTFB
      let sent = 0;
      const stream = new ReadableStream({
        pull(ctrl) {
          if (sent >= bytes) return ctrl.close();
          const n = Math.min(CHUNK.length, bytes - sent);
          sent += n; ctrl.enqueue(CHUNK.subarray(0, n));
        },
      });
      return new Response(stream, { headers: { ...H, "Content-Length": String(bytes) } });
    }

    if (url.pathname === "/__up") {              // upload: kuras & hitung, JANGAN di-buffer
      let received = 0;
      const reader = req.body?.getReader();      // streaming, tanpa buffering utuh
      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value!.length;               // hitung saja, data dibuang
      }
      return new Response(JSON.stringify({ bytes: received }), { headers: H });
    }
    return new Response("Not found", { status: 404 });
  },
};
```

Prinsip yang sama berlaku untuk `handleDownload`/`handleUpload` di VPS (untuk mode
VPS-only / fallback): tulis dari buffer reuse secara streaming, hitung upload secara
incremental.

---

## 6. Analisa Kelayakan per Skenario Target

### Skenario A — Client custom (TypeScript/web) + hibrida VPS+Worker
**Layak (feasible).** Semua fase terpetakan (§5); semua limit Worker terpenuhi
(duration tak terbatas untuk streaming, response size tak terbatas, upload di-chunk);
preseden produksi speed.cloudflare.com; biaya egress VPS turun drastis. Ini juga cocok
dengan temuan CLI bahwa client hanya butuh: (a) satu titik discovery, (b) satu titik
ping, (c) **satu endpoint throughput yang di-hammer N koneksi paralel**.

### Skenario B — Client resmi Ookla (CLI 1.2.0 / apps) + hibrida
**Tidak layak untuk bagian Worker.** Dua penghalang keras:
1. Client resmi memakai **protokol biner Ookla/NetGauge** di TCP 8080 (bukti `HI`→`HELLO`);
   Worker hanya bisa HTTP/WS — tidak ada jalur untuk protokol biner.
2. Client resmi hanya memilih server dari **server-list resmi Ookla** (diambil dari
   `www.speedtest.net`) — endpoint custom tidak akan pernah muncul di daftar itu
   (audit branch mengakalinya lewat proxy/opt-in publishing pada pengujian lab,
   bukan untuk produksi publik).

Kabar baiknya: branch `audit/official-cli-interoperability` **sudah membuktikan** jalur
VPS-only — CLI resmi 1.2.0.84 lulus 3/3 run (exit 0, download 18.4–21.7 Gbps, upload
13.6–15.7 Gbps, packetLoss 0) terhadap SpeedtestServer dengan `NetGaugeEngine`
(plaintext fallback; engine terenkripsi masih gap kecil berseverity Low). Jadi untuk
client resmi, mode VPS-only itu nyata dan sudah tervalidasi — **Worker tetap tidak
berperan di sana**.

### Skenario C — Mode hibrida + fallback VPS-only untuk client custom
**Layak dan disarankan.** Endpoint download/upload tersedia di dua tempat
(Worker utama; VPS fallback saat Worker gagal/di-rate-limit), client memilih berdasarkan
`/api/servers`. Bonus: hasil bisa menampilkan perbandingan "kecepatan ke edge Cloudflare"
vs "kecepatan ke VPS" — dua angka yang berbeda maknanya.

---

## 7. Risiko, Batasan, dan Mitigasi

| # | Risiko | Dampak | Mitigasi |
|---|---|---|---|
| 1 | **Path mismatch**: ping ke VPS ≠ jalur throughput ke PoP Cloudflare | Angka komposit bisa "aneh" (ping 40 ms ke VPS, tapi throughput kencang karena PoP 5 ms) | Ungkapkan metrik sebagai dua label berbeda; tambahkan TTFB Worker sebagai "edge latency"; dokumentasikan metodologi (transparansi ala speed.cloudflare.com) |
| 2 | Request body 100 MB (Free/Pro) | Upload besar gagal bila tak di-chunk | Chunk 10–25 MB, paralel 4–8 (pola speed.cloudflare.com) |
| 3 | CPU 10 ms (Free) habis oleh pembangkitan data acak | Error 1102 `Worker exceeded resource limits` | Buffer tetap 64 KB (generate sekali) + `ReadableStream` — CPU per request ≈ konstan kecil |
| 4 | Memori 128 MB | OOM bila men-buffer body/response | Streaming di kedua arah; jangan `Buffer.concat` |
| 5 | Endpoint Worker publik → abuse (orang pakai tanpa izin) | Quota request habis, hasil tercemar | Token HMAC bertanda-tangan VPS (verifikasi lokal di Worker, 0 subrequest) + `exp` pendek + CORS ketat + rate limit per token |
| 6 | 100 k request/hari (Free) | Batas jumlah test/hari | 1 test ≈ 10–30 request → ±3–10 ribu test/hari; upgrade $5/bln (10 jt request) bila perlu |
| 7 | Tidak ada UDP di Worker | Packet-loss/jitter UDP tak terukur via Worker | Tetap di VPS (UDP-echo sudah ada) — sesuai desain |
| 8 | Anycast berubah PoP | Hasil antar-run bisa beda PoP | Catat colo/PoP di respons Worker (header `cf-ray`/`cf.colo`) dan tampilkan bersama hasil |
| 9 | HTTP/2 browser: multiplexing membuat "N koneksi" = 1 koneksi TCP | Model paralelisme berbeda dari CLI (10 TCP terpisah) | Gunakan `fetch` paralel + `PerformanceResourceTiming`; tetap valid karena agregasi terjadi di level stream |
| 10 | WAF/cache mengganggu endpoint test | Respons tercache / diblok | `Cache-Control: no-store`, endpoint di subdomain terpisah, port 443 |

---

## 8. Roadmap Implementasi (Usulan Urutan Kerja)

**Tahap 1 — VPS discovery & token (foundation)**
1. Tambah `GET /api/servers`, `POST /api/sessions` (token HMAC), `POST /api/results`
   pada `OoklaRequestHandler.ts`.
2. Kunci HMAC dibagikan ke Worker via secret (wrangler `vars`/secret).

**Tahap 2 — Worker throughput**
3. Buat direktori `worker/` (TypeScript + `wrangler.toml`): `__down` streaming,
   `__up` drain-count, `bytes=0` untuk TTFB, CORS + verifikasi token HMAC + info colo
   di respons.
4. Bench: uji `__down` 100 MB–1 GB, `__up` chunk 25 MB × 8 paralel.

**Tahap 3 — Client engine (TypeScript)**
5. Engine ramp-up + paralel 4–8 stream, persentil 90, loaded-latency interval 400 ms
   (pola `cloudflare/speedtest`), plus mode ping UDP+TTFB ke VPS.

**Tahap 4 — Perbaikan throughput VPS (mode fallback)**
6. Refactor `handleDownload`/`handleUpload` di VPS menjadi streaming (lihat §4).

**Tahap 5 — (Opsional, terpisah) protokol biner Ookla**
7. Master masih tanpa protokol biner, namun branch `audit/official-cli-interoperability`
   sudah punya `NetGaugeEngine` tervalidasi — merge/penyelarasan branch itu ke master
   adalah prasyarat bila jalur client resmi (VPS-only) mau dibawa ke produksi.
   Ini jalur terpisah dari Worker.

---

## 9. Kesimpulan

Pertanyaan: *"hasilnya apakah bisa memenuhi target kombinasi project tersebut?"*

**Ya — untuk client custom**, arsitektur VPS (ping/discovery/token/hasil) + Worker
(download/upload) adalah pola yang terbukti (speed.cloudflare.com berjalan penuh di
Workers), selaras dengan bukti perilaku client (satu endpoint throughput di-hammer
koneksi paralel; fase ringan vs berat terpisah bersih), dan menghilangkan beban bandwidth
VPS yang tadinya ±2.3 GB per test.

**Tidak — bila targetnya client resmi Ookla memakai Worker**; client resmi terkunci pada
protokol biner TCP 8080 + server-list resmi Ookla, sehingga Worker tidak mungkin dilibatkan
untuk throughput. Untuk client resmi, satu-satunya mode adalah VPS-only dengan
implementasi protokol biner — yang kini **sudah terbukti feasible** di branch
`audit/official-cli-interoperability` (3/3 sukses), tinggal diselaraskan ke master.

Keputusan desain terpenting yang harus diambil owner project: **metrik komposit**
(latency→VPS, throughput→Cloudflare) diterima apa adanya dengan pelabelan jujur, atau
ditambah pembanding (edge latency + opsional throughput mini ke VPS) supaya pengguna
paham sedang mengukur jalur yang mana.

---

## Referensi

1. Cloudflare, *Workers — Limits* — https://developers.cloudflare.com/workers/platform/limits/ (diakses 2026-11-04; duration HTTP "no limit", body 100 MB–5 GB, CPU 10 ms/30 s/5 min, memori 128 MB, subrequest 50/10k, koneksi keluar 6, 100k req/hari Free)
2. Cloudflare, *Workers — Pricing* — https://developers.cloudflare.com/workers/platform/pricing/ (Standar $5/bln, 10 jt request incl., WebSocket dihitung 1 request per upgrade)
3. Cloudflare, *Network ports* — https://developers.cloudflare.com/fundamentals/reference/network-ports/ (HTTP: 80, 8080, 8880, 2052, 2082, 2086, 2095; HTTPS: 443, 2053, 2083, 2087, 2096, 8443)
4. Cloudflare, *About Speed Test* — https://speed.cloudflare.com/about (full di Workers, 330+ kota, ramp-up + persentil, ping=TTFB, anycast/BGP)
5. cloudflare/speedtest (repo resmi) — https://github.com/cloudflare/speedtest (endpoint `__down`/`__up`, opsi engine, loaded latency 400 ms)
6. Cloudflare Blog, *How does Cloudflare's Speed Test really work?* — https://blog.cloudflare.com/how-does-cloudflares-speed-test-really-work (API speed test berjalan di Workers + anycast)
7. Evidence empiris Speedtest CLI 1.2.0 — [`../`](../README.md) (seleksi server, 10 koneksi paralel download / 6–8 upload ke satu server, probe protokol `HI`→`HELLO 2.11.5`, konfigurasi `speedtest-config.php`)
8. Branch `audit/official-cli-interoperability` pada repo ini — `validation/FINAL_REPORT.md`, `PERFORMANCE_REPORT.md`, `OFFICIAL_CLI_RESULTS.md` (NetGaugeEngine, validasi CLI resmi 3/3, throughput Node 30–37% dari daemon native)
