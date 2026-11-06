#!/usr/bin/env bash
# run-hybrid-lab.sh — bring up the full hybrid lab stack and run the E-I
# hybrid-session probe with byte accounting.
#
# Components:
#   VPS plane (simulated on this host):
#     - SpeedtestServer (STS)          :8080  NetGauge TCP/TLS + UDP + WS fallback
#     - hybrid gateway                 :8090  discovery / tokens / results
#   Edge plane (simulated with local workerd):
#     - speedtest-hybrid-worker        :8790  WSS NetGauge + __down/__up
#
# Usage: bash run-hybrid-lab.sh [output-dir]
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
OUT="${1:-$HERE/../evidence}"
mkdir -p "$OUT"

WRANGLER="${WRANGLER:-/home/z/my-project/tools/wrangler-env/node_modules/.bin/wrangler}"
SECRET="lab-secret-2026-hybrid"
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

echo "=== 1. SpeedtestServer (VPS NetGauge plane) :8080 ==="
cd "$STS_DIR"
nohup node dist/bin/ooklaserver.js --ports 8080 --udp-ports 8080 \
   --evidence-log "$OUT/e-i-sts-evidence.jsonl" > "$OUT/e-i-sts-console.log" 2>&1 &
STS_PID=$!
sleep 2

echo "=== 2. hybrid gateway (VPS control plane) :8090 ==="
cd "$HERE/../../gateway/src"
HYBRID_GATEWAY_PORT=8090 HYBRID_SHARED_SECRET="$SECRET" \
HYBRID_WORKER_BASE=http://127.0.0.1:8790 HYBRID_VPS_PUBLIC_BASE=http://127.0.0.1:8090 \
HYBRID_STS_BASE=http://127.0.0.1:8080 \
HYBRID_RESULTS_FILE="$OUT/e-i-results.jsonl" \
nohup node gateway.mjs > "$OUT/e-i-gateway-console.log" 2>&1 &
GW_PID=$!
sleep 1

echo "=== 3. hybrid worker (edge plane, workerd) :8790 ==="
cd "$REPO_ROOT/hybrid/worker"
WRANGLER_SEND_METRICS=false CI=true nohup "$WRANGLER" dev --port 8790 --ip 127.0.0.1 \
 --var HYBRID_SHARED_SECRET:"$SECRET" > "$OUT/e-i-worker-console.log" 2>&1 &

for i in $(seq 1 45); do
  sleep 1
  curl -s -m 3 http://127.0.0.1:8790/__meta >/dev/null 2>&1 && \
  curl -s -m 3 http://127.0.0.1:8090/api/health >/dev/null 2>&1 && break
done

echo "=== 4. readiness checks ==="
curl -s -m 3 http://127.0.0.1:8090/api/health | head -6
node -e "
const net=require('net');
const s=net.connect({host:'127.0.0.1',port:8080});
let out='';
s.on('connect',()=>s.write('HI\n'));
s.on('data',d=>out+=d);
s.on('close',()=>{console.log('STS NetGauge:', out.split('\n')[0]); process.exit(0);});
setTimeout(()=>{console.log('STS NetGauge:', out.split('\n')[0]||'(no reply)');process.exit(0)},3000);" 2>/dev/null

echo ""
echo "=== 5. hybrid session probe (E-I) ==="
cd "$HERE/../../probe-client/src"
PROBE_LABEL=e-i-hybrid-session PROBE_OUT="$OUT/e-i-hybrid-session.json" \
HYBRID_GATEWAY_BASE=http://127.0.0.1:8090 HYBRID_WORKER_BASE=http://127.0.0.1:8790 \
  node hybrid-probe.mjs 2>&1

echo ""
echo "=== 6. gateway counters (VPS control-plane bytes actually served) ==="
curl -s -m 3 http://127.0.0.1:8090/api/health | python3 -c 'import json,sys; d=json.load(sys.stdin); print(json.dumps(d["counters"], indent=2))'

echo "=== done — evidence in $OUT ==="
