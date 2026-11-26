#!/usr/bin/env bash
# install.sh — SpeedtestServer automated installer (v1.5).
#
# Deploys the OPEN-SOURCE TYPESCRIPT SpeedtestServer (reverse-engineered/
# typescript) — never the proprietary OoklaServer binary. This project is a
# STANDALONE OoklaServer replacement: the daemon binds 8080/5060 ONLY (the
# two ports the official OoklaServer.properties offers). It never touches
# 80/443/8081/8443 or any unrelated production service.
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
#      upgrade — the official Ookla configuration format is NEVER modified)
#      and a hardened systemd unit.
#   7. Verifies: unit syntax (systemd-analyze), listener + protocol probe.
#   8. HYBRID (the default when .env enables it — see .env.example and
#      docs/CLOUDFLARE_CREDENTIALS.md):
#      a. installs the hybrid gateway to /opt/speedtest-hybrid (zero-dep
#         Node sources) + speedtest-hybrid user + hardened systemd unit
#         (speedtest-hybrid-gateway.service, TLS via systemd LoadCredential)
#         + /etc/speedtest-hybrid/gateway.env generated FROM the repo .env;
#         the gateway then WATCHES the repo .env and applies changes
#         ON THE FLY (worker deploy count, pool bounds, lane share,
#         credentials, shared secret — no restart needed);
#      b. builds the worker bundle (esbuild) and deploys/updates the
#         Cloudflare worker pool (1..N = CF_WORKER_DEPLOY_COUNT in .env)
#         through the REST API (rest-deploy.mjs; wrangler deploy-pool.sh is
#         the fallback), setting the shared secret on every worker, then
#         verifies a sample via /__meta;
#      c. VPS-ONLY FALLBACK: when no usable Cloudflare credential is present
#         the install still completes (daemon + gateway, everything served
#         by the VPS); fix .env and re-run install.sh to enable hybrid;
#      d. SPEEDTEST-BRIDGE (v1.6, default on): installs the permanent VPS
#         front for NATIVE Ookla clients (unmodified official CLI / mobile
#         apps — NetGauge protocol parity + measurement payload from the
#         Worker pool) as speedtest-bridge.service (auto-start on boot +
#         auto-restart on crash). PORT UNIFICATION: the bridge owns the
#         native :8080 (TCP+UDP) and muxes TLS ClientHellos to the gateway
#         (now loopback-only, :8790 never public) — so the VPS opens ONLY
#         the two native OoklaServer ports: :8080 (bridge) + :5060 (daemon,
#         narrowed in OoklaServer.properties itself with a timestamped
#         backup). SPEEDTEST_BRIDGE_ENABLED=false restores the daemon to
#         both native ports and disables the unit.
#   9. AUTO-UPDATE (v1.5): installs speedtest-autoupdate.service + .timer
#      (daily 04:30 + jitter, Persistent) — the stack pulls repo updates,
#      reinstalls and restarts itself. See docs/AUTO_UPDATE.md.
#  10. LEGACY PURGE (v1.5): disables and removes the old port-80
#      speedtestserver-legacy unit if present (the project no longer runs
#      any port-80 HTTP surface).
#  11. Optionally starts the services (--start).
#
# Usage:
#   sudo ./install.sh [--start] [--dry-run] [--config FILE] [--prefix DIR]
#        [--service-user N] [--env-file FILE] [--no-hybrid] [--no-workers]
#
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
# Environment overrides: REST_DEPLOY=0 forces the wrangler deploy path.
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
GW_UNIT_NAME="speedtest-hybrid-gateway.service"

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

APP_VERSION="$(cat "$REPO_ROOT/VERSION" 2>/dev/null || echo unknown)"
say "SpeedtestServer installer — VERSION $APP_VERSION"

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
SPEEDTEST_BRIDGE_STATE="${SPEEDTEST_BRIDGE_STATE:-/var/lib/speedtest-bridge}"
CF_WORKER_DEPLOY_COUNT="${CF_WORKER_DEPLOY_COUNT:-0}"

# ------------------------------------------------------------- bridge ------
# speedtest-bridge enablement + port layout (v1.6 port unification):
# enabled with the hybrid stack unless .env says otherwise. The bridge owns
# OoklaServer's primary native port (default 8080); the daemon is narrowed to
# the other native port(s) — configured ONLY in OoklaServer.properties.
BRIDGE_ENABLED=1
[ "$NO_HYBRID" = 1 ] && BRIDGE_ENABLED=0
case "${SPEEDTEST_BRIDGE_ENABLED:-true}" in false|0|off|no) BRIDGE_ENABLED=0 ;; esac
BRIDGE_PORT="${SPEEDTEST_BRIDGE_PORT:-8080}"
BRIDGE_TLS_MUX="${SPEEDTEST_BRIDGE_TLS_MUX:-1}"
case "$BRIDGE_TLS_MUX" in 0|false|off|no) BRIDGE_TLS_MUX=0 ;; esac
# Gateway loopback PLAIN listener (the bridge pipes the decrypted HTTP lane
# here after terminating TLS on the bridge port, daemon parity).
PLAIN_GW_PORT="${HYBRID_GATEWAY_PLAIN_PORT:-8791}"
# Daemon ports = the native list minus the bridge port (5060 when the
# bridge takes 8080, 8080 when it takes 5060). Explicit override:
# SPEEDTEST_BRIDGE_DAEMON_PORTS (comma list, written to OoklaServer.properties).
DAEMON_PORTS="${SPEEDTEST_BRIDGE_DAEMON_PORTS:-$(printf '5060\n8080\n' | grep -vx "$BRIDGE_PORT" | paste -sd, -)}"
[ -n "$DAEMON_PORTS" ] || DAEMON_PORTS="5060"

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

# Worker deploy toolchain: curl (credential verification + REST fallback
# checks). Auto-installed on Debian-family when running as root.
if [ "$NO_HYBRID" = 0 ] && [ "$AS_ROOT" = 1 ]; then
  command -v curl >/dev/null 2>&1 || {
    if command -v apt-get >/dev/null 2>&1; then
      say "Installing curl (apt-get)…"
      DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl >/dev/null 2>&1 \
        || warn "apt-get install curl failed — install it manually"
    else
      warn "curl not found — Cloudflare credential verification will be skipped"
    fi
  }
fi

# ------------------------------------------------------------------ plan ---
PLAN_PREFIX="$PREFIX"
PLAN=(
  "build        npm ci + npm run build        in $TS_DIR"
  "validate     node dist/bin/ooklaserver.js --validate-config"
  "install      rsync dist + runtime deps →  $PLAN_PREFIX"
  "user         dedicated non-root user       $SERVICE_USER"
  "config       OoklaServer.properties →     $CONFIGDIR/OoklaServer.properties (preserved)"
  "state dir    certificates / ACME storage  $STATEDIR (preserved)"
  "systemd      unit file →                   $SYSTEMD_DIR/speedtestserver.service"
  "verify       unit syntax + listener + protocol probe"
)
[ "$START" = 1 ] && PLAN+=("start        systemctl enable --now speedtestserver")

