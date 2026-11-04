# MEASUREMENT_PHASE_MATRIX — matriks fase ↔ koneksi ↔ protokol ↔ backend

> Eksperimen D master prompt. Disintesis dari `evidence/c1-all-b/analysis.json`,
> `evidence/f0-all-a/analysis.json`, dan evidence repo (gate-cli2). Semua baris
> adalah hasil observasi CLI resmi 1.2.0.84.

## 1. Matriks fase

| Fase pengukuran | Koneksi (per run tipikal) | Perintah protokol | Transport | Umur | Yang menentukan hasil di output CLI | Dapat dialihkan per-fase? |
|---|---|---|---|---|---|---|
| **Server selection (probe latency)** | 10 probe + 1 pemenang (+11 zero-byte) | ENC hello → (ERROR →) `HI`[` <UUID>`] → `GETIP` → `PING ×3/×5` | TCP | ~60 ms total | server.id/host/name di JSON (dari entri config, bukan dari protokol); ping.latency dihitung dari PING probe pemenang | ✅ ya (terbukti F2a) |
| **Latency / jitter (tak berbeban)** | probe pemenang (koneksi 22) | `PING ×5` | TCP | 2 ms | `ping.latency`, `ping.jitter`, low/high | ✅ (mengikuti probe pemenang) |
| **Loaded latency (download)** | monitor ping 1 koneksi | `PING` berulang | TCP | 12–15 s | (internal; memengaruhi stableStop) | ✅ |
| **Download** | 4 worker | `DOWNLOAD 32000000` ×~190 | TCP | ~12,3 s | `download.bandwidth/.bytes` | ✅ |
| **Loaded latency (upload)** | monitor ping 1 koneksi | `PING` berulang | TCP | ~9,5 s | (internal) | ✅ |
| **Upload (kontrol)** | 1 koneksi | `CAPABILITIES` → `UPLOAD_STATS 15000 16 0` (→ ERROR, ditoleransi) | TCP | ~9,5 s | (tidak langsung) | ✅ |
| **Upload (data)** | 4 worker | `UPLOAD 32000000 15000 16` + payload | TCP | ~9,5 s | `upload.bandwidth/.bytes` | ✅ |
| **Packet loss (akuntansi)** | 1 koneksi long-lived | `INITPLOSS` → `PLOSS` tiap 500 ms | **TCP** | 12,8 s | `packetLoss` (dihitung dari jawaban PLOSS) | ✅ tapi TERIKAT UDP (lihat §2) |
| **Packet loss (datagram)** | 3 endpoint UDP | `LOSS <t> <seq> <UUID> [<t>]`; balasan `RECV` | **UDP** | seluruh run | (RECV untuk loaded-latency; hitungan loss via PLOSS) | ✅ tapi HARUS backend yang sama dengan koneksi PLOSS |
| **Result submission** | 1 CONNECT (proxy) | HTTPS POST ke results.speedtest.net | HTTPS | — | `result.persisted`, `result.url` | n/a (diblokir lab — non-publishing) |

## 2. Keterikatan lintas-fase (temuan penting)

1. **PLOSS ↔ UDP harus satu backend** (verifikasi sintetis S2/S3 + kontrak
   protokol §3): backend yang menjawab `PLOSS` hanya menghitung datagram
   `LOSS` yang diterimanya sendiri. Bila dipisah: PLOSS menjawab `0 0 0`
   → CLI menghitung loss dari formula — hasil eksperimen F8 menentukan
   apa yang dilaporkan CLI (0%? 100%? gagal?).
2. **Enkripsi dipelajari dari probe seleksi** (F0 vs C1) — probe→A membuat
   seluruh run memakai sesi terenkripsi (jika backend pengukuran B tidak
   bisa terenkripsi, koneksi pengukuran harus fallback per koneksi).
3. **Tidak ada keterikatan download↔upload**: koneksi upload terpisah total
   dari download (worker baru, HI baru) → upload bisa dialihkan ke backend
   berbeda dari download tanpa state bersama (dibuktikan F2a/F4).
4. **Monitor ping per fase independen** → loaded-latency bisa berasal dari
   backend berbeda dengan beban (dibuktikan F2a: ping→B saat download→B,
   dengan seleksi→A).

## 3. Peta jawaban CLI per fase ↔ backend yang menjawab

| Field output CLI | Dijawab oleh | Konsekuensi diversion |
|---|---|---|
| `server.*` | entri CONFIG (bukan protokol) | identitas server tidak berubah oleh diversion (selalu tampil entri config yang di-rewrite) |
| `ping.latency/jitter` | backend yang melayani PING probe pemenang | latency bisa "dari" backend lain tanpa CLI menolak |
| `download.*` | backend worker DOWNLOAD (byte counter) | volume diverter ↔ CLI harus cocok (atribusi) |
| `upload.*` | backend worker UPLOAD | idem |
| `packetLoss` | backend koneksi PLOSS (formula dari hitungan UDP-nya) | **paling sensitif** — lihat §2.1 |
| `result.persisted` | layanan results (diblokir) | tidak terpengaruh diversion |

## 4. Bukti per baris

- `evidence/c1-all-b/analysis.json` → `.phaseAttribution` (fase→backend→byte)
- `evidence/f0-all-a/analysis.json` → idem ke daemon resmi
- `evidence/synth-validation/s2-diverter.jsonl` → keterikatan PLOSS↔UDP (sintetis)
- `../../evidence/gate-cli2-sts-evidence.jsonl` → struktur fase direct (repo)
