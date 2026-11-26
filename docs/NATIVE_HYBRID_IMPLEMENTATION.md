# NATIVE HYBRID IMPLEMENTATION — Keputusan Desain, Opsi yang Ditolak, dan Jalan ke Depan

**Tanggal:** 26 November 2026 · **Basis keputusan:** `docs/NATIVE_HYBRID_AUDIT.md` (Gate F: TIDAK TERPENUHI)
**Perubahan source code dalam PR ini: TIDAK ADA** — changeset hanya dokumentasi verdict + evidence (sesuai master prompt §12: "dokumentasi dan verdict tetap wajib meski tidak ada implementasi feasible").

---

## 1. Keputusan utama

> **Tidak dilakukan implementasi hybrid native** (tidak ada PoC, tidak ada perubahan pada daemon/gateway/worker untuk target native), karena **semua kandidat transport gugur pada feasibility gate** dengan dua akar independen (BLOCKED_BY_PROTOCOL + BLOCKED_BY_FREE_PLAN). Membuat arsitektur palsu untuk "mengatasi" keterbatasan ini dilarang secara eksplisit (§6) dan tidak jujur.

Arsitektur yang dipertahankan **apa adanya** (as-is) adalah hasil yang benar untuk constraint ini — dua jalur yang sudah teruji:

```
JALUR A — client resmi (native)          JALUR B — client HTTP/custom
  NetGauge raw TCP :8080 + UDP loss         HTTPS :8790 (front) + 302 → Worker pool
  seluruh sesi di VPS                      (payload edge, token HMAC)
  = NATIVE_VPS_ONLY                        = CUSTOM_CLIENT_ONLY
```

Kedua jalur di atas TIDAK diubah oleh audit ini; keduanya terverifikasi live 26 Nov 2026 (daemon PID 4412; gateway PID 4465; pool 100 worker ter-deploy & konvergen).

## 2. Opsi yang dievaluasi dan ditolak (dengan alasan)

| # | Opsi | Alasan penolakan |
|---|---|---|
| 1 | **Spectrum TCP → Worker (beta 19 Nov 2026)** untuk menerima raw TCP CLI | (a) **Free zone tidak didukung** ("Free zones are not supported" — spectrum how-to, diakses 26 Nov 2026) → melanggar constraint §1 ("Semua kemampuan Cloudflare yang digunakan tersedia pada paket Free"); (b) Pro/Business hanya 1 app/zona/port tanpa terminasi TLS; (c) **UDP loss tetap tidak terlayani** (UDP = Enterprise) → sesi CLI native rusak atau packetLoss tidak valid; (d) seluruh koneksi klien menuju SATU endpoint — tidak menghasilkan kontribusi paralel VPS+edge, melainkan mengganti endpoint ke edge (atau Worker me-relay ke VPS = byte tetap transit VPS) |
| 2 | **DNS proxied / Workers Route / Custom Domain pada hostname VPS** | Melanggar constraint §2 ("DNS hostname VPS utama tetap DNS-only"); Workers Routes memerlukan hostname proxied; juga akan memutus jalur raw TCP :8080 (proxy CF hanya melayani HTTP/WS pada port tertentu). Verifikasi live: record speedtest = DNS-only (proxied=false) — constraint sudah terpenuhi dan harus dipertahankan |
| 3 | **Round-robin DNS antara IP VPS dan IP edge** untuk memecah koneksi | Bukan mekanisme native yang sah (client melihat satu hostname → resolusi non-deterministik); merusak afinitas sesi/UDP loss (datagram loss terikat IP peer TCP yang sama); TLS identitas berbeda antar IP; tidak didokumentasikan client manapun sebagai opsi |
| 4 | **Relay/tunnel Worker→VPS (connect() outbound)** | Byte payload tetap transit interface VPS — melanggar target mutlak §1 ("payload edge tidak melewati interface jaringan VPS"); bukan offload |
| 5 | **Hosts override sebagai mekanisme produksi** | Hanya sah untuk lab pra-publikasi terisolasi (§5 master prompt); produksi memerlukan registrasi resmi + resolver normal |
| 6 | **Custom client / wrapper / wrapper transport** sebagai "bukti native" | Melanggar §1/§2 (client native asli tanpa modifikasi adalah syarat acceptance); bukti-bukti hybrid historis sudah dilabeli jujur CUSTOM_CLIENT_ONLY |
| 7 | **Upgrade plan berbayar / Spectrum Enterprise** | Di luar batasan project (Free only, no trial); dicatat hanya sebagai analisis di §3 |
| 8 | **Split backend dalam satu endpoint (diversion-lab)** untuk native | Terbukti 3/3 di lab untuk membelah beban antar **backend milik operator sendiri di belakang endpoint yang sama** (daemon resmi ↔ TS) — Cloudflare tetap tidak berperan (transport TCP/UDP tetap di endpoint operator). Tidak menyelesaikan misi edge; tidak diadopsi |

