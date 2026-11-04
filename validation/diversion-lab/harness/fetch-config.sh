#!/usr/bin/env bash
# fetch-config.sh — ambil config live dari endpoint resmi dengan query PERSIS milik CLI
# (dicatat di log proxy lab), dengan retry/backoff sampai rate-limit (429) cleared.
# Output: evidence/config-snapshot.json (valid untuk CLI ini; deviceId+sid stabil).
set -uo pipefail
cd "$(dirname "$0")"
UA="ookla-cli/1.2.0.84-1.ea6b6773cf (speedtest-cli-linux-x86_64)"
QUERY="deviceId=e08a4aff62aae322b2d21575d630fc705dcf86cf74031fc27c4929c4aecf4336&hid=V%2518%2518A%251D%251A%2518%2519%2519%2514%2508_S%2506%2504V%2507U%2502J%251DKKG%2540%2510AOHLB%2512&sid=5c689e7ba41f8d0e5b1e5e0823c64e62da0916a8e21c0021e0847522f70c59b8&uname=Linux%205.10.134-013.15.kangaroo.al8.x86_64%20%231%20SMP%20Thu%20Jul%2030%202026%20x86_64"
URL="https://cli.speedtest.net/api/cli/config?$QUERY"
OUT="../evidence/config-snapshot.json"
MAX="${1:-5}"     # jumlah percobaan
SLEEP="${2:-120}" # jeda antar percobaan (detik)
for i in $(seq 1 "$MAX"); do
  CODE=$(timeout 20 curl -sS -A "$UA" -o /tmp/cfg-live.json -w "%{http_code}" "$URL" 2>/dev/null || echo ERR)
  echo "[$(date -u +%H:%M:%S)] attempt $i/$MAX → HTTP $CODE ($(stat -c%s /tmp/cfg-live.json 2>/dev/null || echo 0) B)"
  if [ "$CODE" = "200" ]; then
    if jq -e '.app.licenseKey and (.servers|length>0)' /tmp/cfg-live.json >/dev/null 2>&1; then
      cp /tmp/cfg-live.json "$OUT"
      echo "SNAPSHOT TERSIMPAN: $OUT (licenseKey: $(jq -r '.app.licenseKey' "$OUT" | head -c 16)…, servers: $(jq -r '.servers|length' "$OUT"))"
      exit 0
    else
      echo "200 tapi body tidak valid (bukan JSON dengan licenseKey) — response: $(head -c 120 /tmp/cfg-live.json)"
    fi
  fi
  [ "$i" = "$MAX" ] && break
  echo "  tunggu ${SLEEP}s…"
  sleep "$SLEEP"
done
echo "GAGAL: rate-limit belum cleared setelah $MAX percobaan"
exit 1
