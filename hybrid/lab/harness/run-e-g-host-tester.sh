#!/usr/bin/env bash
# run-e-g-host-tester.sh — E-G: the Speedtest Host Tester (the instrument
# replicating speedtest.net/host-tester checks) against the hybrid Worker
# through a TLS terminator (the production edge shape).
#
# Usage: bash run-e-g-host-tester.sh [tester-output-dir]
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${1:-$HERE/../evidence/e-g-host-tester-vs-worker}"
WRANGLER="${WRANGLER:-/home/z/my-project/tools/wrangler-env/node_modules/.bin/wrangler}"
TESTER="/home/z/my-project/host-tester/z.ai/cli/speedtest-host-tester.mjs"
mkdir -p "$OUT"

cleanup() {
  [ -n "${TLS_PID:-}" ] && kill "$TLS_PID" 2>/dev/null
  pkill -f "wrangler dev" 2>/dev/null
  pkill -f workerd 2>/dev/null
}
trap cleanup EXIT
cleanup
sleep 1

echo "=== 1. hybrid worker (workerd) :8790 ==="
cd "$HERE/../../worker"
WRANGLER_SEND_METRICS=false CI=true nohup "$WRANGLER" dev --port 8790 --ip 127.0.0.1 > "$OUT/worker-console.log" 2>&1 &
for i in $(seq 1 45); do sleep 1; curl -s -m 3 http://127.0.0.1:8790/__meta >/dev/null 2>&1 && break; done
curl -s -m 3 http://127.0.0.1:8790/__meta | head -4

echo ""
echo "=== 2. edge-front :8793 -> :8790 (single-port TLS/plain-HTTP multiplexing, daemon-style; the edge terminates TLS in production) ==="
cd "$HERE"
nohup node edge-front.mjs 8793 8790 > "$OUT/tls-terminator.log" 2>&1 &
TLS_PID=$!
sleep 1
curl -s -m 3 -k https://127.0.0.1:8793/hi | head -2

echo ""
echo "=== 3. Speedtest Host Tester vs the edge Worker (wss via TLS terminator) ==="
node "$TESTER" 127.0.0.1:8793 --download 4 --upload 4 --samples 8 2>&1 | tee "$OUT/host-tester-output.txt"
EXIT=${PIPESTATUS[0]}
echo "" > "$OUT/host-tester-exit.txt"
echo "exit=$EXIT" | tee -a "$OUT/host-tester-exit.txt"

echo ""
echo "=== 4. same run, JSON evidence ==="
node "$TESTER" 127.0.0.1:8793 --download 3 --upload 3 --samples 5 --json > "$OUT/host-tester.json" 2>"$OUT/host-tester-json.stderr" || true
python3 - "$OUT/host-tester.json" <<'EOF'
import json, sys
try:
    d = json.load(open(sys.argv[1]))
    checks = d.get('checks', [])
    passed = sum(1 for c in checks if c.get('status') == 'pass')
    print(f"checks: {passed}/{len(checks)} pass")
    for c in checks:
        mark = {'pass': '✓', 'fail': '✗', 'warn': '⚠'}.get(c.get('status'), '?')
        print(f"  {mark} {c.get('name','?')}: {str(c.get('detail',''))[:90]}")
    print("verdict:", d.get('verdict') or d.get('summary', {}).get('verdict'))
except Exception as e:
    print("json parse:", e)
EOF
echo "evidence → $OUT"
exit $EXIT
