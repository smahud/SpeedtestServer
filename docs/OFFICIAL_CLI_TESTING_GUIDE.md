# OFFICIAL CLI TESTING GUIDE — cara menguji CLI resmi Ookla terhadap VPS + Worker

> **Untuk agent berikutnya.** Dokumen ini adalah catatan teknis metode uji agar
> pengujian dengan aplikasi resmi Ookla (bukan klien custom) dapat direproduksi
> dengan aman. Semua metode di sini sudah dipakai dan tervalidasi 27 Nov 2026
> (evidence: `hybrid/lab/evidence/cli-bridge-2026-11-27/`).
> Bahasa: Indonesia; konvensi istilah teknis mengikuti repo.

## 0. Prinsip yang tidak boleh dilanggar

1. **Klien HARUS aplikasi resmi** — CLI resmi Ookla (tarball di repo), tanpa
   modifikasi/patch/wrapper. Jangan pernah mengganti dengan klien custom
   (probe, Sivel, clone, dsb.) untuk klaim "CLI resmi berhasil".
2. **Target uji = server ter-publish yang di-mock ke VPS** — lewat
   `/etc/hosts` di namespace lab, BUKAN mengubah DNS publik atau discovery
   resmi. Discovery (`cli.speedtest.net`, `www.speedtest.net`) dibiarkan asli.
3. **Non-publishing** — arahkan `results.speedtest.net` ke 127.0.0.1 di
   namespace lab; pastikan `persisted=false` / `result.url=null` di output.
   Jangan pernah mengirim hasil lab ke direktori publik Ookla.
4. **Produksi hanya disentuh pada window eksperimen** — alur aman:
   **push GitHub → VPS: `git pull` via UAEG → deploy → uji → restore →
   verifikasi**. Selalu ada backup + verifikasi restore (1 run CLI ke daemon
   yang dipulihkan).
5. **Atribusi 3 sisi wajib** untuk setiap klaim: (a) output CLI, (b) sisi VPS
   (counter bridge/journal/eth0), (c) sisi Worker (GraphQL + receipt). Klaim
   tanpa 3 sisi = bukan bukti.

## 1. Binary CLI resmi

- Sumber: repo `speedtest-cli_official/ookla-speedtest-1.2.0-linux-x86_64.tgz`
  (tersedia juga aarch64/armel/armhf/i386). Versi terverifikasi:
  **1.2.0.84 (ea6b6773cf)**.
- Ekstrak + verifikasi identitas:

```bash
mkdir -p ~/lab && cd ~/lab
tar xzf <repo>/speedtest-cli_official/ookla-speedtest-1.2.0-linux-x86_64.tgz
./speedtest --version      # harus: Speedtest by Ookla 1.2.0.84 (ea6b6773cf)…
sha256sum speedtest        # 31f1124c5ab8acdae6b9fe1741e704df420f9f2e7d429679fabe62075453c051 (x86_64)
```

- Perilaku kunci (sudah diverifikasi, lihat `validation/PROTOCOL_CONTRACT.md`):
  koneksi pengukuran CLI membuka **hello biner terenkripsi**; server menjawab
  `ERROR` → CLI **fallback ke protokol NetGauge plaintext** (HI/GETIP/PING →
  DOWNLOAD/UPLOAD) → itulah jalur yang dilayani daemon/bridge. CLI juga
  mengirim `UPLOAD 32000000 15000 16` dan `DOWNLOAD` multi-size (≈1–32 MB,
  adaptif), membuka 30–45 koneksi TCP :8080 + UDP :8080 (loss).

## 2. Lab sandbox: mockhosts + namespace terisolasi

File `mockhosts` (entri daftar server operator → IP VPS; results → loopback):

```
45.126.249.250 speedtest.somedigit.net
45.126.249.250 speedtest-sby.xl.co.id
45.126.249.250 speedtest.patas.id
45.126.249.250 speedtest.tuxsnet.id
45.126.249.250 ookla.sub.atharva.co.id
45.126.249.250 speedtest.era.net.id
45.126.249.250 speedtest2.lintasmediasolusindo.com
45.126.249.250 v137170.faznet.co.id
45.126.249.250 sby.speedtest.ring.net.id
127.0.0.1      results.speedtest.net
```

