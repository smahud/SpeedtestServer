# HYBRID_STATUS — Gap analysis dan status kriteria (Fase 2)

**Tanggal:** 24 November 2026 (dibuat 02:0x–02:2x WIB oleh agent sesi UAEG)
**Basis:** `master@aac909a` (VPS `/opt/SpeedtestServer-src`, working tree bersih, ff dari `836f7de`).
**Referensi:** `docs/MASTER_PROMPT_SPEEDTEST_HYBRID_v2.md` (§4 kriteria, §5 fase), `docs/SPEEDTEST_HYBRID_CLOUDFLARE_FREE.md` v2 (§3.3 G-1..G-12, §7 gate).

Dokumen ini memuat: (1) temuan awal Fase 0–1, (2) gap analysis per celah G-1..G-12, (3) status per kriteria A1–C2. Diperbarui di akhir sesi (lihat bagian "Status akhir").

## 1. Temuan awal (Fase 0–1, sebelum perubahan apa pun)

| # | Temuan | Bukti | Dampak |
|---|---|---|---|
| T-1 | VPS repo `/opt/SpeedtestServer-src` = git checkout bersih di `836f7de`, 3 commit di belakang `origin/master` (upload operator: spec v2 + master prompt v2 + DEPLOY.md). Tidak ada stash, tidak ada divergensi. Fast-forward ke `aac909a` dilakukan sesuai §6.2. | `git status`, `git log`, `git rev-list --left-right --count` | Tidak ada |
| T-2 | Build `master@aac909a` (temp `/root/speedtest-hybrid-work/build-aac909a`) menghasilkan `dist` **identik** (96 file, sha256 sama) dengan runtime `/opt/speedtestserver/dist`. | `diff dist-sha256.txt` = kosong | Runtime == master; aman sebagai basis |
| T-3 | Layanan: `speedtestserver` PID 283954, `speedtestserver-legacy` PID 283944, `nperf-server` PID 278476 (**NRestarts=1, sudah terjadi sebelum sesi ini**), `ookla-capture` PID 281912. Semua active/running. | `systemctl show` baseline `baseline-20261123-190316` | Baseline PID untuk gate A1 |
| T-4 | Sertifikat wildcard `*.lumajangnetworks.my.id`: issuer **Let's Encrypt CN=YE1**, kedaluwarsa **8 Januari 2027** (path: `/var/lib/speedtestserver/certs/{fullchain,privkey}.pem`, custom pair, bukan ACME repo). | `openssl x509` baseline | Gateway bisa pakai cert ini (baca-saja) |
| T-5 | Firewall: nftables policy **accept**; hanya SYN rate-limit (nPerf) + redirect 443→8443 (nPerf) + masquerade ZeroTier. Tidak ada yang memblokir port gateway baru. | `nft list ruleset` baseline | Port gateway baru tidak butuh perubahan firewall |
| T-6 | **Proses lab sisa sesi agent sebelumnya masih hidup** di bawah cgroup `uaeg.service`: `/root/lab-ookla/OoklaServer --ward` (TCP+UDP **8090**, publik), `node dist/bin/legacy-http.js` (**8099**, publik, cwd `/root/lab-ookla`), `php -S 127.0.0.1:18099` (loopback). Tidak terdokumentasi sebagai layanan permanen; port 8090 menghalangi penggunaan lab default gateway. | `ps`, `ss -ltnup`, `/proc/*/cgroup` | Port 8090/8099/18099 tidak dipakai gateway produksi; proses tidak disentuh tanpa persetujuan operator |
| T-7 | Baseline gate A2: `check-http-compatibility.py` **31/31 PASS**; `host-tester-check.py` (chatgpt) default `--legacy-port 80` **19/19 PASS**; varian `--legacy-port 8080` (run pertama kali) **9/19** — 10 check gambar gagal **hanya** pada validasi magic-byte JPEG body (`ff d8`) karena daemon TS menyajikan byte pool ASCII, bukan JPEG sungguhan. Ukuran, status 200, dan Content-Type semuanya benar. **Host tester resmi hanya melakukan HEAD pada `random*.jpg`** (capture §2.1 spesifikasi), sehingga magic byte tidak pernah diamati oleh tester resmi. Ini deviasi clone-vs-resmi, bukan kegagalan Jalur A. | Run 23 Nov 19:08–19:09 UTC dari sandbox eksternal; `curl` + `od` banding port 80 vs 8080 | Temuan awal (bukan regresi). Tidak memicu perubahan Jalur A (§3.4) |
| T-8 | **CLI resmi Ookla 1.2.0.84: 9/9 server ID Surabaya menyelesaikan sesi penuh ke VPS** lewat redirect hosts (namespace + bind-mount `/etc/hosts`, karena binary statis musl; `results.speedtest.net` di-blackhole → `persisted:false` semua). Server ID: 74964, 61853, 48532, 55749, 62314, 66281, 65429, 68214, 73025. (72945/BLiP dilewati — host tidak diketahui.) Contoh: 74964 → ping 62 ms, DL ~491 Mbps, UL ~141 Mbps, loss 0. Variasi loss UDP antar-run: 0–10,7% (amatan jaringan, bukan kegagalan server). | Output JSON CLI + `evidence.jsonl` VPS (sesi NetGauge dari 45.126.249.249, byte upload cocok) | Bukti kuat Jalur A melayani client resmi tanpa modifikasi |

