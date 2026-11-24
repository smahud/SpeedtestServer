# LAPORAN UJI — Kampanye CLI resmi Ookla 9 server Surabaya + hybrid transport (Sesi 5)

**Tanggal:** 24 November 2026 (05:30–06:00 UTC / 12:30–13:00 WIB)
**Pelaksana:** agent UAEG sesi 5
**Target operator (kutipan):** "mock IP dari dns target agar server id terpilih mengarah ke IP vps, lalu jalankan speedtest-cli official dari repo..." — kriteria sukses versi operator: Worker ikut melayani upload/download saat run `speedtest` resmi berjalan, sehingga bandwidth berat tidak lagi dilayani VPS.
**Binary resmi yang dipakai:** `speedtest-cli_official/ookla-speedtest-1.2.0-linux-x86_64.tgz` — Ookla speedtest CLI **1.2.0.84**.
**Client uji:** sandbox eksternal, egress NAT 45.126.249.249 (dua mode dijalankan dari client yang sama).

---

## 1. Ringkasan hasil

Sembilan server id Surabaya diuji dalam dua mode per server (18 run, semua exit code 0):

- **TEST-A "official CLI native"** — mock DNS seluruh 9 hostname Surabaya + `speedtest-mock.lumajangnetworks.my.id` ke 45.126.249.250, lalu `speedtest --server-id=<ID> --accept-license --accept-gdpr -f json`. Sesi NetGauge penuh mendarat di daemon `speedtestserver.service` port 8080 (Jalur A).
- **TEST-B "hybrid transport"** — namespace mock yang sama; klien repo `hybrid/probe-client/speedtest-cli-hybrid.py` (engine pengukuran 100% speedtest-cli sivel 2.1.3 stock, hanya hook transport), env `HYBRID_GATEWAY_BASE` / `HYBRID_WORKER_BASE` / `HYBRID_FRONT_BASE` / `HYBRID_SERVER_LIST_FILE`, dijalankan `--json --server <ID>`.

Tabel utama — 4 titik data per server sesuai permintaan operator (dl/ul dalam Mbps; byte = delta `eth0` VPS rx+tx selama jendela uji; wreq = permintaan Cloudflare Worker per jendela, CF GraphQL `workersInvocationsAdaptive`):

| Server id | Dihandle VPS — TEST-A (ping / dl / ul / byte) | Dihandle Worker — TEST-B (dl / ul / byte VPS / wreq) | Hasil akhir dibaca aplikasi |
|---|---|---|---|
| 74964 — somedigit.net | 59.1 ms / 508.1 / 125.0 / 1022.2 MB | 501.4 / 702.3 / 0.45 MB / 182 | A: JSON final, exit 0, `server.ip=45.126.249.250`; B: exit 0 |
| 61853 — PT XLSMART (XL) | 62.1 ms / 465.5 / 60.6 / 804.7 MB | 405.0 / 725.9 / 0.48 MB / 91 | A: JSON final, exit 0, `server.ip=45.126.249.250`; B: exit 0 |
| 62314 — PT. Pratama Hasta Utama | 60.7 ms / 475.9 / 147.6 / 890.5 MB | 566.6 / 229.5 / 0.47 MB / 193 | A: JSON final, exit 0, `server.ip=45.126.249.250`; B: exit 0 |
| 66281 — PT. Tuxsindo Cyber Networks | 63.7 ms / 496.1 / 116.7 / 798.0 MB | 443.7 / 707.2 / 0.48 MB / 364 | A: JSON final, exit 0, `server.ip=45.126.249.250`; B: exit 0 |
| 65429 — Atharva | 62.1 ms / 481.9 / 142.5 / 862.0 MB | 413.5 / 757.6 / 0.46 MB / 273 | A: JSON final, exit 0, `server.ip=45.126.249.250`; B: exit 0 |
| 68214 — PT. ERA NETWORK INDONESIA | 61.7 ms / 455.1 / 146.9 / 915.7 MB | 622.4 / 589.9 / 0.46 MB / 182 | A: JSON final, exit 0, `server.ip=45.126.249.250`; B: exit 0 |
| 73025 — LINTAS MEDIA SOLUSINDO | 63.8 ms / 473.7 / 70.2 / 670.5 MB | 414.8 / 715.7 / 0.49 MB / 182 | A: JSON final, exit 0, `server.ip=45.126.249.250`; B: exit 0 |
| 48532 — Faznet | 60.5 ms / 477.2 / 141.0 / 803.2 MB | 527.6 / 716.6 / 0.46 MB / 182 | A: JSON final, exit 0, `server.ip=45.126.249.250`; B: exit 0 |
| 55749 — RingNet | 62.5 ms / 464.5 / 58.6 / 701.5 MB | 526.3 / 487.3 / 0.48 MB / 104 | A: JSON final, exit 0, `server.ip=45.126.249.250`; B: exit 0 |

