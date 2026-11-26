# NATIVE HYBRID AUDIT — Feasibility Client Native Ookla + Assist Edge Cloudflare (Free)

**Tanggal audit:** 26 November 2026 (15:05–15:16 UTC) · **Bahasa laporan:** Bahasa Indonesia
**Basis:** `master@0ac51ac1ad3022523c616948b35a3879ebc2c5de` (VERSION 1.5.2) — diverifikasi ulang sebagai HEAD master SAAT INI (bukan asumsi), working tree bersih.
**Metode:** audit statis repo + verifikasi live read-only (probe TCP/HTTP, Cloudflare REST API token auth, DNS publik DoH, status sistem via uaeg MCP) + riset dokumentasi primer. **Tidak ada mutasi produksi.**
**Evidence run ini:** `hybrid/lab/evidence/native-hybrid/audit-2026-11-26/`

---

## Ringkasan eksekutif (verdict)

> **Hybrid native penuh (client resmi Ookla + kontribusi payload edge dalam satu sesi pengukuran) TIDAK DAPAT DIIMPLEMENTASIKAN dalam constraint project ini** — dua akar masalah independen:
>
> 1. **BLOCKED_BY_PROTOCOL** — client native (CLI resmi 1.2.0.84) membuka SEMUA koneksi pengukuran (4–32 download, 6–8 upload, + UDP loss) menuju **SATU host:port** yang diambil dari daftar server Ookla; protokol NetGauge tidak memiliki mekanisme pengumuman endpoint alternatif, redirect payload, WebSocket, atau multi-endpoint. Bukti primer + empiris: 0 request Worker pada run resmi terisolasi (server ID 66281, 24 Nov 2026, `hybrid/lab/evidence/e-m-official-cli-campaign/attribution.txt`).
> 2. **BLOCKED_BY_FREE_PLAN** — jalur masuk satu-satunya untuk raw TCP di Cloudflare adalah Spectrum application dengan Worker sebagai origin (public beta 19 Nov 2026), yang **tidak tersedia untuk zona Free** (Pro/Business: satu app per zona per port; Enterprise: add-on berbayar; UDP hanya Enterprise).
>
> Label akhir yang jujur: **jalur native = NATIVE_VPS_ONLY** (terverifikasi live hari ini), **jalur hybrid = CUSTOM_CLIENT_ONLY** (berlaku bagi client HTTP/custom saja). Bukan `NATIVE_HYBRID_VERIFIED_IN_LAB`, bukan `PRODUCTION_READY_FOR_PUBLIC_OOKLA`.
> Stack produksi sendiri **aktif dan sehat** (daemon + gateway hybrid + pool 100 Worker di akun Free, konvergensi sinkron ok, kuota 0,1%) — status mode `hybrid` pada gateway **TIDAK sama dengan** `HYBRID_ACTIVE` pada sesi native (§7).

---

## 1. Baseline terverifikasi (bukan dari dokumentasi saja)

Semua butir berikut diukur langsung pada 26 Nov 2026 (evidence: `live-baseline.json`, `cloudflare-state.json`, `vps-services.txt`, `netgauge-handshake.json`):

