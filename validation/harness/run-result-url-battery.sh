#!/usr/bin/env bash
# run-result-url-battery.sh — official CLI → SpeedtestServer, PUBLISHING ENABLED.
#
# Multi-server Result-URL battery: forces several DISTINCT server IDs from the
# live engine config (all entries transparently rewritten by cv-proxy.mjs to
# the local SpeedtestServer) and captures, for every run:
#   - the CLI output (json-pretty or human) incl. the genuine public Result URL
#   - CLI stderr, cv-proxy JSONL log, SpeedtestServer JSONL evidence log,
#     per-run process inventory, and a machine summary.
#
# Unlike the mandatory gates (run-official-baseline.sh / run-replacement-test.sh,
# which stay NON-PUBLISHING by refusing results.speedtest.net), this battery is
# the one place where publishing is opted into: cv-proxy runs with --publish so
# the CLI can submit the finished measurement and return
# https://www.speedtest.net/result/c/<uuid>. Every tunnel is logged (k:
# 'publish_tunnel') in the per-run proxy log.
#
# FAILS CLOSED: refuses to run if the target port is not owned by the
# SpeedtestServer process or any official OoklaServer daemon is alive.
#
# Environment:
#   SERVER_IDS  space-separated list; each entry is one of
#                 "<id>"                 json-pretty run
#                 "<id>:human"           human-readable run
#                 "<id>:<fmt>:<suffix>"   same id/format, distinct tag suffix
#               (required; ids must exist in the live config list)
#   STS_PORT    SpeedtestServer TCP/UDP port           (default 8080)
#   OUT         evidence output dir                    (default ./out/result-urls)
#   CLI         official speedtest binary path
#               (default ../../clients/speedtest/speedtest)
#   CA_BUNDLE   CLI trust bundle (system store + lab CA)
#               (default ../certs/cli-ca-bundle.pem)
#   TS_BIN      SpeedtestServer entrypoint
#               (default ../../reverse-engineered/typescript/dist/bin/ooklaserver.js)
set -u
cd "$(dirname "$0")"
HARNESS="$PWD"
STS_PORT="${STS_PORT:-8080}"
UDP_PORT="${UDP_PORT:-5060}"
OUT="${OUT:-./out/result-urls}"
CLI="${CLI:-../../clients/speedtest/speedtest}"
CA_BUNDLE="${CA_BUNDLE:-certs/cli-ca-bundle.pem}"
TS_BIN="${TS_BIN:-../../reverse-engineered/typescript/dist/bin/ooklaserver.js}"
SERVER_IDS="${SERVER_IDS:-}"

[ -n "$SERVER_IDS" ] || { echo "SERVER_IDS required, e.g. SERVER_IDS='60178 35791:human 48446:json-pretty:run2'"; exit 2; }
[ -x "$CLI" ] || { echo "official CLI not found at $CLI"; exit 2; }
[ -f "$CA_BUNDLE" ] || { echo "CA bundle not found at $CA_BUNDLE (run gen-pki.sh)"; exit 2; }
[ -f "$TS_BIN" ] || { echo "SpeedtestServer build not found at $TS_BIN (npm run build)"; exit 2; }

mkdir -p "$OUT"
CLI_SHA="$(sha256sum "$CLI" | cut -d' ' -f1)"
GIT_SHA="$(git -C "$HARNESS/../.." rev-parse HEAD 2>/dev/null || echo unknown)"
SUMMARY="$OUT/battery-summary.json"
# Append-mode: repeated invocations into the same OUT accumulate runs
# (distinct tag suffixes keep per-run files separate); each invocation is
# delimited by its k:"battery" startedUtc/finishedUtc markers.
touch "$SUMMARY"

meta() { printf '%s\n' "$1" >> "$SUMMARY"; }

meta "{\"k\":\"battery\",\"startedUtc\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"gitSha\":\"$GIT_SHA\",\"cliSha256\":\"$CLI_SHA\",\"publishing\":true,\"target\":\"localhost:$STS_PORT\"}"

