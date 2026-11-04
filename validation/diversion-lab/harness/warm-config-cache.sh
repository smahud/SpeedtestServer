#!/usr/bin/env bash
# warm-config-cache.sh — pre-warm token kuota config API dengan curl retry-loop.
# Menyimpan body config live ke file cache (dipakai live-config-proxy --cache).
# Pemakaian: warm-config-cache.sh <file-cache> [max-coba] [jeda-detik]
set -uo pipefail
OUT="${1:-/tmp/live-config.json}"
MAX="${2:-25}"
SLEEP="${3:-20}"
UA="ookla-cli/1.2.0.84-1.ea6b6773cf (speedtest-cli-linux-x86_64)"
QUERY="deviceId=e08a4aff62aae322b2d21575d630fc705dcf86cf74031fc27c4929c4aecf4336&hid=V%2518%2518A%251D%251A%2518%2519%2519%2514%2508_S%2506%2504V%2507U%2502J%251DKKG%2540%2510AOHLB%2512&sid=5c689e7ba41f8d0e5b1e5e0823c64e62da0916a8e21c0021e0847522f70c59b8&uname=Linux%205.10.134-013.15.kangaroo.al8.x86_64%20%231%20SMP%20Thu%20Jul%2030%202026%20x86_64"
URL="https://cli.speedtest.net/api/cli/config?$QUERY"
for i in $(seq 1 "$MAX"); do
  CODE=$(timeout 20 curl -sS -A "$UA" -H "Accept: application/json" -o "$OUT.tmp" -w "%{http_code}" "$URL" 2>/dev/null || echo ERR)
  if [ "$CODE" = "200" ] && jq -e '.app.licenseKey and (.servers|length>0)' "$OUT.tmp" >/dev/null 2>&1; then
    mv "$OUT.tmp" "$OUT"
    echo "[$(date -u +%H:%M:%S)] cache OK → $OUT ($(stat -c%s "$OUT") B, umur 0 dtk, key $(jq -r '.app.licenseKey' "$OUT" | head -c 16)…)"
    exit 0
  fi
  echo "[$(date -u +%H:%M:%S)] coba $i/$MAX → HTTP $CODE — tunggu ${SLEEP}s"
  [ "$i" = "$MAX" ] && break
  sleep "$SLEEP"
done
echo "GAGAL warm cache setelah $MAX percobaan"
exit 1
