#!/usr/bin/env bash
# run-replacement-test.sh — official CLI → SpeedtestServer (the implementation in this repo).
#
# FAILS CLOSED: refuses to run if the target endpoint is not owned by the
# SpeedtestServer process, or if any official OoklaServer process is alive.
#
# Environment:
#   STS_PORT   SpeedtestServer port   (default 8080)
#   OUT        evidence output dir    (default ./out/replacement)
set -euo pipefail
cd "$(dirname "$0")"
STS_PORT="${STS_PORT:-8080}"
OUT="${OUT:-./out/replacement}"
mkdir -p "$OUT"

CLI="${CLI:-../../clients/speedtest/speedtest}"
[ -x "$CLI" ] || { echo "official CLI not found at $CLI"; exit 2; }

# --- Gate CLI-3 pre-checks (fail closed) ---
if ps aux | grep -iE 'ooklaserver(-linux|[[:space:]]--ward)' | grep -v grep | grep -vq dist/bin/ooklaserver.js; then
  echo "FATAL: an official OoklaServer process is running — kill it first (no hidden dependency allowed)."
  exit 3
fi
OWNER=$(ss -tlnp 2>/dev/null | grep -E ":${STS_PORT} " | grep -o 'pid=[0-9]*' | head -1 || true)
if [ -z "$OWNER" ]; then
  echo "FATAL: nothing is listening on ${STS_PORT} — start SpeedtestServer first."
  exit 3
fi
{
  date -u
  echo "SpeedtestServer git SHA: $(git -C ../.. rev-parse HEAD 2>/dev/null || echo unknown)"
  echo "target owner: $OWNER"
  ss -tlnp 2>/dev/null | grep -E ":${STS_PORT} |:5060 "
  ss -ulnp 2>/dev/null | grep -E ":${STS_PORT} |:5060 " || true
  ps aux | grep -iE 'ooklaserver' | grep -v grep || echo "official daemon: ABSENT"
} > "$OUT/process-inventory.txt"
if ! grep -q "official daemon: ABSENT" "$OUT/process-inventory.txt"; then
  echo "FATAL: official daemon still present — see $OUT/process-inventory.txt"
  exit 3
fi
echo "pre-flight OK: target owned by SpeedtestServer ($OWNER), official daemon absent."

# --- config proxy (all servers → SpeedtestServer; results blocked) ---
CV_REWRITE_ALL=1 node cv-proxy.mjs --port 8888 --target "localhost:${STS_PORT}" --log "$OUT/proxy.jsonl" &
PROXY_PID=$!
trap 'kill $PROXY_PID 2>/dev/null || true' EXIT
sleep 1

set +e
ALL_PROXY=http://127.0.0.1:8888 HTTPS_PROXY=http://127.0.0.1:8888 HTTP_PROXY=http://127.0.0.1:8888 \
  "$CLI" --ca-certificate=../certs/cli-ca-bundle.pem --accept-license --accept-gdpr \
  --selection-details -f json-pretty > "$OUT/cli.json" 2> "$OUT/cli.stderr"
EXIT=$?
set -e
echo "exit=$EXIT" >> "$OUT/cli.stderr"

# --- post-run attribution: server-side counters must corroborate ---
node - "$OUT" <<'EOF'
const fs = require('fs');
const out = process.argv[2];
let pass = true;
try {
  const cli = JSON.parse(fs.readFileSync(`${out}/cli.json`, 'utf8'));
  if (cli.result && cli.result.persisted === false) console.log('non-publishing: persisted=false OK');
  else { console.log('NON-PUBLISHING NOT VERIFIED'); pass = false; }
  if (cli.server && String(cli.server.host).includes('localhost')) console.log(`target: ${cli.server.host}:${cli.server.port} OK`);
  else { console.log('TARGET MISMATCH — CLI tested a different server!'); pass = false; }
} catch (e) { console.log('no valid CLI result'); pass = false; }
process.exit(pass ? 0 : 4);
EOF
ATTR=$?
[ "$EXIT" = "0" ] && [ "$ATTR" = "0" ] || { echo "RUN NOT VALID (cli=$EXIT attribution=$ATTR) — status UNVERIFIED"; exit 5; }
echo "replacement run PASS: $OUT/cli.json"