start_sts() { # $1=tag
  node "$TS_BIN" --ports "$STS_PORT,$UDP_PORT" --udp-ports "$STS_PORT,$UDP_PORT" \
    --evidence-log "$OUT/run-$1-sts-evidence.jsonl" > "$OUT/run-$1-sts-console.txt" 2>&1 &
  STS_PID=$!
  for _ in $(seq 1 20); do
    ss -tln 2>/dev/null | grep -q ":${STS_PORT} " && return 0
    sleep 0.5
  done
  return 1
}

preflight() { # $1=tag -> fail-closed prechecks + inventory file
  local TAG="$1" PORT_PID OWNER_CMD DAEMONS
  PORT_PID=$(ss -tlnp 2>/dev/null | grep -E ":${STS_PORT} " | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)
  OWNER_CMD=$(tr '\0' ' ' < "/proc/$PORT_PID/cmdline" 2>/dev/null || true)
  # Official-daemon detection by process NAME (comm): matches OoklaServer and
  # the suffixed binaries; never our own node dist/bin/ooklaserver.js process.
  DAEMONS=$(ps -eo pid=,comm= | awk '$2 ~ /^[Oo]okla[Ss]erver([.-][[:alnum:]_.-]*)?$/ {print $1, $2}')
  {
    date -u
    echo "SpeedtestServer git SHA: $GIT_SHA"
    echo "CLI sha256: $CLI_SHA"
    echo "target owner pid=$PORT_PID cmd=$OWNER_CMD"
    echo "--- listeners ---"
    ss -tlnp 2>/dev/null | grep -E ":${STS_PORT} |:${UDP_PORT} "
    ss -ulnp 2>/dev/null | grep -E ":${STS_PORT} |:${UDP_PORT} " || true
    echo "--- processes ---"
    if [ -n "$DAEMONS" ]; then printf '%s\n' "$DAEMONS"; else echo "official daemon: ABSENT"; fi
  } > "$OUT/run-$TAG-process.txt"
  case "$OWNER_CMD" in
    *dist/bin/ooklaserver.js*) : ;;
    *) echo "FATAL: $STS_PORT not owned by SpeedtestServer (run $TAG)"; return 1 ;;
  esac
  [ -z "$DAEMONS" ] || { echo "FATAL: official daemon present (run $TAG)"; return 1; }
  return 0
}

