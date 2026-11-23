#!/usr/bin/env bash
# run-tests.sh — start local workerd instances and run the conformance battery.
# G-10: wrangler binary, ports, secret and caps are parameterized via env.
#
#   WRANGLER       default "npx wrangler" (was a hardcoded path)
#   PORT_OPEN      default 8790  (open mode + legacy ON → conformance)
#   PORT_SECRET    default 8791  (secret mode + legacy OFF → token + hardening)
#   TEST_SECRET    default testsecret123
#   MAX_DL / MAX_UL  default 26214400 (mirrors production [vars] caps)
#
# The open-mode and secret-mode instances run SEQUENTIALLY (two simultaneous
# `wrangler dev` processes conflict on workerd's internal socket).
set -uo pipefail
cd "$(dirname "$0")/.."

WRANGLER="${WRANGLER:-npx wrangler}"
PORT_OPEN="${PORT_OPEN:-8790}"
PORT_SECRET="${PORT_SECRET:-8791}"
TEST_SECRET="${TEST_SECRET:-testsecret123}"
MAX_DL="${MAX_DL:-26214400}"
MAX_UL="${MAX_UL:-26214400}"

cleanup() {
  pkill -f "wrangler dev" 2>/dev/null || true
  pkill -f workerd 2>/dev/null || true
}
trap cleanup EXIT
cleanup
sleep 2

wait_ready() { # wait_ready <port>
  for i in $(seq 1 90); do
    sleep 1
    curl -s -m 3 "http://127.0.0.1:$1/__meta" >/dev/null 2>&1 && return 0
  done
  return 1
}

FAIL=0

echo "=== phase 1: open mode + legacy surface (conformance) :$PORT_OPEN ==="
WRANGLER_SEND_METRICS=false CI=true nohup $WRANGLER dev --port "$PORT_OPEN" --ip 127.0.0.1 \
  --var LEGACY_HTTP_ENABLED:true \
  --var MAX_DOWNLOAD_BYTES:33554432 --var MAX_UPLOAD_BYTES:33554432 \
  > /tmp/hybrid-worker-open.log 2>&1 &
wait_ready "$PORT_OPEN" || { echo "open-mode worker failed to start"; tail -20 /tmp/hybrid-worker-open.log; exit 1; }
node test/conformance.mjs "http://127.0.0.1:$PORT_OPEN" || FAIL=1

cleanup
sleep 2

echo ""
echo "=== phase 2: token-secret mode + production posture (legacy OFF) :$PORT_SECRET ==="
# Small caps (1 MiB) locally so the over-cap REAL-BODY 413 paths are cheap to
# exercise; the production caps are validated on the real edge (Fase C).
PHASE2_DL="${PHASE2_MAX_DL:-1048576}"
PHASE2_UL="${PHASE2_MAX_UL:-1048576}"
WRANGLER_SEND_METRICS=false CI=true nohup $WRANGLER dev --port "$PORT_SECRET" --ip 127.0.0.1 \
  --var HYBRID_SHARED_SECRET:"$TEST_SECRET" \
  --var MAX_DOWNLOAD_BYTES:"$PHASE2_DL" --var MAX_UPLOAD_BYTES:"$PHASE2_UL" \
  > /tmp/hybrid-worker-secret.log 2>&1 &
wait_ready "$PORT_SECRET" || { echo "secret-mode worker failed to start"; tail -20 /tmp/hybrid-worker-secret.log; exit 1; }
TOKEN_TEST_SECRET="$TEST_SECRET" node test/token-tests.mjs "http://127.0.0.1:$PORT_SECRET" || FAIL=1
TOKEN_TEST_SECRET="$TEST_SECRET" TEST_MAX_DL="$PHASE2_DL" TEST_MAX_UL="$PHASE2_UL" \
  node test/free-hardening-tests.mjs "http://127.0.0.1:$PORT_SECRET" || FAIL=1

exit $FAIL
