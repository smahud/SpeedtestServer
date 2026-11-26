# CONTRACT.md — kontrak proyek SpeedtestServer (hybrid + speedtest-bridge)

> Dokumen ini adalah **titik masuk tunggal** untuk agent/operator baru: apa
> target proyek, siapa berjalan di mana, tata letak port, cara instalasi,
> cara menguji dengan aplikasi RESMI Ookla, dan peta reverse engineering.
> Bahasa: Indonesia; istilah teknis mengikuti repo. Terakhir diperbarui:
> 27 Nov 2026 (speedtest-bridge permanen + penyatuan port).

## 1. Target proyek (kalimat pembuka yang tidak boleh berubah)

Menjadi **pengganti mandiri (standalone) OoklaServer** yang:

1. melayani **klien 100% asli/resmi Ookla TANPA modifikasi** — CLI resmi
   hari ini; keluarga engine yang sama (app Android/iOS) dan lane web
   menyusul. **Tidak pernah ada komponen yang dipasang di sisi klien.**
2. berjalan di **VPS + Cloudflare Worker pool** (Free tier): kontrol +
   identitas + loss di VPS, payload pengukuran bisa ber-origin di edge.
3. membuka **hanya port native OoklaServer** (`8080` + `5060` — dua port
   yang ditawarkan `OoklaServer.properties` resmi), tidak ada port lain.
4. terpasang penuh dari **satu file `.env` + satu perintah instalasi**
   (lihat §5).

### Label jujur (wajib dipertahankan saat mengutip hasil)

- Mode bridge (payload dari Worker): **edge-ORIGIN dengan RELAY VPS** —
  semua byte tetap transit link VPS; **tidak menambah kapasitas per sesi**
  (terukur: DL bridge 416–449 Mbps vs daemon 451–462 Mbps, 27 Nov 2026).
- Jalur edge **langsung** (non-relay) untuk klien native **tetap BLOCKED**
  (BLOCKED_BY_PROTOCOL + BLOCKED_BY_FREE_PLAN — audit 26–27 Nov 2026).

## 2. Siapa berjalan di mana (jawaban atas salah paham umum)

| Komponen | Berjalan di | Fungsi |
|---|---|---|
| **speedtest-bridge** (`hybrid/speedtest-bridge/`) | **VPS** — service permanen `speedtest-bridge.service` | front NetGauge :8080 untuk klien native (paritas daemon) + mux TLS; payload ← Worker |
| **hybrid gateway** (`hybrid/gateway/`) | **VPS** — `speedtest-hybrid-gateway.service`, **loopback :8790** | control plane + front HTTP + mint token + sync pool Worker (watcher .env live) |
| **daemon OoklaServer** (`reverse-engineered/typescript`) | **VPS** — `speedtestserver.service`, **:5060** | induk proyek; paritas PENUH (termasuk permukaan HTTP/TLS + NetGauge-TLS) di port native satunya |
| **Worker pool** (`hybrid/worker/`) | Cloudflare edge (`*.workers.dev`, 1..100) | origin payload `/__down` `/__up` `/ws` (NetGauge WSS) |
| **Klien** | **mana pun — selalu aplikasi asli Ookla, tanpa modifikasi** | CLI resmi (hari ini), app Android/iOS, web. `hybrid/probe-client/` hanyalah alat bantu pengujian |

**Kesimpulan arah**: bridge ada DI VPS. Klien tidak pernah dipaksa apa pun;
sandbox agent memakai CLI resmi hanya sebagai TESTER (fase reverse
engineering) dengan hosts-mock — lihat §6.

## 3. Tata letak port (penyatuan port — hanya port native OoklaServer)

| Port | Pemilik | Protokol yang dilayani |
|---|---|---|
| TCP **:8080** | speedtest-bridge | NetGauge plaintext (HI/GETIP/PING/DOWNLOAD/UPLOAD …) **+** mux TLS daemon-parity: ClientHello `0x16 0x03…` → proxy mentah ke gateway loopback |
| UDP **:8080** | speedtest-bridge | loss plane (LOSS init/loaded + `RECV`) |
| TCP **:5060** | daemon OoklaServer | NetGauge + HTTP + TLS + WS/WSS (multiplex penuh — paritas daemon asli) |
| UDP **:5060** | daemon OoklaServer | loss plane daemon |
| :8790 | gateway | **loopback SAJA** (upstream mux; tidak publik) |

- Deteksi per-koneksi by first-byte di :8080 adalah **paritas daemon**
  (PROTOCOL_CONTRACT §1 [V]: "One TCP port multiplexes everything"), bukan
  hack — daemon asli melakukan hal yang sama.