Satu run (satu siklus lengkap, non-publishing, discovery asli):

```bash
unshare --user --map-root-user --mount bash -c '
  mount --bind ~/lab/mockhosts /etc/hosts
  cd ~/lab
  ./speedtest --server-id=66281 --accept-license --accept-gdpr -f json \
    > run.json 2> run.stderr; echo "EXIT=$?" >> run.json'
```

- `--server-id` pilih dari daftar operator (default 66281 = Tuxsindo,
  Surabaya — kontinuitas dengan evidence H3 dan eksperimen 27 Nov).
- `persisted` harus `false` dan `result.url` `null` — kalau tidak, UJI
  DILARANG dianggap sah; hentikan dan periksa mockhosts.
- Beri **jeda ≥30 detik antar run** bila loss UDP diukur (loaded-loss run
  back-to-back bisa melonjak; catatan V-1 audit).

## 3. Mode produksi (tanpa bridge) — kontrol

Tanpa perubahan apa pun di VPS, run di §2 menguji **daemon produksi langsung**
(:8080) — ini kontrol `NATIVE_VPS_ONLY` (baseline audit H3: 4/4 exit 0,
Worker = 0 request). Gunakan selalu 1 run kontrol sebelum/sesudah eksperimen
bridge (b0/b4 pada evidence 27 Nov).

## 4. Mode cli-bridge (VPS + Worker) — window eksperimen

Bridge: `hybrid/lab/cli-bridge/cli-bridge.mjs` (dokumen: `README.md` di
direktori itu). Front = protokol native di VPS; payload = origin Worker.

**Window di VPS (via UAEG MCP, root):**

```bash
# 1. backup konfigurasi daemon + turunkan daemon dari :8080
cp /etc/speedtestserver/OoklaServer.properties \
   /etc/speedtestserver/OoklaServer.properties.exp-backup-$(date +%Y%m%d)
sed -i 's|^OoklaServer.tcpPorts = .*|OoklaServer.tcpPorts = 5060|; s|^OoklaServer.udpPorts = .*|OoklaServer.udpPorts = 5060|' \
   /etc/speedtestserver/OoklaServer.properties
systemctl restart speedtestserver
ss -tlnp | grep -E ':(5060|8080) '   # :5060 daemon ada, :8080 KOSONG

# 2. nyalakan bridge (transient unit; pilih backend)
mkdir -p /var/lib/cli-bridge
systemd-run --unit=speedtest-clibridge --collect \
  --setenv=BRIDGE_BACKEND=worker-http \
  --setenv=BRIDGE_GATEWAY_BASE=https://127.0.0.1:8790 \
  /usr/local/bin/node /opt/SpeedtestServer-src/hybrid/lab/cli-bridge/cli-bridge.mjs \
  --port 8080 --log /var/lib/cli-bridge/<label>.jsonl

# 3. (ganti backend: stop unit + systemd-run ulang dengan BRIDGE_BACKEND=worker-ws|local)
```

**Snapshot sebelum/sesudah** untuk atribusi eth0:

```bash
date -u +%Y-%m-%dT%H:%M:%SZ
cat /sys/class/net/eth0/statistics/{rx,tx}_bytes
```

**Uji**: jalankan §2 dari sandbox beberapa kali per backend (rekomendasi ≥2).
Lalu **restore + verifikasi**:

```bash
systemctl stop speedtest-clibridge
cp /etc/speedtestserver/OoklaServer.properties.exp-backup-<tgl> \
   /etc/speedtestserver/OoklaServer.properties
systemctl restart speedtestserver
ss -tlnp | grep 8080     # harus daemon lagi; verifikasi 1 run §2 (exit 0)
```

## 5. Atribusi 3 sisi — cara membaca

| Sisi | Sumber | Yang dicek |
|---|---|---|
| Client | `run.json` | exit, `download/upload.bytes+bandwidth`, `ping`, `result.persisted=false` |
| VPS | `<label>.jsonl` bridge (event `heartbeat` terakhir / `summary`) + delta eth0 | `bytesDownCli` ≈ DL client; `bytesFromWorkerDl` (byte origin edge, DL); `bytesToWorkerUl` (byte diteruskan, UL); `workerReceipts`; `worker_retry` |
| Worker | CF GraphQL `workersInvocationsAdaptive` (jalankan DI VPS dengan kredensial `.env` repo — token operator sering tanpa scope analytics) + receipt `{"bytes":N}` / OK-ack | jumlah invocation per menit pada window run; status `success`; 0 `exceededResources` |

