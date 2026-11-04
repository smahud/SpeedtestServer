#!/usr/bin/env bash
# run-official-baseline.sh — official CLI → official OoklaServer reference baseline.
#
# Prerequisites:
#   - Official OoklaServer reference daemon running (see REPRODUCE.md) on REF_PORT
#   - Lab PKI generated:  validation/harness/gen-pki.sh  (needs certs/ next to this script)
#   - Official CLI tarball extracted under  clients/speedtest/
#
# Environment:
#   REF_PORT   daemon port            (default 18080)
#   OUT        evidence output dir    (default ./out/baseline)
set -euo pipefail
cd "$(dirname "$0")"
REF_PORT="${REF_PORT:-18080}"
OUT="${OUT:-./out/baseline}"
mkdir -p "$OUT"

CLI="${CLI:-../../clients/speedtest/speedtest}"
[ -x "$CLI" ] || { echo "official CLI not found at $CLI (extract the official tarball there)"; exit 2; }

# 1) config proxy: redirects all server entries to the reference daemon,
#    refuses results.speedtest.net (non-publishing guarantee).
CV_REWRITE_ALL=1 node cv-proxy.mjs --port 8888 --target "localhost:${REF_PORT}" --log "$OUT/proxy.jsonl" &
PROXY_PID=$!
trap 'kill $PROXY_PID 2>/dev/null || true' EXIT
sleep 1

# 2) pre-run process inventory (attribution)
{ date -u; ss -tlnp 2>/dev/null | grep -E ":${REF_PORT}" ; ps aux | grep -i ooklaserver | grep -v grep || true; } > "$OUT/process-inventory.txt"

# 3) run the official CLI (unmodified) through the proxy
set +e
ALL_PROXY=http://127.0.0.1:8888 HTTPS_PROXY=http://127.0.0.1:8888 HTTP_PROXY=http://127.0.0.1:8888 \
  "$CLI" --ca-certificate=certs/cli-ca-bundle.pem --accept-license --accept-gdpr \
  --selection-details -f json-pretty > "$OUT/cli.json" 2> "$OUT/cli.stderr"
EXIT=$?
set -e
echo "exit=$EXIT" >> "$OUT/cli.stderr"

# 4) verify non-publishing
if grep -q '"persisted": false' "$OUT/cli.json" 2>/dev/null && grep -q '"blocked"' "$OUT/proxy.jsonl"; then
  echo "NON-PUBLISHING: VERIFIED (persisted=false + submission refused at proxy)"
else
  echo "NON-PUBLISHING: NOT VERIFIED — treat run as UNVERIFIED"
fi
echo "baseline complete: $OUT/cli.json (exit $EXIT)"
exit $EXIT