## 2. Gap analysis per celah (§3.3 spesifikasi v2)

| ID | Celah | Status awal | Perubahan minimum | Pelaksana |
|---|---|---|---|---|
| G-1 | Token diikat ke IP socket (`ip-mismatch` di proxy/dual-stack) | Belum ditutup | Mint default `ip='*'` + TTL 5 menit (`HYBRID_TOKEN_TTL_MS=300000`); opsi bind IP tetap didukung verifier | Agent |
| G-2 | Gateway bind 127.0.0.1 HTTP saja, tanpa unit systemd | Belum ditutup | Env bind-host + opsi TLS (path cert/key); unit `speedtest-hybrid-gateway.service` + env file 0600 | Agent |
| G-3 | Discovery mengiklankan fallback STS `/ws` | Belum ditutup | Hapus dari discovery (opt-in via env) | Agent |
| G-4 | Batas default ~2 GiB; `__up`/`upload.php` tanpa cek dini | Belum ditutup | `MAX_DOWNLOAD_BYTES`/`MAX_UPLOAD_BYTES` di `[vars]` (awal 16–25 MiB, final dari pengukuran); cek `Content-Length` dini + hentikan hitungan setelah cap | Agent |
| G-5 | Download/WS tanpa backpressure | Belum ditutup | Stream `pull()` + `FixedLengthStream`; akhiri saat client membatalkan; catat disconnect upload | Agent |
| G-6 | Pool 2 MiB via loop JS ~2 juta iterasi | Belum ditutup | Pool murah CPU (crypto.getRandomValues besar + map per 64 KiB chunk atau pattern berulang), ukur cold start | Agent |
| G-7 | Permukaan legacy Worker terbuka tanpa token | Belum ditutup | Flag `LEGACY_HTTP_ENABLED`, default kode `false` | Agent |
| G-8 | Bearer tidak diterima; token di query bocor ke log | Belum ditutup | Terima `Authorization: Bearer`; query hanya untuk WS | Agent |
| G-9 | Hasil tidak dideduplikasi per `guid` | Belum ditutup | Dedup per guid dengan respons sama | Agent |
| G-10 | Tes/lab hardcode nilai lab (secret, IP, path wrangler, port 8080, direktori evidence) | Belum ditutup | Parameterkan via env/argumen; `npx wrangler` default | Agent |
| G-11 | Probe client hanya WS; byte VPS dari estimasi | Belum ditutup | Mode HTTP `__down`/`__up`; simpan receipt Worker; bandingkan counter interface VPS | Agent |
| G-12 | `wrangler.toml` tanpa `workers_dev`/`preview_urls`; `@cloudflare/workers-types` tidak di devDeps | Belum ditutup | Set flag + devDependency | Agent |

## 3. Status per kriteria (§4 master prompt)

