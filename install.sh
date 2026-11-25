#!/usr/bin/env bash
# install.sh — SpeedtestServer automated installer (MASTER PROMPT v6.0 §13
# + hybrid full-stack v1.4).
#
# Deploys the OPEN-SOURCE TYPESCRIPT SpeedtestServer (reverse-engineered/
# typescript) — never the proprietary OoklaServer binary.
#
# Primary target: Debian 13 (trixie) with systemd.
#
# What it does (system install, requires root):
#   1. Checks OS + dependencies (node >= 18, npm, rsync).
#   2. Installs Node deps reproducibly (npm ci) and builds TypeScript.
#   3. Validates the configuration and TLS material plan (--validate-config).
#   4. Installs to /opt/speedtestserver (dist + runtime node_modules + docs).
#   5. Creates a dedicated non-root service user (speedtestserver).
#   6. Installs /etc/speedtestserver/OoklaServer.properties (preserved on
#      upgrade) and a hardened systemd unit.
#   7. Verifies: unit syntax (systemd-analyze), listener + protocol probe.
#   8. HYBRID (default when .env enables it — see .env.example and
#      docs/CLOUDFLARE_CREDENTIALS.md):
#      a. installs the hybrid gateway to /opt/speedtest-hybrid (zero-dep
#         Node sources) + speedtest-hybrid user + hardened systemd unit
#         (speedtest-hybrid-gateway.service) + /etc/speedtest-hybrid/
#         gateway.env generated FROM the repository .env;
#      b. deploys the Cloudflare worker POOL (1..N workers, N =
#         CF_WORKER_DEPLOY_COUNT in .env) with wrangler using the .env
#         credentials (CLOUDFLARE_API_TOKEN or CLOUDFLARE_EMAIL +
#         CLOUDFLARE_API_KEY) — INCLUDING the shared secret on every
#         worker — then verifies each /__meta;
#      c. starts + health-checks the gateway (its /api/health reports the
#         live pool state).
#   9. Optionally starts the services (--start).
#
# Options:
#   --help              this text
#   --dry-run           validate prerequisites + print the plan; NO changes
#   --staging-dir DIR   full install into DIR (for tests/portable installs):
#                       no system user, no systemctl; unit file written under
#                       DIR/etc/systemd/system, config under DIR/etc/...
#   --start             enable + start the services after install
#   --config FILE       use FILE as the OoklaServer.properties source
#                       (default: shipped template; existing installed
#                       configuration is NEVER overwritten)
#   --prefix DIR        install prefix (default /opt/speedtestserver)
#   --service-user N    systemd service user (default speedtestserver)
#   --env-file FILE     install-time configuration for the FULL stack
#                       (default: .env next to this script). Drives the
#                       hybrid gateway env, the Cloudflare credentials and
#                       the worker pool deploy count. See .env.example and
#                       docs/CLOUDFLARE_CREDENTIALS.md (every variable, and
#                       every Cloudflare permission scope, is documented
#                       there in detail).
#   --no-hybrid         skip the hybrid gateway install (daemon only)
#   --no-workers        skip the Cloudflare worker deployment (gateway only;
#                       its forced-local assist lane keeps measurements alive)
#
# Re-running is safe: builds are rebuilt, files re-synced, existing
# configuration/certificates are preserved. The installer never changes
# firewall rules, DNS, unrelated services, or certificates. The ONLY file
# it may create next to the repo is the auto-generated HYBRID_SHARED_SECRET
# appended to the .env file (never committed — .env is gitignored).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TS_DIR="$REPO_ROOT/reverse-engineered/typescript"
PREFIX="/opt/speedtestserver"
SERVICE_USER="speedtestserver"
START=0
DRY_RUN=0
STAGING=""
CONFIG_SRC="$TS_DIR/config/OoklaServer.properties"
STATEDIR="/var/lib/speedtestserver"
CONFIGDIR="/etc/speedtestserver"
ENV_FILE="$REPO_ROOT/.env"
NO_HYBRID=0
NO_WORKERS=0

while [ $# -gt 0 ]; do
  case "$1" in
    --help|-h) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    --dry-run) DRY_RUN=1 ;;
    --start) START=1 ;;
    --staging-dir) STAGING="${2:?--staging-dir needs a value}"; shift ;;
    --prefix) PREFIX="${2:?--prefix needs a value}"; shift ;;
    --service-user) SERVICE_USER="${2:?--service-user needs a value}"; shift ;;
    --config) CONFIG_SRC="${2:?--config needs a value}"; shift ;;
    --env-file) ENV_FILE="${2:?--env-file needs a value}"; shift ;;
    --no-hybrid) NO_HYBRID=1 ;;
    --no-workers) NO_WORKERS=1 ;;
    *) echo "Unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done

if [ -n "$STAGING" ]; then
  # Staged (portable/test) install: everything under one tree, no root needed.
  PREFIX="$STAGING/opt/speedtestserver"
  CONFIGDIR="$STAGING/etc/speedtestserver"
  STATEDIR="$STAGING/var/lib/speedtestserver"
  SYSTEMD_DIR="$STAGING/etc/systemd/system"
  AS_ROOT=0
elif [ "$DRY_RUN" = 1 ]; then
  SYSTEMD_DIR="/etc/systemd/system"
  AS_ROOT=0
else
  SYSTEMD_DIR="/etc/systemd/system"
  AS_ROOT=1
