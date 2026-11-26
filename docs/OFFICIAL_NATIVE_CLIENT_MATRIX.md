# OFFICIAL NATIVE CLIENT MATRIX — Hasil per Platform, Versi, Transport, dan Plan

**Tanggal:** 27 November 2026 · **Prinsip:** verdict berlaku **per platform × versi × transport × plan**; tidak ada generalisasi lintas platform; kolom PASS hanya untuk client resmi yang tidak dimodifikasi yang benar-benar dijalankan.

---

## 1. Matriks platform resmi

| Client resmi | Versi diuji | Metode pemilihan server | Transport pengukuran | Dapat memilih endpoint operator secara sah? | Verdict audit |
|---|---|---|---|---|---|
| **CLI Linux** (binary resmi Ookla) | 1.2.0.84 (`ea6b6773cf`, tarball repo) — diverifikasi `--version` 26 Nov | server-list resmi (`cli.speedtest.net/api/cli/config`); `-s <id>` / `-o <host>` hanya dari daftar (man page resmi) | **raw TCP NetGauge :8080** (4–32 koneksi DL + 6–8 UL) + **UDP** loss/loaded-latency; HTTPS hanya untuk discovery/result | Ya — melalui **hosts-override lab** atas entri daftar operator (non-publishing, terisolasi); TIDAK untuk publik (butuh registrasi) | **NATIVE_VPS_ONLY — VERIFIED** (live 4/4 run: exit 0, dl 433,8–481,6 Mbps, ul 126,1–152,4 Mbps, Worker 0 request, `persisted=false`) |
| CLI Windows | tidak tersedia di lab | (diasumsikan sama; **tidak diverifikasi**) | (tidak diverifikasi) | — | **NOT_TESTED / BLOCKED_BY_ACCESS** (tidak ada perangkat Windows di lab) |
| CLI macOS | tidak tersedia | — | — | — | **NOT_TESTED / BLOCKED_BY_ACCESS** |
| **Speedtest.net web resmi** (browser) | halaman resmi; engine resmi tidak dimodifikasi | otomatis: "up to five nearby servers... choose the server with the lowest response time" (help guide); user hanya ganti server **dari list** | per dokumen resmi: "mainly over TCP testing with a HTTP fallback... over port: 8080" (WebSocket tidak disebut dokumen; diamati daemon menerima WSS — *inferensi flow, bukan fakta isi protokol* untuk web) | **Tidak** — endpoint operator tidak ada di direktori; memaksa via manipulasi discovery dilarang | **BLOCKED_BY_REGISTRATION** (utama; transport WSS worker = kompatibel-kontraktual tetapi **UNTESTED** dengan web resmi) |
| Android app | tidak ada perangkat | direktori | tidak diverifikasi | tidak | **NOT_TESTED / BLOCKED_BY_ACCESS + BLOCKED_BY_REGISTRATION** |
| iOS app | tidak ada perangkat | direktori | tidak diverifikasi | tidak | idem |
| Windows desktop app | tidak ada perangkat | direktori | tidak diverifikasi | tidak | idem |
| macOS desktop app | tidak ada perangkat | direktori | tidak diverifikasi | tidak | idem |
| **Ookla Server Tester resmi** (speedtest.net/host-tester) | layanan web resmi (bukan aplikasi client uji kecepatan) | operator memasukkan host:8080 manual | NetGauge TCP + legacy HTTP (upload.php, latency.txt, images, KeepAlive) | Ya — host milik operator | **VERIFIED-OPERATOR vs VPS Jalur A** (24 Nov, 4/4 run semua check; bukti `docs/HOST_TESTER_RUNBOOK.md` §5). Terhadap Worker: **gugur oleh desain** (NetGauge raw TCP tidak tersedia di Workers Free; cek 6/10 gagal pada postur produksi — H1) |

