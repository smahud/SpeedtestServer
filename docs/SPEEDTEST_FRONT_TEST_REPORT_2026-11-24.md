# LAPORAN UJI — Real speedtest-cli dengan payload di Cloudflare Worker (Sesi 3)

**Tanggal:** 24 November 2026 (03:00–03:40 UTC / 10:00–10:40 WIB)
**Pelaksana:** agent UAEG sesi 3
**Target operator (kutipan):** "payload besar untuk upload/download di layani oleh cloudflare worker dan kebutuhan lainnya yg relatif ringan dilayani oleh vps itu sendiri. jadi ketika pemilihan server, ping, dll maka IP vps yg muncul, tapi saat payload besar lewat maka cloudflare worker yg melayani."
**Instruksi uji:** mock domain aktif lain diarahkan ke server VPS + speedtest diarahkan ke domain list Surabaya yang dikirim operator sebelumnya.

---

## 1. Ringkasan hasil

| # | Skenario | Tester | Server yang muncul | Ping | Download | Upload | Jalur payload |
|---|---|---|---|---|---|---|---|
| T1 | domain list, `--server-id 74964` | **CLI resmi Ookla 1.2.0.84** | `speedtest.somedigit.net` (→ 45.126.249.250 via /etc/hosts) | 64,6 ms | 447,2 Mbps (566,6 MB) | 149,7 Mbps (228,6 MB) | VPS (daemon :8080, Jalur A) |
| T1b | domain list, `--server-id 66281` | **CLI resmi Ookla 1.2.0.84** | `speedtest.tuxsnet.id` (→ 45.126.249.250) | 64,1 ms | 437,5 Mbps (523,7 MB) | 138,2 Mbps (215,4 MB) | VPS (Jalur A) |
| T2 | `--mini` host produksi | **speedtest-cli 2.1.3 (stock, tanpa modifikasi)** | `speedtest.lumajangnetworks.my.id:8790` (DNS publik → 45.126.249.250) | 129,1 ms | **580,0 Mbps (387,7 MB) — EDGE** | 117,1 Mbps (146,8 MB) — VPS | download = Worker; upload = VPS (batas urllib stock, lihat §6.2) |
| T3 | `--mini` **mock domain** | **speedtest-cli 2.1.3 + transport hybrid** (`speedtest-cli-hybrid.py`) | `speedtest-mock.lumajangnetworks.my.id:8790` → 45.126.249.250 | 130,8 ms | **559,5 Mbps (387,7 MB) — EDGE** | **603,0 Mbps (151,5 MB) — EDGE** | **download + upload = Worker** |
| T4 | **domain list** `--server 74964` | **speedtest-cli 2.1.3 + transport hybrid** | **`somedigit.net (Surabaya, Indonesia) [id 74964]`** | 129,8 ms | **556,6 Mbps (387,7 MB) — EDGE** | **710,7 Mbps (151,5 MB) — EDGE** | **download + upload = Worker** |

**Kesimpulan target tercapai (T3/T4):** saat pemilihan server dan ping, koneksi mendarat di **IP VPS 45.126.249.250** (front gateway port 8790, TLS wildcard). Saat payload besar lewat, **Cloudflare Worker** (`speedtest-hybrid-worker.lumajangnetworks.workers.dev`) yang melayani. Bukti atribusi byte di §3.

Status label (§4 master prompt): front = **DEPLOYED** + **VERIFIED-AUTO**; sesi E2E T3/T4 = **VERIFIED-AUTO**; host tester resmi (A3) tetap **NOT TESTED** (operator).

## 2. Arsitektur yang diuji

```
                      ┌────────────────────────────────────────────┐
                      │  Client (sandbox eksternal, Alibaba HK)    │
                      │  speedtest-cli resmi / speedtest-cli +      │
                      │  transport hybrid (engine ukur 100% stock)  │
                      └───────┬──────────────────────┬──────────────┘
              ringan (ping/seleksi,  │              │ payload besar (302 diikuti
              respons redirect kecil)│              │ langsung oleh client)
                              ┌──────▼─────────┐  ┌──▼──────────────────────────┐
                              │ VPS 45.126.249 │  │ Cloudflare Worker (Free)    │
                              │ gateway :8790  │  │ speedtest-hybrid-worker.    │
                              │ + FRONT baru   │  │ lumajangnetworks.workers.dev│
                              │ latency.txt    │  │ /__down?bytes=N&token=…     │
                              │ 302 random*.jpg├─►│ POST /__up (Bearer)         │
                              │ drain upload   │  │ payload dibuat/dikuras di  │
                              └────────────────┘  │ edge                        │
                                                  └─────────────────────────────┘
```

