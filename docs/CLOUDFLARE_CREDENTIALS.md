# CLOUDFLARE CREDENTIALS — panduan lengkap untuk deploy worker pool

**Dibuat:** 26 November 2026 (v1.4 — bersama `.env` + `install.sh` full-stack).
**Audiens:** operator yang mengisi `.env` sebelum menjalankan `install.sh`.
**Prinsip:** setiap variabel, setiap permission scope, dan setiap langkah
pembuatan kredensial dijelaskan sampai "klik apa, isi apa, hasilnya seperti apa".

---

## 1. Gambaran besar: dua cara autentikasi

| | API Token (DIANJURKAN) | Global API Key |
|---|---|---|
| Bentuk | `cfut_…` (atau 40 karakter acak) | 37 karakter hex (tampil sebagai "Global API Key" di profil) |
| Permission | HANYA scope yang Anda centang | **PENUH** — setara akses seluruh akun |
| Pasangan variabel di `.env` | `CLOUDFLARE_API_TOKEN` | `CLOUDFLARE_EMAIL` + `CLOUDFLARE_API_KEY` |
| Kapan dipakai | Default. Cukup untuk deploy pool worker. | Cadangan bila token scoped ditolak sistem (pernah terjadi sesi 9: token operator ditolak API, global key lolos) |
| Risiko bila bocor | Terbatas pada scope token | Sangat tinggi (semua zona, DNS, akun) |

Metode apa pun yang dipilih, `CLOUDFLARE_ACCOUNT_ID` tetap wajib diisi.

---

## 2. Membuat API Token (langkah demi langkah)

1. Login ke **https://dash.cloudflare.com** → klik ikon profil (kanan atas)
   → **My Profile**.
2. Menu kiri → **API Tokens** → tombol **Create Token**.
3. Cari template **"Edit Cloudflare Workers"** → **Use template**
   (template ini sudah berisi scope yang kita butuhkan — periksa tabel §3).
4. Nama token: bebas, mis. `speedtest-hybrid-deploy`.
5. **Permissions** — pastikan persis seperti ini:

   | # | Tipe | Scope | Permission | Mengapa dibutuhkan |
   |---|---|---|---|---|
   | 1 | Account | **Workers Scripts** | **Edit** | `wrangler deploy` (upload/update script 1..N worker), `wrangler secret bulk` (pasang `HYBRID_SHARED_SECRET` di tiap worker), delete script bila rollback |
   | 2 | Account | **Account Settings** | **Read** | Wrangler membaca metadata akun (resolusi account id / subdomain workers.dev saat men-deploy) |
   | 3 | User | **User Details** | **Read** | `wrangler whoami` + verifikasi token; sebagian versi wrangler memanggil endpoint user sebelum deploy |

6. **Account Resources** → Include → **akun yang dipakai**
   (akun inilah yang `CLOUDFLARE_ACCOUNT_ID`-nya Anda isi). Tidak perlu
   "All accounts" — cukup satu akun.
7. **Zone Resources** — biarkan default (All zones). Zone TIDAK dipakai
   untuk deployment workers.dev. Jika kelak Anda memindahkan worker ke
   custom domain (route zone), tambahkan:
   - Zone | **Workers Routes** | **Edit**
   - Zone | **Zone** | **Read**
   (Tidak dibutuhkan untuk mode `workers_dev = true` default repo ini.)
8. (Opsional) **Client IP Filtering** — bisa dibatasi ke IP VPS bila mau.
9. **Continue to summary** → **Create Token**.
10. Salin token yang tampil **SEKALI ini saja** (`cfut_…` atau 40 karakter).
    Cloudflare hanya menampilkan sekali; kalau hilang → rotate/buat baru.
11. Tempel ke `.env`:
    ```
    CLOUDFLARE_API_TOKEN=cfut_paste_di_sini
    ```

### Scope yang TIDAK dibutuhkan (jangan dicentang — prinsip least privilege)