if [ "$NO_HYBRID" = 0 ]; then
  PLAN+=(
    "hybrid gw    zero-dep Node gateway →     $HYBRID_PREFIX/gateway/src (+ .env watcher)"
    "hybrid user  dedicated non-root user       $HYBRID_USER"
    "hybrid env   gateway.env generated from    $ENV_FILE → $HYBRID_ETC/gateway.env"
    "hybrid unit  speedtest-hybrid-gateway.service (TLS via LoadCredential)"
  )
  if [ "$NO_WORKERS" = 0 ] && [ "$CF_WORKER_DEPLOY_COUNT" != "0" ]; then
    PLAN+=("cf workers   REST deploy 1..${CF_WORKER_DEPLOY_COUNT}     (fingerprint-gated; wrangler fallback)")
  fi
  PLAN+=("autoupdate  speedtest-autoupdate.timer    daily 04:30 + jitter")
fi
[ "$AS_ROOT" = 1 ] && PLAN+=("legacy purge remove port-80 speedtestserver-legacy (if present)")

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
[ -f "$REPO_ROOT/VERSION" ] && rsync -a "$REPO_ROOT/VERSION" "$PREFIX/VERSION"
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
Group=$SERVICE_USER
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
  if ss -tln 2>/dev/null | grep ":${VERIFY_PORT} " >/dev/null; then LISTENING=1; break; fi
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
# v1.5 full-stack install: the VPS control plane + assist-lane front, driven
# entirely by the repository .env — and kept IN SYNC with it at runtime (the
# gateway watches the file; worker count / credentials / secret changes apply
# on the fly). The daemon above stays 100% standard (OoklaServer.properties
# is NEVER touched by this phase).
if [ "$NO_HYBRID" = 0 ] && [ "$AS_ROOT" = 1 ]; then
  say "Installing hybrid gateway (v1.5 — full-potential assist lane + on-the-fly .env sync)…"

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
  # v1.5.1: install the gateway with the REPO-relative layout
  # (hybrid/gateway/src → $HYBRID_PREFIX/gateway/src, sibling of worker/) so the
  # relative import '../../worker/rest-deploy.mjs' in workersync.mjs resolves
  # to $HYBRID_PREFIX/worker/rest-deploy.mjs exactly as in the repo tree.
  # v1.5.0 flattened it to $HYBRID_PREFIX/src — from there the import escaped
  # the prefix to /opt/worker and the gateway crashed with ERR_MODULE_NOT_FOUND.
  mkdir -p "$HYBRID_PREFIX/gateway/src" "$HYBRID_ETC" "$HYBRID_STATE"
  rm -rf "$HYBRID_PREFIX/src"   # purge the broken v1.5.0 flat layout
  rsync -a "$REPO_ROOT/hybrid/gateway/src/" "$HYBRID_PREFIX/gateway/src/"
  rsync -a "$REPO_ROOT/hybrid/README.md" "$HYBRID_PREFIX/README.md" 2>/dev/null || true
  # Worker deploy toolchain + REST module (synced fully — incl. dist/ — in the
  # worker phase below, after the bundle is built).
  rsync -a --delete \
    --exclude node_modules --exclude .wrangler \
    "$REPO_ROOT/hybrid/worker/" "$HYBRID_PREFIX/worker/"
  chown -R "$HYBRID_USER:$HYBRID_USER" "$HYBRID_STATE"

  # --- .env readability for the gateway watcher ---------------------------
  # The gateway (user $HYBRID_USER) polls the repo .env so on-the-fly edits
  # apply without a restart. It already holds HYBRID_CF_* credentials in
  # gateway.env, so group-read on .env grants nothing new.
  if [ -f "$ENV_FILE" ]; then
    chown "root:$HYBRID_USER" "$ENV_FILE"
    chmod 0640 "$ENV_FILE"
    say "  .env secured: 0640 root:$HYBRID_USER (gateway watcher can read it)"
  fi

  # --- worker base URL derivation (when not set explicitly) --------------
  if [ -z "${HYBRID_WORKER_BASE:-}" ] && [ -n "${CF_WORKERS_SUBDOMAIN:-}" ]; then
    HYBRID_WORKER_BASE="https://${CF_WORKER_NAME:-speedtest-hybrid-worker}.${CF_WORKERS_SUBDOMAIN}.workers.dev"
    say "  HYBRID_WORKER_BASE derived: $HYBRID_WORKER_BASE"
  fi
  # Default runtime pool size = the deploy count from .env.
  if [ -z "${HYBRID_WORKER_POOL_MAX:-}" ] && [ "$CF_WORKER_DEPLOY_COUNT" -ge 1 ] 2>/dev/null; then
    HYBRID_WORKER_POOL_MAX="$CF_WORKER_DEPLOY_COUNT"
  fi

  # --- v1.6 port-unification overrides (speedtest-bridge TLS mux) -------
  # When the bridge owns the public native port, the gateway serves from
  # LOOPBACK ONLY: its TLS traffic arrives through the bridge's daemon-parity
  # first-byte mux on :<BRIDGE_PORT>. The public base URL follows the bridge
  # port; the WS-NetGauge fallback base follows the daemon's own port.
  if [ "$BRIDGE_ENABLED" = 1 ] && [ "$BRIDGE_TLS_MUX" = 1 ]; then
    PUB_HOST="$(printf '%s' "${HYBRID_VPS_PUBLIC_BASE:-${HYBRID_STS_BASE:-}}" | sed -E 's#^[a-zA-Z]+://##; s#[:/].*$##')"
    [ -n "$PUB_HOST" ] || PUB_HOST="127.0.0.1"
    HYBRID_GATEWAY_BIND="127.0.0.1"
    HYBRID_VPS_PUBLIC_BASE="https://${PUB_HOST}:${BRIDGE_PORT}"
    HYBRID_STS_BASE="https://${PUB_HOST}:${DAEMON_PORTS%%,*}"
    say "  port unification: bridge :${BRIDGE_PORT} (NetGauge front + TLS mux) → gateway loopback; daemon :${DAEMON_PORTS}; VPS opens ONLY native OoklaServer ports"
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
  # v1.6: loopback plain listener for the speedtest-bridge TLS mux
  if [ "$BRIDGE_ENABLED" = 1 ] && [ "$BRIDGE_TLS_MUX" = 1 ]; then
    printf 'HYBRID_GATEWAY_PLAIN_PORT=%s\n' "$PLAIN_GW_PORT" >> "$GW_TMP"
  fi
  # TLS: the unit reads the daemon wildcard cert via systemd LoadCredential
  # (root-only readable) and exposes private copies under /run/credentials —
  # the gateway never needs direct access to the 0600 privkey.
  if [ -n "${HYBRID_GATEWAY_TLS_CERT:-}" ] && [ -n "${HYBRID_GATEWAY_TLS_KEY:-}" ]; then
    printf 'HYBRID_GATEWAY_TLS_CERT=/run/credentials/%s/cert\n' "$GW_UNIT_NAME" >> "$GW_TMP"
    printf 'HYBRID_GATEWAY_TLS_KEY=/run/credentials/%s/key\n' "$GW_UNIT_NAME" >> "$GW_TMP"
  fi
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
  # --- v1.5: on-the-fly .env sync (the watched file + deployment plane) ---
  printf 'HYBRID_ENV_FILE=%s\n' "$ENV_FILE" >> "$GW_TMP"
  gw_emit HYBRID_ENV_POLL_MS 2000
  printf 'HYBRID_WORKER_BUNDLE=%s/worker/dist/worker-bundle.js\n' "$HYBRID_PREFIX" >> "$GW_TMP"
  printf 'HYBRID_WORKER_FP_FILE=%s/deployed.pool.sha\n' "$HYBRID_STATE" >> "$GW_TMP"
  printf 'HYBRID_VERSION_FILE=%s\n' "$REPO_ROOT/VERSION" >> "$GW_TMP"
  gw_emit HYBRID_WORKER_SYNC_DELETE true
  gw_emit HYBRID_WORKER_SYNC_INTERVAL_MS 0
  gw_emit CF_WORKER_DEPLOY_COUNT "${CF_WORKER_DEPLOY_COUNT:-1}"
  gw_emit CF_WORKER_NAME speedtest-hybrid-worker
  gw_emit CF_WORKERS_SUBDOMAIN lumajangnetworks
  # --- routing pool bounds (same semantics as v1.4) ---
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
  # Cloudflare credentials (runtime): token method, or global key method.
  # Used by the quota guard AND by the on-the-fly worker deploy sync.
  if [ -n "${CLOUDFLARE_API_TOKEN:-}" ] && [ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
    printf 'HYBRID_CF_API_TOKEN=%s\n' "$CLOUDFLARE_API_TOKEN" >> "$GW_TMP"
    printf 'HYBRID_CF_ACCOUNT_ID=%s\n' "$CLOUDFLARE_ACCOUNT_ID" >> "$GW_TMP"
  elif [ -n "${CLOUDFLARE_EMAIL:-}" ] && [ -n "${CLOUDFLARE_API_KEY:-}" ] && [ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
    printf 'HYBRID_CF_EMAIL=%s\n' "$CLOUDFLARE_EMAIL" >> "$GW_TMP"
    printf 'HYBRID_CF_API_KEY=%s\n' "$CLOUDFLARE_API_KEY" >> "$GW_TMP"
    printf 'HYBRID_CF_ACCOUNT_ID=%s\n' "$CLOUDFLARE_ACCOUNT_ID" >> "$GW_TMP"
  fi
  gw_emit HYBRID_CF_QUOTA_SOFT_PCT
  gw_emit HYBRID_CF_QUOTA_HARD_PCT
  gw_emit HYBRID_CF_DAILY_QUOTA
  install -m 0640 -o root -g "$HYBRID_USER" "$GW_TMP" "$GW_ENV"
  rm -f "$GW_TMP"
  say "  gateway.env written: $GW_ENV (0640 root:$HYBRID_USER, $(grep -c '=' "$GW_ENV") vars)"

  # --- TLS material sanity (the gateway exits 2 on a broken pair) --------
  if [ -n "${HYBRID_GATEWAY_TLS_CERT:-}" ] || [ -n "${HYBRID_GATEWAY_TLS_KEY:-}" ]; then
    [ -n "${HYBRID_GATEWAY_TLS_CERT:-}" ] && [ -n "${HYBRID_GATEWAY_TLS_KEY:-}" ] \
      || fail "HYBRID_GATEWAY_TLS_CERT set without HYBRID_GATEWAY_TLS_KEY (or vice versa)"
    [ -r "${HYBRID_GATEWAY_TLS_CERT}" ] || fail "HYBRID_GATEWAY_TLS_CERT not readable: ${HYBRID_GATEWAY_TLS_CERT}"
    [ -r "${HYBRID_GATEWAY_TLS_KEY}" ] || fail "HYBRID_GATEWAY_TLS_KEY not readable: ${HYBRID_GATEWAY_TLS_KEY}"
    say "  TLS material OK (served to the unit via systemd LoadCredential)"
  else
    warn "no HYBRID_GATEWAY_TLS_CERT/KEY set — gateway will listen PLAINTEXT HTTP"
  fi

  # --- systemd unit (TLS material via LoadCredential) ---------------------
  cat > "$SYSTEMD_DIR/$GW_UNIT_NAME" <<EOF
[Unit]
Description=Speedtest Hybrid Gateway (VPS control plane + full-potential assist lane v1.5)
Documentation=file://$HYBRID_PREFIX/README.md
After=network-online.target speedtestserver.service
Wants=network-online.target

[Service]
Type=simple
User=$HYBRID_USER
Group=$HYBRID_USER
EnvironmentFile=$GW_ENV
WorkingDirectory=$HYBRID_PREFIX
ExecStart=$(command -v node) $HYBRID_PREFIX/gateway/src/gateway.mjs
Restart=on-failure
RestartSec=2
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$HYBRID_STATE
LimitNOFILE=65536
EOF
  if [ -n "${HYBRID_GATEWAY_TLS_CERT:-}" ] && [ -n "${HYBRID_GATEWAY_TLS_KEY:-}" ]; then
    # systemd (root) reads the READ-ONLY wildcard certs and exposes private
    # copies at /run/credentials/<unit>/{cert,key} — no permission changes.
    cat >> "$SYSTEMD_DIR/$GW_UNIT_NAME" <<EOF
LoadCredential=cert:${HYBRID_GATEWAY_TLS_CERT}
LoadCredential=key:${HYBRID_GATEWAY_TLS_KEY}
EOF
  fi
  cat >> "$SYSTEMD_DIR/$GW_UNIT_NAME" <<EOF

[Install]
WantedBy=multi-user.target
EOF
  if command -v systemd-analyze >/dev/null 2>&1; then
    if UNIT_ERR="$(systemd-analyze verify "$SYSTEMD_DIR/$GW_UNIT_NAME" 2>&1 | grep -v '^$' | head -5)"; [ -z "$UNIT_ERR" ]; then
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
      -e "/^HYBRID_RESULTS_FILE=/d" -e "/^HYBRID_ENV_FILE=/d" \
      -e "/^HYBRID_WORKER_BUNDLE=/d" -e "/^HYBRID_WORKER_FP_FILE=/d" \
      -e "/^HYBRID_VERSION_FILE=/d" \
      "$GW_ENV" > "$GW_PROBE_CFG"
  # Node >= 20.6: --env-file. The probe launches with a CLEAN environment
  # (env -i) so install.sh's own exported .env values cannot leak in and
  # defeat the sed-strip above. Values are parsed WITHOUT shell evaluation.
  env -i PATH="$PATH" HOME="${HOME:-/root}" \
    HYBRID_GATEWAY_PORT="$GW_PROBE_PORT" HYBRID_GATEWAY_BIND=127.0.0.1 \
    "$(command -v node)" --env-file="$GW_PROBE_CFG" "$HYBRID_PREFIX/gateway/src/gateway.mjs" > "$GW_PROBE_LOG" 2>&1 &
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
    try { const j = JSON.parse(d); console.log(j.server + ' mode=' + j.mode + ' vpsDlShare=' + (j.front && j.front.assist ? j.front.assist.vpsDlShare : 'front-off')); process.exit(0); }
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

# ---------------------------------------------------- speedtest-bridge -----
# v1.6: the PERMANENT VPS front for NATIVE Ookla clients (unmodified official
# CLI today — the same NetGauge engine family powers the mobile apps): the
# bridge terminates the native protocol exactly like the daemon (control +
# identity + loss stay on the VPS) while the measurement payload originates
# from the Cloudflare Worker pool. It also carries the daemon-parity TLS mux
# on the same port (ClientHello → the loopback gateway), so the VPS opens
# ONLY the two native OoklaServer ports: :<BRIDGE_PORT> (bridge) + daemon
# ports (narrowed in OoklaServer.properties — the official config file —
# with a timestamped backup). Runs as speedtest-bridge.service with
# Restart=always (auto-start on boot, auto-restart on crash).
if [ "$NO_HYBRID" = 0 ] && [ "$AS_ROOT" = 1 ] && [ "$BRIDGE_ENABLED" = 1 ]; then
  say "Installing speedtest-bridge (permanent :${BRIDGE_PORT} — native clients + Worker payload + TLS mux)…"
  BRIDGE_DST="$HYBRID_PREFIX/speedtest-bridge"
  mkdir -p "$BRIDGE_DST" "$SPEEDTEST_BRIDGE_STATE"
  rsync -a --delete "$REPO_ROOT/hybrid/speedtest-bridge/" "$BRIDGE_DST/"
  chown -R "$HYBRID_USER:$HYBRID_USER" "$SPEEDTEST_BRIDGE_STATE"
  say "  files: $BRIDGE_DST (state: $SPEEDTEST_BRIDGE_STATE)"

  # --- /etc/speedtest-hybrid/speedtest-bridge.env — regenerated ----------
  SB_ENV="$HYBRID_ETC/speedtest-bridge.env"
  [ -f "$SB_ENV" ] && cp -a "$SB_ENV" "$SB_ENV.bak.$(date +%Y%m%d%H%M%S)" || true
  SB_TMP="$(mktemp)"
  sb_emit() { # sb_emit <KEY> [default]
    local key="$1" v="${!1:-}"
    [ -z "$v" ] && v="${2:-}"
    [ -z "$v" ] && return 0
    printf '%s=%s\n' "$key" "$v" >> "$SB_TMP"
  }
  printf 'SPEEDTEST_BRIDGE_PORT=%s\n' "$BRIDGE_PORT" >> "$SB_TMP"
  sb_emit SPEEDTEST_BRIDGE_BACKEND worker-http
  printf 'SPEEDTEST_BRIDGE_GATEWAY_BASE=https://127.0.0.1:%s\n' "${HYBRID_GATEWAY_PORT:-8790}" >> "$SB_TMP"
  sb_emit SPEEDTEST_BRIDGE_WORKER_BASE
  sb_emit SPEEDTEST_BRIDGE_TOKEN
  printf 'SPEEDTEST_BRIDGE_LOG=%s\n' "$SPEEDTEST_BRIDGE_STATE/speedtest-bridge.jsonl" >> "$SB_TMP"
  sb_emit SPEEDTEST_BRIDGE_IDLE_MS
  sb_emit SPEEDTEST_BRIDGE_MAX_CONN_PER_IP 500
  sb_emit SPEEDTEST_BRIDGE_CONN_RATE_PER_MIN 240
  sb_emit SPEEDTEST_BRIDGE_MAX_DL_BYTES
  sb_emit SPEEDTEST_BRIDGE_MAX_UL_BYTES
  sb_emit SPEEDTEST_BRIDGE_HTTP_CHUNK
  sb_emit SPEEDTEST_BRIDGE_UL_CHUNK
  sb_emit SPEEDTEST_BRIDGE_UL_INFLIGHT
  sb_emit SPEEDTEST_BRIDGE_WS_CHUNK
  sb_emit SPEEDTEST_BRIDGE_WS_PACE_MS
  printf 'SPEEDTEST_BRIDGE_TLS_MUX=%s\n' "$BRIDGE_TLS_MUX" >> "$SB_TMP"
  printf 'SPEEDTEST_BRIDGE_TLS_UPSTREAM=127.0.0.1:%s\n' "${HYBRID_GATEWAY_PORT:-8790}" >> "$SB_TMP"
  printf 'SPEEDTEST_BRIDGE_HTTP_UPSTREAM=127.0.0.1:%s\n' "$PLAIN_GW_PORT" >> "$SB_TMP"
  # TLS TERMINATION in the bridge (daemon parity: native NetGauge served
  # INSIDE TLS on :8080 — the official client's PRIMARY path): the unit reads
  # the same wildcard cert as the gateway via systemd LoadCredential.
  if [ -n "${HYBRID_GATEWAY_TLS_CERT:-}" ] && [ -n "${HYBRID_GATEWAY_TLS_KEY:-}" ]; then
    printf 'SPEEDTEST_BRIDGE_TLS_CERT=/run/credentials/%s/cert\n' "speedtest-bridge.service" >> "$SB_TMP"
    printf 'SPEEDTEST_BRIDGE_TLS_KEY=/run/credentials/%s/key\n' "speedtest-bridge.service" >> "$SB_TMP"
  fi
  sb_emit SPEEDTEST_BRIDGE_TLS_SNIFF_MS
  sb_emit SPEEDTEST_BRIDGE_VERSION_STRING
  install -m 0640 -o root -g "$HYBRID_USER" "$SB_TMP" "$SB_ENV"
  rm -f "$SB_TMP"
  say "  speedtest-bridge.env written: $SB_ENV (0640 root:$HYBRID_USER)"

  # --- daemon ports in OoklaServer.properties (the official config) -----
  # The bridge must own its port, so the daemon is narrowed to the other
  # native port(s) — configured ONLY in OoklaServer.properties, backed up
  # first (idempotent: no rewrite when the daemon no longer holds the port).
  PROP_TCP="$(grep -E '^OoklaServer\.tcpPorts' "$CONFIG_INSTALLED" | head -1 | sed 's/^[^=]*= *//' | tr -d ' ')"
  PROP_UDP="$(grep -E '^OoklaServer\.udpPorts' "$CONFIG_INSTALLED" | head -1 | sed 's/^[^=]*= *//' | tr -d ' ')"
  list_has_port() { case ",$1," in *",$2,"*) return 0 ;; *) return 1 ;; esac; }
  if list_has_port "$PROP_TCP" "$BRIDGE_PORT" || list_has_port "$PROP_UDP" "$BRIDGE_PORT"; then
    cp -a "$CONFIG_INSTALLED" "$CONFIG_INSTALLED.bak-speedtest-bridge.$(date +%Y%m%d%H%M%S)"
    sed -i -e "s/^OoklaServer\.tcpPorts.*/OoklaServer.tcpPorts = ${DAEMON_PORTS}/" \
           -e "s/^OoklaServer\.udpPorts.*/OoklaServer.udpPorts = ${DAEMON_PORTS}/" "$CONFIG_INSTALLED"
    say "  OoklaServer.properties: daemon → ${DAEMON_PORTS} (bridge owns :${BRIDGE_PORT}; timestamped backup kept)"
  else
    say "  OoklaServer.properties already leaves :${BRIDGE_PORT} to the bridge (daemon on ${PROP_TCP:-?})"
  fi

  # --- systemd unit (auto-start + auto-restart) ---------------------------
  cat > "$SYSTEMD_DIR/speedtest-bridge.service" <<EOF