fi

say()  { printf '\033[1;34m[install]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[1;31m[FATAL]\033[0m %s\n' "$*" >&2; exit 1; }

# ------------------------------------------------------------- .env load ---
# The repository .env is the SINGLE source of truth for install-time
# configuration: hybrid on/off, Cloudflare credentials, worker deploy
# count, gateway runtime vars. Parsed as literal KEY=VALUE lines (never
# sourced as shell code — a hostile .env cannot execute anything).
# Format rules: no quoting semantics beyond stripping symmetric outer
# quotes, no inline comments after a value, blank/#-prefixed lines ignored.
# Every variable is documented in .env.example and
# docs/CLOUDFLARE_CREDENTIALS.md.
env_load() { # env_load <file>
  local f="$1" line key val
  [ -f "$f" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line#"${line%%[![:space:]]*}"}"   # trim leading whitespace
    case "$line" in ''|'#'*) continue ;; esac
    case "$line" in *=*) ;; *) continue ;; esac
    key="${line%%=*}"
    val="${line#*=}"
    case "$key" in *[!A-Za-z0-9_]*|'') continue ;; esac
    # strip one symmetric pair of outer quotes, if present
    if [ "${#val}" -ge 2 ]; then
      q_first="${val:0:1}"
      q_last="${val: -1}"
      if [ "$q_first" = "$q_last" ] && { [ "$q_first" = '"' ] || [ "$q_first" = "'" ]; }; then
        val="${val:1:${#val}-2}"
      fi
    fi
    export "$key=$val"
  done < "$f"
}

if [ "$NO_HYBRID" = 0 ]; then
  if [ ! -f "$ENV_FILE" ]; then
    if [ -f "$REPO_ROOT/.env.example" ]; then
      warn "no $ENV_FILE found — hybrid install will be SKIPPED."
      warn "copy .env.example → .env, fill the Cloudflare credentials + worker count"
      warn "(every field is explained in .env.example and docs/CLOUDFLARE_CREDENTIALS.md),"
      warn "then re-run install.sh for the full stack. The daemon install below continues."
      NO_HYBRID=1
    else
      fail "--env-file default .env and .env.example both missing"
    fi
  else
    env_load "$ENV_FILE"
    if [ "${HYBRID_ENABLED:-true}" = "false" ]; then
      say "  .env: HYBRID_ENABLED=false — hybrid install SKIPPED (daemon only)"
      NO_HYBRID=1
    else
      say "  .env loaded: $ENV_FILE"
    fi
  fi
fi

# Hybrid phase constants (overridable from .env).
HYBRID_PREFIX="${HYBRID_PREFIX:-/opt/speedtest-hybrid}"
HYBRID_USER="${HYBRID_USER:-speedtest-hybrid}"
HYBRID_ETC="${HYBRID_ETC:-/etc/speedtest-hybrid}"
HYBRID_STATE="${HYBRID_STATE:-/var/lib/speedtest-hybrid}"
CF_WORKER_DEPLOY_COUNT="${CF_WORKER_DEPLOY_COUNT:-0}"

# Sanity: worker count bounds (Cloudflare Workers Free = 100 scripts/account).
if [ "$NO_HYBRID" = 0 ] && [ "$NO_WORKERS" = 0 ] && [ "$CF_WORKER_DEPLOY_COUNT" != "0" ]; then
  case "$CF_WORKER_DEPLOY_COUNT" in
    ''|*[!0-9]*) fail "CF_WORKER_DEPLOY_COUNT must be an integer 0..100 (got '$CF_WORKER_DEPLOY_COUNT')" ;;
  esac
  [ "$CF_WORKER_DEPLOY_COUNT" -ge 1 ] && [ "$CF_WORKER_DEPLOY_COUNT" -le 100 ] \
    || fail "CF_WORKER_DEPLOY_COUNT must be in 1..100 (Workers Free script cap; got $CF_WORKER_DEPLOY_COUNT)"
fi

# ---------------------------------------------------------------- checks ---
say "Checking operating system…"
if [ -r /etc/os-release ]; then
  . /etc/os-release
  say "  OS: ${PRETTY_NAME:-unknown}"
  case "${ID:-}: ${VERSION_CODENAME:-}" in
    debian:*|ubuntu:*) : ;;
    *) warn "Target platform is Debian 13; this OS is '${ID:-?} ${VERSION_ID:-?}'. Continuing (unverified)." ;;
  esac
else
  warn "/etc/os-release missing — cannot verify OS"
fi

say "Checking dependencies…"
command -v node >/dev/null 2>&1 || fail "node not found (install Node.js >= 18 first)"
command -v npm  >/dev/null 2>&1 || fail "npm not found"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || fail "Node >= 18 required (found $(node --version))"
command -v rsync >/dev/null 2>&1 || fail "rsync not found"
[ -f "$TS_DIR/package.json" ] || fail "TypeScript implementation missing at $TS_DIR"
say "  node $(node --version) · npm $(npm --version) · rsync $(rsync --version | head -1 | awk '{print $3}')"

if [ "$AS_ROOT" = 1 ] && [ "$(id -u)" != 0 ]; then
  fail "system install must run as root (use --dry-run or --staging-dir for non-root)"
fi
if [ "$AS_ROOT" = 1 ]; then
  command -v systemctl >/dev/null 2>&1 || fail "systemctl not found (systemd required for system install)"
