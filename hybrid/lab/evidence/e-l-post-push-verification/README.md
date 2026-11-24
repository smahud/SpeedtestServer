# E-L — Verifikasi pasca-push (sesi 4, 24 November 2026)

Verifikasi ulang end-to-end SETELAH commit sesi 1–3 dipush ke GitHub (operator memerintahkan "push").
Tujuan: membuktikan sistem hybrid + native VPS tetap berfungsi utuh pada kondisi terpublikasi,
dari client eksternal (sandbox, bukan VPS).

## Isi jendela uji (urutan kronologis)

| Run | Perintah | Hasil |
|---|---|---|
| T2 | `speedtest-cli --json --mini https://speedtest.lumajangnetworks.my.id:8790` (stock 2.1.3) | dl 544,8 Mbps (387,7 MB) — EDGE; ul 132,4 Mbps (151,5 MB) — drain VPS; ping 129,6 ms — VPS |
| T3 | `speedtest-cli-hybrid.py --json --mini https://speedtest-mock...:8790` + env HYBRID_* + /etc/hosts ns | dl 452,2 Mbps — EDGE; ul 778,6 Mbps — EDGE (`__up` Bearer); ping 124,5 ms — VPS; guid 18a34eef |
| T4 | `speedtest-cli-hybrid.py --json --server 74964` + HYBRID_SERVER_LIST_FILE (domain list operator) | dl 573,0 Mbps — EDGE; ul 757,5 Mbps — EDGE; ping 129,4 ms — VPS; server tampil: somedigit.net [74964] Surabaya; guid 36fb7bf2 |

(Ada satu run awal T3 tanpa env HYBRID_* yang berperilaku stock — dipakai sebagai uji stock tambahan
dalam pembukuan atribusi; lihat attribution.txt baris "run0".)

## Bukti kunci

- `attribution.txt` — counter eth0 VPS + counter front gateway sebelum/sesudah:
  download 4×387,7 MB tidak transit VPS (eth0 tx hanya 14,7 MB untuk seluruh jendela);
  upload T3/T4 tidak menambah `uploadsDrained`; offload hybrid ~1:617.000 (konservatif).
- `dns-proof.txt` — resolusi domain dalam namespace uji: mock domain + 9 domain list → 45.126.249.250.
- `t*-*.json` — output JSON per run (client.ip disensor 47.57.x.x / 8.212.x.x).
- `t*.stderr` — bukti resolusi + balasan `hybrid-result` dari gateway (`{"ok":true,"guid":…}`).
- Hop redirect (live): `random1000x1000.jpg` → 302 `Location: …workers.dev/__down?bytes=1986284&token=…`
  → HTTP/2 200 `server: cloudflare` `cf-ray: …-HKG`.
- Keamanan tetap: `__up`/`__down` tanpa token → 401 di edge; rate limit 0 429 baru pada jendela ini.

## Kesimpulan

Status sesi 3 dipertahankan: seleksi server + ping mendarat di VPS 45.126.249.250 (front :8790),
payload besar upload/download dilayani Cloudflare Worker `speedtest-hybrid-worker.lumajangnetworks.workers.dev`.
Semua hasil run tercatat di `results.jsonl` gateway. A3 (host tester resmi) tetap menunggu operator.