[Unit]
Description=Speedtest Bridge (VPS front for native Ookla clients: NetGauge parity + Worker payload, :${BRIDGE_PORT})
Documentation=file://${BRIDGE_DST}/README.md
# Start order: the gateway mints the worker tokens the bridge relays (the
# bridge tolerates a late gateway: cached token + 5s mint backoff). Requires
# = start propagation only — the native front deliberately SURVIVES a brief
# gateway restart.
After=network-online.target speedtest-hybrid-gateway.service
Wants=network-online.target
Requires=speedtest-hybrid-gateway.service
# Restart rate-limiting (unit-level keys since systemd 230)
StartLimitIntervalSec=120
StartLimitBurst=10

[Service]
Type=simple
User=$HYBRID_USER
Group=$HYBRID_USER
EnvironmentFile=$SB_ENV
WorkingDirectory=$HYBRID_PREFIX
ExecStart=$(command -v node) $BRIDGE_DST/speedtest-bridge.mjs
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$SPEEDTEST_BRIDGE_STATE
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true
CapabilityBoundingSet=
AmbientCapabilities=
LimitNOFILE=65536
EOF
  if [ -n "${HYBRID_GATEWAY_TLS_CERT:-}" ] && [ -n "${HYBRID_GATEWAY_TLS_KEY:-}" ]; then
    # systemd (root) reads the READ-ONLY wildcard certs and exposes private
    # copies at /run/credentials/<unit>/{cert,key} — same pattern as the
    # gateway unit. The bridge terminates TLS on :8080 (daemon parity).
    cat >> "$SYSTEMD_DIR/speedtest-bridge.service" <<EOF