verify_json_run() { # $1=tag $2=jsonfile -> 0 ok
  node - "$1" "$2" <<'EOF'
const fs = require('fs');
const [tag, file] = process.argv.slice(2);
try {
  const r = JSON.parse(fs.readFileSync(file, 'utf8'));
  const checks = {
    localhostTarget: !!(r.server && String(r.server.host).includes('localhost') && r.server.port === Number(process.env.STS_PORT || 8080)),
    persisted: !!(r.result && r.result.persisted === true),
    resultUrl: !!(r.result && r.result.url && /^https:\/\/www\.speedtest\.net\/result\/c\//.test(r.result.url)),
    packetLossZero: r.packetLoss === 0,
  };
  const ok = Object.values(checks).every(Boolean);
  console.log(`[verify ${tag}] ${JSON.stringify(checks)} -> ${ok ? 'PASS' : 'FAIL'}`);
  process.exit(ok ? 0 : 4);
} catch (e) { console.log(`[verify ${tag}] no valid JSON: ${e}`); process.exit(4); }
EOF
}

run_one() { # $1=id $2=fmt $3=optional tag suffix
  local ID="$1" FMT="$2" SUF="${3:-}" TAG="s${1}${3:+-$3}"
  [ "$FMT" = "human" ] && TAG="s${1}-human${3:+-$3}"
  echo "=== run $TAG (format=$FMT) ==="
  start_sts "$TAG" || { echo "STS failed to start (run $TAG)"; meta "{\"k\":\"run\",\"id\":$ID,\"format\":\"$FMT\",\"status\":\"STS_START_FAILED\"}"; return 1; }
  sleep 1
  preflight "$TAG" || { kill -9 $STS_PID 2>/dev/null; return 1; }
  CV_REWRITE_ALL=1 node cv-proxy.mjs --port 8888 --target "localhost:${STS_PORT}" \
    --publish --log "$OUT/run-$TAG-proxy.jsonl" > "$OUT/run-$TAG-proxy-console.txt" 2>&1 &
  PROXY_PID=$!
  sleep 1

  local ARGS=(-s "$ID" --selection-details --ca-certificate="$CA_BUNDLE" --accept-license --accept-gdpr)
  if [ "$FMT" = "human" ]; then
    ALL_PROXY=http://127.0.0.1:8888 HTTPS_PROXY=http://127.0.0.1:8888 HTTP_PROXY=http://127.0.0.1:8888 \
      "$CLI" "${ARGS[@]}" > "$OUT/run-$TAG.txt" 2> "$OUT/run-$TAG.stderr"
  else
    ALL_PROXY=http://127.0.0.1:8888 HTTPS_PROXY=http://127.0.0.1:8888 HTTP_PROXY=http://127.0.0.1:8888 \
      "$CLI" "${ARGS[@]}" -f json-pretty > "$OUT/run-$TAG.json" 2> "$OUT/run-$TAG.stderr"
  fi
  local EXIT=$?
  echo "exit=$EXIT" >> "$OUT/run-$TAG.stderr"
  kill $PROXY_PID $STS_PID 2>/dev/null; sleep 2; kill -9 $PROXY_PID $STS_PID 2>/dev/null

  local STATUS="EXIT_$EXIT" RESULT_URL="" PL=""
  if [ "$FMT" = "human" ]; then
    if [ "$EXIT" = "0" ] && grep -q "Result URL: https://www.speedtest.net/result/c/" "$OUT/run-$TAG.txt"; then STATUS=PASS; fi
    RESULT_URL=$(grep -o 'Result URL: https://www\.speedtest\.net/result/c/[a-f0-9-]*' "$OUT/run-$TAG.txt" | head -1 | sed 's/^Result URL: //' || true)
    PL=$(grep -o 'Packet Loss:[[:space:]]*[0-9.]*%' "$OUT/run-$TAG.txt" | head -1 | grep -o '[0-9.]*' || true)
  else
    if [ "$EXIT" = "0" ] && STS_PORT=$STS_PORT verify_json_run "$TAG" "$OUT/run-$TAG.json"; then STATUS=PASS; fi
    RESULT_URL=$(node -e "try{const r=JSON.parse(require('fs').readFileSync('$OUT/run-$TAG.json','utf8'));console.log(r.result&&r.result.url||'')}catch(e){}" 2>/dev/null || true)
    PL=$(node -e "try{const r=JSON.parse(require('fs').readFileSync('$OUT/run-$TAG.json','utf8'));console.log(r.packetLoss===undefined?'':r.packetLoss)}catch(e){}" 2>/dev/null || true)
  fi
  meta "{\"k\":\"run\",\"id\":$ID,\"format\":\"$FMT\",\"tag\":\"$TAG\",\"status\":\"$STATUS\",\"exit\":$EXIT,\"resultUrl\":\"${RESULT_URL:-}\",\"packetLoss\":\"${PL:-}\"}"
  echo "run $TAG -> $STATUS ${RESULT_URL:+| $RESULT_URL} ${PL:+| loss=${PL}%}"
}

for ENTRY in $SERVER_IDS; do
  ID="${ENTRY%%:*}"
  REST="${ENTRY#*:}"
  FMT="json-pretty"; SUF=""
  if [ "$REST" != "$ENTRY" ]; then
    FMT="${REST%%:*}"
    SUF="${REST#*:}"
    [ "$SUF" = "$REST" ] && SUF=""
  fi
  run_one "$ID" "$FMT" "$SUF"
  sleep 2
done

meta "{\"k\":\"battery\",\"finishedUtc\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}"
echo ""
echo "=== battery summary ($SUMMARY) ==="
cat "$SUMMARY"
