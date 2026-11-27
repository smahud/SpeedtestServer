# DIRECT EDGE LANE — 27 November 2026

> Realisasi kontrak operator 27 Nov: **"worker membantu load berat LANGSUNG
> ke client"** (relay/bridge dilarang — lihat `CONTRACT.md` §1 "LARANGAN
> RELAY"). Dokumen ini = bukti RE + arsitektur + metode uji. Semua klaim
> di bawah punya bukti first-hand sesi ini (bukan kutipan sesi lama).

## 0. TL;DR

| Pertanyaan | Jawaban | Bukti |
|---|---|---|
| Bisakah klien RESMI Ookla dilayani VPS + Worker dengan payload **langsung** client ↔ edge (tanpa transit VPS)? | **YA — web client resmi speedtest.net** (SDK Ookla 3.1.3, halaman asli, browser asli, tanpa modifikasi): DL **232,0 Mbps** + UL **23,3 Mbps** dilayani **100% dari edge CF**; VPS hanya 440 byte control HTTP + WSS ping. | §3 PoC + §4 produksi |
| Kenapa CLI resmi TIDAK bisa? | CLI hanya bicara NetGauge biner (TCP/TLS) — **tidak punya permukaan redirect**. Diverifikasi ulang first-hand: gagal total "Latency test failed" **tanpa pernah mengirim satu request HTTP** walau permukaan HTTP + 307 disediakan di port yang sama. | §2 |
| Apakah relay (bridge worker-http/ws lama) masih dibenarkan? | **TIDAK — dilarang kontrak.** Semua lane relay terkunci egress VPS (audit 27 Nov: 429–473 Mbps semua lane). CLI kini dilayani `SPEEDTEST_BRIDGE_BACKEND=local` (full-VPS). | `CONTRACT.md` §1 |

## 1. Arsitektur direct lane (yang sekarang produksi)

```
Browser asli (https://www.speedtest.net — HALAMAN & ENGINE RESMI, unmodified)
  │
  ├─ WSS  wss://<host-ter-publish>:8080/ws ──────────► VPS (bridge :8080 TLS
  │   HI / GETIP / CAPABILITIES / PING                termination → gateway)
  │   (+ loaded-latency SELAMA fase DL dan UL         = CONTROL plane:
  │    berjalan simultan — ~2.400 frame PING/run)      ping/jitter/handshake
  │
  ├─ XHR  GET /hello /getip /capabilities /ping ────► VPS (byte kecil)
  │
  ├─ XHR  GET /download?size=25MB ──► VPS menjawab **307**
  │                                       └─► browser ikut → WORKER CF ◄── payload DL
  │
  └─ XHR  POST /upload (body 25MB) ──► VPS menjawab **307** (method+body dipertahankan)
                                          └─► browser re-POST → WORKER CF ◄── payload UL
```

- **VPS tidak pernah membawa byte payload** pada lane ini (kecuali "spill"
  ~1 RTT body upload yang sudah terkirim sebelum 307 sampai — terukur
  ~970 KB dari 44 MB UL pada PoC; hilang jika RTT kecil).
- **DL dan UL dilayani simultan** oleh worker, sementara WSS ping
  (loaded latency) tetap mengalir ke VPS pada saat bersamaan.

Komponen (semua sudah di repo, teruji):

| Komponen | File | Fungsi |
|---|---|---|
| Worker edge surface | `hybrid/worker/src/ookla-xhr.ts` (+ routing `index.ts`) | `GET /download?size=N` (CL persis N, octet-stream, CORS), `POST /upload` (`size=N\n`), `/hello /getip /capabilities /ping`, OPTIONS preflight; token-gated sama seperti `/__down /__up`; log JSONL `xhr_dl`/`xhr_ul` (guid) untuk atribusi |
| Gateway front (VPS) | `hybrid/gateway/src/front.mjs` (rute web + `redirectCors`) | control XHR lokal + **307 handoff** `/download` & `POST /upload` ke worker pool (token mint ada; fallback full-VPS bila edge mati/mint ter-limit); knob `HYBRID_WEB_DIRECT` |
| Gateway WSS control | `hybrid/gateway/src/webws.mjs` | NetGauge-over-WS dengan quirk web (HELLO/CAPABILITIES tanpa `\n`, raw UPLOAD frame, GETIP gate); **CAPABILITIES tanpa UPLOAD_STATS** |
| Env | `.env.example` | `HYBRID_WEB_DIRECT=true` (default; `false` = full-VPS) |

## 2. RE fresh: CLI resmi TIDAK punya permukaan redirect (bukti 27 Nov)

Eksperimen `cli-exhaust` (lab terisolasi `unshare --user --map-root-user
--mount` + bind `/etc/hosts`; server target 66281 tuxsnet di-mock ke
127.0.0.1; listener :8080 dengan dispatch byte-pertama):

1. **TLS ClientHello** → ditolak (close) — memaksa fallback plaintext.
2. **NetGauge terenkripsi** (`18 11 c7 17 …` 65B) → dijawab `ERROR\n`
   (terlihat di log CLI: `input:RVJST1IK` = base64 "ERROR\n").
