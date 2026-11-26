# API speedtest.net — endpoint server-list (verifikasi 2026-11-26)

## 1. `GET /api/js/config-sdk` (web client modern, engine js)

Query params (camelCase di client, dikirim snake_case setelah remap):

| Param | Nilai teramati | Kapan dikirim |
|---|---|---|
| `engine` | `js` | selalu |
| `limit` | `10` (default `settings().latency.maxServers`), `100` saat search popup | auto-discovery & popup |
| `https_functional` | `true` | halaman https (nilai `isSecure()` di client) |
| `server_ids` | daftar id dipisah `%2C` (,) | pemilihan server eksplisit (URL `/server/<id>` atau settings) |
| `search` | string bebas (mis. `Surabaya`) | popup "Change Server" & route `/server/<nama>` |
| `isVpn` | `true` | jika VPN terdeteksi |

Response (snippet, `GET ?engine=js&https_functional=true&server_ids=74964,...&limit=10`):

```json
{
  "ipAddress": "8.212.10.159",
  "ispName": "Alibaba",
  "ispId": 111899,
  "location": {"latitude": 22.2842, "longitude": 114.1759, "cityName": "Hong Kong", "countryCode": "HK", "countryName": "Hong Kong"},
  "servers": [
    {
      "url": "http://speedtest-sby.xl.co.id:8080/speedtest/upload.php",
      "lat": "-7.2575", "lon": "112.7521", "distance": 2046,
      "name": "Surabaya", "country": "Indonesia", "cc": "ID",
      "sponsor": "PT XLSMART Telecom Sejahtera",
      "id": "61853", "preferred": 0, "isp_id": "53991",
      "https_functional": 1,
      "host": "speedtest-sby.xl.co.id:8080"
    }
  ]
}
```

Pemetaan di client (`remapServerObject`): `id` → int, `https_functional` → `httpsFunctional`,
`host` "host:port" dipecah jadi `hostname` + `port` (default port 8080).
Header response: `access-control-allow-origin` dicerminkan dari Origin.
Header `x-cors-token` muncul pada response di beberapa deployment (SDK membacanya sebagai
`corsToken` dan menyisipkannya sebagai query param `ct=` pada koneksi ke server) — pada run
anonim teramati TIDAK muncul (log capture: URL `/ws` tanpa `ct`).

## 2. `GET /api/js/servers` (legacy — masih aktif, dipakai klien non-web)

`?engine=js&limit=N[&server_ids=...][&search=...]` → array server dengan bentuk yang sama
(tanpa wrapper `ipAddress/location`). Inilah yang dipakai CLI/klien lama (bukti lama repo:
`speedtest-cli_analysis/evidence/01_servers_list.json`).

## 3. `GET /api/js/config-sdk?search=Surabaya&limit=100` (popup "Change Server")

Teramati di capture Playwright: klik "Change Server" → isi "Surabaya" →
`GET /api/js/config-sdk?engine=js&search=Surabaya&https_functional=true&limit=100`.
Urutan hasil: server terdekat dulu (jarak dari geoIP klien). 25 server Surabaya+sekitarnya
dikembalikan (tercatat di capture_manualui.jsonl).

## 4. Route manual: `/server/:name`

`path:"server/:name"` di router React. `fetchServerFromURL(name, type)`:
- numerik → `getServers(serverIds)` (harus tepat 1 hasil)
- teks → `searchServers(name, 100)` lalu cocokkan `sponsor` persis (lowercase) → `name` mengandung → hasil pertama
- halaman https MENOLAK server dengan `httpsFunctional !== 1` (error `server_from_url_not_found`)
- subdomain host `*.speedtest.net` juga dipakai (`fetchServerFromURL(ke, "dns")`)

## 5. Endpoint pendukung lain (teramati di bundle/capture)

- `GET /api/js/validate-api-key` — validasi API key (instalasi custom)
- `POST /api/results.php` — simpan hasil (payload 25–26 KB, `content-type: application/json;charset=UTF-8`; response `resultid`/`hash_key_id`)
- `GET /api/js/result/<id>` — ambil hasil (404 tanpa session teramati untuk run web)
- `GET /api/downdetector-outages?countryCode=HK` — widget samping, bukan engine
- `https://ipv6-api.speedtest.net/getip` — deteksi IPv6 (tidak terpanggil pada run teramati)