| # | Kriteria | Status awal | Target |
|---|---|---|---|
| A1 | Layanan existing tetap aktif | VERIFIED-AUTO (baseline T-3) | Tetap VERIFIED-AUTO setelah tiap deploy |
| A2 | Gate 31/31 + 19/19 dua varian | 31/31 + 19/19 default PASS; varian 8080 9/19 (temuan T-7, deviasi magic-byte JPEG) | Minimal tidak lebih buruk dari baseline |
| A3 | Host tester resmi lulus semua check | NOT TESTED (operator; CAPTCHA tidak boleh diotomasi) | VERIFIED-OPERATOR oleh operator |
| B1 | Worker deploy ke Workers Free | BLOCKED (menunggu Phase 3–4; credential tersedia dari operator) | DEPLOYED |
| B2 | Pengukuran CPU/invocation edge nyata | BLOCKED ( belum ada worker di edge) | VERIFIED-AUTO + evidence `e-j-real-edge/` |
| B3 | Gateway systemd + TLS + perbaikan binding IP | BLOCKED (G-1, G-2) | DEPLOYED |
| B4 | Sesi E2E eksternal + atribusi byte | BLOCKED (menunggu B1+B3) | VERIFIED-AUTO |
| B5 | Uji negatif token di edge; legacy tertutup | BLOCKED (menunggu B1) | VERIFIED-AUTO |
| C1 | Dokumentasi lengkap | IMPLEMENTED parsial (spec v2 ada; runbook belum) | IMPLEMENTED |
| C2 | Commit lokal VPS tanpa push | BELUM (working tree bersih) | IMPLEMENTED |

## 4. Rencana eksekusi (urutan)

1. Fase 3: hardening G-1..G-12 di `hybrid/` + tes lokal (port non-produksi) + template unit/env.
2. Fase 4: deploy Worker uji → ukur CPU/invocation → tetapkan `MAX_*` → deploy Worker produksi + uji token.
3. Fase 5: gateway systemd di port bebas (kandidat: 8790/18090 — di luar daftar terlarang §3.3 dan di luar 8090/8099/18099 yang terpakai; konfirmasi `ss` saat deploy) dengan TLS wildcard baca-saja.
4. Fase 6: probe E2E eksternal + atribusi byte (counter interface + gateway + receipt).
5. Fase 7: menunggu operator host tester (A3 NOT TESTED sampai itu).
6. Fase 8: runbook + errata + laporan akhir.

## Status akhir (24 November 2026, akhir sesi agent UAEG)

| # | Kriteria | Status | Bukti |
|---|---|---|---|
| A1 | Layanan existing tetap aktif | **VERIFIED-AUTO** | PID tidak berubah sepanjang sesi: speedtestserver 283954, legacy 283944, nperf 278476 (NRestarts=1 pra-sesi), capture 281912. Listener baru hanya 8790 (gateway). |
| A2 | Gate 31/31 + 19/19 dua varian | **VERIFIED-AUTO** | 31/31 dan 19/19 (default) lulus sebelum dan sesudah semua deploy. Varian `--legacy-port 8080` = 9/19: deviasi magic-byte JPEG (T-7), sama dengan baseline, tidak memburuk. |
| A3 | Host tester resmi lulus semua check | **NOT TESTED** | Operator belum menjalankan ulang setelah deploy early answer. CAPTCHA tidak boleh diotomasi. Pengganti terdekat: CLI resmi 9/9 server ID (T-8). |
| B1 | Worker di-deploy ke Workers Free | **BLOCKED (credential Cloudflare)** | Global API Key yang diberikan ditolak Cloudflare (9103, semua varian email; format cfk_ 52 char valid). Token certbot di VPS scope-nya hanya Zone-DNS (tidak bisa Workers). Kode+konfigurasi+runbook siap deploy. |
| B2 | Pengukuran CPU/invocation edge nyata | **BLOCKED (credential Cloudflare)** | Menunggu B1. |
| B3 | Gateway systemd + TLS + binding IP | **DEPLOYED** | `speedtest-hybrid-gateway.service` aktif (user non-root, LoadCredential TLS wildcard, port 8790); token `ip='*'` TTL 5 menit; dedup guid; discovery tanpa fallback STS. Verifikasi eksternal TLS ketat lulus. |
| B4 | Sesi E2E eksternal + atribusi byte | **VERIFIED-AUTO (evidence interim)** | Payload 117.440.512 B client↔edge; delta interface VPS 67.971 B; gateway app bytes 4.298 B ≈ client vpsBytes 4.199 B; offload ≈1:28.000; receipts cocok; replay idempoten. Edge = workerd lokal (stand-in) — edge nyata menunggu B1. Evidence: `hybrid/lab/evidence/e-i-production-gateway/`. |
| B5 | Uji negatif token di edge; legacy tertutup | **BLOCKED (edge nyata)** — lokal **VERIFIED-AUTO** | Token battery 11/11 + hardening 16/16 (caps 400/413, legacy 404, Bearer) lulus di workerd lokal DAN di VPS (total 82/82). Uji edge nyata menunggu B1. |
| C1 | Dokumentasi lengkap | **IMPLEMENTED** | Spec v2 + HYBRID_STATUS + HYBRID_DEPLOYMENT_RUNBOOK + HOST_TESTER_RUNBOOK + errata bertanggal (README/W-9/E-G/HANDOFF). |
| C2 | Commit lokal VPS tanpa push | **IMPLEMENTED** | 16 commit lokal (`5841b1a`..`011c495`), working tree bersih, tidak ada push.