| Area | Hasil verifikasi live |
|---|---|
| Git | `master` HEAD = `0ac51ac` = snapshot referensi audit (masih TERKINI); VERSION 1.5.2; tree bersih; branch lain: `hybrid-assist-lane`, `vps-full-potential`, `v1.5-dynamic-pool-autoupdate`, `audit/native-hybrid-2026-11-26` (branch kerja audit ini) |
| Daemon native | `speedtestserver` **active/running, PID 4412**; listener `0.0.0.0:8080` + `:5060` (v4+v6) — port discipline 8080/5060 sesuai `config/OoklaServer.properties.template:28,38` |
| Gateway hybrid | `speedtest-hybrid-gateway` **active/running, PID 4465**; listener `0.0.0.0:8790`; `/api/health`: `hybrid-gateway/1.5, version 1.5.2, mode hybrid`, `vpsDlShare 0.15` |
| Pool Worker | `/api/workers`: **target 100 / deployed 100, deployStatus ok**, lastSync `2026-11-26T13:42:30Z`; `/api/pool`: activeCount 2 (activeMin 2), quota guard aktif (terpakai 89/100.000 = 0,1%) |
| Worker edge | `GET /__meta` worker-1 → live (colo HKG, `speedtest-hybrid-worker/1.2`) — deployed DAN sehat; payload-bearing belum teramati (traffic idle) |
| Cloudflare | token aktif; zone `lumajangnetworks.my.id` **active, plan Free Website**; **100 script Worker** di akun (pool `speedtest-hybrid-worker`..`-100`), tidak ada script lain; **route Worker di zona: kosong**; subdomain workers.dev `lumajangnetworks` |
| DNS | `speedtest.lumajangnetworks.my.id` A → `45.126.249.250`, **proxied=false (DNS-only, awan abu-abu)** — diverifikasi via API DAN resolusi publik DoH (TTL 300) → constraint terpenuhi; tidak ada record proxied di zona ini |
| Protokol native | Raw TCP `HI` → `HELLO 2.11 (2.11.5) 2026-06-04.1737.7d0993d`; `CAPABILITIES` → `SERVER_HOST_AUTH UPLOAD_STATS` — **byte-exact** dengan `validation/PROTOCOL_CONTRACT.md` (banner daemon resmi) |
| TLS | `GET /hi` via HTTPS `:8080` dengan SNI/Host sah → verifikasi rantai sertifikat lulus CA publik (Let's Encrypt wildcard) |
| Auto-update | `speedtest-autoupdate.timer` **active** |
| Akses | Shell VPS via uaeg MCP (`:3902`, UAEG 1.0.0) **tersedia dan teruji** (read-only); Cloudflare API **tersedia**; lingkungan client uji = sandbox eksternal ini (egress `45.126.249.249`) |

Pemisahan status (master prompt §3): **deployed** = 100 script · **healthy** = worker-1 terverifikasi live (99 lainnya belum di-probe satu per satu; sinkronisasi REST melaporkan konvergen) · **eligible/selected** = pool rotasi aktif 2 worker · **serving_payload** = 0 teramati untuk sesi native (konsisten dengan verdict §6 — memang tidak mungkin).

## 2. Inventaris tree & klasifikasi

| Area | Lokasi | Klasifikasi |
|---|---|---|
| Daemon native (jalur aktif) | `reverse-engineered/typescript/src/server/*.ts` (ServerCore, NetGaugeEngine, HttpApi, LegacyFallback, UdpLossEngine, ConfigManager, CertificateManager, OoklaServer, dst. + test) | produksi — jalur A |
| Gateway (jalur aktif) | `hybrid/gateway/src/{gateway,front,runtime,workerpool,workersync}.mjs` | produksi — jalur B control plane |
| Worker (jalur aktif) | `hybrid/worker/src/{index,netgauge,http-legacy,config,pool,token}.ts` + `wrangler.toml` + `rest-deploy.mjs`, `deploy-pool.sh` | produksi — jalur B data plane (100 script ter-deploy) |
| Deployment | `.env.example`, `install.sh`, `auto-update.sh`, unit systemd, `config/*.properties` | produksi (operator) |
| Binary resmi | `OoklaServer-{linux-x86_64,aarch64,macosx,windows-*}`, `speedtest-cli_official/` | referensi RE/validasi — tidak dipakai runtime |
| Pembanding non-acceptance | `hybrid/probe-client/`, `speedtest-cli_analysis/`, `reverse-engineering-batch/` | diagnostik/lab — JAMAK dihitung sebagai acceptance native |
| Evidence historis | `hybrid/lab/evidence/` (E-A..E-M), `validation/` (PROTOCOL_CONTRACT, FINAL_REPORT, dst.), `Result_Comparison.md`, `docs/HYBRID_STATUS.md` | bukti — direkonsiliasi §4 |

Alur aktual client→result (dua jalur):
```
Client resmi Ookla ─ raw TCP :8080 (NetGauge; hello terenkripsi → fallback plaintext) + UDP :8080/5060 (loss/loaded-latency)
                    └────────────────────────► VPS daemon (PID 4412) ─ hasil via engine (persisted=false di lab)

Client HTTP/custom ─ HTTPS :8790 (front: latency.txt, random*.jpg 302→worker, upload.php)
                    └─ kontrol: /api/sessions (mint HMAC), /api/results ─ VPS gateway (PID 4465)
                    └─ payload: 302 → https://speedtest-hybrid-worker[-N].lumajangnetworks.workers.dev/__down|__up|/ws (Bearer token)
```

## 3. Matriks protokol — jawaban pertanyaan wajib (§4 master prompt)

Sumber: `validation/PROTOCOL_CONTRACT.md` (verifikasi probe langsung 2026-11-04, label [V]), `speedtest-cli_analysis/README.md` + `KESIMPULAN-FINAL.md` (observasi first-hand CLI 1.2.0.84), `hybrid/worker/src/netgauge.ts`, `NetGaugeEngine.ts`.

| Pertanyaan wajib | Jawaban (dengan bukti) |
|---|---|
| Transport aktual per fase CLI resmi? | **Discovery/config**: HTTPS `cli.speedtest.net/api/cli/config` (server list 10 kandidat, semua `:8080`). **Seleksi**: latency probe ke tiap kandidat. **Ping/latency + DL + UL**: **raw TCP NetGauge** ke host:port server terpilih (`HI`→`HELLO`; hello terenkripsi → fallback plaintext per koneksi). **Loaded latency + packet loss**: UDP ke port yang sama (`LOSS`/`RECV`). **Result**: HTTPS ke speedtest.net. CLI tidak memakai HTTP/WS untuk payload (bukti empiris: 0 request Worker pada 18 run E-M) |
| Endpoint alternatif terdokumentasi / redirect payload / WebSocket / multi-endpoint pada satu sesi? | **TIDAK ADA.** Command set NetGauge (`HI GETIP CAPABILITIES SERVERID UPTIME PING INITPLOSS PLOSS UPLOAD_STATS DOWNLOAD UPLOAD QUIT`) tidak memuat mekanisme pengumuman/redirect endpoint; opsi CLI hanya memilih dari daftar (`-s <id>`, `-L`). Multi-connection = banyak koneksi TCP ke **server yang sama** (4–32 koneksi DL, 6–8 UL teramati; `evidence/04_ss_samples.txt`) |
| Client menghubungi endpoint edge langsung setelah handshake VPS? | **TIDAK** — 0 request Worker pada run resmi terisolasi 66281 (celah hening CF GraphQL; VPS membawa seluruh 511,9 MB DL + 224,2 MB UL) |
| VPS pertahankan koneksi native + Worker melayani koneksi tambahan paralel (target/TLS/pengukuran sah)? | **TIDAK DIMUNGKINKAN untuk client native** — semua koneksi sesi menuju satu endpoint dari daftar; tidak ada koneksi "tambahan" yang bisa diarahkan client ke endpoint lain tanpa modifikasi |
| Raw TCP native pakai host:port tetap sepanjang sesi? Mekanisme Free untuk memindahkan sebagian koneksi ke edge? | **YA** host:port tetap (17 port lokal berbeda → 1 IP:port server). **TIDAK ADA mekanisme** Free: Worker hanya menerima inbound HTTP/HTTPS/WebSocket; raw TCP inbound = Spectrum (bukan Free) |
| Alternatif menghemat bandwidth VPS nyata? | Untuk **client jalur HTTP/custom: YA** (E-M mode B: VPS 0,45–0,49 MB vs 539 MB payload ≈ 1:1.200 offload). Untuk **native: tidak ada opsi selain relay** (melanggar misi) |
| Arsitektur diizinkan untuk server terdaftar di direktori Ookla? | **BELUM DIKETAHUI / BLOCKED_BY_REGISTRATION** — program hosting resmi menyediakan daemon resmi Ookla; re-implementasi + arsitektur hibrida memerlukan persetujuan Ookla sebelum klaim public-ready. Audit ini tidak mengklaim kesiapan direktori publik |

## 4. Rekonsiliasi fakta historis

| Fakta historis | Rekonsiliasi (status audit) |
|---|---|
| Run terisolasi resmi 66281 (24 Nov): DL 511,9 MB / UL 224,2 MB seluruhnya via VPS, **0 request Worker** | **KONSISTEN dengan verdict** — bukti empiris paling kuat bahwa payload CLI resmi tidak bisa lewat edge. `attribution.txt` diverifikasi ulang; interpretasinya benar |
| Bukti HTTP/hybrid sebelumnya (offload nyata 1:1.200) | **SAH tetapi untuk client custom/jalur HTTP** — probe-client & speedtest-cli sivel ≠ client resmi Ookla → tidak pernah menjadi bukti native (label CUSTOM_CLIENT_ONLY) |
| Commit 26 Nov: deploy ulang v1.5.2, pool 100 worker fullRedeploy + secret baru, edge 302→200 OK, legacy unit dihapus | **TERVERIFIKASI live hari ini**: 100 script ter-deploy, sinkron konvergen, gateway mode hybrid, `frontDownRedirects=1` pada counter health (jejak uji unduh 302→200), unit legacy tidak ada lagi di `ss`/systemd, timer auto-update aktif |
| Share DL 0.15 / UL 0.15 = pembagian **request**, bukan distribusi byte/jaminan utilisasi | **BENAR** — `HYBRID_VPS_DL_SHARE` menginterleave permintaan HTTP front (Bresenham per-IP) dan `HYBRID_VPS_UL_SHARE` memecah POST klien hybrid; keduanya **tidak berlaku sama sekali untuk client native** (jalurnya tidak melewati front). Verifikasi konfigurasi live: `vpsDlShare 0.15` pada `/api/health` |

## 5. Riset primer (dokumentasi masih berlaku saat eksekusi)

Diakses 26 November 2026 (WebFetch; kutipan adalah bunyi halaman):

| Sumber | Fakta kunci | Implikasi |
|---|---|---|
| `developers.cloudflare.com/workers/reference/protocols/` | Inbound Workers: HTTP/HTTPS, WebSockets, HTTP/3, SMTP (Email Workers); **"Direct TCP sockets — via service binding atau Spectrum application (connect() handler, public beta)"** | Raw TCP masuk BUKAN kemampuan Worker standar |
| `developers.cloudflare.com/workers/runtime-apis/tcp-sockets/` | `connect()` = koneksi **keluar**; inbound TCP hanya via export `connect()` handler — **"Inbound TCP is in public beta"** melalui service binding atau **Spectrum application dengan Worker sebagai origin** | Jalur TCP masuk = Spectrum, bukan fitur Workers Free |
| `developers.cloudflare.com/spectrum/protocols-per-plan/` | Free: **No** untuk semua proxy TCP/UDP; TCP Worker-origin (beta): Pro/Business (satu app per zona) / Enterprise add-on; **UDP: Enterprise saja** | **BLOCKED_BY_FREE_PLAN** untuk zona Free + protokol loss tidak terlayani bahkan berbayar non-Enterprise |
| `developers.cloudflare.com/spectrum/how-to/route-tcp-traffic-to-a-worker/` | **"Free zones are not supported"**; tanpa Spectrum Enterprise, Pro/Business = **satu app Worker-origin per zona, satu port TCP**, tanpa terminasi TLS | Bahkan bila upgrade plan: satu port, UDP loss tetap hilang, TLS tidak diterminasi → sesi CLI rusak |
| `developers.cloudflare.com/workers/platform/limits/` | Free: **100.000 request/hari PER AKUN**, **100 script/akun**, CPU 10 ms, memori 128 MB, body 100 MB, 6 koneksi simultan/invokasi | Pool 100 = batas script akun (pool saat ini tepat di 100) |
| `www.speedtest.net/apps/cli` + hasil pencarian (speedtest.net/help/guides/how-can-i-host-a-speedtest-server; support.ookla.com "Speedtest Server Requirements", 18 Mei 2026) | Halaman CLI tidak mendokumentasikan opsi endpoint custom; hosting resmi: *"Joining the network is free... We provide the Speedtest server daemon, and you provide the server capacity"* — pendaftaran via Speedtest Server Network™ | Pendaftaran resmi = jalur satu-satunya ke daftar server; tidak ada opsi CLI untuk host publik bebas |
| Gagal diambil saat eksekusi (HTML error): `changelog/post/2026-11-19-inbound-tcp/`, `ooklaserver.org/help/guides/...`, `dns/proxy-status/` | Tidak bisa dikutip dari sumber primer — klaim beta 19 Nov 2026 pada halaman yang BERHASIL diambil menyebut "public beta" (protocols/tcp-sockets/spectrum) dan "Free zones are not supported" (spectrum how-to), jadi substansi tetap terverifikasi dari halaman primer lain | Errata jujur; kesimpulan tidak bergantung pada halaman yang gagal |

Perilaku client dinyatakan sebagai **observasi pada versi yang diuji** (CLI resmi 1.2.0.84) — sesuai batasan §4: tidak mengklaim dukungan resmi dari reverse engineering semata.

## 6. FEASIBILITY GATE — tabel keputusan per transport teramati

| Kandidat | Perilaku native (teramati) | Direct client↔edge? | DL | UL | VPS bypass payload? | Free? | Diizinkan? | Keputusan |
|---|---|---|---|---|---|---|---|---|
| **Raw TCP/UDP native** | Semua koneksi + UDP loss → SATU host:port dari server-list; payload = `DOWNLOAD`/`UPLOAD` pada koneksi sama; tidak ada mekanisme endpoint alternatif | **Tidak** — Worker inbound bukan raw TCP; Spectrum bukan Free | Gagal | Gagal | n/a | **Tidak** | — | **GUGUR — BLOCKED_BY_PROTOCOL + BLOCKED_BY_FREE_PLAN** |
| **HTTP/HTTPS native** | CLI resmi tidak memakai jalur HTTP untuk payload (0 wreq E-M); permukaan HTTP `:8080` melayani web/legacy | Hanya untuk client jalur-HTTP (stock sivel mengikuti 302) | n/a utk native | n/a (klien stock kirim body dulu) | Ya, utk client HTTP | Ya | Ya | **GUGUR untuk native** (jalur tidak dipakai CLI) → lane ini adalah basis label CUSTOM_CLIENT_ONLY |
| **WebSocket native** | CLI tidak pakai WS (E-M 0 wreq); klien web resmi memakai WSS tetapi daftar server tetap dari API Ookla; `/ws` Worker dipakai probe custom saja | Tidak utk CLI | Gagal | Gagal | n/a | — | — | **GUGUR — BLOCKED_BY_PROTOCOL** |
| **Native endpoint negotiation** | Tidak ada di command set; opsi CLI hanya pilih dari daftar | **Tidak ada mekanisme** | — | — | — | — | — | **GUGUR — BLOCKED_BY_PROTOCOL** |
| **HTTP redirect (302/307)** | Front 302→worker hanya dimanfaatkan client urllib; CLI tidak memproses redirect pada jalur pengukuran (0 wreq); 307 daemon hanya redirect TLS host-mismatch | Tidak utk CLI | Gagal | Gagal | — | — | — | **GUGUR untuk native** |
| **VPS relay/tunnel** | Worker `connect()` keluar ke VPS → seluruh byte transit interface VPS | Bukan offload | — | — | **Tidak** (tetap transit) | — | Melanggar misi | **GUGUR — melanggar constraint non-relay** |
| **Inbound TCP via Spectrum→Worker** | Beta publik; Worker sebagai origin Spectrum app | Secara teknis ya | Teoretis | Teoretis | Tidak paralel: seluruh koneksi menuju satu endpoint CF; UDP loss tanpa layanan (Enterprise only) | **TIDAK — Free zone tidak didukung** | Melanggar constraint Free | **GUGUR — BLOCKED_BY_FREE_PLAN** (+ sekunder: satu port/app, UDP loss hilang, non-paralel) |

**GATE F: TIDAK TERPENUHI.** Tidak ada kandidat yang memenuhi "client asli memulai koneksi edge langsung dan menerima/mengirim payload dalam pengukuran native yang sama" dalam constraint (Free + DNS-only + client tak dimodifikasi + non-relay). Konsekuensi: **tidak ada implementasi hybrid native yang boleh dimulai**; dokumentasi verdict tetap wajib (master prompt §6, §12) — dilakukan di tiga dokumen ini.

## 7. Mode status runtime aktual (pemisahan wajib §8)

| Mode | Status terverifikasi |
|---|---|
| Jalur native (client resmi) | **efektif VPS_ONLY setiap saat** — `mode: hybrid` pada gateway hanya menyatakan ketersediaan lane HTTP edge, dan **tidak pernah** berarti sesi native memakai edge (0 request Worker terbukti). Tidak ada HYBRID_ACTIVE pada sesi native |
| Lane hybrid (client HTTP/custom) | **HYBRID_READY** (edge tersedia: 100 worker sehat, sinkron ok, kuota 0,1%); kontribusi payload edge NYATA pada sesi client hybrid (bukti historis E-M mode B) → label CUSTOM_CLIENT_ONLY |
| VPS_ONLY fallback | Teruji per desain (credentials unusable → front degrade; `.env` fix live) |

## 8. Temuan akses & keamanan

1. Akses shell VPS **tersedia** (uaeg MCP; read-only dipakai audit ini), Cloudflare API **tersedia** (token aktif, scope terbatas), lingkungan client uji **tersedia** (sandbox eksternal). Tidak ada input operator yang menghalangi tahap audit/riset/feasibility; yang pending hanyalah **daftar server ID** untuk matrix pengujian pra-publikasi (§VALIDATION).
2. Credential yang diberikan operator kembali dipakai sesuai kebutuhan (Cloudflare: GET read-only; uaeg: status read-only; GitHub PAT: push branch kerja dokumen). **Tidak ada secret yang di-commit, dicetak di dokumen, atau dibagikan** — evidence hanya memuat identifier non-rahasia.
3. Hygiene: key uaeg `lumajangnetworks` (Permissions: all) pernah ditampilkan operator di chat — disarankan rotasi bila ada keraguan; HYBRID_SHARED_SECRET baru terpasang pada full redeploy 26 Nov (commit `0ac51ac`) — tidak dibaca/ditampilkan audit ini.

## 9. Risiko & blocker

| # | Risiko/blocker | Tingkat | Catatan |
|---|---|---|---|
| R-1 | Hybrid native penuh **blocked permanen** dalam constraint Free+native+non-relay | Blocker fundamental | Dua akar independen (protokol + plan); tidak bisa di-"tuning" |
| R-2 | Pool 100 script = **tepat di batas akun** (script ke-101 tidak bisa) | Batas Free | Sudah maksimal; tambah script lain di akun akan menggantikan pool |
| R-3 | Koneksi simultan Worker 6/invokasi + CPU 10 ms soft | Batas Free | Sudah dimitigasi (pacing 64 KiB, deflection antar worker, autoscaler) |
| R-4 | Registrasi direktori Ookla = keputusan komersial Ookla (daemon resmi mereka disyaratkan program hosting) | BLOCKED_BY_REGISTRATION | Re-implementasi ini tidak otomatis ditolak, tapi TIDAK bisa diklaim public-ready |
| R-5 | `mode: hybrid` di health bisa disalahpahami sebagai edge-assist native | Risiko pelaporan | Ditangani eksplisit §7; label STATUS yang dipakai sesuai definisi |
| R-6 | Worker-2..100 belum di-probe satu-per-satu hari ini | Minor | Konvergensi REST ok + canary saat scale; verifikasi massal bisa ditambah |

## 10. Verdict

1. **NATIVE_VPS_ONLY** untuk client resmi — jalur aktif, terverifikasi live (banner, handshake byte-exact, PID/port, DNS direct). Kapasitas VPS murni terbukti historis 470,9/448,8 Mbps (NetGauge) pada VPS ini.
2. **CUSTOM_CLIENT_ONLY** untuk lane hybrid — offload nyata (±1:1.200) bagi client HTTP/custom; tidak berlaku untuk client resmi.
3. **NATIVE_HYBRID (DL/UL/full): BLOCKED_BY_PROTOCOL + BLOCKED_BY_FREE_PLAN** — Gate F tidak lolos; tidak ada PoC yang sah untuk dilakukan; jangan ada arsitektur palsu untuk "mengatasi" keterbatasan ini.
4. Bukan `PRODUCTION_READY_FOR_PUBLIC_OOKLA` — menunggu registrasi + validasi pasca-registrasi (N10/G10-G11).

Lanjutan yang diizinkan tanpa merubah verdict: perbaikan reliability native yang independen (di luar scope perubahan hari ini) dan kualitas evidence — keduanya tercatat di `NATIVE_HYBRID_IMPLEMENTATION.md`.