LoadCredential=cert:${HYBRID_GATEWAY_TLS_CERT}
LoadCredential=key:${HYBRID_GATEWAY_TLS_KEY}
EOF
  fi
  cat >> "$SYSTEMD_DIR/speedtest-bridge.service" <<EOF

[Install]
WantedBy=multi-user.target
EOF
  if command -v systemd-analyze >/dev/null 2>&1; then
    if UNIT_ERR="$(systemd-analyze verify "$SYSTEMD_DIR/speedtest-bridge.service" 2>&1 | grep -v '^$' | head -5)"; [ -z "$UNIT_ERR" ]; then
      say "  systemd-analyze verify (bridge): OK"
    else
      warn "systemd-analyze verify (bridge) reported: $UNIT_ERR"
    fi
  fi

  # --- live probe of the exact bridge entrypoint (temporary instance) ----
  say "Verifying the speedtest-bridge starts and answers…"
  SB_PROBE_PORT="18808"
  SB_PROBE_LOG="$(mktemp /tmp/sts-bridge-verify.XXXXXX.log)"
  env -i PATH="$PATH" HOME="${HOME:-/root}" \
    "$(command -v node)" "$BRIDGE_DST/speedtest-bridge.mjs" \
    --port "$SB_PROBE_PORT" --backend local --no-tls-mux --log "$SB_PROBE_LOG" > "$SB_PROBE_LOG" 2>&1 &
  SB_PROBE_PID=$!
  cleanup_sbprobe() { kill "$SB_PROBE_PID" 2>/dev/null || true; rm -f "$SB_PROBE_LOG"; }
  trap cleanup_sbprobe EXIT
  SB_LISTENING=0
  for _ in $(seq 1 20); do
    if ss -tln 2>/dev/null | grep ":${SB_PROBE_PORT} " >/dev/null; then SB_LISTENING=1; break; fi
    sleep 0.5
  done
  [ "$SB_LISTENING" = 1 ] || { cat "$SB_PROBE_LOG" >&2; fail "speedtest-bridge did not listen on $SB_PROBE_PORT"; }
  SB_PROBE="$(node -e "
