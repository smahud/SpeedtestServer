# INSTALL_BOOTSTRAP.md — kontrak installer beku (frozen bootstrap)

> **Status: BINDING** sejak 27 Nov 2026 (permintaan operator: "file instalasi
> dan update tidak boleh berubah meski code berubah banyak"). Model yang
> ditiru: pola *bootstrap permanen* UAEG (`smahud/uaeg`, klausul U-13) —
> installer/updater tidak bergantung pada code; bootstrap memanggil
> installer/updater TERBARU yang boleh berubah seiring waktu.

## Ringkasan satu kalimat

> Operator mengunduh **SATU file** (`install.sh`), **sekali**, dan memakainya
> **selamanya**: file itu adalah *bootstrap* beku tanpa logika proyek yang
> setiap dijalankan mengambil **installer core terbaru** dari GitHub dan
> mengeksekusinya — code boleh berubah sebanyak apa pun, file instalasi
> operator tidak pernah perlu diganti, dan instalasi lawas tetap mendapat
> pembaruan.

## Struktur

```
operator (unduh SEKALI, simpan selamanya)     GitHub (per commit/ref)
──────────────────────────────────            ──────────────────────────────
install.sh  (BOOTSTRAP BEKU, ~100 baris) ──► installer/install-core.sh
  · tanpa logika proyek                        (logika installer PENUH —
  · ambil core terbaru (default: master)        berubah bebas mengikuti code)
  · verifikasi dasar (#! + non-empty)
  · exec core dengan argumen + env asli
  · offline → fallback core lokal (berperingat)
        │
        ▼
  installer/install-core.sh (dijalankan dari mktemp)
  · REPO_ROOT dari SPEEDTEST_BOOTSTRAP_DIR (direktori install.sh operator)
  · build + pasang + verifikasi + transisi unit + restart
```

File terkait yang juga BEKU (tidak berubah mengikuti code):

| File | Peran |
|---|---|
| `install.sh` | bootstrap installer — satu-satunya file yang perlu diunduh operator |
| `auto-update.sh` | wrapper updater harian: `git pull` (ff-only) lalu **delegasi penuh** ke `install.sh --start` — tanpa logika proyek apa pun (tidak tahu layout stack, tidak menyentuh unit; semua transisi unit milik core) |

## Klausul

### B-1 — Bootstrap beku
`install.sh` tidak memuat logika proyek dan **tidak pernah berubah** ketika
code berubah. Perubahan pada `installer/install-core.sh` TIDAK memerlukan
perubahan apa pun pada `install.sh`. Satu-satunya alasan sah mengubah
bootstrap: perubahan kontrak bootstrap ini sendiri (versi naik, dicatat di
bawah).

### B-2 — Core diambil saat dijalankan
Setiap eksekusi bootstrap mengambil
`https://raw.githubusercontent.com/smahud/SpeedtestServer/<ref>/installer/install-core.sh`
(ref default `master`; bisa dipin via `--installer-ref <git-ref>` atau env
`SPEEDTEST_INSTALLER_REF`), memverifikasi bentuk dasar (non-kosong, diawali
`#!`), lalu mengeksekusinya dengan **seluruh argumen dan environment
operator yang tidak berubah**. Akibatnya: checkout/`install.sh` LAWAS tetap
selalu memasang dengan logika TERKINI.

### B-3 — Fallback offline
Bila GitHub tidak terjangkau dan ada `installer/install-core.sh` lokal
di samping bootstrap, salinan lokal dipakai dengan peringatan jelas
(bisa lebih tua dari ref default — hanya untuk kondisi offline).

### B-4 — Konteks repo via env
Bootstrap mengekspor `SPEEDTEST_BOOTSTRAP_DIR` (direktori tempat `install.sh`
dipanggil) supaya core yang ditarik tetap bekerja atas checkout/.env milik
operator. Invokasi langsung `installer/install-core.sh` (debug) fallback ke
direktori induknya.

### B-5 — Wrapper updater juga beku
`auto-update.sh` hanya melakukan: flock, cek allowlist origin, clean-tree
guard, `git fetch` + ff-only pull, lalu `bash install.sh --start`.
**Semua** transisi unit (bridge aktif / daemon park / restore standalone)
dan restart adalah tanggung jawab core — wrapper tidak boleh tahu layout
stack rilis mana pun, sehingga tidak perlu ikut berubah.

### B-6 — Diverifikasi di CI/manual
`install.sh --bootstrap-version` mencetak versi bootstrap + URL core;
`install.sh --dry-run` menjalankan core terbaru tanpa mengubah apa pun.

## Perubahan kontrak

- **v2 (27 Nov 2026)** — kontrak awal: bootstrap `install.sh` (beku),
  core `installer/install-core.sh`, wrapper `auto-update.sh` (beku).
  Termasuk PORT AUTHORITY: satu-satunya sumber port TCP/UDP proyek adalah
  `OoklaServer.properties` (8080 wajib) — lihat CONTRACT.md §3.