Pekerjaan lanjutan (butuh operator): (1) credential Cloudflare valid — token terbatas template "Edit Cloudflare Workers" + Zone:Read + DNS:Read, atau Global API Key yang benar; (2) deploy Worker uji → ukur CPU → Worker produksi (langkah di HYBRID_DEPLOYMENT_RUNBOOK §4); (3) isi `HYBRID_WORKER_BASE` + restart gateway; (4) ulangi E2E ke edge nyata; (5) jalankan host tester resmi (A3).

## Status akhir sesi 2 (24 November 2026, sesi credential Cloudflare - edge nyata)

Sesi ini menyelesaikan sisa B1/B2/B4/B5 dengan API token Workers dari operator. Basis: 17 commit lokal sesi 1 (origin/master = aac909a, tanpa divergensi).

| # | Kriteria | Status | Bukti |
|---|---|---|---|
| A1 | Layanan existing tetap aktif | VERIFIED-AUTO | PID keempat unit tidak berubah sepanjang sesi 1 dan 2: speedtestserver 283954, legacy 283944, nperf 292073, capture 281912. Satu-satunya restart adalah unit Jalur B (speedtest-hybrid-gateway) saat pengisian HYBRID_WORKER_BASE. |
| A2 | Gate 31/31 + 19/19 dua varian | VERIFIED-AUTO (dengan temuan T-9) | 26/31 dan 4/19 (default) / 9/19 (8080) - identik sebelum & sesudah seluruh kerja sesi ini. 5 kegagalan port 80 + 15 kegagalan clone default SEMUANYA karena redirect nPerf port 80 (T-9, sisi operator; spec 7.1b). Port 8080 (jalur tester resmi): 26/26 lulus. |
| A3 | Host tester resmi | NOT TESTED | Operator belum menjalankan ulang. Sebelum run resmi tidak ada prasyarat dari Jalur B; tester resmi hanya memakai 8080 sehingga tidak terdampak T-9. |
| B1 | Worker deploy Workers Free | **DEPLOYED** | speedtest-hybrid-worker.lumajangnetworks.workers.dev versi 28e2f5cc (legacy OFF, cap 25 MiB, secret terpasang). Worker uji c564820b untuk conformance 55/55 lalu DIHAPUS. Subdomain workers.dev lumajangnetworks terdaftar via API. |
| B2 | Pengukuran CPU edge nyata | **VERIFIED-AUTO** | e-j-real-edge: 14 titik uji, semua success tanpa exceededCpu/1102. Keputusan: transport utama WS NetGauge; MAX_* tetap 25 MiB. Batas Free diverifikasi 24 Nov 2026. |
| B3 | Gateway systemd + TLS | DEPLOYED (sesi 1) | Tidak berubah; HYBRID_WORKER_BASE kini menunjuk Worker produksi (speedtest-hybrid-worker.lumajangnetworks.workers.dev). |
| B4 | E2E eksternal + atribusi byte | **VERIFIED-AUTO (edge nyata)** | Payload 117.440.512 B client<->edge; kontrol VPS 4.296 B; gateway app 4.404 B; delta interface (batas atas) 183.393 B; offload ~1:27.337; receipts cocok; replay dedup OK (guid 0b3dd684). |
| B5 | Uji negatif token di edge | **VERIFIED-AUTO** | token-tests 11/11 + free-hardening 17/17 di edge produksi (termasuk body nyata MAX+1 -> 413). Temuan platform-hold dienkode ke battery. |
| C1 | Dokumentasi | IMPLEMENTED | Spec 7.1b + 0.1/K-6 diperbarui; runbook 4 diisi kondisi terdeploy; HOST_TESTER_RUNBOOK riwayat + T-9; e-j-real-edge README. |
| C2 | Commit lokal tanpa push | IMPLEMENTED | Commit topik sesi ini ditambahkan (lihat git log); tidak ada push. |