fi

SYSTEMD_AVAILABLE=0
if [ "$AS_ROOT" = 1 ]; then
  if [ -d /run/systemd/system ]; then SYSTEMD_AVAILABLE=1; else
    warn "systemd is not the running init (no /run/systemd/system) — unit will be installed but NOT started"
  fi
fi

# Hybrid worker toolchain: curl + jq (deploy-pool.sh verify) — auto-install
# on Debian-family when running as root, warn-and-continue otherwise.
if [ "$NO_HYBRID" = 0 ] && [ "$NO_WORKERS" = 0 ] && [ "$CF_WORKER_DEPLOY_COUNT" != "0" ]; then
  MISSING=""
  command -v curl >/dev/null 2>&1 || MISSING="curl"
  command -v jq   >/dev/null 2>&1 || MISSING="$MISSING jq"
  if [ -n "${MISSING// /}" ]; then
    if [ "$AS_ROOT" = 1 ] && command -v apt-get >/dev/null 2>&1; then
      say "Installing missing worker-deploy toolchain:${MISSING} (apt-get)…"
      DEBIAN_FRONTEND=noninteractive apt-get install -y -qq $MISSING >/dev/null 2>&1 \
        || warn "apt-get install failed — install ${MISSING} manually if worker verification errors"
    else
      warn "worker verification needs:${MISSING} — not auto-installed (non-root or no apt-get)"
    fi
  fi
fi

# ------------------------------------------------------------------ plan ---
PLAN_PREFIX="$PREFIX"
PLAN=(
  "build        npm ci + npm run build        in $TS_DIR"
  "validate     node dist/bin/ooklaserver.js --validate-config"
  "install      rsync dist + runtime deps →  $PLAN_PREFIX"
  "user         dedicated non-root user       $SERVICE_USER"
  "config       OoklaServer.properties →     $CONFIGDIR/OoklaServer.properties"
  "state dir    certificates / ACME storage  $STATEDIR (preserved)"
  "systemd      unit file →                   $SYSTEMD_DIR/speedtestserver.service"
  "verify       unit syntax + listener + protocol probe"
)
[ "$START" = 1 ] && PLAN+=("start        systemctl enable --now speedtestserver")

if [ "$NO_HYBRID" = 0 ]; then
  PLAN+=(
    "hybrid gw    zero-dep Node gateway →     $HYBRID_PREFIX/src"
    "hybrid user  dedicated non-root user       $HYBRID_USER"
    "hybrid env   gateway.env generated from    $ENV_FILE → $HYBRID_ETC/gateway.env"
    "hybrid unit  speedtest-hybrid-gateway.service"
  )
  if [ "$NO_WORKERS" = 0 ] && [ "$CF_WORKER_DEPLOY_COUNT" != "0" ]; then
    PLAN+=("cf workers   deploy-pool.sh →           $CF_WORKER_DEPLOY_COUNT workers (+ secrets + /__meta verify)")
  fi
fi

say "Install plan:"
printf '  %s\n' "${PLAN[@]}"

if [ "$DRY_RUN" = 1 ]; then
  say "DRY RUN complete — no changes were made. Validation of config/TLS plan:"
  ( cd "$TS_DIR" && node dist/bin/ooklaserver.js --validate-config --config "$CONFIG_SRC" ) || true
  say "To install: sudo ./install.sh [--start]"
  exit 0
fi

# ----------------------------------------------------------------- build ---
say "Building SpeedtestServer (npm ci + tsc)…"
( cd "$TS_DIR" \
  && npm ci --no-audit --no-fund \
  && npm run build ) || fail "build failed"
[ -f "$TS_DIR/dist/bin/ooklaserver.js" ] || fail "build produced no entrypoint"

# -------------------------------------------------------------- validate ---
say "Validating configuration + TLS plan…"
if ( cd "$TS_DIR" && node dist/bin/ooklaserver.js --validate-config --config "$CONFIG_SRC" ); then
  say "configuration OK"
else
  fail "configuration validation failed (see report above)"
fi

# ---------------------------------------------------------- install tree ---
say "Installing files to $PREFIX…"
mkdir -p "$PREFIX" "$CONFIGDIR" "$STATEDIR/certs"
rsync -a --delete "$TS_DIR/dist/" "$PREFIX/dist/"
rsync -a "$REPO_ROOT/README.md" "$PREFIX/README.md"
[ -f "$REPO_ROOT/LICENSE" ] && rsync -a "$REPO_ROOT/LICENSE" "$PREFIX/LICENSE"
# Runtime dependencies: production node_modules for the installed dist.
# Built in an ISOLATED copy of the manifest (never `npm ci` in the source tree,
# which would strip devDependencies needed for future builds).
PROD_DEPS="$TS_DIR/node_modules_prod"
if [ "${INSTALL_SH_FORCE_DEPS:-0}" = 1 ] || [ ! -d "$PROD_DEPS/ws" ]; then
  say "  preparing production dependencies (npm ci --omit=dev)…"
  rm -rf "$PROD_DEPS" "$TS_DIR/.prod-deps-tmp"
  mkdir -p "$TS_DIR/.prod-deps-tmp"
  cp "$TS_DIR/package.json" "$TS_DIR/package-lock.json" "$TS_DIR/.prod-deps-tmp/"
  ( cd "$TS_DIR/.prod-deps-tmp" && npm ci --omit=dev --no-audit --no-fund ) || fail "dependency install failed"
  mv "$TS_DIR/.prod-deps-tmp/node_modules" "$PROD_DEPS"
  rm -rf "$TS_DIR/.prod-deps-tmp"