| Scope | Kenapa tidak perlu |
|---|---|
| Workers KV Storage / R2 / D1 | Worker speedtest **stateless** — tanpa binding storage |
| Cloudflare Pages | Bukan deployment Pages |
| DNS / Zone Settings / Firewall | Worker memakai domain `*.workers.dev` internal Cloudflare, bukan record DNS Anda |
| Workers Tail | Hanya untuk `wrangler tail` (observability manual) — boleh ditambah belakangan bila mau |
| Billing / Members | Tidak ada hubungannya dengan deploy |

---

## 3. Global API Key (metode cadangan)

1. **My Profile** → **API Tokens** → gulir ke bawah ke bagian
   **Global API Key** → **View** → masukkan password → copy key (37 hex).
2. Isi **DUA** variabel di `.env` (berpasangan, keduanya wajib):
   ```
   CLOUDFLARE_EMAIL=email-akun-cloudflare-anda@contoh.com
   CLOUDFLARE_API_KEY=paste_global_key_di_sini
   ```
3. Catatan: keduanya dipakai sebagai header `X-Auth-Email` + `X-Auth-Key`.
   `deploy-pool.sh` dan `install.sh` menerima pasangan ini sebagai alternatif
   `CLOUDFLARE_API_TOKEN` ( perilaku sama: verifikasi → deploy pool ).

---

## 4. Account ID (wajib, bukan rahasia)

Account ID = pengenal 32-hex **akun** Anda (bukan token, aman dilihat orang).

Cara tercepat (pilih satu):
- Dashboard → **Workers & Pages** → sidebar kanan → **Account ID** → copy.
- Atau dari VPS:
  ```bash
  CLOUDFLARE_API_TOKEN=... npx wrangler whoami
  ```
- Atau via API:
  ```bash
  curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    https://api.cloudflare.com/client/v4/accounts | python3 -m json.tool
  # → result[0].id  = account id, result[0].name = nama akun
  ```

Isi ke `.env`:
```
CLOUDFLARE_ACCOUNT_ID=5159165037054bd3ddc033e34cefe46e
```

**Zone ID tidak dibutuhkan** untuk mode workers.dev (zone hanya relevan
bila worker di-route ke custom domain di zone Anda).

---

## 5. Verifikasi kredensial SEBELUM install (opsional tapi disarankan)

`install.sh` melakukan pre-flight yang sama otomatis, tapi manual:

```bash
# 1. Token aktif? (hanya untuk API Token)
curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  https://api.cloudflare.com/client/v4/user/tokens/verify
# → {"success":true,...,"result":{"status":"active",...}}

# 2. Global key benar? (hanya untuk metode global key)
curl -s -H "X-Auth-Email: $CLOUDFLARE_EMAIL" -H "X-Auth-Key: $CLOUDFLARE_API_KEY" \
  https://api.cloudflare.com/client/v4/user
# → {"success":true,...}

# 3. Account id terlihat dengan kredensial ini?
curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  https://api.cloudflare.com/client/v4/accounts | grep -o "$CLOUDFLARE_ACCOUNT_ID"
```

Kalau langkah 3 kosong padahal token aktif → cek **Account Resources** pada
token: kemungkinan akun Anda tidak termasuk scope token (§2 langkah 6).

---

## 6. Peta variabel `.env` → kegunaan

