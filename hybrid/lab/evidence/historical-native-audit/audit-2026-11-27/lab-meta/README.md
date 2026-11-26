# Evidence — historical-native-audit/audit-2026-11-27

Audit: **HISTORICAL REGRESSION AUDIT & OFFICIAL NATIVE CLIENT INTEROPERABILITY**
(master prompt: `MASTER_PROMPT_SPEEDTESTSERVER_HISTORICAL_NATIVE_WORKER_AUDIT.md`).

**Baseline:** `master@0ac51ac` (v1.5.2) · VPS runtime `/opt/speedtest-hybrid` = `b629642` (master unggul
1 commit docs-only). **Dilakukan:** 26 Nov 2026 17:00–17:30 UTC dari sandbox eksternal (egress NAT
45.126.249.249). **Semua akses VPS read-only via uaeg MCP** — tidak ada restart/deploy/rotasi secret
yang dilakukan audit ini.

## Struktur

| Direktori | Isi |
|---|---|
| `h0-worker-differential/` | Ringkasan A/B/A worker d6b5f1e vs HEAD (3 postur) — verdict NO_REGRESSION |
| `h1-eg-replay/` | Replay E-G: clone z.ai Host Tester v1.0.1 vs worker lama (open) 10/10, HEAD test-env 10/10, HEAD postur produksi 3/6 |
| `h3-official-cli-vps/` | 4 run CLI resmi 1.2.0.84 → VPS (66281): CLI JSON + dns-proof + jendela + delta eth0 VPS + journal daemon + Worker GraphQL (0 request) |
| `h2-hybrid-probe/` | Kontrol positif jalur custom (probe E-I) di produksi hari ini: payload edge 56 MiB, offload 1:12284,6 |
| `lab-meta/` | metadata.json (manifest seluruh run) + README ini + perintah reproduksi |

## Reproduksi (aman, tidak mengubah produksi)

```bash
# H0/H1 — lokal murni (workerd), tidak menyentuh produksi:
git worktree add ../worker-d6b5f1e d6b5f1e
cd hybrid/worker && npx wrangler dev --port 8790 --ip 127.0.0.1 \
  --var LEGACY_HTTP_ENABLED:true --var MAX_DOWNLOAD_BYTES:33554432 --var MAX_UPLOAD_BYTES:33554432
node test/conformance.mjs http://127.0.0.1:8790
# clone z.ai: https://github.com/smahud/SpeedtestHost-Tester (branch audit/z-ai-official-validation)
node SpeedtestHost-Tester/z.ai/cli/speedtest-host-tester.mjs 127.0.0.1:8793 --download 4 --upload 4 --samples 8
# (edge-front.mjs dari hybrid/lab/harness/ menyediakan TLS/plain :8793 -> :8790)

# H3 — CLI resmi ke VPS (non-publishing; ikuti metodologi E-M):
unshare --user --map-root-user --mount bash -c '
  mount --bind /tmp/mockhosts /etc/hosts   # hostnames Surabaya operator -> 45.126.249.250; results.speedtest.net -> 127.0.0.1
  speedtest --server-id=66281 --accept-license --accept-gdpr -f json'
# atribusi: delta /sys/class/net/eth0/statistics/{rx,tx}_bytes + journalctl -u speedtestserver + CF GraphQL
# workersInvocationsAdaptive per menit pada jendela run.

# H2 — probe custom ke produksi (endpoint milik operator):
HYBRID_GATEWAY_BASE=https://speedtest.lumajangnetworks.my.id:8790 \
HYBRID_WORKER_BASE=https://speedtest-hybrid-worker.lumajangnetworks.workers.dev \
PROBE_MODE=ws node hybrid/probe-client/src/hybrid-probe.mjs
```

## Higien

- Tidak ada token/secret di evidence (semua `v1~…` di-redact; skrip sanitasi di sesi agent, tidak
  di-commit).
- Hasil H3 tidak pernah dikirim ke speedtest.net (`results.speedtest.net` → 127.0.0.1 dalam namespace;
  `persisted=false`, `result.url=null` pada 4/4 run).
- Discovery resmi tidak dimanipulasi: `cli.speedtest.net` diakses apa adanya; hanya resolusi hostname
  (hosts) entri daftar operator yang diarahkan ke VPS milik operator dalam namespace lab terisolasi.
- Checksum SHA-256 seluruh file evidence ada di `checksums.txt`.