fi
rsync -a --delete "$PROD_DEPS/" "$PREFIX/node_modules/"

# ------------------------------------------------------- config + state ----
CONFIG_INSTALLED="$CONFIGDIR/OoklaServer.properties"
if [ -f "$CONFIG_INSTALLED" ]; then
  say "  existing configuration preserved: $CONFIG_INSTALLED"
else
  rsync -a "$CONFIG_SRC" "$CONFIG_INSTALLED"
  say "  configuration installed: $CONFIG_INSTALLED"
fi
# Certificates/ACME state under $STATEDIR are never touched by the installer.

# ----------------------------------------------------------- service user --
if [ "$AS_ROOT" = 1 ]; then
  if getent passwd "$SERVICE_USER" >/dev/null; then
    say "  service user exists: $SERVICE_USER"
  else
    useradd --system --home-dir "$STATEDIR" --shell /usr/sbin/nologin "$SERVICE_USER"
    say "  service user created: $SERVICE_USER (no login shell)"
  fi
  chown -R "$SERVICE_USER:$SERVICE_USER" "$STATEDIR"
else
  say "  (staged install) skipping system user creation"
fi

# ----------------------------------------------------------- systemd unit --
say "Installing systemd unit…"
mkdir -p "$SYSTEMD_DIR"
cat > "$SYSTEMD_DIR/speedtestserver.service" <<EOF
[Unit]
Description=SpeedtestServer (independent OoklaServer-compatible speedtest server)
Documentation=file://$PREFIX/README.md
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$( [ "$AS_ROOT" = 1 ] && echo "$SERVICE_USER" || echo "$SERVICE_USER" )
WorkingDirectory=$STATEDIR
ExecStart=$(command -v node) $PREFIX/dist/bin/ooklaserver.js --config $CONFIG_INSTALLED
Restart=on-failure
RestartSec=2
# Hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$STATEDIR
StateDirectory=$(basename "$STATEDIR")
CapabilityBoundingSet=
AmbientCapabilities=
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF

if command -v systemd-analyze >/dev/null 2>&1; then
  if UNIT_ERR="$(systemd-analyze verify "$SYSTEMD_DIR/speedtestserver.service" 2>&1 | grep -v '^$' | head -5)"; [ -z "$UNIT_ERR" ]; then
    say "  systemd-analyze verify: OK"
  else
    warn "systemd-analyze verify reported: $UNIT_ERR"
  fi
fi

# -------------------------------------------------------------- verify -----
# Direct launch verification of the EXACT ExecStart command (works with or
# without systemd supervision; systemd start itself is only attempted when
# systemd is the running init).
say "Verifying the installed server starts and answers…"
VERIFY_PORT="18080"
VERIFY_LOG="$(mktemp /tmp/sts-install-verify.XXXXXX.log)"
VERIFY_CFG="$(mktemp /tmp/sts-install-verify.XXXXXX.properties)"
sed "s/^OoklaServer.tcpPorts.*/OoklaServer.tcpPorts = $VERIFY_PORT/" "$CONFIG_INSTALLED" > "$VERIFY_CFG"
node "$PREFIX/dist/bin/ooklaserver.js" --config "$VERIFY_CFG" --ports "$VERIFY_PORT" --udp-ports "$VERIFY_PORT" \
  > "$VERIFY_LOG" 2>&1 &
VERIFY_PID=$!
cleanup_verify() { kill "$VERIFY_PID" 2>/dev/null || true; rm -f "$VERIFY_CFG" "$VERIFY_LOG"; }
trap cleanup_verify EXIT
LISTENING=0
for _ in $(seq 1 20); do
  if ss -tln 2>/dev/null | grep -q ":${VERIFY_PORT} "; then LISTENING=1; break; fi
  sleep 0.5
done
[ "$LISTENING" = 1 ] || { cat "$VERIFY_LOG" >&2; fail "installed server did not listen on $VERIFY_PORT"; }
PROBE="$(node -e "
const net = require('net');
const s = net.connect({ host: '127.0.0.1', port: process.argv[1] });
let out = '';
const t = setTimeout(() => { console.error('timeout'); process.exit(1); }, 5000);
s.on('connect', () => s.write('HI\nGETIP\n'));
s.on('data', (d) => { out += d.toString(); if (out.includes('\n')) { clearTimeout(t); console.log(out.split('\n')[0]); s.destroy(); } });
s.on('error', (e) => { clearTimeout(t); console.error(e.message); process.exit(1); });
" "$VERIFY_PORT")"
case "$PROBE" in
  HELLO\ *) say "  protocol probe: $PROBE" ;;
  *) cat "$VERIFY_LOG" >&2; fail "protocol probe failed on installed server" ;;
