#!/usr/bin/env bash
# run-tests.sh — start local workerd instances and run the conformance battery.
# The open-mode and secret-mode instances run SEQUENTIALLY (two simultaneous
# `wrangler dev` processes conflict on workerd's internal socket).
set -uo pipefail
cd "$(dirname "$0")/.."

WRANGLER="${WRANGLER:-/home/z/my-project/tools/wrangler-env/node_modules/.bin/wrangler}"
PORT_OPEN="${PORT_OPEN:-8790}"
PORT_SECRET="${PORT_SECRET:-8791}"

cleanup() {
  pkill -f "wrangler dev" 2>/dev/null || true
  pkill -f workerd 2>/dev/null || true
}
trap cleanup EXIT
cleanup
sleep 2

wait_ready() { # wait_ready <port>
  for i in $(seq 1 45); do
    sleep 1
    curl -s -m 3 "http://127.0.0.1:$1/__meta" >/dev/null 2>&1 && return 0
  done
  return 1
}

FAIL=0

echo "=== phase 1: open mode (no token enforcement) :$PORT_OPEN ==="
WRANGLER_SEND_METRICS=false CI=true nohup "$WRANGLER" dev --port "$PORT_OPEN" --ip 127.0.0.1 > /tmp/hybrid-worker-open.log 2>&1 &
wait_ready "$PORT_OPEN" || { echo "open-mode worker failed to start"; tail -20 /tmp/hybrid-worker-open.log; exit 1; }
node test/conformance.mjs "http://127.0.0.1:$PORT_OPEN" || FAIL=1

cleanup
sleep 2

echo ""
echo "=== phase 2: token-secret mode :$PORT_SECRET ==="
WRANGLER_SEND_METRICS=false CI=true nohup "$WRANGLER" dev --port "$PORT_SECRET" --ip 127.0.0.1 \
  --var HYBRID_SHARED_SECRET:testsecret123 > /tmp/hybrid-worker-secret.log 2>&1 &
wait_ready "$PORT_SECRET" || { echo "secret-mode worker failed to start"; tail -20 /tmp/hybrid-worker-secret.log; exit 1; }
node test/token-tests.mjs "http://127.0.0.1:$PORT_SECRET" || FAIL=1

exit $FAIL