**Catatan generalisasi (jawaban pertanyaan #3 master prompt):** audit 26 Nov membatasi klaimnya pada "CLI resmi 1.2.0.84" dan menyebut web/mobile sebagai belum diuji — secara substansi **tidak ada generalisasi ilegal** di dokumen itu. Overclaim justru terjadi pada **laporan riset 6 Nov** (klaim "official web clients" & "official host-tester suite" berbasis clone/probe) — sudah dikoreksi errata untuk E-G; baris "official web clients" dikoreksi eksplisit oleh audit ini.

## 2. Cloudflare — kondisi Free per 27 Nov 2026 (riset primer, kutipan aktual)

| Topik | Fakta (sumber, diakses 27 Nov 2026) | Implikasi |
|---|---|---|
| Protokol inbound Worker | protocols/ (upd. 19 Nov): HTTP/HTTPS, WebSockets, HTTP/3 (zone setting), SMTP (Email Workers), Direct TCP "via service binding or Spectrum application using the connect() handler (public beta)" | Tidak ada jalur TCP/UDP mentah baru; ingress tetap HTTP-semantik |
| Inbound TCP beta | tcp-sockets/ (upd. 19 Nov): "Inbound TCP is in public beta" — hanya via service binding atau Spectrum app; changelog 2026-11-19; **tidak ada GA** hingga 25 Nov (changelog terakhir yang bisa diambil) | Status sama seperti saat audit 26 Nov |
| Spectrum per plan | protocols-per-plan/ (upd. 19 Nov): Free "No" semua TCP/UDP; TCP Worker-origin (beta): Pro/Business "One app per zone" (satu port TCP), Enterprise add-on; UDP: Enterprise saja. how-to/ (upd. 20 Nov): "**Free zones are not supported**" | `BLOCKED_BY_FREE_PLAN` berlaku; bahkan berbayar non-Enterprise: 1 app/1 port, tanpa startTls, UDP loss hilang |
| Limit Workers Free | limits/ (upd. 25 Nov): 100.000 req/hari **per akun**; CPU 10 ms; memori 128 MB; **6 koneksi simultan per invokasi** (termasuk connect()/WS outbound); 100 script/akun; body request 100 MB (zone Free); response body tanpa batas enforced | Pool 100 = tepat batas akun; kuota per akun (bukan per script) |
| WebSocket Worker | websockets/ (upd. 18 Nov): message max **32 MiB** (1009 close) | Lane WSS custom aman terhadap frame 2–4 MiB engine |

## 3. Ookla — kondisi per 27 Nov 2026 (riset primer)

| Topik | Fakta (sumber) | Implikasi |
|---|---|---|
| Opsi server CLI | `--help` & man page binary resmi 1.2.0.84: `-s/--server-id` dan `-o/--host` — keduanya "from the server list"; tidak ada opsi host:port/URL kustom | Client resmi tidak dapat diarahkan ke endpoint bebas → jalur endpoint operator = registrasi |
| Struktur entri server | `-L` live: setiap server = satu `host` + `port: 8080` | Satu endpoint per server — tidak ada multi-endpoint kontrak |
| Web transport | help guide: "mainly over TCP testing with a HTTP fallback... multiple connections over port: 8080"; WebSocket tidak disebut | Web resmi juga TCP-8080-semantik; HTTP fallback tetap ke host server yang sama |
| Multi-server | methodology page: engine "dynamically scales the number of connections to multiple servers" (internal); man page 1.2.0: "experimental support for multi-server testing" tanpa opsi CLI | Multi-server = mekanisme internal engine dari direktori, **bukan** mekanisme yang dapat diarahkan user ke campuran VPS+Worker |
| Registrasi | ookla.com/network: 15.000+ server "host our Speedtest server daemon"; join via akun + register | `BLOCKED_BY_REGISTRATION` — keputusan komersial Ookla |
| Host tester resmi | speedtest.net/host-tester: memverifikasi "Ookla Server daemon is accepting connections, as well as the legacy HTTP upload script, latency file, download image files, and required server settings like KeepAlive" | Permukaan wajib yang musti dipenuhi untuk registrasi — VPS Jalur A sudah lolos (VERIFIED-OPERATOR) |

## 4. Kandidat mekanisme native — verdict per transport

| Kandidat | Client yang mendukung | Payload transit VPS? | Free? | Verdict |
|---|---|---|---|---|
| Raw TCP/UDP native → Worker | CLI resmi (semua platform, 1.2.0.84) | tidak relevan | **Tidak** (Spectrum; Free unsupported) | **BLOCKED_BY_PROTOCOL + BLOCKED_BY_FREE_PLAN** |
| HTTP legacy / WSS Worker | web resmi (plausible, UNTESTED), klien custom (teruji) | tidak (edge) | Ya | **CUSTOM_CLIENT_ONLY terbukti; untuk web resmi → BLOCKED_BY_REGISTRATION** |
| Negosiasi endpoint resmi (redirect/multi-endpoint) | tidak ada pada CLI 1.2.0.84 (bukti E-D/E-E/E-M/H3 + man page) | — | — | **BLOCKED_BY_PROTOCOL** |
| Spectrum → Worker (TCP masuk) | CLI resmi (teoretis, seluruh TCP) | seluruh koneksi ke SATU endpoint CF (tidak paralel dengan VPS); UDP loss tanpa layanan (Enterprise only) | **Tidak** (Free "No") | **BLOCKED_BY_FREE_PLAN** (+sekunder: 1 app/1 port, tanpa TLS termination, non-paralel) |
| Relay/tunnel Worker→VPS | semua | YA (melanggar non-relay) | Ya | **GUGUR — melanggar misi (kapasitas tidak bertambah)** |
| VPS-only | semua client resmi | Ya (memang itu jalurnya) | Ya | **AKTIF — NATIVE_VPS_ONLY (VERIFIED live)** |

## 5. Spectrum — analisis opsi terakhir (tanpa pembelian/aktivitas)

- Eligibility: Free **tidak didukung** ("Free zones are not supported", how-to, upd. 20 Nov 2026); Pro/Business: **satu** Worker-origin app per zone, **satu** port TCP, tanpa port range; Spectrum Enterprise = add-on terpisah.
- Tanpa Spectrum Enterprise tidak ada terminasi TLS pada socket masuk (`startTls()` tidak didukung pada socket Spectrum) → sesi NetGauge-terenkripsi CLI resmi tidak dapat di-terminasi secara normal.
- **UDP loss/loaded-latency phase CLI tidak terlayani** kecuali Enterprise — fase pengukuran wajib CLI hilang di plan lebih rendah.
- Bahkan bila diaktifkan: seluruh koneksi sesi menuju **satu** endpoint CF (klien tidak punya mekanisme split) → hasilnya `NATIVE_EDGE_ONLY` (Worker melayani semua), **bukan** hibrida VPS+Worker; dan biaya transfer Workers terpisah dari Spectrum ("Workers usage is billed separately").
- **Keputusan operator yang diperlukan bila mengejar jalur ini:** upgrade zone + menerima kehilangan fase UDP + tetap tidak mendapat hibrida. Tidak direkomendasikan; tidak diaktifkan oleh audit ini.