| Variabel `.env` | Dipakai oleh | Keterangan |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | `install.sh` → `deploy-pool.sh` (wrangler) + disalin ke gateway sebagai `HYBRID_CF_API_TOKEN` (quota guard GraphQL per jam) | API Token §2 |
| `CLOUDFLARE_EMAIL` + `CLOUDFLARE_API_KEY` | `install.sh` → `deploy-pool.sh` (wrangler auth alternatif) | Global Key §3 |
| `CLOUDFLARE_ACCOUNT_ID` | `deploy-pool.sh` + gateway quota guard | §4 |
| `CF_WORKER_DEPLOY_COUNT` | `install.sh` → `deploy-pool.sh` `POOL_SIZE` | Jumlah worker (1..100). Juga default `HYBRID_WORKER_POOL_MAX` runtime |
| `CF_WORKERS_SUBDOMAIN` | `install.sh` (menurunkan `HYBRID_WORKER_BASE` bila kosong) + verifikasi `/__meta` di `deploy-pool.sh` | Subdomain workers.dev akun |
| `CF_WORKER_NAME` | `install.sh` (derivasi URL) | Nama script worker 1 (sibling: `-2..-N`) |
| `CF_WORKER_VERIFY` | `deploy-pool.sh` | 1 = cek `/__meta` tiap worker pasca-deploy |
| `HYBRID_SHARED_SECRET` | gateway VPS + SEMUA worker (HMAC) | Kosong → auto-generate oleh `install.sh` (openssl rand -hex 32) dan disimpan ke `.env` |
| `HYBRID_ENABLED` | `install.sh` | `false` → daemon saja |
| `HYBRID_GATEWAY_PORT/BIND/TLS_*` | gateway env | Listener + TLS (sertifikat wildcard daemon, baca-saja) |
| `HYBRID_VPS_DL_SHARE` | gateway front v1.4 | Pangsa request download di lane VPS TANPA cap (1.0 = murni VPS; 0.0 = murni edge) |
| `HYBRID_WORKER_POOL_MAX` dst. | gateway workerpool.mjs | Batas aktif + tuning autoscaler (default pool = deploy count) |
| `HYBRID_CF_QUOTA_SOFT_PCT/HARD_PCT` | gateway quota guard | Ambang vs kuota 100k/hari (per akun) |

Variabel yang **tidak** masuk `.env` (jalur berbeda):
- `HYBRID_DL_THREADS`/`HYBRID_UL_THREADS`/`HYBRID_DL_COUNTS`/
  `HYBRID_VPS_UL_SHARE`/`HYBRID_GATEWAY_BASE`/`HYBRID_FRONT_BASE`/`HYBRID_WORKER_BASE`
  — variabel **klien** (diekspor saat menjalankan
  `hybrid/probe-client/speedtest-cli-hybrid.py`, lihat contoh di `.env.example`).

---

## 7. Batas platform Workers Free (jujur, agar tidak salah harapan)

| Batas | Nilai | Konsekuensi praktis |
|---|---|---|
| Script per akun | **100** | `CF_WORKER_DEPLOY_COUNT` maksimal 100; pool sudah mentok semua slot |
| Request per hari | **100.000 — PER AKUN** (ACCOUNT-WIDE) | Pool MENDISTRIBUSIKAN kuota, tidak mengalikannya. Lane VPS justru menghemat kuota: request yang dilayani VPS tidak menyentuh CF |
| CPU per invocation | 10 ms (soft) | Terukur real-edge: P50 sampai 259 ms tanpa error; kelebihan konsisten → 1102. Deflection worker (§WORKER_POOL.md) meredam |
| Ukuran body request | 100 MB (Free) | Upload chunk worker ≤ 25 MB (`MAX_UPLOAD_BYTES`) — di bawah batas |

---

## 8. Keamanan operasional

1. **`.env` tidak pernah di-commit** — sudah masuk `.gitignore`; file berisi
   token/global key/secret. `chmod 600 .env` di VPS.
2. **Token minimal scope** — pakai template §2; jangan "All privileges".
3. **Rotasi** — profile → API Tokens → ⋯ → Roll; update `.env`; re-run
   `install.sh` (idempotent: worker + secret di-update, gateway.env di-regenerate).
4. **Secret worker write-only** — `HYBRID_SHARED_SECRET` di sisi Cloudflare
   hanya bisa ditulis ulang, tidak bisa dibaca kembali lewat API/dashboard.
5. **Kebocoran token** → revoke segera (profile → API Tokens → Delete/Roll).
   Token scoped hanya membuka worker scripts — bukan DNS/zona/billing.
6. `gateway.env` di VPS = 0640 root:speedtest-hybrid — token CF di dalamnya
   (untuk quota guard) tidak terbaca user lain.