Catatan penting:
- `bytesFromWorkerDl` bisa >100% dari byte client — itu overhead refetch
  chunk yang ter-reset tengah jalan (sudah normal, dicatat di JSONL sebagai
  `worker_retry`).
- `/__meta` worker itu **per-isolate** — tidak bisa dipakai untuk agregat;
  pakai GraphQL.
- Query GraphQL wajib `scriptName` + window ±1 menit; contoh skrip:
  `hybrid/lab/evidence/cli-bridge-2026-11-27/lab-meta/` (metadata `method`).

## 6. Jebakan yang SUDAH terjadi (jangan diulang)

1. **Mint token berbadai** — jangan mint token per koneksi/perintah; token
   satu proses di-cache (bug 27 Nov: 92 mint → gateway 429 rate-limit → CLI
   exit 2 "NoServers"). Bridge sekarang cache + backoff.
2. **Reset tengah-stream dari edge CF** (ECONNRESET) — normal pada volume
   besar; WAJIB retry refetch sisa chunk (bridge sudah otomatis; tanpa retry,
   koneksi CLI mati — CLI biasanya pulih dengan koneksi baru, tapi run jadi
   kotor).
3. **Upload WSS tanpa perintah UPLOAD mentah** → payload jadi frame sampah,
   worker balas ERROR per frame, tidak ada receipt. Bridge sekarang meneruskan
   baris perintah mentah lebih dulu.
4. **Ukuran perintah vs cap worker** — CLI mengirim `DOWNLOAD/UPLOAD 32000000`;
   cap worker sekarang 128 MiB (commit a9d4775). Jangan turunkan kembali ke
   25 MiB.
5. **Pola konkuren 32 koneksi × 32 MB via `/ws` TANPA chunking/pacing** →
   isolate dibunuh `exceededResources` (reproduksi 27 Nov: 10/32 sesi mati;
   lihat `hybrid/lab/cli-bridge/README.md`). Pakai lane chunk (bridge sudah)
   atau `?pace=`.
6. **Quota**: worker Free 100.000 req/hari; eksperimen full ≈ 200–900
   invocation/run. Cek `/api/pool` gateway (`quotaGuard.used`).

## 7. Verifikasi kesehatan stack sebelum uji

```bash
# di VPS
systemctl is-active speedtestserver speedtest-hybrid-gateway
ss -tlnp | grep -E ':(8080|5060|8790) '        # daemon + gateway
curl -sk https://127.0.0.1:8790/api/pool | head -c 300   # pool + quota
# worker live (dari mana pun, pakai token dari gateway):
TOKEN=$(curl -sk -X POST https://127.0.0.1:8790/api/sessions -H 'Content-Type: application/json' -d '{}' | grep -o '"token": "[^"]*"' | cut -d'"' -f4)
curl -s -H "Authorization: Bearer $TOKEN" \
  'https://speedtest-hybrid-worker.lumajangnetworks.workers.dev/__down?bytes=32000000' -o /dev/null -w '%{http_code} %{size_download}\n'
# harus: 200 32000000  (kalau 400 → cap worker sudah diturunkan lagi)
```

## 8. Ekspektasi hasil yang sehat (referensi 27 Nov 2026)

| Mode | DL / UL (Mbps) | Origin payload |
|---|---|---|
| daemon produksi (kontrol) | ~450–462 / ~160 | 100% VPS |
| bridge `local` | ~455 / ~159 | 100% VPS (paritas front ✓) |
| bridge `worker-http` | ~416–431 / ~118–133 | DL ≈100% edge; UL 96,8–97,8% edge |
| bridge `worker-ws` | ~437–449 / ~134–177 | DL ≈100% edge; UL ≈100% edge |

Jika angka jauh di bawah itu, cek `worker_retry`/`worker_err` di JSONL bridge
dan window GraphQL sebelum menyimpulkan.