const net = require('net');
const s = net.connect({ host: '127.0.0.1', port: process.argv[1] });
let out = '';
const t = setTimeout(() => { console.error('timeout'); process.exit(1); }, 5000);
s.on('connect', () => s.write('HI\nGETIP\n'));
s.on('data', (d) => { out += d.toString(); if (out.includes('\n')) { clearTimeout(t); console.log(out.split('\n')[0]); s.destroy(); } });
s.on('error', (e) => { clearTimeout(t); console.error(e.message); process.exit(1); });
" "$SB_PROBE_PORT")"
  case "$SB_PROBE" in
    HELLO\ *) say "  bridge protocol probe: $SB_PROBE" ;;
    *) cat "$SB_PROBE_LOG" >&2; fail "speedtest-bridge protocol probe failed" ;;
  esac
  cleanup_sbprobe
  trap - EXIT
fi
# (bridge disable path — SPEEDTEST_BRIDGE_ENABLED=false or --no-hybrid — is
# handled in the systemctl section below: unit removed, daemon restored to
# both native ports from the oldest pre-narrowing backup.)

# ------------------------------------------------- cloudflare workers -----
# v1.5: builds the esbuild bundle once, then converges the deployed 1..N
# pool (N = CF_WORKER_DEPLOY_COUNT from .env) through the Cloudflare REST
# API — fast (parallel), fingerprint-gated (unchanged deployments are
# skipped), and the SAME code path the gateway uses for on-the-fly sync.
# Fallback: wrangler deploy-pool.sh (REST_DEPLOY=0 forces it).
# Credentials that do not verify → VPS-ONLY fallback (the install completes;
# fix .env and re-run to enable the hybrid lane).
if [ "$NO_HYBRID" = 0 ] && [ "$AS_ROOT" = 1 ] && [ "$NO_WORKERS" = 0 ] && [ "$CF_WORKER_DEPLOY_COUNT" != "0" ]; then
  CF_AUTH_MODE="none"
  if command -v curl >/dev/null 2>&1; then
    say "Verifying Cloudflare credentials…"
    if [ -n "${CLOUDFLARE_API_TOKEN:-}" ]; then
      CF_CHECK="$(curl -s -m 20 -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
        https://api.cloudflare.com/client/v4/user/tokens/verify || true)"
      if echo "$CF_CHECK" | grep -q '"status":"active"'; then
        say "  API token: ACTIVE"
        CF_AUTH_MODE="token"
      else
        warn "  API token did not verify as active — trying the Global API Key method"
      fi
    fi
    if [ "$CF_AUTH_MODE" = "none" ] && [ -n "${CLOUDFLARE_EMAIL:-}" ] && [ -n "${CLOUDFLARE_API_KEY:-}" ]; then
      CF_CHECK="$(curl -s -m 20 -H "X-Auth-Email: ${CLOUDFLARE_EMAIL}" -H "X-Auth-Key: ${CLOUDFLARE_API_KEY}" \
        https://api.cloudflare.com/client/v4/user || true)"
      if echo "$CF_CHECK" | grep -q '"success":true'; then
        say "  Global API Key: OK (user ${CLOUDFLARE_EMAIL})"
        CF_AUTH_MODE="key"
      else
        warn "  Global API Key check failed"
      fi
    fi
    if [ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ] && [ "$CF_AUTH_MODE" != "none" ]; then
      CF_ACC="$(curl -s -m 20 ${CLOUDFLARE_API_TOKEN:+-H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}"} \
        ${CLOUDFLARE_EMAIL:+-H "X-Auth-Email: ${CLOUDFLARE_EMAIL}"} ${CLOUDFLARE_API_KEY:+-H "X-Auth-Key: ${CLOUDFLARE_API_KEY}"} \
        https://api.cloudflare.com/client/v4/accounts || true)"
      if echo "$CF_ACC" | grep -q "${CLOUDFLARE_ACCOUNT_ID}"; then
        say "  account ${CLOUDFLARE_ACCOUNT_ID}: reachable with these credentials"
      else
        warn "  account id ${CLOUDFLARE_ACCOUNT_ID} not visible with these credentials (token account-resource scoping?)"
      fi
    fi
  else
    warn "curl not available — skipping credential verification"
    [ -n "${CLOUDFLARE_API_TOKEN:-}" ] && CF_AUTH_MODE="token"
    { [ -z "$CF_AUTH_MODE" ] || [ "$CF_AUTH_MODE" = "none" ]; } && [ -n "${CLOUDFLARE_EMAIL:-}" ] && [ -n "${CLOUDFLARE_API_KEY:-}" ] && CF_AUTH_MODE="key"
  fi

  if [ "$CF_AUTH_MODE" = "none" ] || [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
    warn "==================================================================="
    warn " VPS-ONLY FALLBACK: no usable Cloudflare credential in $ENV_FILE."
    warn " The daemon + gateway are installed and fully functional — every"
    warn " measurement is served by the VPS at full speed. To enable the"
    warn " hybrid Cloudflare lane: fix the credentials in .env (see"
    warn " docs/CLOUDFLARE_CREDENTIALS.md) and re-run install.sh."
    warn "==================================================================="
    NO_WORKERS=1
  fi
fi

if [ "$NO_HYBRID" = 0 ] && [ "$AS_ROOT" = 1 ] && [ "$NO_WORKERS" = 0 ] && [ "$CF_WORKER_DEPLOY_COUNT" != "0" ]; then
  say "Installing worker toolchain (npm ci in hybrid/worker)…"
  ( cd "$REPO_ROOT/hybrid/worker" && npm ci --no-audit --no-fund >/dev/null 2>&1 ) \
    || fail "npm ci failed in hybrid/worker"

  say "Building the worker bundle (esbuild)…"
  ( cd "$REPO_ROOT/hybrid/worker" \
    && [ -x node_modules/.bin/esbuild ] \
    && node_modules/.bin/esbuild src/index.ts --bundle --format=esm --outfile=dist/worker-bundle.js --log-level=warning ) \
    || fail "esbuild bundle failed (is esbuild present in hybrid/worker/node_modules?)"
  [ -s "$REPO_ROOT/hybrid/worker/dist/worker-bundle.js" ] || fail "worker bundle is empty"
  mkdir -p "$HYBRID_PREFIX/worker/dist"
  rsync -a --delete \
    --exclude node_modules --exclude .wrangler \
    "$REPO_ROOT/hybrid/worker/" "$HYBRID_PREFIX/worker/"
  say "  bundle: $(wc -c < "$REPO_ROOT/hybrid/worker/dist/worker-bundle.js") bytes → $HYBRID_PREFIX/worker/dist/worker-bundle.js"

  if [ "${REST_DEPLOY:-1}" = "1" ]; then
    say "Deploying Cloudflare worker pool 1..${CF_WORKER_DEPLOY_COUNT} (REST, fingerprint-gated)…"
    if ( cd "$REPO_ROOT/hybrid/worker" && \
      POOL_SIZE="$CF_WORKER_DEPLOY_COUNT" \
      CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-}" \
      CLOUDFLARE_API_TOKEN="${CLOUDFLARE_API_TOKEN:-}" \
      CLOUDFLARE_EMAIL="${CLOUDFLARE_EMAIL:-}" \
      CLOUDFLARE_API_KEY="${CLOUDFLARE_API_KEY:-}" \
      CF_WORKER_NAME="${CF_WORKER_NAME:-speedtest-hybrid-worker}" \
      CF_WORKERS_SUBDOMAIN="${CF_WORKERS_SUBDOMAIN:-}" \
      HYBRID_SHARED_SECRET="${HYBRID_SHARED_SECRET:-}" \
      FP_FILE="$HYBRID_STATE/deployed.pool.sha" \
      VERIFY="${CF_WORKER_VERIFY:-1}" \
      node rest-deploy.mjs ); then
      say "Worker pool converged: 1..${CF_WORKER_DEPLOY_COUNT} (secret set on every worker)."
    else
      warn "REST deploy failed — falling back to wrangler deploy-pool.sh"
      ( cd "$REPO_ROOT/hybrid/worker" && \
        POOL_SIZE="$CF_WORKER_DEPLOY_COUNT" \
        CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-}" \
        CLOUDFLARE_API_TOKEN="${CLOUDFLARE_API_TOKEN:-}" \
        CLOUDFLARE_EMAIL="${CLOUDFLARE_EMAIL:-}" \
        CLOUDFLARE_API_KEY="${CLOUDFLARE_API_KEY:-}" \
        CF_WORKERS_SUBDOMAIN="${CF_WORKERS_SUBDOMAIN:-}" \
        HYBRID_SHARED_SECRET="${HYBRID_SHARED_SECRET:-}" \
        VERIFY="${CF_WORKER_VERIFY:-1}" \
        bash deploy-pool.sh ) \
        || fail "worker pool deployment failed — the VPS side (daemon + gateway) is already installed; fix the error above (usually credentials/scopes — see docs/CLOUDFLARE_CREDENTIALS.md) and re-run install.sh"
      say "Worker pool deployed via wrangler: 1..${CF_WORKER_DEPLOY_COUNT}."
    fi
  else
    say "Deploying Cloudflare worker pool 1..${CF_WORKER_DEPLOY_COUNT} (wrangler, REST_DEPLOY=0)…"
    ( cd "$REPO_ROOT/hybrid/worker" && \
      POOL_SIZE="$CF_WORKER_DEPLOY_COUNT" \
      CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-}" \
      CLOUDFLARE_API_TOKEN="${CLOUDFLARE_API_TOKEN:-}" \
      CLOUDFLARE_EMAIL="${CLOUDFLARE_EMAIL:-}" \
      CLOUDFLARE_API_KEY="${CLOUDFLARE_API_KEY:-}" \
      CF_WORKERS_SUBDOMAIN="${CF_WORKERS_SUBDOMAIN:-}" \
      HYBRID_SHARED_SECRET="${HYBRID_SHARED_SECRET:-}" \
      VERIFY="${CF_WORKER_VERIFY:-1}" \
      bash deploy-pool.sh ) \
      || fail "worker pool deployment failed — the VPS side (daemon + gateway) is already installed; fix the error above and re-run install.sh"
    say "Worker pool deployed via wrangler: 1..${CF_WORKER_DEPLOY_COUNT}."
  fi
fi

# ----------------------------------------------------- auto-update units --
# Daily self-update: git pull → reinstall → restart (docs/AUTO_UPDATE.md).
if [ "$AS_ROOT" = 1 ] && [ -f "$REPO_ROOT/auto-update.sh" ]; then
  say "Installing auto-update units (daily 04:30 + jitter, Persistent)…"
  cat > "$SYSTEMD_DIR/speedtest-autoupdate.service" <<EOF
[Unit]
Description=SpeedtestServer daily auto-update (git pull + reinstall + restart)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/bin/bash $REPO_ROOT/auto-update.sh
Environment=AUTO_UPDATE_BRANCH=${AUTO_UPDATE_BRANCH:-master}
Nice=10
IOSchedulingClass=idle
TimeoutStartSec=3600

[Install]
WantedBy=multi-user.target
EOF
  cat > "$SYSTEMD_DIR/speedtest-autoupdate.timer" <<EOF
[Unit]
Description=Run the SpeedtestServer auto-update daily

[Timer]
OnCalendar=*-*-* 04:30:00
RandomizedDelaySec=30min
Persistent=true
AccuracySec=1min
Unit=speedtest-autoupdate.service

[Install]
WantedBy=timers.target
EOF
  if command -v systemd-analyze >/dev/null 2>&1; then
    UNIT_ERR="$(systemd-analyze verify "$SYSTEMD_DIR/speedtest-autoupdate.service" "$SYSTEMD_DIR/speedtest-autoupdate.timer" 2>&1 | grep -v '^$' | head -5 || true)"
    [ -z "$UNIT_ERR" ] && say "  systemd-analyze verify (autoupdate): OK" || warn "systemd-analyze verify (autoupdate) reported: $UNIT_ERR"
  fi
  say "  timer enabled: speedtest-autoupdate.timer (systemctl list-timers to verify)"
fi

# ------------------------------------------------------------ legacy purge -
# v1.5: the project binds 8080/5060 ONLY. Remove the old port-80 legacy unit
# (this project's own speedtestserver-legacy) and any stray legacy-http.js
# instance of ours. Unrelated services are never touched.
if [ "$AS_ROOT" = 1 ]; then
  # SIGPIPE-safe probe: under "set -o pipefail", "systemctl … | grep -q" is a
  # trap — grep -q exits on first match, systemctl (still writing) gets
  # SIGPIPE 141 and the pipeline evaluates FALSE in the if, so the purge
  # silently never ran (production incident, 26 Nov 2026: the legacy unit
  # stayed enabled through the v1.5.0/v1.5.1 installs). grep WITHOUT -q
  # consumes the whole stream, so systemctl always exits cleanly.
  if systemctl list-unit-files 2>/dev/null | grep '^speedtestserver-legacy' >/dev/null; then
    say "Purging the legacy port-80 unit (speedtestserver-legacy)…"
    systemctl disable --now speedtestserver-legacy.service 2>/dev/null || true
    rm -f "$SYSTEMD_DIR/speedtestserver-legacy.service"
    systemctl daemon-reload
    say "  speedtestserver-legacy removed (the daemon serves 8080/5060 only)"
  fi
  STRAY="$(pgrep -f 'legacy-http\.js' 2>/dev/null || true)"
  if [ -n "$STRAY" ]; then
    say "Stopping stray legacy-http.js instance(s): $(echo "$STRAY" | tr '\n' ' ')"
    pkill -f 'legacy-http\.js' 2>/dev/null || true
  fi
fi

# ------------------------------------------------------------ systemctl ----
if [ "$AS_ROOT" = 1 ]; then
  # --- speedtest-bridge disable path (SPEEDTEST_BRIDGE_ENABLED=false) ---
  # Remove the unit and restore the daemon to BOTH native ports from the
  # oldest pre-narrowing OoklaServer.properties backup (only when the bridge
  # was previously narrowed by us — recognized by the backup's presence).
  if [ "$BRIDGE_ENABLED" = 0 ] && [ -f "$SYSTEMD_DIR/speedtest-bridge.service" ]; then
    say "speedtest-bridge DISABLED — removing the unit and restoring the daemon's ports…"
    systemctl disable --now speedtest-bridge 2>/dev/null || true
    rm -f "$SYSTEMD_DIR/speedtest-bridge.service"
    systemctl daemon-reload
    say "  speedtest-bridge.service removed (the bridge front is gone)"
    if ls "$CONFIG_INSTALLED".bak-speedtest-bridge.* >/dev/null 2>&1; then
      SB_OLDEST_BAK="$(ls -1tr "$CONFIG_INSTALLED".bak-speedtest-bridge.* | head -1)"
      cp -a "$SB_OLDEST_BAK" "$CONFIG_INSTALLED"
      rm -f "$CONFIG_INSTALLED".bak-speedtest-bridge.*
      say "  OoklaServer.properties restored from $SB_OLDEST_BAK (daemon back on both native ports)"
    else
      warn "  no OoklaServer.properties.bak-speedtest-bridge.* found — daemon ports UNCHANGED (check $CONFIG_INSTALLED manually)"
    fi
  fi
  systemctl daemon-reload
  if [ "$SYSTEMD_AVAILABLE" = 1 ]; then
    # enable + (re)start: a re-install on an already-running unit RESTARTS it
    # so the running code matches the freshly installed files.
    for U in speedtestserver; do
      if [ "$START" = 1 ] || systemctl is-active --quiet "$U"; then
        say "Enabling + (re)starting $U…"
        systemctl enable "$U" >/dev/null 2>&1 || true
        systemctl restart "$U" || fail "failed to start $U"
      fi
    done
    sleep 2
    if [ "$START" = 1 ] || systemctl is-active --quiet speedtest-hybrid-gateway; then
      if [ "$NO_HYBRID" = 0 ] || systemctl list-unit-files 2>/dev/null | grep '^speedtest-hybrid-gateway' >/dev/null; then
        say "Enabling + (re)starting speedtest-hybrid-gateway…"
        systemctl enable speedtest-hybrid-gateway >/dev/null 2>&1 || true
        systemctl restart speedtest-hybrid-gateway || fail "failed to start speedtest-hybrid-gateway"
        sleep 2
      fi
    elif [ "$START" = 1 ] && [ "$NO_HYBRID" = 0 ]; then
      say "Enabling + starting speedtest-hybrid-gateway…"
      systemctl enable --now speedtest-hybrid-gateway || fail "failed to start speedtest-hybrid-gateway"
      sleep 2
    fi
    # speedtest-bridge LAST (the daemon must have released :<BRIDGE_PORT>
    # and the gateway must be up for the mint). Restart starts it when
    # stopped, so this covers both fresh installs and code updates.
    if [ "$BRIDGE_ENABLED" = 1 ] && [ -f "$SYSTEMD_DIR/speedtest-bridge.service" ]; then
      say "Enabling + (re)starting speedtest-bridge…"
      systemctl enable speedtest-bridge >/dev/null 2>&1 || true
      if [ "$START" = 1 ] || systemctl is-active --quiet speedtest-bridge || systemctl is-enabled --quiet speedtest-bridge; then
        systemctl restart speedtest-bridge || fail "failed to start speedtest-bridge"
        sleep 1
        systemctl is-active --quiet speedtest-bridge || fail "speedtest-bridge is NOT active after start"
        say "  speedtest-bridge: active on :${BRIDGE_PORT} (auto-start on boot + auto-restart on crash)"
      fi
    fi
    if [ -f "$SYSTEMD_DIR/speedtest-autoupdate.timer" ]; then
      systemctl enable speedtest-autoupdate.timer >/dev/null 2>&1 || true
      systemctl start speedtest-autoupdate.timer 2>/dev/null || true
    fi
    systemctl --no-pager --lines=3 status speedtestserver 2>/dev/null | head -6 || true
    say "Service logs: journalctl -u speedtestserver -f"
    if systemctl is-active --quiet speedtest-hybrid-gateway; then
      say "Hybrid gateway logs: journalctl -u speedtest-hybrid-gateway -f"
      if command -v curl >/dev/null 2>&1; then
        GW_PORT_LIVE="${HYBRID_GATEWAY_PORT:-8790}"
        say "Live health check: https://127.0.0.1:$GW_PORT_LIVE/api/health"
        # || true: head -c closes the pipe early → curl gets SIGPIPE 141 →
        # under "set -euo pipefail" the installer DIED right here (missing
        # "Done" output, exit swallowed by a tee pipeline) and auto-update
        # treated every reinstall as failed. The health display is cosmetic.
        curl -sk -m 10 "https://127.0.0.1:$GW_PORT_LIVE/api/health" | head -c 500 || true; echo
      fi
    fi
    if systemctl is-active --quiet speedtest-bridge; then
      say "Bridge logs:     journalctl -u speedtest-bridge -f  (JSONL: $SPEEDTEST_BRIDGE_STATE/speedtest-bridge.jsonl)"
      say "Public ports:    ss -tlnp | grep -E ':(8080|5060) '  → bridge :8080 + daemon :5060 (native OoklaServer ports only)"
    fi
    if [ "$START" != 1 ]; then
      say "Units installed. To start now: systemctl enable --now speedtestserver speedtest-hybrid-gateway speedtest-bridge"
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

say "Done (VERSION $APP_VERSION). Upgrade: re-run this script (configuration and certificates are preserved)."
say "Recovery: systemctl restart speedtestserver  (or re-run with --start)"
if [ "$NO_HYBRID" = 0 ] && [ "$AS_ROOT" = 1 ]; then
  say "Hybrid recovery: systemctl restart speedtest-hybrid-gateway"
  if [ "$BRIDGE_ENABLED" = 1 ]; then
    say "Bridge recovery: systemctl restart speedtest-bridge   (owns :${BRIDGE_PORT} — native clients + TLS mux)"
  fi
  say "Pool status:   curl -sk https://127.0.0.1:${HYBRID_GATEWAY_PORT:-8790}/api/pool"
  say "Worker sync:   curl -sk https://127.0.0.1:${HYBRID_GATEWAY_PORT:-8790}/api/workers"
  say "On-the-fly:    edit .env — the running gateway applies it within seconds"
  say "Auto-update:   systemctl list-timers speedtest-autoupdate.timer"
  say "Documentation: docs/HYBRID_ASSIST_MODE.md · docs/WORKER_POOL.md · docs/CLOUDFLARE_CREDENTIALS.md · docs/AUTO_UPDATE.md"
  if [ "$BRIDGE_ENABLED" = 1 ]; then
    say "Contract + official-CLI test method: CONTRACT.md · docs/OFFICIAL_CLI_TESTING_GUIDE.md"
  fi
fi