Pembacaan cepat:

- **A — jalur native CLI resmi, seluruh sesi di VPS:** dl 455.1–508.1 Mbps, ul 58.6–147.6 Mbps, byte `eth0` 670.5–1022.2 MB per run; ping 59.1–63.8 ms (raw TCP).
- **B — jalur hybrid pada server id yang sama, payload di edge Worker:** dl 405.0–622.4 Mbps, ul 229.5–757.6 Mbps; byte `eth0` VPS tetap 0.45–0.49 MB; wreq 91–364; ping 124.1–129.1 ms (HTTPS `latency.txt`).
- Semua 18 run exit code 0. Setiap JSON hasil run A melaporkan `server.ip=45.126.249.250` (mock DNS terverifikasi) dan journal daemon mencatat 41–42 koneksi yang membawa seluruh sesi (detail §3).

**Kesimpulan sesi:** jalur native CLI resmi (A) bekerja penuh pada 9 server id; jalur hybrid (B) mencapai offload penuh pada 9 server id yang sama. Kriteria literal operator ("Worker melayani upload/download saat CLI resmi berjalan") **tidak dapat dicapai karena desain protokol** — bukan karena kegagalan implementasi; pembatasan ini dijelaskan jujur di §4, bersama dengan apa yang justru terbukti.

## 2. Metodologi

### 2.1 Namespace mock DNS

Semua uji dijalankan dari sandbox eksternal dalam namespace terisolasi: `unshare --user --map-root-user --mount` + bind-mount `/etc/hosts` (transparan bagi semua klien, termasuk binary statis CLI resmi). Pemetaan (bukti: `dns-proof.txt`):

| Entri | Nilai tujuan |
|---|---|
| 9 hostname server Surabaya + `speedtest-mock.lumajangnetworks.my.id` | 45.126.249.250 |
| `results.speedtest.net` | 127.0.0.1 (diblokir) |

Hostnames 9 server (sesuai `hybrid/probe-client/server-list-surabaya.json`): `speedtest.somedigit.net`, `speedtest-sby.xl.co.id`, `speedtest.patas.id`, `speedtest.tuxsnet.id`, `ookla.sub.atharva.co.id`, `speedtest.era.net.id`, `speedtest2.lintasmediasolusindo.com`, `v137170.faznet.co.id`, `sby.speedtest.ring.net.id`. Server 72945 (BLiP) tidak memiliki host yang resolve dan dikecualikan dari kampanye.

### 2.2 Dua mode uji

- **A:** `speedtest --server-id=<ID> --accept-license --accept-gdpr -f json` — CLI resmi memilih server dari daftar resmi Ookla ber-ID, seluruh sesi NetGauge TCP mendarat di host:port entri → `45.126.249.250:8080` (daemon Jalur A).
- **B:** env `HYBRID_GATEWAY_BASE=https://speedtest.lumajangnetworks.my.id:8790`, `HYBRID_WORKER_BASE=https://speedtest-hybrid-worker.lumajangnetworks.workers.dev`, `HYBRID_FRONT_BASE=https://speedtest-mock.lumajangnetworks.my.id:8790`, `HYBRID_SERVER_LIST_FILE=hybrid/probe-client/server-list-surabaya.json`; `python3 hybrid/probe-client/speedtest-cli-hybrid.py --json --server <ID>` — seleksi+ping ke front VPS, transfer di edge Worker.

