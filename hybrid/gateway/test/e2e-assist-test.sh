#!/bin/bash
# e2e-assist-test.sh — end-to-end proof of the VPS ASSIST lane + the pool
# candidate-scan fix (sesi 9: "Cloudflare membantu beban, bukan menggantikan").
#
# Topology: 4 fake Node workers — worker 2 is CANARY-BROKEN from the start —
# plus the gateway with the assist lane enabled.
#
#   Phase A: pool growth SKIPS the broken worker 2 → active set = {1,3}
#            (v1.2 bug: growth stopped dead at worker 2 forever)
#   Phase B: front download: budget → LOCAL 200 lane (X-Hybrid-Lane: vps,
#            byte-exact Content-Length, image/jpeg)
#   Phase C: budget exhausted → 302 → pool worker __down (edge overflow)
#   Phase D: mint rate-limited (cache off, MPM=2) + assist on → forced-local
#            200 instead of 429 (measurement never breaks)
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/.."

SECRET="assist-secret-9"
GPORT=18995
G2PORT=18994
W1=18996; W2=18997; W3=18998; W4=18999
SCALE_RATE=6
IDLE_SHRINK_MS=600000     # keep the grown set stable during the test
FW_PIDS=""; GW_PID=""; GW2_PID=""

cleanup() {
  [ -n "${GW_PID:-}" ] && kill "$GW_PID" 2>/dev/null
  [ -n "${GW2_PID:-}" ] && kill "$GW2_PID" 2>/dev/null
  [ -n "${FW_PIDS:-}" ] && kill $FW_PIDS 2>/dev/null
}
trap cleanup EXIT
cleanup
sleep 1

start_fake() { # start_fake <port> <id> [broken]
  node test/fake-worker.mjs "$1" "$2" "${3:-}" > /tmp/e2e-assist-f$1.log 2>&1 &
  FW_PIDS="$FW_PIDS $!"
}

start_gateway() { # start_gateway <port> <extra-env...>
  local port="$1"; shift
  env "$@" \
    HYBRID_GATEWAY_PORT=$port \
    HYBRID_GATEWAY_BIND=127.0.0.1 \
    HYBRID_SHARED_SECRET="$SECRET" \
    HYBRID_FRONT_ENABLED=true \
    HYBRID_WORKER_BASE="http://127.0.0.1:$W1" \
    HYBRID_WORKER_URLS="http://127.0.0.1:$W1,http://127.0.0.1:$W2,http://127.0.0.1:$W3,http://127.0.0.1:$W4" \
    HYBRID_WORKER_POOL_MAX=4 \
    HYBRID_WORKER_ACTIVE_MIN=1 \
    HYBRID_WORKER_ACTIVE_MAX=4 \
    HYBRID_WORKER_SCALE_RATE=$SCALE_RATE \
    HYBRID_WORKER_SHRINK_RATE=2 \
    HYBRID_WORKER_IDLE_SHRINK_MS=$IDLE_SHRINK_MS \
    node src/gateway.mjs > /tmp/e2e-assist-g$port.log 2>&1 &
}

wait_gateway() {
  local port="$1"
  local log="/tmp/e2e-assist-g${port}.log"
  for i in $(seq 1 40); do
    sleep 0.5
    grep -q gateway_started "$log" && return 0
  done
  echo "gateway :$port failed to start"; cat "$log"; return 1
}

echo "=== 4 fake workers: 1 ok, 2 CANARY-BROKEN, 3 ok, 4 ok ==="
start_fake "$W1" 1
start_fake "$W2" 2 broken
start_fake "$W3" 3
start_fake "$W4" 4
sleep 1
for p in $W1 $W2 $W3 $W4; do
  curl -s -m 3 "http://127.0.0.1:$p/__meta" >/dev/null && echo "  fake worker :$p up" || { echo "  fake worker :$p FAILED"; exit 1; }
done

echo "=== gateway A (:$GPORT, assist 1.5 Mbps / burst 1.5 s ≈ 281,250 B — exactly ONE 245,388 B local serve) ==="
start_gateway "$GPORT" HYBRID_VPS_DL_BUDGET_MBPS=1.5 HYBRID_VPS_DL_BURST_S=1.5
GW_PID=$!
wait_gateway "$GPORT" || exit 1