Temuan baru sesi 2:
- T-9 (nPerf port 80 redirect) - lihat spec 7.1b. Keputusan di tangan operator; agent tidak boleh menyentuh (invarian).
- Platform-hold: edge Cloudflare menahan respons Worker sampai body request selesai; "413 early" atas lying-CL tidak teramati klien. Perlindungan via real-body 413 + cancel-at-cap terbukti. G-4b (request.body.cancel()) dipertahankan.
- Egress VPS ke Cloudflare: 45.126.249.131 (dipakai sebagai TOKEN_TEST_IP).

Sisa pekerjaan untuk operator:
1. A3: jalankan host tester resmi (speedtest.net/host-tester) untuk speedtest.lumajangnetworks.my.id:8080; kirim hasil + jam mulai ke agent untuk analisis capture (Fase 7).
2. Putuskan T-9: pertahankan redirect nPerf port 80 (nPerf mengambil port 80) atau kembalikan (legacy speedtest port 80 pulih). Bukan wewenang agent.
3. Push ke GitHub bila ingin menerbitkan commit lokal (dilakukan operator/agent lain, sesuai workflow git master prompt).


---

## Status akhir sesi 3 (24 November 2026, sesi speedtest front — real speedtest-cli)

Target operator sesi 3: "real speedtest dengan speedtest-cli resmi sebagai tester; payload besar upload/download dilayani Cloudflare Worker; kebutuhan ringan (seleksi server, ping, dll) dilayani VPS; IP VPS muncul saat seleksi/ping, Worker melayani saat payload besar lewat." Basis: 20 commit lokal sesi 1+2 (origin/master = aac909a, tanpa divergensi).

Pekerjaan sesi 3 (semua Jalur B; Jalur A tidak disentuh):

1. `hybrid/gateway/src/front.mjs` (BARU) — permukaan HTTP legacy speedtest di gateway: `latency.txt` langsung (plane ping VPS), `random*.jpg` → 302 → `__down` Worker dengan token HMAC (offload download; urllib stock mengikuti 302 GET), `upload.php` POST → drain penuh + `size=N` (klien stock), GET `upload.php` → `size=0` (probe mini). Rate limit mint per IP (90/menit, terverifikasi burst: 90×302 + 30×429), cap 25 MiB per redirect, event journal `front_*` tanpa token.
2. `hybrid/gateway/src/gateway.mjs` — integrasi front (env `HYBRID_FRONT_ENABLED`, `HYBRID_FRONT_RATE_LIMIT_MPM`, `HYBRID_FRONT_MAX_DOWN_BYTES`), routing front sebelum buffering body, counter front di `/api/health`.
3. `hybrid/probe-client/speedtest-cli-hybrid.py` (BARU) — speedtest-cli stock (engine pengukuran 100% tidak diubah) + 2 hook transport: URL server → front VPS; POST upload → `__up` Worker (Bearer). Mode `HYBRID_SERVER_LIST_FILE` mengganti daftar geo-lokal dengan domain list operator.
4. `hybrid/probe-client/server-list-surabaya.json` (BARU) — 9 entri domain list Surabaya operator (72945 BLiP tanpa host tidak diikutkan).

| # | Kriteria | Status | Bukti |
|---|---|---|---|
| A1 | Layanan existing tetap aktif | VERIFIED-AUTO | PID keempat unit tidak berubah sepanjang sesi 3 (283954/283944/292073/281912). Gateway di-restart dua kali untuk deploy front (unit Jalur B, diizinkan). |
| A2 | Gate 31/31 + 19/19 dua varian | VERIFIED-AUTO (identik baseline) | 26/31 dan 4/19 (default) / 9/19 (8080) — persis baseline sesi 2; semua kegagalan = T-9 nPerf port 80 (pra-ada). |
| A3 | Host tester resmi | NOT TESTED | Tidak ada run operator selama sesi 3. |
| B1–B3 | Worker / gateway | DEPLOYED (sesi 2, tidak berubah) | Worker `speedtest-hybrid-worker.lumajangnetworks.workers.dev` versi 28e2f5cc; gateway + front :8790 TLS. |
| B4 | E2E eksternal + atribusi byte | **VERIFIED-AUTO (speedtest-cli nyata)** | T3/T4: 539,2 MB payload di edge (387,7 down + 151,5 up), delta eth0 VPS ±0,5 MB, front keluar 30–146 B; hasil masuk `results.jsonl` (guid 19b4a965). Laporan lengkap: `docs/SPEEDTEST_FRONT_TEST_REPORT_2026-11-24.md`. |
| B5 | Uji negatif token + rate limit | VERIFIED-AUTO | `__down`/`__up` tanpa token → 401 di edge (tetap); burst 120 → 90×302 + 30×429. |
| C1 | Dokumentasi | IMPLEMENTED | Laporan uji baru + runbook front + errata spec §0.1/§7.1c + contoh env diperbarui. |
| C2 | Commit lokal tanpa push | IMPLEMENTED | Commit topik sesi 3 (lihat git log); tidak ada push. |