### 2.3 Jendela pengukuran (tiga sisi)

1. **VPS:** delta `eth0` dari `/sys/class/net/eth0/statistics/{rx,tx}_bytes` sebelum/sesudah tiap run + journal `journalctl -u speedtestserver` (statistik `conn_close` per koneksi).
2. **Cloudflare Worker:** query GraphQL `workersInvocationsAdaptive` per jendela uji.
3. **Client:** JSON hasil CLI resmi / hybrid (byte terukur, ping, server yang dipilih).

Untuk bukti definitif sisi Worker, satu run A dijalankan **terisolasi** (celah hening sebelum/sesudah, tanpa trafik tetangga) — lihat §3.2.

## 3. Bukti atribusi byte

### 3.1 TEST-A — seluruh sesi NetGauge transit VPS (angka per server)

| Server id | `eth0` VPS rx / tx / total (MB) | Client A: dl / ul (MB) | Daemon conn_close: bytesDown / bytesUp (MB) |
|---|---|---|---|
| 74964 | 257.9 / 764.3 / 1022.2 | 722.3 / 221.7 | 799.6 / 223.5 |
| 61853 | 121.1 / 683.6 / 804.7 | 633.8 / 93.1 | 709.4 / 95.1 |
| 62314 | 226.7 / 663.8 / 890.5 | 617.0 / 195.0 | 680.0 / 196.7 |
| 66281 | 199.3 / 598.7 / 798.0 | 562.6 / 170.7 | 636.5 / 172.5 |
| 65429 | 243.9 / 618.0 / 862.0 | 575.5 / 212.9 | 652.7 / 214.6 |
| 68214 | 260.4 / 655.3 / 915.7 | 615.6 / 226.5 | 686.8 / 229.0 |
| 73025 | 147.9 / 522.5 / 670.5 | 489.3 / 123.9 | 567.3 / 125.6 |
| 48532 | 231.8 / 571.5 / 803.2 | 529.2 / 203.0 | 606.1 / 204.4 |
| 55749 | 144.6 / 557.0 / 701.5 | 513.3 / 118.4 | 583.5 / 121.6 |

Journal daemon menunjukkan **41–42 koneksi per run** yang membawa seluruh sesi; statistik `conn_close` per run: **bytesDown 567–800 MB, bytesUp 95–229 MB** — konsisten dengan delta `eth0` dan byte yang dilaporkan client (selisih kecil = framing/overhead TCP/TLS).

### 3.2 Bukti terisolasi: Worker menerima 0 permintaan saat CLI resmi berjalan

Run A server **66281** di jendela **05:46:57–05:47:21 UTC**, dengan celah hening sebelum/sesudah dan tanpa trafik tetangga:

- Cloudflare Worker requests dalam jendela = **0** (CF GraphQL `workersInvocationsAdaptive` tidak mengembalikan baris apa pun).
- VPS membawa sesi penuh: dl **482.1 Mbps / 512 MB**, ul **148.2 Mbps / 224 MB**, exit 0.

Ini bukti definitif sisi Worker bahwa binary CLI resmi **tidak pernah mengirim payload ke Worker**. Catatan metodik: run A dan B per server dieksekusi back-to-back sehingga bucket per-menit mentah Worker bisa tumpang-tindih dengan run B yang mengikuti; run terisolasi di atas bebas dari efek itu dan menjadi acuan otoritatif.

### 3.3 TEST-B — offload penuh ke Worker (angka per server)

- Byte `eth0` VPS per run tetap **0.45–0.49 MB** (lihat tabel §1) sementara client mengukur **387.7 MB download + 151.5 MB upload** yang dilayani Worker → rasio offload **≈ 1 : 1200 per test**.
- Permintaan Worker per run: **91–364** (wreq, tabel §1) — variasi mengikuti jumlah chunk download/upload engine stock.
- Gateway `/var/lib/speedtest-hybrid/results.jsonl` menerima **satu receipt (guid) per run**, mis. guid `3379b32d-…`, `847eb6ec-…` — alur sesi hybrid (seleksi+ping VPS → transfer edge → receipt) utuh untuk 9 server id.