- Port daemon dikonfigurasi **di `OoklaServer.properties`** (file config
  resminya OoklaServer — satu-satunya tempat). `install.sh` menyempitkannya
  ke `5060` saat bridge aktif, dengan backup bertanda-waktu;
  `SPEEDTEST_BRIDGE_ENABLED=false` memulihkan `5060,8080` + melepas unit.
- Deviasi terdokumentasi: HTTP polos (non-TLS) ke :8080 jatuh ke front
  NetGauge (ERROR/3-strikes) — produksi TLS-only; permukaan HTTP/TLS penuh
  tetap ada di daemon :5060.

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
- Uji: `bash hybrid/speedtest-bridge/test/run-tests.sh` — **225/225**
  (paritas protokol 3 backend + mux TLS + rate-limit + konkurensi).

## 5. Instalasi — `.env` dulu, lalu satu perintah

```bash
git clone https://github.com/smahud/SpeedtestServer.git && cd SpeedtestServer
cp .env.example .env
nano .env        # isi bagian [WAJIB] saja (kredensial CF + account id);
                 # sisanya default aman — lihat komentar inline
sudo ./install.sh --start
```

- **Urutan `.env`**: variabel **[WAJIB] di urutan paling atas**
  (kredensial Cloudflare, Account ID, jumlah worker, shared secret bisa
  dikosongkan → auto-generate). **Config tambahan dengan default ada di
  bawah** (mode, port, bridge, guard, knob) — user cukup edit bila perlu.
- `install.sh` memasang SEMUA: daemon + gateway (loopback) + **speedtest-
  bridge** + deploy pool Worker (REST, fingerprint-gated) + auto-update
  timer harian + verifikasi probe tiap komponen. Aman diulang (idempoten;
  konfigurasi/sertifikat/.env dipertahankan).
- Yang berlaku ON-THE-FLY (gateway watcher .env): jumlah worker, lane
  share, front limits, kredensial, shared secret. Kunci `SPEEDTEST_BRIDGE_*`:
  `systemctl restart speedtest-bridge` (atau jalankan ulang install.sh).
- Pulihkan mode lama (daemon pegang 8080+5060, gateway publik :8790):
  set `SPEEDTEST_BRIDGE_ENABLED=false` lalu jalankan ulang `install.sh --start`.

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
CLI resmi + hosts-mock langsung dilayani `speedtest-bridge :8080`.

## 7. Peta reverse engineering (di mana ilmunya)

| Topik | Sumber |
|---|---|
| Kontrak protokol NetGauge byte-exact (HI/GETIP/PING/DOWNLOAD/UPLOAD/LOSS, three-strikes, GETIP gate, WS quirk, HTTP surface, allowedDomains) | `validation/PROTOCOL_CONTRACT.md` (semua fakta berlabel [V]/[P]/[D]) |
| Engine referensi TypeScript (port NetGaugeEngine yang diverifikasi) | `reverse-engineered/typescript/` |
| Analisis binary CLI resmi (hello terenkripsi → ERROR → fallback plaintext) | `speedtest-cli_analysis/`, `validation/OFFICIAL_CLI_FAILURE_ANALYSIS.md` |
| Semantik Worker `/__down` `/__up` `/ws` + cap 128 MiB + `?pace=` | `hybrid/worker/` (suite conformance/token/free-hardening/pool) |
| Audit jalur edge langsung (verdict BLOCKED) | `audit/historical-native-worker-2026-11-27` (branch) |
| Eksperimen bridge asli + kronologi perbaikan | `docs/CLI_BRIDGE_REPORT_2026-11-27.md` + `hybrid/lab/evidence/cli-bridge-2026-11-27/` |
| Perbandingan hasil VPS murni vs VPS+Worker | `Result_Comparison.md` |

## 8. Kontribusi & kualitas (aturan main agent)

1. **Commit + push ke GitHub setiap unit pekerjaan selesai** — sesi bisa
   putus; agent berikutnya melanjutkan dari repo, bukan dari memori.
2. Tes wajib hijau sebelum push: `hybrid/speedtest-bridge/test/run-tests.sh`
   (225), suite gateway/worker, build TS.
3. Klaim hasil selalu 3-sisi + label jujur (§1). Angka tanpa bukti 3 sisi
   bukan bukti.
4. Produksi hanya disentuh dengan alur §6.6 (push → pull → deploy → uji →
   restore → verifikasi) dan selalu tinggalkan produksi dalam keadaan
   terverifikasi.
5. Jebakan yang SUDAH terjadi (jangan diulang): mint token berbadai;
   ECONNRESET tengah-stream tanpa refetch remainder; UPLOAD mentah tidak
   diteruskan ke WSS; cap worker < 32 MiB; `?pace=`/chunking dimatikan di
   bawah pola 32 koneksi.
