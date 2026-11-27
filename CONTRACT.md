# CONTRACT.md — kontrak proyek SpeedtestServer (hybrid + speedtest-bridge)

> Dokumen ini adalah **titik masuk tunggal** untuk agent/operator baru: apa
> target proyek, siapa berjalan di mana, tata letak port, cara instalasi,
> cara menguji dengan aplikasi RESMI Ookla, dan peta reverse engineering.
> Bahasa: Indonesia; istilah teknis mengikuti repo. Terakhir diperbarui:
> 27 Nov 2026 (DIRECT LANE — kontrak operator: relay dilarang).

## 1. Target proyek (kalimat pembuka yang tidak boleh berubah)

Menjadi **pengganti mandiri (standalone) OoklaServer** yang:

1. melayani **klien 100% asli/resmi Ookla TANPA modifikasi** — CLI resmi
   hari ini; keluarga engine yang sama (app Android/iOS) dan lane web
   menyusul. **Tidak pernah ada komponen yang dipasang di sisi klien.**
2. berjalan di **VPS + Cloudflare Worker pool** (Free tier): kontrol +
   identitas + loss di VPS, payload pengukuran bisa ber-origin di edge.
3. membuka **hanya port yang tertulis di `OoklaServer.properties`** — file
   konfigurasi RESMINYA OoklaServer, **satu-satunya sumber port** proyek
   (port **8080 wajib** ada di `OoklaServer.tcpPorts`; boleh 1 port, boleh
   lebih; TIDAK ada asumsi port lain — mis. 5060 — wajib ada). Semua port
   yang tertulis di situ — dan HANYA port itu — mengikat seluruh
   infrastruktur proyek ini.
4. terpasang penuh dari **satu file `.env` + satu perintah instalasi** via
   **installer beku** yang tidak pernah berubah meski code berubah
   (lihat §5 dan docs/INSTALL_BOOTSTRAP.md).

### Prinsip arsitektur — LARANGAN RELAY (kontrak operator, 27 Nov 2026)

> "Konsep relay, bridge, atau sejenisnya itu **salah total** — justru
> menyalahi target awal proyek. Kalau konsep tersebut dijalankan, artinya
> ada **pemborosan resource**: daripada pakai worker, sekalian saja full
> VPS. Yang dimau: **worker membantu load berat LANGSUNG ke client**
> (di-serve DL dan UL secara simultan, tanpa transit VPS)." — operator

Aturan turunannya (berlaku untuk semua agent berikutnya):

1. **Worker hanya boleh membawa payload yang mengalir LANGSUNG client ↔
   edge CF.** Setiap byte payload yang transit NIC VPS = pelanggaran
   kontrak (terukur audit 27 Nov: relay membuat semua lane terkunci di
   egress VPS 429–473 Mbps; worker jadi pemborosan resource).
2. **VPS = control plane saja** untuk lane edge: handshake, ping/jitter
   (WSS), token, identitas, loss. Payload berat = edge.
3. **Klien NetGauge-native (CLI resmi) tidak punya permukaan redirect** —
   diverifikasi ulang first-hand 27 Nov (hello terenkripsi → ERROR →
   plaintext HI → ERROR → "Latency test failed"; **0 request HTTP, 0 port
   lain** walau permukaan HTTP penuh + 307 tersedia di port yang sama).
   Maka CLI dilayani **full-VPS** (`SPEEDTEST_BRIDGE_BACKEND=local`) —
   sesuai logika operator: kalau worker hanya bisa relay untuk lane itu,
   jangan pakai worker.
4. **Klien web resmi speedtest.net (SDK Ookla, tanpa modifikasi) PUNYA
   permukaan redirect**: payload-nya XHR (`GET /download?size=` +
   `POST /upload`) → **307 handoff ke Worker** = direct lane. Terbukti
   live 27 Nov (PoC sandbox, halaman speedtest.net asli): DL 232 Mbps / UL 23.3 Mbps dilayani
   100% dari edge, VPS hanya 440 byte control HTTP + WSS ping.

### Label jujur (wajib dipertahankan saat mengutip hasil)

- Mode **direct lane** (web client resmi): **payload client ↔ edge CF
  LANGSUNG** — VPS hanya control (terukur: 533 MB DL + UL dilayani edge,
  VPS 440 byte HTTP control + ~46 KB WSS ping + spill ~1 MB pra-redirect).
  Ini SATU-SATUNYA lane yang memenuhi target "hasil > bandwidth VPS".