## 4. Batasan protokol CLI resmi (pernyataan jujur)

CLI resmi Ookla 1.2.0.84 berbicara **protokol biner NetGauge TCP mentah**, bukan HTTP:

- rangkaian perintah sesi: `HI`/`HELLO`, `GETIP`, `PING`, `DOWNLOAD`, `UPLOAD`, `INITPLOSS`/`PLOSS`, `UPLOAD_STATS`;
- koneksi pengukuran berakhir pada **host:port dari entri server-list Ookla** — setiap byte pengukuran transit endpoint tersebut.

Tiga baris bukti:

1. **Analisis string binary 1.2.0.84** (`ookla-speedtest-1.2.0-linux-x86_64.tgz`): tidak ditemukan dukungan WebSocket maupun redirect HTTP untuk jalur pengukuran.
2. **Bukti E-D/E-E (sesi sebelumnya):** saat NetGauge diarahkan ke Cloudflare, CF menjawab **HTTP 400** dan CLI gagal dengan `Protocol error: Did not receive HELLO` — CF tidak bisa berbicara NetGauge TCP mentah.
3. **Run terisolasi §3.2:** Worker = 0 permintaan sementara VPS membawa seluruh 736 MB sesi — binary resmi tidak pernah menyentuh Worker.

**Kesimpulan:** untuk klien binary resmi, payload berat **secara fisik tidak dapat melewati VPS**; offload hybrid hanya berlaku bagi klien transport-HTTP (keluarga speedtest-cli sivel + klien custom). Dengan demikian kriteria literal operator — "worker serves upload/download during the official speedtest-cli run" — berlabel **NOT achievable by protocol design** (bukan NOT TESTED; bukti §3.2 justru membuktikan kebalikannya secara definitif).

Yang **terbukti** pada kampanye ini:

- **jalur native CLI resmi (A) bekerja penuh** — 9 server id, 9 run exit 0, sesi NetGauge lengkap di `speedtestserver.service` dengan mock DNS terverifikasi;
- **offload penuh jalur hybrid (B) pada server id yang sama** — payload 539 MB per run di edge Worker, VPS hanya kontrol (< 0.5 MB).

## 5. Temuan tambahan

1. **Worker Free — `exceededResources`:** 4 invokasi berstatus `exceededResources` (CPU limit) pukul 05:50 UTC saat dua uji B berjalan back-to-back; pengukuran tidak terpengaruh (exit 0, hasil lengkap). Didokumentasikan sebagai catatan konkurensi tier Worker Free, bukan insiden.
2. **Outlier ping run B:** dua run B awal menunjukkan ping 586 ms / 316 ms (cold-start TLS); re-run memberikan 129.1 / 128.1 ms — angka di tabel §1 adalah hasil re-run.
3. **Perbedaan ping A vs B (diharapkan):** A ~59–64 ms (raw TCP ke daemon :8080) vs B ~124–129 ms (HTTPS `latency.txt` ke front :8790) — perbedaan protokol, bukan anomali.

## 6. Keamanan dan invariant yang dijaga

- **Layanan VPS tidak tersentuh** — PID tidak berubah sepanjang kampanye: `speedtestserver` (283954), `speedtestserver-legacy` (283944), `nperf-server` (292073), `ookla-capture` (281912), `speedtest-hybrid-gateway` (302847).
- **Worker tidak diubah:** `speedtest-hybrid-worker` tetap versi sesi sebelumnya (last modified 2026-11-24T02:08Z).
- **`results.speedtest.net` diblokir** (127.0.0.1) di namespace uji sesuai invariant §3.8 `MASTER_PROMPT_SPEEDTEST_HYBRID_v2.md` (tes paksa/forced-endpoint tidak boleh mengirim hasil ke layanan Ookla); CLI tetap exit 0 tanpa URL hasil (`persisted=false`).
- **Token tidak dicatat:** Bearer token hybrid hanya transit lewat TLS, tidak muncul di log/journal/evidence; IP client disamarkan (masked) pada semua file evidence.
- **Kuota Worker:** total invokasi sepanjang sesi ~2.000 (9 run B final tercatat 1.753 wreq + 2 run awal outlier yang di-re-run, lihat §5) — jauh di bawah 20.000.

