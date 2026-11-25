#!/usr/bin/env bash
# deploy-pool.sh — deploy the smart worker pool (1 primary + N-1 siblings).
#
# USAGE
#   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... \
#   HYBRID_SHARED_SECRET=<same secret as the VPS gateway> \
#   POOL_SIZE=100 bash deploy-pool.sh
#
# WHAT IT DOES
#   - Worker 1: the canonical `speedtest-hybrid-worker` (same name as the
#     existing production script — a redeploy KEEPS its existing secrets;
#     the secret is re-set anyway for idempotency).
#   - Workers 2..N: `speedtest-hybrid-worker-2` … `speedtest-hybrid-worker-N`
#     (Workers Free allows up to 100 scripts per account — verified
#     2026-11-25, developers.cloudflare.com/workers/platform/limits).
#   - Every deployment gets WORKER_ID / WORKER_POOL_MAX vars (pool identity +
#     autonomous deflection routing) plus the shared HMAC secret.
#   - Optional VERIFY=1 checks each worker's /__meta afterwards.
#
# SAFETY
#   - The daily 100k request quota is ACCOUNT-WIDE: an idle pool worker costs
#     ZERO invocations. The gateway's autoscaler only routes traffic to
#     workers it has canary-verified.
#   - NEVER commit the secret; pass it via environment only.
set -euo pipefail
cd "$(dirname "$0")"

POOL_SIZE="${POOL_SIZE:-100}"
VERIFY="${VERIFY:-1}"
WORKERS_DEV_SUFFIX="workers.dev"

if [[ -z "${CLOUDFLARE_API_TOKEN:-}" || -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]]; then
  echo "ERROR: set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID (env)." >&2
  exit 2
fi
if [[ -z "${HYBRID_SHARED_SECRET:-}" ]]; then
  echo "ERROR: set HYBRID_SHARED_SECRET (must equal the VPS gateway's secret)." >&2
  exit 2
fi
if (( POOL_SIZE < 1 || POOL_SIZE > 100 )); then
  echo "ERROR: POOL_SIZE must be in [1,100] (Workers Free script cap = 100)." >&2
  exit 2
fi

secret_json() { printf '{"HYBRID_SHARED_SECRET":"%s"}\n' "$HYBRID_SHARED_SECRET"; }

# ---- per-worker config (worker 1 keeps the canonical unsuffixed name) ----
make_config() { # make_config <id>
  local id="$1"
  local name
  if (( id == 1 )); then name="speedtest-hybrid-worker"; else name="speedtest-hybrid-worker-${id}"; fi
  cat <<EOF
name = "${name}"
main = "src/index.ts"
compatibility_date = "2026-10-01"
workers_dev = true
preview_urls = false

[observability]
enabled = false

[vars]
VERSION_STRING = "2.11 (2.11.5) 2026-06-04.1737.7d0993d"
ALLOWED_DOMAINS = "*"
STRICT_HOST_VALIDATION = "false"
WS_FRAME_LIMIT_BYTES = "5242880"
MAX_DOWNLOAD_BYTES = "26214400"
MAX_UPLOAD_BYTES = "26214400"
LEGACY_HTTP_ENABLED = "false"
WORKER_ID = "${id}"
WORKER_POOL_MAX = "${POOL_SIZE}"
WORKER_DEFLECT_CONCURRENCY = "6"
EOF
}

deploy_one() { # deploy_one <id>
  local id="$1"
  local name
  if (( id == 1 )); then name="speedtest-hybrid-worker"; else name="speedtest-hybrid-worker-${id}"; fi
  local cfg="/tmp/wrangler-pool-${id}.toml"
  make_config "$id" > "$cfg"
  WRANGLER_SEND_METRICS=false CI=true npx wrangler deploy -c "$cfg" --dry-run >/dev/null 2>&1 || true
  WRANGLER_SEND_METRICS=false CI=true npx wrangler deploy -c "$cfg" >/dev/null
  # Idempotent secret set (re-deploys keep secrets; this also covers fresh scripts).
  secret_json | WRANGLER_SEND_METRICS=false CI=true npx wrangler secret bulk --name "$name" >/dev/null 2>&1 \
    || secret_json | WRANGLER_SEND_METRICS=false CI=true npx wrangler secret:bulk --name "$name" >/dev/null
  rm -f "$cfg"
  echo "  deployed ${name} (WORKER_ID=${id}, POOL=${POOL_SIZE})"
}

echo "Deploying worker pool: 1..${POOL_SIZE}"
START_TS=$(date +%s)
for (( id=1; id<=POOL_SIZE; id++ )); do
  deploy_one "$id"
done
END_TS=$(date +%s)
echo "Pool deployed in $((END_TS - START_TS))s."

if [[ "$VERIFY" == "1" ]]; then
  echo ""
  echo "Verifying /__meta per worker (1 invocation each)…"
  FAIL=0
  for (( id=1; id<=POOL_SIZE; id++ )); do
    if (( id == 1 )); then name="speedtest-hybrid-worker"; else name="speedtest-hybrid-worker-${id}"; fi
    URL="https://${name}.lumajangnetworks.${WORKERS_DEV_SUFFIX}/__meta"
    BODY=$(curl -s -m 15 "$URL" || true)
    WID=$(echo "$BODY" | jq -r '.worker.id // "err"' 2>/dev/null || echo err)
    if [[ "$WID" == "$id" ]]; then
      echo "  ✓ ${name} (id=${WID})"
    else
      echo "  ✗ ${name}: expected id=${id}, got ${WID}" >&2
      FAIL=1
    fi
  done
  if (( FAIL )); then echo "Verification had failures — check the URLs above." >&2; exit 1; fi
fi

echo ""
echo "NEXT (VPS side — needs shell access):"
echo "  1. Update /opt/speedtest-hybrid (pull master), keep gateway.env,"
echo "     add: HYBRID_WORKER_POOL_MAX=${POOL_SIZE} HYBRID_WORKER_ACTIVE_MIN=2"
echo "  2. systemctl restart speedtest-hybrid-gateway"
echo "  3. Watch: journalctl -u speedtest-hybrid-gateway -f | grep pool_"
echo "     and: curl -s https://speedtest.lumajangnetworks.my.id:8790/api/pool"
