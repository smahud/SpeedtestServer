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

## Status akhir

(diperbarui di akhir sesi — lihat bagian bawah dokumen ini setelah Fase 8)