## 7. Reproduksi

```bash
# prasyarat: repo SpeedtestServer di sandbox eksternal (egress NAT 45.126.249.249);
# akses ke VPS 45.126.249.250 (daemon :8080, gateway :8790) dan Worker.
tar xzf speedtest-cli_official/ookla-speedtest-1.2.0-linux-x86_64.tgz  # binary speedtest 1.2.0.84

# file hosts mock (mock-hosts):
#   45.126.249.250 speedtest.somedigit.net speedtest-sby.xl.co.id speedtest.patas.id
#   45.126.249.250 speedtest.tuxsnet.id ookla.sub.atharva.co.id speedtest.era.net.id
#   45.126.249.250 speedtest2.lintasmediasolusindo.com v137170.faznet.co.id sby.speedtest.ring.net.id
#   45.126.249.250 speedtest-mock.lumajangnetworks.my.id
#   127.0.0.1 results.speedtest.net

# TEST-A — official CLI native (ganti <ID>, salah satu dari 9 server id):
unshare --user --map-root-user --mount sh -c \
  'mount --bind mock-hosts /etc/hosts && \
   speedtest --server-id=<ID> --accept-license --accept-gdpr -f json'

# TEST-B — hybrid transport (server id yang sama):
unshare --user --map-root-user --mount sh -c \
  'mount --bind mock-hosts /etc/hosts && \
   HYBRID_GATEWAY_BASE=https://speedtest.lumajangnetworks.my.id:8790 \
   HYBRID_WORKER_BASE=https://speedtest-hybrid-worker.lumajangnetworks.workers.dev \
   HYBRID_FRONT_BASE=https://speedtest-mock.lumajangnetworks.my.id:8790 \
   HYBRID_SERVER_LIST_FILE=hybrid/probe-client/server-list-surabaya.json \
   python3 hybrid/probe-client/speedtest-cli-hybrid.py --json --server <ID>'

# atribusi byte per jendela (di VPS / dashboard CF):
#   /sys/class/net/eth0/statistics/{rx,tx}_bytes  (sebelum/sesudah run)
#   journalctl -u speedtestserver                 (conn_close per koneksi)
#   CF GraphQL workersInvocationsAdaptive         (permintaan Worker per jendela)
```

## 8. Status per kriteria

| Item | Status |
|---|---|
| Jalur native CLI resmi (A) — 9 server id, sesi NetGauge penuh di VPS, exit 0, mock DNS terverifikasi | **VERIFIED-AUTO** |
| Atribusi byte kelas B4 mode B — 9 server id, VPS < 0.5 MB vs 539 MB di edge, receipt guid per run | **VERIFIED-AUTO** |
| Bukti terisolasi "CLI resmi tidak mengirim payload ke Worker" (66281, Worker = 0) | **VERIFIED-AUTO** |
| Infrastruktur (daemon, gateway, Worker) — tidak diubah sepanjang sesi | **DEPLOYED** (tetap) |
| A3 — host tester Ookla (`speedtest.net/host-tester`) | **NOT TESTED** (operator) |
| Kriteria literal operator "Worker melayani payload saat CLI resmi berjalan" | **NOT achievable by protocol design** — lihat §4 |

Evidence lengkap: `hybrid/lab/evidence/e-m-official-cli-campaign/` — `a-*.cli.json`, `b-*.cli.json`, `attribution.txt`, `dns-proof.txt`, `summary.json`, `journal-map-smoke-74964.txt`, `iso-a-66281.*`. IP client disamarkan.