3. **Fallback plaintext** `HI BE96287D-…` → dijawab `ERROR\n` →
   CLI log: `Protocol error: Did not receive HELLO` → **RST**.
4. Hasil akhir CLI: `"error": "Latency test failed"`, exit 2.

Yang TIDAK pernah terjadi meski disediakan lengkap di port yang sama:
`GET /download` (307 ke worker), `POST /upload` (307), `/hello`, `/latency.txt`,
`random*.jpg` (307) — **0 request HTTP, 0 koneksi ke port lain (:5060)**.

Kesimpulan: transport CLI = NetGauge biner saja (plain/terenkripsi),
single host:port dari server-list. CF Workers free hanya menerima inbound
HTTP/WS ⇒ **tidak ada jalur edge langsung untuk CLI** — bukan karena
"CF free", tapi karena protokol CLI-nya sendiri. Maka CLI dilayani
full-VPS (backend `local`) — sesuai kalimat operator: *"dr pada pakai
worker sekalian saja full vps"*.

## 3. PoC end-to-end (bukti mekanisme, 27 Nov 15:30–15:45 UTC)

Metode (padanan hosts-mock lane CLI, versi browser):

1. `poc-vps-role.mjs` = VPS-role di sandbox (TLS :8080 self-signed):
   WSS control (quirk web) + XHR control lokal + **307** `/download` &
   `/upload` → worker asli `speedtest-hybrid-worker-test.lumajangnetworks.workers.dev`.
2. Playwright + Chromium headless: `--host-resolver-rules=MAP
   speedtest.tuxsnet.id.prod.hosts.ooklaserver.net <ip>` +
   `--ignore-certificate-errors` (setara mock hosts lab CLI; discovery
   `www.speedtest.net` 100% asli).
3. Navigasi `https://www.speedtest.net/server/66281` → klik GO → run penuh.

Hasil run (output JSONL `poc-run.jsonl` + payload resmi `POST
/api/results.php`):

| Metrik | Nilai | Atribusi |
|---|---|---|
| Download (SDK resmi) | **29.684.467 B/s = 232,0 Mbps**; 6 koneksi, 434.776.887 B | `workers.dev` melayani **533.098.487 B** / 14 request (semua via 307 dari VPS-role); VPS-role **0 byte payload** |
| Upload (SDK resmi) | 2.906.977 B/s = **23,3 Mbps** (lokal — lihat §5) | 12 × `ul_307` dari VPS-role → worker; spill 970.048 B (body pra-redirect) |
| Ping / jitter | 0,6 ms / 0,122 ms (jarak lab) | WSS ke VPS-role, 4.866 frame |
| `testmethod` | `wss,xhrs,xhrs` | latency=WSS(VPS), DL=XHR(edge), UL=XHR(edge) |
| VPS-role total | HTTP control keluar **440 B**; WSS control ~46 KB | bandingkan: relay lama memindahkan SEMUA 533 MB via VPS |

Dua temuan jaringan penting selama PoC (sudah diimplementasi di kode):

- **PNA (Private Network Access) Chromium**: XHR dari halaman publik ke
  `127.0.0.1` diblok browser (WSS tidak). Lab harus memetakan host mock ke
  IP **publik** mesin uji (produksi tidak terkena — VPS memang publik).
- **`Origin: null` pada redirect lintas-origin**: browser yang mengikuti
  307 mengirim `Origin: null` (aturan fetch spec). Worker HARUS menjawab
  `Access-Control-Allow-Origin: null` — kalau tidak, request measurement
  diblok CORS (ini bug pertama yang kami temui dan perbaiki di
  `ookla-xhr.ts`).
- **Preflight octet-stream**: POST `/upload` SDK memicu OPTIONS preflight
  dengan `Access-Control-Request-Headers: content-type`; jawaban OPTIONS
  **wajib** meng-echo ACAH (bug kedua — tanpa ini stage upload mati
  sebelum mengirim byte).

## 4. Verifikasi produksi (VPS asli 45.126.249.250 — 27 Nov, post-deploy 1.7.0)

Deploy: push `f094541` → VPS `git pull` → `install.sh --start` (VERSION
1.7.0; bridge `backend: local`; worker produksi ter-redeploy dengan
permukaan `ooklaXhr`) → `SPEEDTEST_BRIDGE_BACKEND=local` + restart bridge.

E2E dari sandbox (metode §6-C, host 66281 → 45.126.249.250, halaman
speedtest.net asli):

| Bukti | Nilai |
|---|---|
| Worker produksi melayani DL | **458.046.142 byte (458 MB)** di 52 response — semuanya via 307 dari VPS; `redirects_followed=52` |
| VPS (host mock) | 300 request control, **total 1.865 byte** respons body (hello/ping/pong/307) — **0 byte payload** |
| Run | selesai penuh + `POST /api/results.php` (payload 10.637 byte terkirim) |
| Perbaikan lapangan | gateway produksi awalnya `webws_unavailable` (ws tidak ter-ship ke $HYBRID_PREFIX) → SDK fallback XHR ping (run tetap selesai); FIXED: ws di-copy ke `/opt/speedtest-hybrid/gateway/node_modules` + installer kini selalu menship ws (commit ini) → upgrade **101 Switching Protocols** terverifikasi via Unix socket |