echo "=== gateway B (:$G2PORT, cache OFF + MPM=2 → forced-local after 2 mints) ==="
start_gateway "$G2PORT" HYBRID_VPS_DL_BUDGET_MBPS=1.5 HYBRID_VPS_DL_BURST_S=1.5 HYBRID_FRONT_TOKEN_CACHE_MS=0 HYBRID_FRONT_RATE_LIMIT_MPM=2
GW2_PID=$!
wait_gateway "$G2PORT" || exit 1

pool_state() {
  curl -s -m 5 "http://127.0.0.1:$GPORT/api/pool" | jq -c '{active: .activeCount, ids: [.workers[] | select(.active) | .id]}'
}

echo ""
echo "=== phase A: burst 30 mints → target=4; canary(2) fails → growth must SKIP 2 → active={1,3} ==="
CURL_PIDS=""
for i in $(seq 1 30); do
  curl -s -m 10 -X POST "http://127.0.0.1:$GPORT/api/sessions" > /dev/null &
  CURL_PIDS="$CURL_PIDS $!"
  sleep 0.05
done
for p in $CURL_PIDS; do wait "$p" 2>/dev/null; done
sleep 14  # ≥2 autoscaler ticks: tick1 canary(2) fails→backoff; tick2 skips 2, canaries 3
STATE_A=$(pool_state)
echo "  state: $STATE_A (expect active=2, ids=[1,3])"
ACTIVE_A=$(echo "$STATE_A" | jq -r .active)
IDS_A=$(echo "$STATE_A" | jq -c .ids)

echo ""
echo "=== phase B: download 1 → LOCAL lane (VPS assist) ==="
B1=$(curl -s -m 10 -D /tmp/e2e-assist-h1 -o /tmp/e2e-assist-b1 "http://127.0.0.1:$GPORT/speedtest/random350x350.jpg" -w "%{http_code} %{size_download}")
LANE1=$(grep -i '^x-hybrid-lane:' /tmp/e2e-assist-h1 | tr -d '\r' | awk '{print $2}')
echo "  request 1: $B1 lane=$LANE1 (expect: 200 245388 lane=vps)"

echo ""
echo "=== phase C: budget drained → 302 → edge (fake worker __down) ==="
C1=$(curl -s -m 10 -o /dev/null -w "%{http_code} %{redirect_url}" "http://127.0.0.1:$GPORT/speedtest/random350x350.jpg")
echo "  request 2: $C1"
echo "  (expect: 302 → http://127.0.0.1:1899[68]/__down?bytes=245388&token=v1~...)"

echo ""
echo "=== phase D: gateway B — L → 302 → 302 → forced-L → forced-L (no 429) ==="
SEQ=""
for i in 1 2 3 4 5; do
  R=$(curl -s -m 10 -D /tmp/e2e-assist-hd -o /dev/null "http://127.0.0.1:$G2PORT/speedtest/random350x350.jpg" -w "%{http_code}")
  L=$(grep -i '^x-hybrid-lane:' /tmp/e2e-assist-hd | tr -d '\r' | awk '{print $2}')
  SEQ="$SEQ $R:${L:--}"
done
echo "  sequence:$SEQ"
echo "  (expect: 200:vps 302:- 302:- 200:vps 200:vps)"

echo ""
R_A=$([ "$ACTIVE_A" = "2" ] && [ "$IDS_A" = "[1,3]" ] && echo PASS || echo FAIL)
R_B=$(echo "$B1" | grep -q "^200 245388$" && [ "$LANE1" = "vps" ] && echo PASS || echo FAIL)
R_C=$(echo "$C1" | grep -q "^302 http://127.0.0.1:1899.*/__down?bytes=245388&token=v1~" && echo PASS || echo FAIL)
R_D=$(echo "$SEQ" | grep -q "200:vps 302:- 302:- 200:vps 200:vps" && echo PASS || echo FAIL)
echo "== RESULT: pool-skip-broken(growth): $R_A | local-lane: $R_B | edge-overflow-302: $R_C | forced-local-no-429: $R_D =="
echo "--- gateway pool events ---"
grep -E "pool_" /tmp/e2e-assist-g$GPORT.log | tail -8
echo "--- gateway front events ---"
grep -E "front_download" /tmp/e2e-assist-g$GPORT.log | tail -6

[ "$R_A" = "PASS" ] && [ "$R_B" = "PASS" ] && [ "$R_C" = "PASS" ] && [ "$R_D" = "PASS" ] && exit 0 || exit 1