## 3. Analisis "apa yang berubah bila constraint dilepas" (bukan rekomendasi)

| Skenario | Efek | Catatan jujur |
|---|---|---|
| Zona naik Pro/Business + Spectrum app 1 port | Raw TCP :8080 bisa diteruskan ke Worker connect() handler | UDP loss tetap hilang (Enterprise only) → CLI native kehilangan packetLoss/loaded-latency yang valid; TLS tidak diterminasi; tetap NON-PARALEL (satu endpoint) → tetap bukan "VPS + edge paralel" |
| Spectrum Enterprise (TCP+UDP) | Secara teoretis endpoint tunggal terganti edge sepenuhnya; relay murni bila Worker connect() ke VPS | Semua byte tetap transit VPS bila relay; identitas/latensi berubah; biaya tinggi; **tetap bukan arsitektur paralel dua-lane yang diminta** |
| Client dimodifikasi (wrapper hybrid) | Offload nyata terbukti (E-M B, 5,6× upload) | Sudah ada sebagai Jalur B — label CUSTOM_CLIENT_ONLY, bukan acceptance native |

Kesimpulan §3: bahkan di luar constraint, **tidak ada konfigurasi Cloudflare yang menghasilkan "VPS + edge berkontribusi paralel dalam SATU sesi native"** — keterbatasan pertama adalah protokol client (satu endpoint per sesi), bukan hanya plan.

## 4. Batas Free yang mengikat lane hybrid (existing — dipertahankan)

- 100.000 request/hari **per akun** (pool mendistribusikan, tidak mengalikan) — quota guard live terverifikasi (0,1% terpakai).
- 100 script/akun — pool saat ini tepat 100 (tidak ada headroom script).
- CPU 10 ms/invokasi (soft), memori 128 MB, body 100 MB, 6 koneksi simultan per invokasi — mitigasi existing: pacing frame 64 KiB, deflection antar worker (302/503 hop=1), autoscaler canary, cap 25 MiB per request (`wrangler.toml` MAX_*).
- Workers.dev = satu-satunya permukaan edge (tanpa route zona — konsisten constraint DNS-only; terverifikasi routes: kosong).

## 5. Perbaikan reliability native yang independen (diizinkan, TIDAK dieksekusi hari ini)

Sesuai §6 master prompt ("perbaikan reliability native yang independen boleh diteruskan bila... tidak berisiko terhadap produksi"), yang tercatat sebagai kandidat lanjutan (tanpa perubahan hari ini, semua butuh otorisasi deploy terpisah):
1. Probe berkala seluruh anggota pool (`HYBRID_WORKER_PROBE_INTERVAL_MS`) untuk status healthy per-worker (bukan hanya worker-1).
2. Observability: export counter atribusi front (dlLocal vs redirect) ke jurnal periodik.
3. Uji N4/N8 formal (worker unavailable; IPv6) — tercatat di matrix VALIDATION.

## 6. Checklist jalan ke publik (untuk operator — urutan)

1. **Keputusan hosting resmi**: mendaftar ke Speedtest Server Network™ (Ookla) — program menyediakan daemon resmi; kecocokan arsitektur dua-lane dengan ketentuan hosting **wajuh dikonfirmasi ke Ookla** sebelum klaim publik (G10).
2. Setelah persetujuan: validasi pasca-registrasi tanpa hosts override (N10/G11) — CLI resmi memilih server dari direktori resmi.
3. Host Tester ulang pasca-registrasi (R2) — kompatibilitas server (terpisah dari klaim offload).
4. Bila di masa depan constraint plan dibuka oleh operator (keluar scope project ini): baca §3 di atas dulu — keterbatasan pertama tetap protokol client.

## 7. Konfigurasi & rollback

- Perubahan PR ini: **hanya file dokumentasi + evidence** (`docs/NATIVE_HYBRID_{AUDIT,IMPLEMENTATION,VALIDATION}.md`, `hybrid/lab/evidence/native-hybrid/audit-2026-11-26/`). Tidak ada perubahan `.env.example`, unit, source, atau Worker.
- Rollback: merge PR dapat dibatalkan tanpa efek runtime apa pun (docs-only); tidak ada prosedur rollback produksi yang diperlukan.
- Branch kerja: `audit/native-hybrid-2026-11-26` (dari master `0ac51ac`) — PR draft, **tidak merge tanpa review operator**.
