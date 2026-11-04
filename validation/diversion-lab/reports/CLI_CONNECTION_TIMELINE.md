# CLI_CONNECTION_TIMELINE — timeline peristiwa koneksi lengkap CLI resmi

> Eksperimen A master prompt. Sumber: `evidence/c1-all-b/diverter.jsonl`
> (semua peristiwa dengan timestamp relatif & absolut), `analysis.json`,
> `evidence/f0-all-a/` (pola identik ke daemon resmi). Tabel di bawah adalah
> rekonstruksi mekanis dari log — bukan rekaan.

## 1. Timeline gabungan (C1 — run lengkap exit 0, 34 koneksi TCP, 3 endpoint UDP)

Semua waktu relatif terhadap `meta.ts0` diverter (t=0 saat diverter start;
CLI mulai ~1,5 s kemudian). Jalur peristiwa:

```
t=0,00s  diverter listen TCP+UDP :9090 (policy all:B)
t≈1,4s   [proxy] CONNECT cli.speedtest.net:443 → MITM lab-CA → GET /api/cli/config?… → fetch live → rewrite 10 entri → 200
t≈1,7s   [proxy] CONNECT results.speedtest.net:443 → 403 DITOLAK (non-publishing)
t≈1,9s   [diverter] burst 22 koneksi (60 ms):
           11× zero-byte (buka-tutup, 0–4 ms)
           10× probe seleksi terenkripsi (ENC→ERROR→HI→GETIP→PING×3→close, 3–10 ms)
           1× probe pemenang (ENC 64B→ERROR→HI <UUID>→GETIP→PING×5→close, 2 ms)
t≈2,0s   [diverter] koneksi loss: HI <UUID> → INITPLOSS → (PLOSS tiap ~500 ms)
t≈2,0s   [diverter] monitor-ping download: HI <UUID> → PING berulang
t≈2,0s   [diverter] 4 worker download: HI <UUID> → DOWNLOAD 32000000 ×~190
t≈2,0s   [UDP] 3 endpoint klien mulai mengirim LOSS (244/245/188 datagram)
t≈14,3s  download selesai (12,12 GB be→cli; stableStop) — worker download close
t≈14,3s  monitor-ping upload + kontrol upload (CAPABILITIES, UPLOAD_STATS) open
t≈14,3s  4 worker upload: HI <UUID> → UPLOAD 32000000 15000 16 + payload ×~60
t≈23,8s  upload selesai (8,30 GB cli→be) — worker upload + kontrol + monitor close
t≈23,9s  koneksi loss: PLOSS terakhir → close (umur 12,8 s)
t≈24,1s  [proxy] percobaan kirim hasil (sudah diblokir di awal) → CLI: persisted:false
t≈24,2s  CLI exit 0
```

## 2. Tabel peristiwa terpilih (ekstrak mesin terbaca — field lengkap di diverter.jsonl)

| Sequence | Timestamp (UTC) | Relatif (ms) | Koneksi ID | Sumber → Tujuan | Transport | Peristiwa | Perintah | Bytes TX→RX | Fase | Confidence |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 18:56:55.0 | 0 | — | diverter start | — | listen | — | — | — | mesin |
| 2 | 18:56:56.9 | 1900 | — | CLI→proxy | HTTPS | CONNECT+config | GET /api/cli/config | ~1,4 KB | config | tinggi (log proxy) |
| 3 | 18:56:57.1 | 2100 | — | CLI→proxy | HTTPS | blocked | — | 0 | submit | tinggi |
| 4 | 18:56:57.3 | 2300 | 1–21 | CLI→9090 | TCP ×11 | open+close | — | 0/0 | zero-byte | tinggi |
| 5 | 18:56:57.3 | 2300 | 2–20 | CLI→9090→B | TCP ×10 | probe | ENC,HI,GETIP,PING×3 | ~90/124 | seleksi | tinggi |
| 6 | 18:56:57.4 | 2400 | 22 | CLI→9090→B | TCP | probe pemenang | ENC64,HI UUID,GETIP,PING×5 | 202/162 | seleksi | tinggi |
| 7 | 18:56:57.5 | 2500 | 23 | CLI→9090→B | TCP | loss open | HI UUID,INITPLOSS | 22/10 | loss | tinggi |
| 8 | 18:56:57.5 | 2500 | 24 | CLI→9090→B | TCP | pingmon open | HI UUID,PING… | — | latency(dn) | tinggi |
| 9 | 18:56:57.5 | 2500 | 25–28 | CLI→9090→B | TCP ×4 | download open | HI UUID,DOWNLOAD 32000000… | — | download | tinggi |
| 10 | 18:56:57.6+ | 2600+ | — | CLI→9090→B | UDP ×3 | LOSS stream mulai | LOSS t seq UUID [t] | 677 datagram | loss | tinggi |
| 11 | 18:57:09.8 | 14800 | 25–28 | →B | TCP | download close | — | 12,12 GB be→cli | download | tinggi (byte counter) |
| 12 | 18:57:09.8 | 14800 | 29–34 | →B | TCP ×6 | fase upload open | HI UUID, CAP/USTATS/UPLOAD | — | upload | tinggi |
| 13 | 18:57:19.3 | 24300 | 23,29–34 | →B | TCP | close semua | — | 8,30 GB cli→be | upload+loss | tinggi |
| 14 | 18:57:19.5 | 24500 | — | CLI | — | exit | — | — | akhir | tinggi (exit=0) |

*(Tabel penuh 34 baris koneksi + ratusan conn_cmd/udp_datagram tersimpan di
`evidence/c1-all-b/diverter.jsonl` — 100% mesin terbaca; angka di atas adalah
ringkasan representatifnya.)*

## 3. Keajekan lintas run

| Aspek | C1 (all→B) | F0 (all→A) | gate-cli2 repo (direct→B) |
|---|---|---|---|
| Jumlah koneksi | 34 | ~34 | 23 (+11 tanpa perintah) |
| Pola fase | identik | identik | identik |
| Probe terenkripsi dijawab | ERROR (fallback) | diterima | ERROR |
| Loss | 0 | 0 | 0 |
| Exit | 0 | 0 | 0 |

→ Struktur timeline deterministik; satu-satunya cabang perilaku adalah
enkripsi-diterima vs fallback (ditentukan oleh backend yang menjawab probe).

## 4. Zona kritis untuk diversion (dari timeline)

- **Jendela seleksi (t≈1,9–2,0 s)**: 22 koneksi dalam 60 ms — kebijakan
  firstN dan phase-aware harus memutuskan routing dalam jendela ini.
- **Koneksi loss panjang umur (12,8 s)**: membentang lintas fase — kandidat
  titik belah paling "mahal" bila dipindah backend di tengah (tidak diuji —
  diverter tidak memindahkan koneksi aktif; hanya antar-koneksi).
- **Tumpang tindih UDP**: datagram LOSS mengalir sejak awal download sampai
  akhir run — 3 endpoint paralel.
