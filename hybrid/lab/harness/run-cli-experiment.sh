#!/usr/bin/env bash
# run-cli-experiment.sh — one official-CLI hybrid experiment = one full cycle.
#
# Brings up: STS :8080 (lab cert, evidence log) + workerd :8790 (when needed)
#            hybrid-config-proxy :8888 (per-entry server-list rewrite)
# Then runs the UNMODIFIED official CLI through the proxy and captures:
#   cli.json (stdout), cli.stderr (selection details / errors),
#   proxy.jsonl (config fetch + rewrite decisions), sts-evidence.jsonl,
#   process inventory.
#
# Env:
#   EXP_ID      (required) evidence dir name (e-d-*, e-e-*)
#   SERVERS     (required) comma list mapped onto the config servers[]
#               e.g. "speed.cloudflare.com:8080,127.0.0.1:8080"
#   NEED_STS    1 = start SpeedtestServer (default 1)
#   NEED_WORKER 1 = start workerd            (default 0)
#   CLI_ARGS    extra CLI args
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
LAB_ROOT="/home/z/my-project/lab"
CLI="$LAB_ROOT/clients/speedtest/speedtest"
CERTS="/home/z/my-project/baseline/validation/harness/certs"
WRANGLER="${WRANGLER:-/home/z/my-project/tools/wrangler-env/node_modules/.bin/wrangler}"

EXP_ID="${EXP_ID:-}"
SERVERS="${SERVERS:-}"
NEED_STS="${NEED_STS:-1}"
NEED_WORKER="${NEED_WORKER:-0}"
[ -n "$EXP_ID" ] && [ -n "$SERVERS" ] || { echo "usage: EXP_ID=e-d-x SERVERS='h:p,...' ./run-cli-experiment.sh"; exit 2; }

OUT="$HERE/../evidence/$EXP_ID"
rm -rf "$OUT"; mkdir -p "$OUT"
ABS_OUT="$(cd "$OUT" && pwd)"

log() { echo "[cli-exp:$EXP_ID] $*"; }

cleanup() {
  [ -n "${STS_PID:-}" ] && kill "$STS_PID" 2>/dev/null
  [ -n "${PROXY_PID:-}" ] && kill "$PROXY_PID" 2>/dev/null
  pkill -f "wrangler dev" 2>/dev/null
  pkill -f workerd 2>/dev/null
  sleep 1
}
trap cleanup EXIT
cleanup
sleep 1

# --- preflight inventory
{
  date -u; uname -a
  echo "repo HEAD: $(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null)"
  echo "experiment: $EXP_ID"
  echo "SERVERS: $SERVERS"
  echo "CLI: $($CLI --version 2>/dev/null | head -1)"
  echo "listeners before:"; ss -tlnp 2>/dev/null | grep -E ':(8080|8790|8888) ' || echo "(none)"
} > "$OUT/process-inventory.txt" 2>&1

# --- SpeedtestServer (the VPS lane)
STS_PID=""
if [ "$NEED_STS" = "1" ]; then
  log "start SpeedtestServer :8080 (lab cert)"
  cd "$LAB_ROOT/SpeedtestServer/reverse-engineered/typescript"
  nohup node dist/bin/ooklaserver.js --ports 8080 --udp-ports 8080 \
    --evidence-log "$ABS_OUT/sts-evidence.jsonl" > "$ABS_OUT/sts-console.log" 2>&1 &
  STS_PID=$!
  for i in $(seq 1 40); do
    node -e "
const net=require('net');const s=net.connect({host:'127.0.0.1',port:8080});
let o='';s.on('connect',()=>s.write('HI\n'));s.on('data',d=>o+=d);
s.on('close',()=>process.exit(o.includes('HELLO')?0:1));
setTimeout(()=>process.exit(o.includes('HELLO')?0:1),2500);" 2>/dev/null && break
    sleep 0.5
  done
  log "STS READY (pid $STS_PID)"
fi

# --- workerd (edge stand-in)
if [ "$NEED_WORKER" = "1" ]; then
  log "start hybrid worker (workerd) :8790"
  cd "$REPO_ROOT/hybrid/worker"
  WRANGLER_SEND_METRICS=false CI=true nohup "$WRANGLER" dev --port 8790 --ip 127.0.0.1 > "$ABS_OUT/worker-console.log" 2>&1 &
  for i in $(seq 1 45); do
    sleep 1
    curl -s -m 3 http://127.0.0.1:8790/__meta >/dev/null 2>&1 && break
  done
  log "worker READY"
fi

# --- config proxy
log "start hybrid-config-proxy :8888 → [$SERVERS]"
cd "$HERE"
nohup node hybrid-config-proxy.mjs --port 8888 --servers "$SERVERS" --log "$ABS_OUT/proxy.jsonl" > "$ABS_OUT/proxy-console.log" 2>&1 &
PROXY_PID=$!
sleep 1

{
  echo "listeners at run start:"; ss -tlnp 2>/dev/null | grep -E ':(8080|8790|8888) ' || echo "(none)"
} >> "$OUT/process-inventory.txt" 2>&1

# --- run the official CLI (unmodified, non-publishing)
log "run official CLI — servers map: $SERVERS"
START_TS=$(date +%s)
set +e
ALL_PROXY=http://127.0.0.1:8888 HTTPS_PROXY=http://127.0.0.1:8888 HTTP_PROXY=http://127.0.0.1:8888 \
  timeout 300 "$CLI" --ca-certificate="$CERTS/cli-ca-bundle.pem" --accept-license --accept-gdpr \
  --selection-details -f json-pretty ${CLI_ARGS:-} > "$ABS_OUT/cli.json" 2> "$ABS_OUT/cli.stderr"
EXIT=$?
set -e
END_TS=$(date +%s)
echo "exit=$EXIT" >> "$ABS_OUT/cli.stderr"
log "CLI exit=$EXIT duration=$((END_TS-START_TS))s"

sleep 1
echo ""
echo "--- cli.stderr (selection details / errors) ---"
head -c 3000 "$ABS_OUT/cli.stderr"
echo ""
echo "--- cli.json (head) ---"
head -c 2000 "$ABS_OUT/cli.json"
echo ""
log "evidence → $OUT"
exit $EXIT
