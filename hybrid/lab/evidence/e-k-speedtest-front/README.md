# E-K — Real speedtest-cli vs speedtest front (sesi 3, 24 November 2026)

Client eksternal: sandbox Alibaba HK (egress 47.57.242.119 / 45.126.249.249 via NAT jaringan VPS).
Laporan lengkap + interpretasi: `docs/SPEEDTEST_FRONT_TEST_REPORT_2026-11-24.md`.

| File | Isi |
|---|---|
| `t1-official-cli-74964.json` | CLI resmi Ookla 1.2.0.84, `--server-id 74964` (somedigit) via /etc/hosts → VPS Jalur A |
| `t1b-official-cli-66281.json` | CLI resmi, `--server-id 66281` (tuxsnet) → VPS Jalur A |
| `t2-stock-mini-prodhost.json` | speedtest-cli 2.1.3 stock `--mini https://speedtest.lumajangnetworks.my.id:8790` (download edge, upload VPS drain) |
| `t3-hybrid-mini-mockdomain.json` | wrapper hybrid `--mini https://speedtest-mock.lumajangnetworks.my.id:8790` (download+upload edge) |
| `t4-hybrid-server-74964.json` | wrapper hybrid `--server 74964` + domain list operator (download+upload edge) |
| `snapshots.jsonl` | snapshot counter eth0 VPS + gateway/front + worker /__meta per jendela uji |
| `attribution.txt` | tabel delta atribusi byte per jendela |
| `dns-proof.txt` | bukti resolusi DNS di namespace uji (domain list + mock domain → 45.126.249.250) |
| `gateway-journal.txt` | journal speedtest-hybrid-gateway (event front_*, session_minted, result_accepted) |
| `t*.stderr` | keluaran error/traceback tiap uji |

Token/secret tidak tersimpan di evidence ini (diverifikasi dengan pemindaian).
