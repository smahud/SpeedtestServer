#!/bin/bash
# e2e-pool-test.sh — end-to-end autoscale proof of the smart worker pool.
#
# Runs 3 lightweight Node fake-workers (the minimal surface the gateway's
# pool manager consumes: canary /__down?bytes=0, /__down streams, /__meta
# identity) + the NEW gateway with HYBRID_WORKER_POOL_URLS pointing at them,
# then drives token load and watches the autoscaler grow the active set
# (canary-gated) — and shrink it back after the idle window.
#
# (Two simultaneous `wrangler dev` instances conflict on workerd's internal
# socket — verified, and the reason run-tests.sh runs phases sequentially —
# so real-worker behavior is covered by test/pool-tests.mjs against ONE
# instance; this E2E proves the GATEWAY-side autoscaler.)
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/.."

SECRET="pooltest-secret-42"
GPORT=18990
W1=18991
W2=18992
W3=18993
SCALE_RATE=6        # tokens/min per active worker that justifies one more
IDLE_SHRINK_MS=6000 # short idle window for the test
FW_PIDS=""
GW_PID=""

cleanup() {
  [ -n "${GW_PID:-}" ] && kill "$GW_PID" 2>/dev/null
  [ -n "${FW_PIDS:-}" ] && kill $FW_PIDS 2>/dev/null
}
trap cleanup EXIT
cleanup
sleep 1

start_fake() { # start_fake <port> <id> [broken]
  node test/fake-worker.mjs "$1" "$2" "${3:-}" > /tmp/e2e-fake-$1.log 2>&1 &
  FW_PIDS="$FW_PIDS $!"
}

echo "=== starting 3 fake workers (ids 1,2,3 — 3 is CANARY-BROKEN) ==="
start_fake "$W1" 1
start_fake "$W2" 2
start_fake "$W3" 3 broken
sleep 1
for p in $W1 $W2 $W3; do
  curl -s -m 3 "http://127.0.0.1:$p/__meta" | grep -q "\"id\":$([ "$p" = "$W1" ] && echo 1 || ([ "$p" = "$W2" ] && echo 2 || echo 3))" && echo "  fake worker :$p ready" || { echo "  fake worker :$p FAILED"; cat /tmp/e2e-fake-$p.log; exit 1; }
done

echo "=== starting the NEW gateway (pool of 3, autoscaler tuned for the test) ==="
HYBRID_GATEWAY_PORT=$GPORT \
HYBRID_GATEWAY_BIND=127.0.0.1 \
HYBRID_SHARED_SECRET="$SECRET" \
HYBRID_FRONT_ENABLED=false \
HYBRID_WORKER_BASE="http://127.0.0.1:$W1" \
HYBRID_WORKER_URLS="http://127.0.0.1:$W1,http://127.0.0.1:$W2,http://127.0.0.1:$W3" \
HYBRID_WORKER_POOL_MAX=3 \
HYBRID_WORKER_ACTIVE_MIN=1 \
HYBRID_WORKER_ACTIVE_MAX=3 \
HYBRID_WORKER_SCALE_RATE=$SCALE_RATE \
HYBRID_WORKER_SHRINK_RATE=2 \
HYBRID_WORKER_IDLE_SHRINK_MS=$IDLE_SHRINK_MS \
node src/gateway.mjs > /tmp/e2e-gateway.log 2>&1 &
GW_PID=$!
for i in $(seq 1 40); do
  sleep 0.5
  grep -q gateway_started /tmp/e2e-gateway.log && break
done
grep -q gateway_started /tmp/e2e-gateway.log || { echo "gateway failed"; cat /tmp/e2e-gateway.log; exit 1; }
echo "  gateway :$GPORT ready (pool max 3, scale rate ${SCALE_RATE}/min per worker)"

pool_state() {
  curl -s -m 5 "http://127.0.0.1:$GPORT/api/pool" | jq -c '{active: .activeCount, rate: .mintRatePerMin, workers: [.workers[] | select(.active) | .id]}'
}

echo ""
echo "=== phase A: idle — expect activeCount=1 (worker 1 only) ==="
sleep 7
echo "  state: $(pool_state)"

echo ""
echo "=== phase B: burst 40 mints (≈40/min) → target=3, but worker 3 canary FAILS → expect active=2 ==="
CURL_PIDS=""
for i in $(seq 1 40); do
  curl -s -m 10 -X POST "http://127.0.0.1:$GPORT/api/sessions" > /dev/null &
  CURL_PIDS="$CURL_PIDS $!"
  sleep 0.08
done
for p in $CURL_PIDS; do wait "$p" 2>/dev/null; done
sleep 14 # ≥2 autoscaler ticks (5 s each) + canaries
STATE_B=$(pool_state)
echo "  state: $STATE_B"
ACTIVE_B=$(echo "$STATE_B" | jq -r .active)

echo ""
echo "=== phase C: idle wait until the 60 s mint window clears → shrink back to 1 ==="
sleep 75
STATE_C=$(pool_state)
echo "  state: $STATE_C"
ACTIVE_C=$(echo "$STATE_C" | jq -r .active)

echo ""
echo "=== phase D: minted sessions actually WORK (token + assigned worker download) ==="
S=$(curl -s -m 10 -X POST "http://127.0.0.1:$GPORT/api/sessions")
T=$(echo "$S" | jq -r .token)
WURL=$(echo "$S" | jq -r .worker.url)
BYTES=$(curl -s -m 30 -o /tmp/e2e-down.bin -w "%{http_code} %{size_download}" "$WURL/__down?bytes=1048576&token=$T")
echo "  assigned worker: $WURL → __down 1 MiB: $BYTES"
OK_D=$([ "$BYTES" = "200 1048576" ] && echo 1 || echo 0)

echo ""
R1=$(echo "$ACTIVE_B" | grep -qE "^2$" && echo PASS || echo FAIL)
R2=$(echo "$ACTIVE_C" | grep -qE "^1$" && echo PASS || echo FAIL)
R3=$([ "$OK_D" = "1" ] && echo PASS || echo FAIL)
echo "== RESULT: scale-up-to-2 (broken 3rd NOT activated): $R1 | shrink-back-to-1: $R2 | session-download: $R3 =="
echo "--- gateway pool events ---"
grep -E "pool_" /tmp/e2e-gateway.log | tail -10

[ "$R1" = "PASS" ] && [ "$R2" = "PASS" ] && [ "$R3" = "PASS" ] && exit 0 || exit 1