Temuan baru sesi 3: T-10 (early-answer memutus kirim upload di RTT nyata → drain penuh), T-11 (random4000x4000 31,6 MB melebihi cap 25 MiB edge → front memangkas `bytes`), T-12 (daftar server Python speedtest-cli kini geo-lokal → `--server` ID Surabaya perlu injeksi `HYBRID_SERVER_LIST_FILE`). Batasan terdokumentasi: upload klien stock urllib tidak bisa dialihkan via redirect (body dikirim ke hop pertama sebelum respons dibaca); mock domain publik menunggu credential `Zone › DNS › Edit` (API token aktif tapi tanpa izin DNS; Global Key ditolak Cloudflare).

Sisa pekerjaan operator: (1) A3 host tester resmi; (2) keputusan T-9 (nPerf port 80); (3) record DNS `A speedtest-mock.lumajangnetworks.my.id → 45.126.249.250` (DNS-only) bila mock domain ingin aktif di DNS publik; (4) push ke GitHub bila ingin menerbitkan (agent tidak push sesuai §6.6).

---

## Status akhir sesi 4 (24 November 2026, push + verifikasi pasca-push)

Operator memerintahkan **push** (pengecualian eksplisit §6.6 master prompt). Yang dilakukan:

1. Scan rahasia atas diff `origin/master..HEAD` sebelum push: 6.107 baris tambahan, 0 hit (pola token UAEG/PAT/CF/HMAC/private-key/password); tanpa file `.env`, `node_modules`, `.wrangler`, `dist`, pcap baru; blob >2 MB hanya milik origin lama.
2. Divergensi kecil direkonsiliasi tanpa force/rebase/reset: `git fetch` (operator menambah commit `4045b9b` — upload tarball `speedtest-cli_official/` via web UI), `git merge origin/master` → `f8b7c57` (bersih, tanpa konflik), lalu `git push origin master` fast-forward `4045b9b..f8b7c57` (PAT via `GIT_ASKPASS`, file kredensial 0600 dihapus setelahnya).
3. Verifikasi independen dari klon segar: origin/master = `f8b7c57`, 7 dokumen `docs/` terpublikasi (termasuk laporan sesi 3).
4. **Verifikasi E2E pasca-push** dari client eksternal (evidence `hybrid/lab/evidence/e-l-post-push-verification/`):
   - T2 stock: dl 544,8 Mbps edge / ul 132,4 Mbps drain VPS / ping 129,6 ms VPS.
   - T3 hybrid mock domain: dl 452,2 Mbps + ul 778,6 Mbps keduanya EDGE; ping 124,5 ms VPS; guid 18a34eef.
   - T4 hybrid domain list `--server 74964`: dl 573,0 Mbps + ul 757,5 Mbps EDGE; server tampil `somedigit.net [74964] Surabaya`; ping 129,4 ms VPS; guid 36fb7bf2.
   - Atribusi byte: eth0 tx VPS hanya 14,7 MB untuk 1,55 GB download client (download tidak transit VPS); `uploadsDrained` hanya bertambah dari 2 run stock; offload hybrid konservatif ~1:617.000; `rateLimited` delta 0; hasil masuk `results.jsonl` (counter results 1→3).
   - Keamanan tetap: `__up`/`__down` tanpa token → 401 di edge.
5. Layanan produksi tidak tersentuh: keempat unit Jalur A tetap PID 283954/283944/292073/281912, NRestarts 0; baseline read-only disimpan di `/root/speedtest-hybrid-work/baseline-20261124T042512Z/`.

