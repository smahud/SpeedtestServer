# web-client-analysis — Reverse engineering web client speedtest.net

Sesi 26 November 2026. Laporan utama:
[`docs/WEB_CLIENT_REVERSE_ENGINEERING_2026-11-26.md`](../WEB_CLIENT_REVERSE_ENGINEERING_2026-11-26.md)

Cakupan: alur "Finding optimal server", pemilihan server manual (popup UI +
route `/server/:name` + subdomain), pembukaan koneksi (WSS `/ws` + XHR `:8080`),
stage latency/download/upload, pengukuran upload remote (`UPLOAD_STATS`),
`POST /api/results.php` (payload penuh), dan probe protokol langsung ke 10
server target Surabaya milik operator.

Semua temuan diverifikasi tiga lapis: ekstraksi kode dari bundle resmi
(`r.cdnst.net/assets/index-CUbMX1WR.js`, SDK 3.1.3), capture run nyata
Playwright/Chromium, dan probe protokol mandiri.

## evidence/

| File | Isi |
|---|---|
| [01_sdk_default_settings.json](evidence/01_sdk_default_settings.json) | Settings default engine hasil de-minifikasi |
| [02_api_config-sdk.md](evidence/02_api_config-sdk.md) | Endpoint API server-list + parameter + response |
| [03_capture_auto_timeline.md](evidence/03_capture_auto_timeline.md) | Timeline run otomatis |
| [04_capture_manual_tuxsindo_timeline.md](evidence/04_capture_manual_tuxsindo_timeline.md) | Timeline run manual (Tuxsindo 66281) |
| [05_result_payload_tuxsindo.json](evidence/05_result_payload_tuxsindo.json) | Payload penuh results.php (25,9 KB) |
| [06_ws_protocol_transcripts.txt](evidence/06_ws_protocol_transcripts.txt) | Transkrip frame WS |
| [07_server_probes_surabaya.json](evidence/07_server_probes_surabaya.json) | Probe 10 server target |
| [08_server_quirks.md](evidence/08_server_quirks.md) | Quirk implementasi server |
| [09_api_config-sdk_server_ids_response.json](evidence/09_api_config-sdk_server_ids_response.json) | Response API server_ids |
| [10_capture_auto_full.jsonl](evidence/10_capture_auto_full.jsonl) | Log mentah run otomatis |
| [11_capture_manual_tuxsindo_full.jsonl](evidence/11_capture_manual_tuxsindo_full.jsonl) | Log mentah run manual |
| [12_capture_manualui_popup_search.jsonl](evidence/12_capture_manualui_popup_search.jsonl) | Log mentah popup search |

Tools: [`tools/web-client-probe/`](../../tools/web-client-probe/)