- Klien native (CLI/app): **full-VPS, tanpa worker** (backend `local`);
  mode bridge-relay LAMA (payload dari Worker transit VPS) **dilarang
  kontrak** — semua lane relay terkunci egress VPS 429–473 Mbps
  (audit 27 Nov; ingress 872 Mbps tak terpakai untuk DL).
- Jalur edge langsung untuk **CLI** tetap BLOCKED_BY_PROTOCOL (bukan
  karena CF free, tapi karena CLI sendiri tidak punya transport
  redirect-able — bukti fresh 27 Nov: `docs/DIRECT_EDGE_LANE_2026-11-27.md` §2).

## 2. Siapa berjalan di mana (jawaban atas salah paham umum)

| Komponen | Berjalan di | Fungsi |
|---|---|---|
| **speedtest-bridge** (`hybrid/speedtest-bridge/`) | **VPS** — service permanen `speedtest-bridge.service` | front untuk klien native di **SEMUA port `OoklaServer.properties`** (TCP+UDP; mux paritas daemon penuh di SETIAP port: TLS diterminasi di bridge + NetGauge di dalam TLS + HTTP lane + loss) + payload ← Worker |
| **hybrid gateway** (`hybrid/gateway/`) | **VPS** — `speedtest-hybrid-gateway.service`, **UNIX SOCKET `/run/speedtest-hybrid/gateway.sock`** (tanpa port TCP) | control plane + front HTTP + mint token + sync pool Worker (watcher .env live); diakses bridge via socket atau admin via `curl --unix-socket` |
| **daemon OoklaServer** (`reverse-engineered/typescript`) | **VPS** — `speedtestserver.service`, **DI-PARK saat bridge aktif** | induk proyek + implementasi referensi; front standalone di SEMUA port properties bila `SPEEDTEST_BRIDGE_ENABLED=false` |
| **Worker pool** (`hybrid/worker/`) | Cloudflare edge (`*.workers.dev`, 1..100) | origin payload `/__down` `/__up` `/ws` (NetGauge WSS) |
| **Klien** | **mana pun — selalu aplikasi asli Ookla, tanpa modifikasi** | CLI resmi (hari ini), app Android/iOS, web. `hybrid/probe-client/` hanyalah alat bantu pengujian |

**Kesimpulan arah**: bridge ada DI VPS. Klien tidak pernah dipaksa apa pun;
sandbox agent memakai CLI resmi hanya sebagai TESTER (fase reverse
engineering) dengan hosts-mock — lihat §6.

## 3. Tata letak port — PORT AUTHORITY (OoklaServer.properties)

**Satu-satunya sumber port TCP/UDP proyek ini adalah file konfigurasi resmi
OoklaServer**: `/etc/speedtestserver/OoklaServer.properties`
(`OoklaServer.tcpPorts` / `OoklaServer.udpPorts`). Installer **tidak pernah
menulis** ke file itu; semua front diturunkan darinya saat runtime:

| Entitas | Sumber | Isi |
|---|---|---|
| `SPEEDTEST_BRIDGE_PORTS` | `OoklaServer.tcpPorts` | daftar port TCP — **bridge mengikat SEMUA-nya**, setiap port = mux paritas daemon penuh |
| `SPEEDTEST_BRIDGE_UDP_PORTS` | `OoklaServer.udpPorts` (default = tcpPorts) | daftar port UDP — plane loss, satu socket per port |
| Port 8080 | **WAJIB** anggota tcpPorts | bila tidak ada → installer MENOLAK dengan pesan jelas (tidak pernah menambah port sendiri) |
| Gateway | Unix socket `/run/speedtest-hybrid/gateway.sock` | **TANPA port TCP sama sekali** (dihubungi bridge + admin `curl --unix-socket`) |
| Daemon | unit di-park saat bridge aktif | aktif lagi di SEMUA port properties bila bridge dimatikan |

Aturan:

- **Jangan berasumsi port 5060 ada** — operator mungkin hanya mengisi 1 port
  (mis. hanya 8080); maka hanya port itu yang dipakai. 5060 setara 8080
  **bila** tertulis di properties.
- **Tidak ada port lain** yang dipakai proyek ini di luar daftar properties
  (port self-test installer bersifat transien, loopback, mati dalam
  hitungan detik).