Catatan: evidence sesi 3 berisi IP egress sandbox client (47.57.x.x, 21.0.9.23 internal) yang sengaja didokumentasikan di README-nya; evidence sesi 4 menyanitasi kolom `client.ip` (47.57.x.x / 8.212.x.x). Temuan lingkungan: baris hosts `127.0.0.1 results.speedtest.net` pada namespace uji tidak efektif di sandbox ini (resolv masih ke fastly) — tanpa dampak karena speedtest-cli sivel tanpa `--share` tidak mengirim hasil ke results.speedtest.net; hasil dikirim ke gateway (sesi tercatat di `results.jsonl`).

Sisa pekerjaan operator tetap: (1) A3 host tester resmi; (2) keputusan T-9 (redirect nPerf port 80); (3) record DNS `A speedtest-mock → 45.126.249.250` bila mock domain ingin aktif di DNS publik (butuh token `Zone › DNS › Edit`).

## Status akhir sesi 5 (24 November 2026, kampanye CLI resmi 9 server + quickstart README)

Operator memberi instruksi baru: uji **binary CLI resmi Ookla** (`speedtest-cli_official/`, 1.2.0.84) dengan mekanisme mock DNS 9 server id Surabaya → IP VPS, kumpulkan 4 titik data per server (server id / dihandle VPS / dihandle Worker / hasil akhir dibaca aplikasi), lalu commit+merge+push bila lolos. Yang dilakukan dan hasilnya:

1. **Kampanye 18 run (9 server × 2 mode), semua exit 0** (evidence `hybrid/lab/evidence/e-m-official-cli-campaign/`, laporan `docs/OFFICIAL_CLI_MOCK_CAMPAIGN_2026-11-24.md`):
   - **A (CLI resmi, native):** seluruh sesi NetGauge mentah TCP di daemon :8080 — ping 59,1–63,8 ms, dl 455,1–508,1 Mbps, ul 58,6–147,6 Mbps, transit `eth0` 670–1022 MB/run, 41–42 koneksi/run (journal conn_close).
   - **B (hybrid transport, server id sama):** dl 405,0–622,4 Mbps + ul 229,5–757,6 Mbps **EDGE**; `eth0` VPS 0,45–0,49 MB/run; wreq 91–364; receipt guid per run di `results.jsonl` (11 baris baru sesi ini).
2. **Bukti terisolasi (kunci):** run A 66281 dengan celah hening 05:46:57–05:47:21 UTC → **Worker menerima 0 permintaan** (CF GraphQL `workersInvocationsAdaptive` tanpa baris) sementara VPS membawa seluruh 736 MB sesi. Kesimpulan protokol: payload binary CLI resmi transit host:port entri server-list (NetGauge TCP mentah; tanpa WebSocket/redirect pada binary) — offload Worker tidak mungkin bagi binary resmi, dan itu **desain protokol, bukan kegagalan implementasi**. Kriteria literal operator ("Worker melayani payload saat CLI resmi berjalan") dilabeli **NOT achievable by protocol design** di laporan; yang terbukti: jalur native 9/9 VERIFIED-AUTO + offload hybrid 9/9 pada server id yang sama VERIFIED-AUTO.
3. **Temuan Free-tier:** 4 invokasi `exceededResources` (CPU) saat dua run B back-to-back — pengukuran tidak terpengaruh (exit 0). Kuota sesi ~2.000 invokasi (jauh di bawah 20.000).
4. **README quickstart baru** ("Hybrid mode quickstart — run with or without the Cloudflare Worker"): tabel dua mode operasi (native tanpa Worker / hybrid dengan Worker), ringkas instalasi, **panduan langkah demi langkah membuat Worker di Cloudflare** (wrangler + jalur dashboard alternatif), cara menjalankan speedtest per jenis klien, diagram arsitektur — memenuhi permintaan operator "bisa berjalan dengan atau tanpa cloudflare worker".
5. Layanan tidak tersentuh: PID kelima unit tetap (speedtestserver 283954, legacy 283944, nperf 292073, capture 281912, gateway 302847); Worker `speedtest-hybrid-worker` tidak diubah (02:08Z); `results.speedtest.net` diblokir di namespace uji (invariant §3.8) — CLI resmi exit 0 tanpa result URL.
6. **Commit + push** dilaksanakan atas perintah eksplisit operator di sesi ini (commit: kampanye+evidence, README quickstart, status ini). Kredensial (PAT/token CF/UAEG) tidak pernah masuk repo; file env 0600 di sandbox dihapus di akhir sesi.

Sisa pekerjaan operator tidak berubah: (1) A3 host tester resmi; (2) keputusan T-9; (3) record DNS `A speedtest-mock` bila mock domain ingin aktif publik.