Komponen baru sesi 3 (semua Jalur B, Jalur A tidak disentuh):
- `hybrid/gateway/src/front.mjs` — permukaan HTTP legacy speedtest di gateway dengan offload: `latency.txt` langsung dari VPS; `random*.jpg` → **302** → `__down` Worker (token HMAC di query); `upload.php` POST → drain penuh + `size=N` (klien stock); GET `upload.php` → `size=0` (probe mini). Rate limit mint token per IP (default 90/menit), cap 25 MiB per redirect (menyesuaikan MAX_DOWNLOAD_BYTES Worker).
- `hybrid/probe-client/speedtest-cli-hybrid.py` — wrapper klien: engine pengukuran **100% speedtest-cli stock**; hanya dua hook transport: (1) URL server diarahkan ke front VPS (seleksi+ping), (2) POST upload diarahkan langsung ke `__up` Worker dengan Bearer token. (Latar: urllib stock selalu mengirim seluruh body POST ke hop pertama sebelum membaca respons — 307 tidak bisa mengalihkan upload, lihat §6.2.)
- `hybrid/probe-client/server-list-surabaya.json` — domain list operator (9 server Surabaya; entri 72945 BLiP tanpa host tidak diikutkan).

### Keputusan "mock domain"

Operator meminta mock domain aktif lain diarahkan ke VPS. Uji cakupan:
- `speedtest-mock.lumajangnetworks.my.id` dipilih sebagai nama; sertifikat wildcard `*.lumajangnetworks.my.id` (Let's Encrypt, kedaluwarsa 2027-01-08) sudah mencakupnya — Terverifikasi dengan `openssl s_client -servername`.
- **Record DNS publik tidak dapat dibuat** dari credential yang tersedia: API token `cfut_…` aktif tapi tanpa izin `Zone › DNS` (verifikasi: `GET /zones/{id}/dns_records` → 10000 Authentication error; Global API Key `cfk_…` ditolak Cloudflare, konsisten dengan temuan sesi 2). Karena itu mock domain diaktifkan lewat `/etc/hosts` pada client uji (`45.126.249.250 speedtest-mock.lumajangnetworks.my.id`) — sandbox tanpa root memakai `unshare --user --map-root-user --mount` + bind-mount `/etc/hosts` (mekanisme /etc/hosts yang setara, transparan bagi semua klien termasuk binary statis CLI resmi).
- Untuk produksi: perintah API pembuatan record ada di `HYBRID_DEPLOYMENT_RUNBOOK.md` §front (menunggu operator memberi token DNS Edit atau membuat record manual: `A speedtest-mock 45.126.249.250, DNS-only`).

## 3. Bukti atribusi byte (VPS hanya melayani kontrol)

Counter `eth0` VPS (dari `/sys/class/net/eth0/statistics/{rx,tx}_bytes`) dan counter front gateway, diambil sebelum/sesudah tiap jendela uji (`hybrid/lab/evidence/e-k-speedtest-front/snapshots.jsonl`):

| Jendela | VPS rx (MB) | VPS tx (MB) | front out (B) | front in (B) | Interpretasi |
|---|---|---|---|---|---|
| T1 (CLI resmi 74964) | 265,61 | 621,00 | 0 | 0 | Path A: 566,6 MB down + 228,6 MB up transit VPS |
| T1b (CLI resmi 66281) | 249,75 | 575,57 | 0 | 0 | Path A: 523,7 MB down + 215,4 MB up transit VPS |
| T2 (stock `--mini`) | 154,40 | 6,90 | 779 | 146.685.952 | download 387,7 MB **tidak lewat VPS** (front keluar 779 B); upload 146,8 MB drain di VPS (stock) |
| T3 (hybrid mock domain) | 0,16 | 0,33 | 146 | 0 | 539,2 MB payload (387,7 down + 151,5 up) **semua di edge**; VPS hanya kontrol |
| T4 (hybrid domain list) | 0,15 | 0,31 | 30 | 0 | 539,2 MB payload **semua di edge**; front keluar 30 B |

- T2: `bytes_sent` client 146.767.872 vs `front bytesIn` 146.685.952 — selisih < 0,06% (framing/overhead TLS) → pembukuan drain akurat.
- T3/T4: `front uploadsDrained` **tidak bertambah** (tetap 51 milik T2) — upload hybrid tidak pernah menyentuh VPS.
- Offload T3/T4 ≈ 539.200.000 B payload : ±500.000 B VPS ≈ **1 : 1000**.
- Catatan metodik: counter `__meta` Worker per-isolate bisa melewatkan invoke di isolate lain (jendelah isolate ≠ PoP), karena itu bukti primer = counter interface VPS + byte client, konsisten dengan Fase 6 master prompt.

## 4. Bukti "IP VPS muncul" saat seleksi/ping

- DNS di dalam namespace uji (`dns-proof.txt`): `speedtest-mock.lumajangnetworks.my.id → 45.126.249.250`, `speedtest.somedigit.net → 45.126.249.250`, dst. (9 domain list dipetakan; `results.speedtest.net` diblok 127.0.0.1, lihat §6.4).
- Journal gateway: `front_latency` dari IP egress client setiap run ping (raw HTTP, tanpa redirect-follow — `latency.txt` memang harus dijawab VPS).
- T1/T1b: CLI resmi memilih server dari daftar resmi Ookla ber-ID operator (`74964`/`66281`), lalu seluruh sesi NetGauge TCP mendarat di `45.126.249.250:8080` (daemon Jalur A) — `resolved.ipv4` di JSON hasil = 45.126.249.250.

## 5. Bukti payload dilayani Worker

- Redirect front (T2/T3/T4): `Location: https://speedtest-hybrid-worker.lumajangnetworks.workers.dev/__down?bytes=…&token=v1~…` (token tidak dicatat di log).
- `curl -L` dari client: `final=200 bytes=245388` dengan `remote_ip=172.67.131.176` (anycast Cloudflare) — bukan IP VPS.
- Upload hybrid: POST masuk `__up` Worker dengan `Authorization: Bearer v1~…`; balasan `{"bytes":…}`; `results.jsonl` gateway menerima hasil lengkap (guid `19b4a965…`, receipt `{"ok":true}`) — alur sesi hybrid (token → ping VPS → transfer edge → hasil) utuh.

## 6. Batasan dan keputusan teknis yang terdokumentasi

1. **CLI resmi Ookla (binary)** tidak dapat dialihkan payloadnya ke Worker — protokol NetGauge TCP mentah, bukan HTTP (eksperimen E-D/E-E; spec §2). Peran CLI resmi dalam target ini = jalur Jalur A (T1/T1b lulus penuh, exit 0, `result.persisted=false` karena endpoint hasil sengaja diblok). Uji speedtest-cli HTTP (sivel) yang mendukung offload = T2/T3/T4.
2. **Upload klien stock urllib tidak bisa dialihkan via redirect**: urllib mengirim seluruh body POST ke hop pertama sebelum membaca respons 307/302 (diverifikasi di lab lokal: POST+307 → HTTPError; POST+302 → body dijatuhkan). Solusi perencanaan spec §4 ("ambil URL dari manifest sebelum mengirim body") diwujudkan sebagai hook transport di `speedtest-cli-hybrid.py` (POST diarahkan ke `__up` sebelum body dikirim). Klien stock tetap jujur: upload terukur di jalur VPS (T2, drain penuh — bukan early-answer; lihat temuan T-10).
3. **`--server <ID>` dari geo-list tidak memuat server Surabaya** (daftar speedtest.net kini geo-lokal; dari sandbox HK hanya server HK). Karena itu domain list operator diinjeksikan lewat `HYBRID_SERVER_LIST_FILE` (isi persis daftar yang dikirim operator) — inilah mode "speedtest diarahkan ke domain list". CLI resmi tidak terpengaruh (API `--server-id` miliknya tetap menemukan 74964/66281).
4. **Pengiriman hasil CLI resmi diblokir** (`127.0.0.1 results.speedtest.net` di namespace uji) sesuai invariant §3.8 master prompt (tes paksa tidak boleh mengirim hasil ke layanan Ookla). CLI tetap exit 0 dengan `persisted:false` — pola yang sudah tervalidasi repo (`validation/EXTERNAL_FLOWS.md`).

## 7. Temuan baru (didokumentasikan untuk agent berikutnya)

- **T-10**: early-answer + `Connection: close` pada `upload.php` front memutus aliran kirim klien di jaringan nyata (RTT ±130 ms) — `bytes_sent` hanya ±64 KB/request (ukuran tidak jujur). Perbaikan: drain penuh baru jawab `size=<drained>` (paritas daemon legacy). Tersebar di journal sebagai `front_upload_start/done/abort/timeout`.
- **T-11**: cap 25 MiB per `__down` (keputusan sesi 2) membuat `random4000x4000.jpg` (31,6 MB) gagal 400 di edge → front memangkas `bytes` ke 25 MiB (`downCapped` counter; ukuran tetap jujur karena client menghitung byte yang benar-benar diterima).
- **T-12**: daftar server Python speedtest-cli kini geo-lokal (±10 entri terdekat client) — `--server <ID jauh>` gagal `NoMatchedServers` meski ID valid (CLI resmi masih menemukannya). Ini latar injeksi `server-list-surabaya.json`.

## 8. Keamanan (dicek ulang setelah deploy front)

- Rate limit mint token: burst 120 request → tepat 90×302 + 30×429; `latency.txt` tidak dibatasi (jendela 60 s).
- Token: HMAC v1, TTL 5 menit, `ip='*'` (kebijakan G-1), tidak pernah dicatat di log/journal; hanya lewat TLS.
- Worker produksi: `__down`/`__up` tanpa token → 401 (`{"error":"unauthorized","reason":"missing-token"}`) — permukaan legacy tetap mati (K-7).
- Unit systemd gateway tetap hardening penuh (user non-root, LoadCredential, ProtectSystem=strict); file env 0640 root:speedtest-hybrid.
- Jalur A tidak tersentuh: PID speedtestserver 283954, legacy 283944, nperf 292073, capture 281912 tidak berubah sejak baseline sesi 3; gate A2 identik baseline (26/31; 4/19 default; 9/19 varian 8080 — semua kegagalan pra-ada T-9 nPerf port 80, bukan regresi).

## 9. Reproduksi

```bash
# prasyarat: pip install speedtest-cli; akses VPS 45.126.249.250:8790
# /etc/hosts (atau unshare bind-mount):
#   45.126.249.250 speedtest-mock.lumajangnetworks.my.id speedtest.lumajangnetworks.my.id
#   45.126.249.250 speedtest.somedigit.net <8 domain list lain>
#   127.0.0.1 results.speedtest.net

# T2 — stock, download via edge:
speedtest-cli --json --mini https://speedtest.lumajangnetworks.my.id:8790

# T3 — hybrid penuh via mock domain:
HYBRID_GATEWAY_BASE=https://speedtest.lumajangnetworks.my.id:8790 \
HYBRID_WORKER_BASE=https://speedtest-hybrid-worker.lumajangnetworks.workers.dev \
python3 hybrid/probe-client/speedtest-cli-hybrid.py --json \
  --mini https://speedtest-mock.lumajangnetworks.my.id:8790

# T4 — hybrid penuh, diarahkan ke domain list operator:
HYBRID_GATEWAY_BASE=… HYBRID_WORKER_BASE=… \
HYBRID_FRONT_BASE=https://speedtest-mock.lumajangnetworks.my.id:8790 \
HYBRID_SERVER_LIST_FILE=hybrid/probe-client/server-list-surabaya.json \
python3 hybrid/probe-client/speedtest-cli-hybrid.py --json --server 74964

# T1 — CLI resmi (Jalur A), hasil tidak dipublikasikan:
speedtest --server-id=74964 --accept-license --accept-gdpr -f json
```

Evidence lengkap: `hybrid/lab/evidence/e-k-speedtest-front/` (JSON per uji, snapshots.jsonl, dns-proof.txt, journal gateway, tabel konsol).