esac
TLS_LINE="$(grep -o 'TLS material resolved' "$VERIFY_LOG" | head -1 || true)"
[ -n "$TLS_LINE" ] && say "  TLS readiness: $TLS_LINE $(grep -o '"mode":"[^"]*"' "$VERIFY_LOG" | head -1 || true)"
cleanup_verify
trap - EXIT

# ------------------------------------------------------- hybrid gateway ---
# v1.4 full-stack install: the VPS control plane + assist-lane front, driven
# entirely by the repository .env. The daemon above stays 100% standard
# (OoklaServer.properties is NEVER touched by this phase).
if [ "$NO_HYBRID" = 0 ] && [ "$AS_ROOT" = 1 ]; then
  say "Installing hybrid gateway (v1.4 — full-potential assist lane)…"

  # --- shared secret: reuse from .env, or generate + persist back ---------
  if [ -z "${HYBRID_SHARED_SECRET:-}" ]; then
    say "  HYBRID_SHARED_SECRET not set — generating (openssl rand -hex 32)…"
    if command -v openssl >/dev/null 2>&1; then
      HYBRID_SHARED_SECRET="$(openssl rand -hex 32)"
    else
      HYBRID_SHARED_SECRET="$(head -c 48 /dev/urandom | od -An -tx1 | tr -d ' \n' | head -c 64)"
    fi
    [ -n "$HYBRID_SHARED_SECRET" ] || fail "could not generate HYBRID_SHARED_SECRET"
    printf '\n# --- auto-generated by install.sh (%s) ---\nHYBRID_SHARED_SECRET=%s\n' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$HYBRID_SHARED_SECRET" >> "$ENV_FILE"
    say "  secret generated and appended to $ENV_FILE (never committed — .env is gitignored)"
    say "  THE SAME secret is deployed to every Cloudflare worker below."
  fi

  # --- dedicated service user + directories ------------------------------
  if getent passwd "$HYBRID_USER" >/dev/null; then
    say "  service user exists: $HYBRID_USER"
  else
    useradd --system --home-dir "$HYBRID_STATE" --shell /usr/sbin/nologin "$HYBRID_USER"
    say "  service user created: $HYBRID_USER (no login shell)"
  fi
  mkdir -p "$HYBRID_PREFIX/src" "$HYBRID_ETC" "$HYBRID_STATE"
  rsync -a "$REPO_ROOT/hybrid/gateway/src/" "$HYBRID_PREFIX/src/"
  rsync -a "$REPO_ROOT/hybrid/README.md" "$HYBRID_PREFIX/README.md"
  # Worker deploy toolchain (for operator re-runs / pool changes later):
  rsync -a --delete \
    --exclude node_modules --exclude .wrangler \
    "$REPO_ROOT/hybrid/worker/" "$HYBRID_PREFIX/worker/"
  chown -R "$HYBRID_USER:$HYBRID_USER" "$HYBRID_STATE"

  # --- worker base URL derivation (when not set explicitly) --------------
  if [ -z "${HYBRID_WORKER_BASE:-}" ] && [ -n "${CF_WORKERS_SUBDOMAIN:-}" ]; then
    HYBRID_WORKER_BASE="https://${CF_WORKER_NAME:-speedtest-hybrid-worker}.${CF_WORKERS_SUBDOMAIN}.workers.dev"
    say "  HYBRID_WORKER_BASE derived: $HYBRID_WORKER_BASE"
  fi
  # Default runtime pool size = the deploy count from .env.
  if [ -z "${HYBRID_WORKER_POOL_MAX:-}" ] && [ "$CF_WORKER_DEPLOY_COUNT" -ge 1 ] 2>/dev/null; then
    HYBRID_WORKER_POOL_MAX="$CF_WORKER_DEPLOY_COUNT"
  fi

  # --- /etc/speedtest-hybrid/gateway.env — regenerated from .env ----------
  # .env is the source of truth; a previous manual gateway.env is backed up.
  GW_ENV="$HYBRID_ETC/gateway.env"
  [ -f "$GW_ENV" ] && cp -a "$GW_ENV" "$GW_ENV.bak.$(date +%Y%m%d%H%M%S)" \
    && say "  existing gateway.env backed up (gateway.env.bak.<ts>)"
  GW_TMP="$(mktemp)"
  gw_emit() { # gw_emit <KEY> <default>
    local key="$1" v="${!1:-}"
    [ -z "$v" ] && v="${2:-}"
    [ -z "$v" ] && return 0
    printf '%s=%s\n' "$key" "$v" >> "$GW_TMP"
  }
  gw_emit HYBRID_SHARED_SECRET
  gw_emit HYBRID_GATEWAY_PORT 8790
  gw_emit HYBRID_GATEWAY_BIND 0.0.0.0
  gw_emit HYBRID_GATEWAY_TLS_CERT
  gw_emit HYBRID_GATEWAY_TLS_KEY
  gw_emit HYBRID_VPS_PUBLIC_BASE
  gw_emit HYBRID_WORKER_BASE
  gw_emit HYBRID_STS_BASE
  gw_emit HYBRID_TOKEN_TTL_MS
  gw_emit HYBRID_TOKEN_BIND_IP
  gw_emit HYBRID_DISCOVERY_FALLBACK
  gw_emit HYBRID_RESULTS_FILE "$HYBRID_STATE/results.jsonl"
  gw_emit HYBRID_RESULTS_DEDUP_MS
  gw_emit HYBRID_SESSIONS_RATE_LIMIT_MPM
  gw_emit HYBRID_FRONT_ENABLED true
  gw_emit HYBRID_FRONT_RATE_LIMIT_MPM
  gw_emit HYBRID_FRONT_MAX_DOWN_BYTES
  gw_emit HYBRID_FRONT_TOKEN_CACHE_MS
  gw_emit HYBRID_VPS_DL_SHARE 0.15
  gw_emit HYBRID_WORKER_POOL_MAX "${CF_WORKER_DEPLOY_COUNT:-1}"
  if [ "${HYBRID_WORKER_POOL_MAX:-1}" -ge 2 ] 2>/dev/null; then
    gw_emit HYBRID_WORKER_ACTIVE_MIN 2
  else
    gw_emit HYBRID_WORKER_ACTIVE_MIN 1
  fi
  gw_emit HYBRID_WORKER_ACTIVE_MAX
  gw_emit HYBRID_WORKER_SCALE_RATE
  gw_emit HYBRID_WORKER_SHRINK_RATE
  gw_emit HYBRID_WORKER_IDLE_SHRINK_MS
  gw_emit HYBRID_WORKER_PROBE_INTERVAL_MS
  gw_emit HYBRID_WORKER_BENCH_COOLDOWN_MS
  gw_emit HYBRID_WORKER_URLS
  # Cloudflare quota guard (runtime): reuses the .env credentials — hourly
  # GraphQL usage poll; soft = stop pool growth, hard = refuse token mints.
  if [ -n "${CLOUDFLARE_API_TOKEN:-}" ] && [ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
    printf 'HYBRID_CF_API_TOKEN=%s\n' "$CLOUDFLARE_API_TOKEN" >> "$GW_TMP"
    printf 'HYBRID_CF_ACCOUNT_ID=%s\n' "$CLOUDFLARE_ACCOUNT_ID" >> "$GW_TMP"
    gw_emit HYBRID_CF_QUOTA_SOFT_PCT
    gw_emit HYBRID_CF_QUOTA_HARD_PCT
    gw_emit HYBRID_CF_DAILY_QUOTA
  fi
  install -m 0640 -o root -g "$HYBRID_USER" "$GW_TMP" "$GW_ENV"
  rm -f "$GW_TMP"
  say "  gateway.env written: $GW_ENV (0640 root:$HYBRID_USER, $(grep -c '=' "$GW_ENV") vars)"

  # --- TLS material sanity (the gateway exits 2 on a broken pair) --------
  if [ -n "${HYBRID_GATEWAY_TLS_CERT:-}" ] || [ -n "${HYBRID_GATEWAY_TLS_KEY:-}" ]; then
    [ -n "${HYBRID_GATEWAY_TLS_CERT:-}" ] && [ -n "${HYBRID_GATEWAY_TLS_KEY:-}" ] \
      || fail "HYBRID_GATEWAY_TLS_CERT set without HYBRID_GATEWAY_TLS_KEY (or vice versa)"
    [ -r "${HYBRID_GATEWAY_TLS_CERT}" ] || fail "HYBRID_GATEWAY_TLS_CERT not readable: ${HYBRID_GATEWAY_TLS_CERT}"
    [ -r "${HYBRID_GATEWAY_TLS_KEY}" ] || fail "HYBRID_GATEWAY_TLS_KEY not readable: ${HYBRID_GATEWAY_TLS_KEY}"
    say "  TLS material OK (read-only use of the daemon certificate)"
  else
    warn "no HYBRID_GATEWAY_TLS_CERT/KEY set — gateway will listen PLAINTEXT HTTP"
  fi

  # --- systemd unit --------------------------------------------------------
  cat > "$SYSTEMD_DIR/speedtest-hybrid-gateway.service" <<EOF
[Unit]
Description=Speedtest Hybrid Gateway (VPS control plane + full-potential assist lane v1.4)
Documentation=file://$HYBRID_PREFIX/README.md
After=network-online.target speedtestserver.service
Wants=network-online.target

[Service]
Type=simple
User=$HYBRID_USER
Group=$HYBRID_USER
EnvironmentFile=$GW_ENV
WorkingDirectory=$HYBRID_PREFIX
ExecStart=$(command -v node) $HYBRID_PREFIX/src/gateway.mjs
Restart=on-failure
RestartSec=2
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$HYBRID_STATE
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF
  if command -v systemd-analyze >/dev/null 2>&1; then
    if UNIT_ERR="$(systemd-analyze verify "$SYSTEMD_DIR/speedtest-hybrid-gateway.service" 2>&1 | grep -v '^$' | head -5)"; [ -z "$UNIT_ERR" ]; then
      say "  systemd-analyze verify (hybrid): OK"
    else
      warn "systemd-analyze verify (hybrid) reported: $UNIT_ERR"
    fi
  fi

  # --- live probe of the exact gateway entrypoint (temporary instance) ----
  say "Verifying the hybrid gateway starts and answers…"
  GW_PROBE_PORT="18790"
  GW_PROBE_LOG="$(mktemp /tmp/sts-hybrid-verify.XXXXXX.log)"
  GW_PROBE_CFG="$(mktemp /tmp/sts-hybrid-verify.XXXXXX.env)"
  # probe copy: local bind + free port + no TLS (cert is for the public name)
  sed -e "s/^HYBRID_GATEWAY_BIND=.*/HYBRID_GATEWAY_BIND=127.0.0.1/" \
      -e "s/^HYBRID_GATEWAY_PORT=.*/HYBRID_GATEWAY_PORT=$GW_PROBE_PORT/" \
      -e "/^HYBRID_GATEWAY_TLS_CERT=/d" -e "/^HYBRID_GATEWAY_TLS_KEY=/d" \
      -e "/^HYBRID_RESULTS_FILE=/d" \
      "$GW_ENV" > "$GW_PROBE_CFG"
  # Node >= 20.6: --env-file. IMPORTANT: process-environment values take
  # precedence over the file — and install.sh itself EXPORTED the .env into
  # its own environment (env_load), so a plain subprocess would inherit e.g.
  # HYBRID_GATEWAY_TLS_CERT and defeat the sed-strip below. The probe
  # therefore launches with a CLEAN environment (env -i): the file + the two
  # explicit overrides are the only sources. Values are parsed WITHOUT any
  # shell evaluation.
  env -i PATH="$PATH" HOME="${HOME:-/root}" \
    HYBRID_GATEWAY_PORT="$GW_PROBE_PORT" HYBRID_GATEWAY_BIND=127.0.0.1 \
    "$(command -v node)" --env-file="$GW_PROBE_CFG" "$HYBRID_PREFIX/src/gateway.mjs" > "$GW_PROBE_LOG" 2>&1 &
  GW_PROBE_PID=$!
  cleanup_gwprobe() { kill "$GW_PROBE_PID" 2>/dev/null || true; rm -f "$GW_PROBE_CFG" "$GW_PROBE_LOG"; }
  trap cleanup_gwprobe EXIT
  GW_READY=0
  for _ in $(seq 1 20); do
    grep -q gateway_started "$GW_PROBE_LOG" && { GW_READY=1; break; }
    sleep 0.5
  done
  if [ "$GW_READY" != 1 ]; then
    cat "$GW_PROBE_LOG" >&2
    fail "hybrid gateway did not start (see log above)"
  fi
  GW_PROBE="$(node -e "
const http = require('http');
const req = http.get({ host: '127.0.0.1', port: +process.argv[1], path: '/api/health' }, (res) => {
  let d = '';
  res.on('data', (c) => { d += c; });
  res.on('end', () => {
    try { const j = JSON.parse(d); console.log(j.server + ' vpsDlShare=' + (j.front && j.front.assist ? j.front.assist.vpsDlShare : 'front-off')); process.exit(0); }
    catch { console.error('bad health body'); process.exit(1); }
  });
});
req.on('error', (e) => { console.error(e.message); process.exit(1); });
setTimeout(() => { req.destroy(); process.exit(1); }, 5000);
" "$GW_PROBE_PORT")" || { cat "$GW_PROBE_LOG" >&2; fail "hybrid gateway /api/health probe failed"; }
  say "  health probe: $GW_PROBE"
  cleanup_gwprobe
  trap - EXIT
fi

# ------------------------------------------------- cloudflare workers -----
# Deploys the 1..N worker pool (N = CF_WORKER_DEPLOY_COUNT from .env) with
# wrangler, sets HYBRID_SHARED_SECRET on EVERY worker, verifies /__meta.
# Skipped by --no-workers or CF_WORKER_DEPLOY_COUNT=0.
if [ "$NO_HYBRID" = 0 ] && [ "$AS_ROOT" = 1 ] && [ "$NO_WORKERS" = 0 ] && [ "$CF_WORKER_DEPLOY_COUNT" != "0" ]; then
  CF_MISSING=0
  [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ] && { warn "  CLOUDFLARE_ACCOUNT_ID is empty in $ENV_FILE"; CF_MISSING=1; }
  if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
    if [ -z "${CLOUDFLARE_EMAIL:-}" ] || [ -z "${CLOUDFLARE_API_KEY:-}" ]; then
      warn "  CLOUDFLARE_API_TOKEN empty AND CLOUDFLARE_EMAIL+CLOUDFLARE_API_KEY incomplete in $ENV_FILE"
      CF_MISSING=1
    fi
  fi
  if [ "$CF_MISSING" = 1 ]; then
    fail "worker deployment requested (CF_WORKER_DEPLOY_COUNT=$CF_WORKER_DEPLOY_COUNT) but the Cloudflare credentials are incomplete — fill .env per docs/CLOUDFLARE_CREDENTIALS.md and re-run install.sh"
  fi

  # Pre-flight: verify the credentials actually authenticate (fast fail).
  if command -v curl >/dev/null 2>&1; then
    say "Verifying Cloudflare credentials…"
    if [ -n "${CLOUDFLARE_API_TOKEN:-}" ]; then
      CF_CHECK="$(curl -s -m 20 -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
        https://api.cloudflare.com/client/v4/user/tokens/verify || true)"
      if echo "$CF_CHECK" | grep -q '"status":"active"'; then
        say "  API token: ACTIVE"
      else
        warn "  API token did not verify as active — wrangler will surface any auth error"
      fi
    else
      CF_CHECK="$(curl -s -m 20 -H "X-Auth-Email: ${CLOUDFLARE_EMAIL}" -H "X-Auth-Key: ${CLOUDFLARE_API_KEY}" \
        https://api.cloudflare.com/client/v4/user || true)"
      if echo "$CF_CHECK" | grep -q '"success":true'; then
        say "  Global API Key: OK (user ${CLOUDFLARE_EMAIL})"
      else
        warn "  Global API Key check failed — wrangler will surface any auth error"
      fi
    fi
    if [ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
      CF_ACC="$(curl -s -m 20 ${CLOUDFLARE_API_TOKEN:+-H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}"} \
        ${CLOUDFLARE_EMAIL:+-H "X-Auth-Email: ${CLOUDFLARE_EMAIL}"} ${CLOUDFLARE_API_KEY:+-H "X-Auth-Key: ${CLOUDFLARE_API_KEY}"} \
        https://api.cloudflare.com/client/v4/accounts || true)"
      if echo "$CF_ACC" | grep -q "${CLOUDFLARE_ACCOUNT_ID}"; then
        say "  account ${CLOUDFLARE_ACCOUNT_ID}: reachable with these credentials"
      else
        warn "  account id ${CLOUDFLARE_ACCOUNT_ID} not visible with these credentials (token account-resource scoping?)"
      fi
    fi
  fi

  say "Installing worker deploy toolchain (npm ci in hybrid/worker)…"
  ( cd "$REPO_ROOT/hybrid/worker" && npm ci --no-audit --no-fund >/dev/null 2>&1 ) \
    || fail "npm ci failed in hybrid/worker (wrangler toolchain)"

  say "Deploying Cloudflare worker pool: 1..${CF_WORKER_DEPLOY_COUNT}…"
  ( cd "$REPO_ROOT/hybrid/worker" && \
    POOL_SIZE="$CF_WORKER_DEPLOY_COUNT" \
    CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-}" \
    CLOUDFLARE_API_TOKEN="${CLOUDFLARE_API_TOKEN:-}" \
    CLOUDFLARE_EMAIL="${CLOUDFLARE_EMAIL:-}" \
    CLOUDFLARE_API_KEY="${CLOUDFLARE_API_KEY:-}" \
    HYBRID_SHARED_SECRET="${HYBRID_SHARED_SECRET:-}" \
    VERIFY="${CF_WORKER_VERIFY:-1}" \
    bash deploy-pool.sh ) \
    || fail "worker pool deployment failed — the VPS side (daemon + gateway) is already installed; fix the error above (usually credentials/scopes — see docs/CLOUDFLARE_CREDENTIALS.md) and re-run install.sh"
  say "Worker pool deployed: 1..${CF_WORKER_DEPLOY_COUNT} (secret set on every worker)."
fi

# ------------------------------------------------------------ systemctl ----
if [ "$AS_ROOT" = 1 ]; then
  systemctl daemon-reload
  if [ "$SYSTEMD_AVAILABLE" = 1 ]; then
    if [ "$START" = 1 ]; then
      say "Enabling + starting speedtestserver.service…"
      systemctl enable --now speedtestserver
      sleep 2
      systemctl --no-pager --lines=5 status speedtestserver || true
      say "Service started. Logs: journalctl -u speedtestserver -f"
      if [ "$NO_HYBRID" = 0 ]; then
        say "Enabling + starting speedtest-hybrid-gateway.service…"
        systemctl enable --now speedtest-hybrid-gateway
        sleep 2
        systemctl --no-pager --lines=5 status speedtest-hybrid-gateway || true
        say "Hybrid gateway started. Logs: journalctl -u speedtest-hybrid-gateway -f"
        if command -v curl >/dev/null 2>&1; then
          GW_PORT_LIVE="${HYBRID_GATEWAY_PORT:-8790}"
          GW_TLS_LIVE="${HYBRID_GATEWAY_TLS_CERT:-}"
          GW_PROTO="http"
          [ -n "$GW_TLS_LIVE" ] && GW_PROTO="https"
          say "Live health check: $GW_PROTO://127.0.0.1:$GW_PORT_LIVE/api/health"
          curl -sk -m 10 "$GW_PROTO://127.0.0.1:$GW_PORT_LIVE/api/health" \
            | head -c 400; echo
        fi
      fi
    else
      say "Unit installed (not started — rerun with --start or: systemctl enable --now speedtestserver)"
      [ "$NO_HYBRID" = 0 ] && say "Hybrid unit installed (start: systemctl enable --now speedtest-hybrid-gateway)"
    fi
  else
    warn "systemd not running in this environment — service NOT started (BLOCKED)."
    warn "When systemd is available: systemctl enable --now speedtestserver"
    [ "$NO_HYBRID" = 0 ] && warn "…and: systemctl enable --now speedtest-hybrid-gateway"
    [ "$START" = 1 ] && warn "--start was requested but could not be honored here."
  fi
else
  say "Staged install complete. Unit file: $SYSTEMD_DIR/speedtestserver.service"
  say "Run manually: node $PREFIX/dist/bin/ooklaserver.js --config $CONFIG_INSTALLED"
  say "(staging mode never installs the hybrid gateway — use a system install for that)"
fi

say "Done. Upgrade: re-run this script (configuration and certificates are preserved)."
say "Recovery: systemctl restart speedtestserver  (or re-run with --start)"
if [ "$NO_HYBRID" = 0 ] && [ "$AS_ROOT" = 1 ]; then
  say "Hybrid recovery: systemctl restart speedtest-hybrid-gateway"
  say "Pool status:   curl -sk ${HYBRID_GATEWAY_TLS_CERT:+-k }https://127.0.0.1:${HYBRID_GATEWAY_PORT:-8790}/api/pool"
  say "Documentation: docs/HYBRID_ASSIST_MODE.md · docs/WORKER_POOL.md · docs/CLOUDFLARE_CREDENTIALS.md"
fi