- Deteksi per-koneksi by first-byte di SETIAP port TCP adalah **paritas
  daemon** (PROTOCOL_CONTRACT §1 [V]: "One TCP port multiplexes
  everything"), termasuk **TLS diterminasi lalu dideteksi ulang di
  dalamnya** (NetGauge-in-TLS = jalur UTAMA klien resmi; tanpa ini klien
  resmi gagal "Latency test failed" — pelajaran 27 Nov).
- HTTP (plain maupun di dalam TLS) di port properties dilayani **rute
  gateway** (control plane + front lane) melalui pipe Unix socket. Guard
  abuse (rate per-IP) di bridge.

## 4. speedtest-bridge — kontrak runtime

- **Auto-start saat boot + auto-restart saat crash**: unit
  `speedtest-bridge.service` (`Restart=always`, `RestartSec=3`,
  `WantedBy=multi-user.target`, `Requires=speedtest-hybrid-gateway.service`
  — start-propagation saja; front sengaja selamat dari restart gateway
  singkat karena mint punya cache + backoff 5 dtk).
- **Guard abuse** (rekomendasi #1 laporan 27 Nov): `maxConnPerIp` 500
  (paritas daemon) + `SPEEDTEST_BRIDGE_CONN_RATE_PER_MIN` 240 koneksi
  baru/menit/IP (satu run CLI = 30–45 koneksi) + mint token di belakang
  rate-limiter gateway.
- **Backend** (`SPEEDTEST_BRIDGE_BACKEND`): `worker-http` (default) ·
  `worker-ws` (framing di-strip, chunk 1 MiB wajib — single-command 32 MiB
  tanpa pacing ter-bunuh `exceededResources`) · `local` (kontrol A/B).
- Log JSONL: `/var/lib/speedtest-bridge/speedtest-bridge.jsonl`
  (append; rollover 64 MiB → `.old`). Kunci atribusi: `bytesFromWorkerDl`,
  `bytesToWorkerUl`, `workerReceipts`, per-event `dl_done`/`ul_done`,
  `tls_proxy_*`.
- Uji: `bash hybrid/speedtest-bridge/test/run-tests.sh` — **250/250**
  (paritas protokol 3 backend + mux TLS routing + **terminasi TLS: NetGauge
  di dalam TLS** + crash-regression RST saat sniff + rate-limit + konkurensi
  + **port-authority: multi-port full mux + gateway via Unix socket**).

## 5. Instalasi — `.env` dulu, lalu satu perintah (installer BEKU)

```bash
git clone https://github.com/smahud/SpeedtestServer.git && cd SpeedtestServer
cp .env.example .env
nano .env        # isi bagian [WAJIB] saja (kredensial CF + account id);
                 # sisanya default aman — lihat komentar inline
sudo ./install.sh --start
```

- **`install.sh` adalah bootstrap BEKU** (pola uaeg U-13): file itu tidak
  pernah berubah meski code berubah banyak — setiap eksekusi mengambil
  **installer core terbaru** dari GitHub (`installer/install-core.sh`, ref
  default `master`) dan menjalankannya. Checkout/`install.sh` LAWAS tetap
  selalu memasang dengan logika TERKINI. Kontrak lengkap:
  **docs/INSTALL_BOOTSTRAP.md**.
- **Urutan `.env`**: variabel **[WAJIB] di urutan paling atas**
  (kredensial Cloudflare, Account ID, jumlah worker, shared secret bisa
  dikosongkan → auto-generate). **Config tambahan dengan default ada di
  bawah** (mode, bridge, guard, knob) — user cukup edit bila perlu. **Port
  TIDAK diatur dari `.env`** — satu-satunya sumber port adalah
  `OoklaServer.properties` (§3).
- Installer core memasang SEMUA: daemon + gateway (Unix socket) +
  **speedtest-bridge** (SEMUA port properties) + deploy pool Worker (REST,
  fingerprint-gated) + auto-update timer harian + verifikasi probe tiap
  komponen. Aman diulang (idempoten; konfigurasi/sertifikat/.env
  dipertahankan; properties TIDAK PERNAH ditulis).
- Yang berlaku ON-THE-FLY (gateway watcher .env): jumlah worker, lane
  share, front limits, kredensial, shared secret. Kunci `SPEEDTEST_BRIDGE_*`:
  `systemctl restart speedtest-bridge` (atau jalankan ulang install.sh).
- Ganti port: edit `OoklaServer.properties` (tcpPorts/udpPorts; 8080 wajib
  ada) lalu jalankan ulang `install.sh --start` — bridge mengikat ulang
  SEMUA port baru, tanpa port lain dipakai.
- Mode standalone daemon (bridge dilepas; daemon pegang SEMUA port
  properties): set `SPEEDTEST_BRIDGE_ENABLED=false` lalu jalankan ulang
  `install.sh --start` — properties TIDAK pernah disentuh, jadi tidak ada
  yang perlu dipulihkan.

## 6. Metode uji klien RESMI (mock IP) — ringkas

Detail lengkap + jebakan: **`docs/OFFICIAL_CLI_TESTING_GUIDE.md`** (metode
tervalidasi 27 Nov 2026). Prinsip yang tidak boleh dilanggar:

1. **Klien = binary resmi** (`speedtest-cli_official/ookla-speedtest-1.2.0-…tgz`,
   versi 1.2.0.84, sha256 `31f1124c…`) — tanpa patch/wrapper.
2. **Target = server TER-PUBLISH yang IP-nya di-mock ke VPS** lewat
   `/etc/hosts` di namespace lab terisolasi (`unshare --user --map-root-user
   --mount` + bind `mockhosts`): entri server Surabaya operator →
   `45.126.249.250`, dan `results.speedtest.net` → `127.0.0.1`
   (**non-publishing**; wajib `persisted=false` / `result.url=null`).
3. Discovery (`cli.speedtest.net`) dibiarkan asli; pilih server via
   `--server-id` (default 66281 Tuxsindo).
4. **Atribusi 3 sisi** tiap klaim: output CLI (run.json) + sisi VPS
   (JSONL bridge / journal / delta eth0) + sisi Worker (GraphQL
   `workersInvocationsAdaptive` window ±1 menit + receipt).
5. Kontrol: run ke daemon (mode tanpa bridge) sebelum/sesudah eksperimen.
6. Alur aman produksi: **push GitHub → VPS `git pull` → deploy → uji →
   restore → verifikasi** (via UAEG MCP; kredensial di luar repo).

Kini mode bridge sudah PERMANEN (tidak perlu window eksperimen/manual):
CLI resmi + hosts-mock langsung dilayani `speedtest-bridge` di SEMUA port
`OoklaServer.properties`.

## 7. Peta reverse engineering (di mana ilmunya)

| Topik | Sumber |
|---|---|
| Kontrak protokol NetGauge byte-exact (HI/GETIP/PING/DOWNLOAD/UPLOAD/LOSS, three-strikes, GETIP gate, WS quirk, HTTP surface, allowedDomains) | `validation/PROTOCOL_CONTRACT.md` (semua fakta berlabel [V]/[P]/[D]) |
| Engine referensi TypeScript (port NetGaugeEngine yang diverifikasi) | `reverse-engineered/typescript/` |
| Analisis binary CLI resmi (hello terenkripsi → ERROR → fallback plaintext) | `speedtest-cli_analysis/`, `validation/OFFICIAL_CLI_FAILURE_ANALYSIS.md` |
| Semantik Worker `/__down` `/__up` `/ws` + cap 128 MiB + `?pace=` | `hybrid/worker/` (suite conformance/token/free-hardening/pool) |
| **DIRECT LANE web client resmi** (307 handoff, bukti PoC live + metode uji ulang) | `docs/DIRECT_EDGE_LANE_2026-11-27.md` + `hybrid/lab/evidence/direct-edge-lane-2026-11-27/` |
| Audit jalur edge langsung (verdict BLOCKED) | `audit/historical-native-worker-2026-11-27` (branch) |
| Eksperimen bridge asli + kronologi perbaikan | `docs/CLI_BRIDGE_REPORT_2026-11-27.md` + `hybrid/lab/evidence/cli-bridge-2026-11-27/` |
| Kontrak installer beku (bootstrap ↔ core ↔ updater) | `docs/INSTALL_BOOTSTRAP.md` |
| Perbandingan hasil VPS murni vs VPS+Worker | `Result_Comparison.md` |

## 8. Kontribusi & kualitas (aturan main agent)

1. **Commit + push ke GitHub setiap unit pekerjaan selesai** — sesi bisa
   putus; agent berikutnya melanjutkan dari repo, bukan dari memori.
2. Tes wajib hijau sebelum push: `hybrid/speedtest-bridge/test/run-tests.sh`
   (250), suite gateway/worker, build TS.
3. Klaim hasil selalu 3-sisi + label jujur (§1). Angka tanpa bukti 3 sisi
   bukan bukti.
4. Produksi hanya disentuh dengan alur §6.6 (push → pull → deploy → uji →
   restore → verifikasi) dan selalu tinggalkan produksi dalam keadaan
   terverifikasi.
5. Jebakan yang SUDAH terjadi (jangan diulang): mint token berbadai;
   ECONNRESET tengah-stream tanpa refetch remainder; UPLOAD mentah tidak
   diteruskan ke WSS; cap worker < 32 MiB; `?pace=`/chunking dimatikan di
   bawah pola 32 koneksi.
