#!/usr/bin/env bash
# run-hybrid-lab.sh — bring up the full hybrid lab stack and run the E-I
# hybrid-session probe with byte accounting.
#
# G-10 / master-prompt §3.12: ALL ports and the output directory are
# parameterized so the lab never touches production ports (8080/8081/8443…)
# and never overwrites the committed E-A..E-I evidence. Defaults use the
# 18xxx range which is free on the VPS.
#
# Components:
#   VPS plane (simulated on this host):
#     - SpeedtestServer (STS)  :$STS_PORT    NetGauge TCP/TLS + UDP (default 18080)
#     - hybrid gateway         :$GW_PORT     discovery / tokens / results (default 18090)
#   Edge plane (simulated with local workerd):
#     - speedtest-hybrid-worker :$WORKER_PORT  WSS NetGauge + __down/__up (default 18790)
#
# Usage: bash run-hybrid-lab.sh [output-dir]
#   STS_PORT / GW_PORT / WORKER_PORT / PROBE_MODE / WRANGLER / SECRET via env
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
OUT="${1:-$HERE/../evidence}"
mkdir -p "$OUT"

WRANGLER="${WRANGLER:-npx wrangler}"
SECRET="${SECRET:-lab-secret-2026-hybrid}"
STS_PORT="${STS_PORT:-18080}"
GW_PORT="${GW_PORT:-18090}"
WORKER_PORT="${WORKER_PORT:-18790}"
export HYBRID_SHARED_SECRET="$SECRET"

cleanup() {
  [ -n "${GW_PID:-}" ] && kill "$GW_PID" 2>/dev/null
  [ -n "${STS_PID:-}" ] && kill "$STS_PID" 2>/dev/null
  pkill -f "wrangler dev" 2>/dev/null
  pkill -f workerd 2>/dev/null
}
trap cleanup EXIT
STS_PID=""
GW_PID=""
cleanup
sleep 1

STS_DIR="$REPO_ROOT/reverse-engineered/typescript"
[ -d "$STS_DIR" ] || STS_DIR="/home/z/my-project/lab/SpeedtestServer/reverse-engineered/typescript"

echo "=== 1. SpeedtestServer (VPS NetGauge plane) :$STS_PORT ==="
cd "$STS_DIR"
nohup node dist/bin/ooklaserver.js --ports "$STS_PORT" --udp-ports "$STS_PORT" \
   --evidence-log "$OUT/e-i-sts-evidence.jsonl" > "$OUT/e-i-sts-console.log" 2>&1 &
STS_PID=$!
sleep 2

echo "=== 2. hybrid gateway (VPS control plane) :$GW_PORT ==="
cd "$HERE/../../gateway/src"
HYBRID_GATEWAY_PORT="$GW_PORT" HYBRID_SHARED_SECRET="$SECRET" \
HYBRID_WORKER_BASE="http://127.0.0.1:$WORKER_PORT" \
HYBRID_VPS_PUBLIC_BASE="http://127.0.0.1:$GW_PORT" \
HYBRID_STS_BASE="http://127.0.0.1:$STS_PORT" \
HYBRID_RESULTS_FILE="$OUT/e-i-results.jsonl" \
nohup node gateway.mjs > "$OUT/e-i-gateway-console.log" 2>&1 &
GW_PID=$!
sleep 1

echo "=== 3. hybrid worker (edge plane, workerd) :$WORKER_PORT ==="
cd "$REPO_ROOT/hybrid/worker"
WRANGLER_SEND_METRICS=false CI=true nohup $WRANGLER dev --port "$WORKER_PORT" --ip 127.0.0.1 \
 --var HYBRID_SHARED_SECRET:"$SECRET" > "$OUT/e-i-worker-console.log" 2>&1 &

for i in $(seq 1 90); do
  sleep 1
  curl -s -m 3 "http://127.0.0.1:$WORKER_PORT/__meta" >/dev/null 2>&1 && \
  curl -s -m 3 "http://127.0.0.1:$GW_PORT/api/health" >/dev/null 2>&1 && break
done

echo "=== 4. readiness checks ==="
curl -s -m 3 "http://127.0.0.1:$GW_PORT/api/health" | head -6
node -e "
const net=require('net');
const s=net.connect({host:'127.0.0.1',port:$STS_PORT});
let out='';
s.on('connect',()=>s.write('HI\n'));
s.on('data',d=>out+=d);
s.on('close',()=>{console.log('STS NetGauge:', out.split('\n')[0]); process.exit(0);});
setTimeout(()=>{console.log('STS NetGauge:', out.split('\n')[0]||'(no reply)');process.exit(0)},3000);" 2>/dev/null

echo ""
echo "=== 5. hybrid session probe (E-I) ==="
cd "$HERE/../../probe-client/src"
PROBE_LABEL=e-i-hybrid-session PROBE_OUT="$OUT/e-i-hybrid-session.json" \
HYBRID_GATEWAY_BASE="http://127.0.0.1:$GW_PORT" HYBRID_WORKER_BASE="http://127.0.0.1:$WORKER_PORT" \
  node hybrid-probe.mjs 2>&1

echo ""
echo "=== 6. gateway counters (VPS control-plane bytes actually served) ==="
curl -s -m 3 "http://127.0.0.1:$GW_PORT/api/health" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(json.dumps(d["counters"], indent=2))'

echo "=== done — evidence in $OUT ==="