**Run final (setelah fix ws — WSS control lane aktif, evidence
`prod-run3.jsonl` + `prod-run3.result-payload.json`):**

| Sisi | Bukti |
|---|---|
| SDK resmi (payload hasil) | **DL 208,7 Mbps** (390,0 MB, 6 koneksi) · **UL 23,1 Mbps** · ping 60,1 ms · jitter 0,7 · **testmethod `wss,xhrs,xhrs`** |
| Browser (per-host) | `workers.dev`: **492.468.080 byte** DL, 59 redirect diikuti; VPS host: 528 byte; **920 frame WSS control** ke VPS |
| Gateway VPS (journal) | 40 × `web_download_redirect` + 274 × `web_upload_redirect` (lane=edge, guid cocok) + `web_ws_open` |

Ketiga sisi cocok: payload berat 100% client ↔ edge; VPS hanya control.

## 5. Keputusan desain + batasan jujur

1. **CAPABILITIES tanpa UPLOAD_STATS pada direct lane.** Byte upload
   mendarat di edge, jadi VPS tidak bisa menghitungnya secara remote;
   SDK lalu mengukur upload **lokal** (progress event XHR) — jalur
   fallback yang memang didesain SDK untuk server tanpa kapabilitas itu.
   Konsekuensi: `uploadMeasurementMethod` = local (bukan remote).
   (Peningkatan lanjutan opsional: worker beacon byte-count per-guid ke
   gateway agar stats remote tetap presisi — control-plane kecil.)
2. **Spill pra-redirect**: ±1 RTT × bandwidth dari body upload pertama
   per koneksi masuk ke VPS sebelum 307 terbaca (PoC: 970 KB / 44 MB).
   Pada RTT Indonesia↔klien kecil, nyaris nol.
3. **Cap worker**: `MAX_DOWNLOAD_BYTES`/`MAX_UPLOAD_BYTES` (128 MiB
   produksi) per request — permintaan SDK 25–34 MB aman.
4. **`size > cap` di-edge**: potong ke cap + log `xhr_dl_capped`
   (deviasi terdokumentasi — produksi daemon menjawab default 10 GiB).
5. Preflight OPTIONS di gateway meng-echo `Access-Control-Allow-Headers`
   (permintaan header) — deviasi disengaja dari daemon (daemon tidak
   perlu karena jalur aslinya same-origin-ish di ekosistem Ookla);
   diperlukan agar preflight browser lolos.
6. Lab browser wajib: host mock dipetakan ke IP publik + flag
   `--ignore-certificate-errors` (PNA + cert lab). Produksi normal
   (cert wildcard LE valid) tidak butuh keduanya.

## 6. Metode uji ulang (untuk agent berikutnya)

```bash
# A. Worker test env (open, caps 128 MiB) — deploy dari repo:
cd hybrid/worker && npx wrangler deploy --env test \
  --var MAX_DOWNLOAD_BYTES:134217728 --var MAX_UPLOAD_BYTES:134217728

# B. PoC lengkap (VPS-role lokal + worker asli + halaman asli speedtest.net):
#    lab/poc-vps-role.mjs + lab/poc-webclient.mjs (repo sesi ini —
#    disalin ke hybrid/lab/evidence/direct-edge-lane-2026-11-27/lab/)

# C. Produksi (VPS asli): MOCK_IP=45.126.249.250 lalu jalankan
#    poc-webclient.mjs — atribusi: gateway JSONL (/var/lib/speedtest-hybrid/)
#    + Worker logs + browser per-host accounting.

# D. CLI lane (full-VPS): ikuti docs/OFFICIAL_CLI_TESTING_GUIDE.md
#    (backend `local` — bridge tidak lagi memanggil worker).
```

## 7. Indeks bukti sesi ini

| Bukti | Lokasi |
|---|---|
| PoC run JSONL + payload hasil resmi | `hybrid/lab/evidence/direct-edge-lane-2026-11-27/poc-run.jsonl`, `poc-run.result-payload.json`, `vps-role.jsonl` |
| Skrip PoC (VPS-role, driver browser, diagnostik PNA/redirect/preflight) | `hybrid/lab/evidence/direct-edge-lane-2026-11-27/lab/` |
| CLI-exhaust (rejector + log + output CLI) | `…/cli-exhaust/` (`rejector.log`, `cli-exhaust-out.json`, `cli-exhaust-err.log`) |
| Tes gateway direct lane (T21–T24) | `hybrid/gateway/test/gateway-tests.mjs` — 23/23 |
| Tes worker (conformance+token+hardening+pool) | `hybrid/worker/test/` — 90/90 |
