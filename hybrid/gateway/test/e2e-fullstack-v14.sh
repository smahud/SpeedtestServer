#!/usr/bin/env bash
# e2e-fullstack-v14.sh — FULL-STACK local E2E of the v1.4 "full potential"
# assist model with REAL clients (sivel speedtest-cli — the stock engine,
# no mocks): proves the operator's v1.4 contract end-to-end.
#
#   T1: stock --mini client vs gateway share=1.0 → 100% VPS lane (uncapped,
#       zero edge redirects, zero token mints — pure VPS potential)
#   T2: stock --mini client vs gateway share=0.5 → BOTH lanes in ONE
#       measurement (local 200s + edge 302s in parallel, Bresenham split)
#   T3: hybrid probe client (8/4 threads, HYBRID_VPS_UL_SHARE=0.15) vs
#       share=0.5 → full hybrid loop: download lanes + upload split +
#       session token mint + result submission to /api/results
#
# Topology: 3 fake Node workers (fake-worker.mjs) + 2 gateways
# (A: share 1.0, B: share 0.5). Requires: node, python3 + speedtest-cli
# (sivel), curl, jq. Internet access for the engine's config fetch.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
GATEWAY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$GATEWAY_DIR/../.." && pwd)"
SECRET="e2e-v14-secret"
GA=18790; GB=18795
W1=18791; W2=18792; W3=18793
FW_PIDS=""; GA_PID=""; GB_PID=""
PASS=0; FAIL=0
ok()  { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

cleanup() {
  [ -n "${GA_PID:-}" ] && kill "$GA_PID" 2>/dev/null
  [ -n "${GB_PID:-}" ] && kill "$GB_PID" 2>/dev/null
  [ -n "${FW_PIDS:-}" ] && kill $FW_PIDS 2>/dev/null
}
trap cleanup EXIT
cleanup; sleep 1

start_fake() { node "$GATEWAY_DIR/test/fake-worker.mjs" "$1" "$2" > /tmp/e2e14-fw$1.log 2>&1 & FW_PIDS="$FW_PIDS $!"; }

start_gateway() { # port share resultsfile
  env HYBRID_GATEWAY_PORT="$1" HYBRID_GATEWAY_BIND=127.0.0.1 \
    HYBRID_SHARED_SECRET="$SECRET" \
    HYBRID_FRONT_ENABLED=true \
    HYBRID_VPS_DL_SHARE="$2" \
    HYBRID_WORKER_BASE="http://127.0.0.1:$W1" \
    HYBRID_WORKER_URLS="http://127.0.0.1:$W1,http://127.0.0.1:$W2,http://127.0.0.1:$W3" \
    HYBRID_WORKER_POOL_MAX=3 HYBRID_WORKER_ACTIVE_MIN=2 HYBRID_WORKER_ACTIVE_MAX=3 \
    HYBRID_WORKER_SCALE_RATE=6 HYBRID_WORKER_SHRINK_RATE=2 \
    HYBRID_WORKER_IDLE_SHRINK_MS=600000 \
    HYBRID_RESULTS_FILE="$3" \
    node "$GATEWAY_DIR/src/gateway.mjs" > /tmp/e2e14-g$1.log 2>&1 &
}

wait_gw() {
  for i in $(seq 1 30); do grep -q gateway_started "/tmp/e2e14-g$1.log" && return 0; sleep 0.5; done
  echo "gateway :$1 failed"; cat "/tmp/e2e14-g$1.log"; return 1
}

health() { curl -s -m 5 "http://127.0.0.1:$1/api/health"; }

echo "=== 3 fake workers + gateway A (share=1.0) + gateway B (share=0.5) ==="
start_fake "$W1" 1; start_fake "$W2" 2; start_fake "$W3" 3
sleep 1
for p in $W1 $W2 $W3; do
  curl -s -m 3 "http://127.0.0.1:$p/__meta" >/dev/null || { echo "fake worker $p failed"; exit 1; }
done
rm -f /tmp/e2e14-results.jsonl
start_gateway "$GA" 1.0 ""
GA_PID=$!; wait_gw "$GA" || exit 1
start_gateway "$GB" 0.5 "/tmp/e2e14-results.jsonl"
GB_PID=$!; wait_gw "$GB" || exit 1
echo "  stack up (workers :$W1-:$W3, GA :$GA share=1.0, GB :$GB share=0.5)"

echo ""
echo "=== T1: stock speedtest-cli --mini vs share=1.0 (pure VPS, uncapped) ==="
T1_OUT=$(timeout 180 speedtest-cli --json --mini "http://127.0.0.1:$GA" 2>/tmp/e2e14-t1.stderr); T1_RC=$?
if [ "$T1_RC" = 0 ]; then
  T1_JSON=$(echo "$T1_OUT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(f\"down={d['download']/1e6:.1f}Mbps up={d['upload']/1e6:.1f}Mbps ping={d['ping']:.0f}ms\")")
  ok "stock client exit 0: $T1_JSON"
else
  bad "stock client exit $T1_RC"; head -5 /tmp/e2e14-t1.stderr
fi
H1=$(health "$GA")
echo "$H1" | jq -e '.front.counters.dlLocal > 0 and .front.counters.downRedirects == 0 and .front.counters.tokensMinted == 0' >/dev/null \
  && ok "share=1.0 attribution: dlLocal=$(echo "$H1"|jq -r .front.counters.dlLocal) redirects=0 mints=0 (pure VPS potential)" \
  || bad "share=1.0 counters wrong: $(echo "$H1" | jq -c .front.counters)"
echo "$H1" | jq -e '.front.counters.uploadsDrained > 0' >/dev/null && ok "stock uploads drained at VPS ($(echo "$H1"|jq -r .front.counters.uploadsDrained) POSTs)" || bad "no uploads drained"

echo ""
echo "=== T2: stock speedtest-cli --mini vs share=0.5 (both lanes parallel) ==="
T2_OUT=$(timeout 180 speedtest-cli --json --mini "http://127.0.0.1:$GB" 2>/tmp/e2e14-t2.stderr); T2_RC=$?
if [ "$T2_RC" = 0 ]; then
  T2_JSON=$(echo "$T2_OUT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(f\"down={d['download']/1e6:.1f}Mbps up={d['upload']/1e6:.1f}Mbps ping={d['ping']:.0f}ms\")")
  ok "stock client exit 0: $T2_JSON"
else
  bad "stock client exit $T2_RC"; head -5 /tmp/e2e14-t2.stderr
fi
H2=$(health "$GB")
echo "$H2" | jq -e '.front.counters.dlLocal > 0 and .front.counters.downRedirects > 0' >/dev/null \
  && ok "share=0.5 attribution: dlLocal=$(echo "$H2"|jq -r .front.counters.dlLocal) edgeRedirects=$(echo "$H2"|jq -r .front.counters.downRedirects) (BOTH lanes served one measurement)" \
  || bad "share=0.5 counters wrong: $(echo "$H2" | jq -c .front.counters)"
echo "$H2" | jq -e '.front.assist.vpsDlShare == 0.5' >/dev/null && ok "health reports vpsDlShare=0.5" || bad "health share wrong"
echo "$H2" | jq -e '.pool.activeCount >= 1 and .pool.poolMax == 3' >/dev/null && ok "pool sane (active=$(echo "$H2"|jq -r .pool.activeCount)/3)" || bad "pool state wrong"

echo ""
echo "=== T3: hybrid probe client (8/4 threads, UL split 0.15) vs share=0.5 ==="
cat > /tmp/e2e14-servers.json <<EOF
[{"id": 99999, "url": "http://127.0.0.1:$GB/speedtest/upload.php", "lat": "-7.25", "lon": "112.75", "name": "SandboxVPS", "country": "Indonesia", "cc": "ID", "sponsor": "E2E", "host": "127.0.0.1:$GB"}]
EOF
T3_OUT=$(cd "$REPO_ROOT" && timeout 240 env \
  HYBRID_GATEWAY_BASE="http://127.0.0.1:$GB" \
  HYBRID_FRONT_BASE="http://127.0.0.1:$GB" \
  HYBRID_WORKER_BASE="http://127.0.0.1:$W1" \
  HYBRID_SERVER_LIST_FILE=/tmp/e2e14-servers.json \
  HYBRID_DL_THREADS=8 HYBRID_UL_THREADS=4 \
  HYBRID_VPS_UL_SHARE=0.15 \
  HYBRID_SUBMIT_RESULTS=1 \
  python3 hybrid/probe-client/speedtest-cli-hybrid.py --json --server 99999 2>/tmp/e2e14-t3.stderr); T3_RC=$?
if [ "$T3_RC" = 0 ]; then
  T3_JSON=$(echo "$T3_OUT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(f\"down={d['download']/1e6:.1f}Mbps up={d['upload']/1e6:.1f}Mbps ping={d['ping']:.0f}ms server={d['server']['id']}\")")
  ok "hybrid client exit 0: $T3_JSON"
else
  bad "hybrid client exit $T3_RC"; head -8 /tmp/e2e14-t3.stderr
fi
grep -q "hybrid-result" /tmp/e2e14-t3.stderr && ok "result receipt from /api/results" || bad "no result submission"
H3=$(health "$GB")
echo "$H3" | jq -e '.front.counters.tokensMinted >= 1' >/dev/null && ok "offload tokens minted ($(echo "$H3"|jq -r .front.counters.tokensMinted))" || bad "no token mints"
LINES=$(wc -l < /tmp/e2e14-results.jsonl 2>/dev/null || echo 0)
[ "${LINES:-0}" -ge 1 ] && ok "results.jsonl has $LINES record(s) — full hybrid loop closed" || bad "results file empty"
grep -q "session_minted" /tmp/e2e14-g$GB.log && ok "session token minted (upload split authorized)" || bad "no session mint"

echo ""
echo "== RESULT: $PASS PASS / $FAIL FAIL =="
[ "$FAIL" = 0 ] && exit 0 || exit 1
