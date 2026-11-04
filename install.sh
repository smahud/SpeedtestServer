#!/usr/bin/env bash
# install.sh — SpeedtestServer automated installer (MASTER PROMPT v6.0 §13).
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
#   8. Optionally starts the service (--start).
#
# Options:
#   --help              this text
#   --dry-run           validate prerequisites + print the plan; NO changes
#   --staging-dir DIR   full install into DIR (for tests/portable installs):
#                       no system user, no systemctl; unit file written under
#                       DIR/etc/systemd/system, config under DIR/etc/...
#   --start             enable + start the service after install
#   --config FILE       use FILE as the OoklaServer.properties source
#                       (default: shipped template; existing installed
#                       configuration is NEVER overwritten)
#   --prefix DIR        install prefix (default /opt/speedtestserver)
#   --service-user N    systemd service user (default speedtestserver)
#
# Re-running is safe: builds are rebuilt, files re-synced, existing
# configuration/certificates are preserved. The installer never changes
# firewall rules, DNS, unrelated services, or certificates.
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

while [ $# -gt 0 ]; do
  case "$1" in
    --help|-h) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    --dry-run) DRY_RUN=1 ;;
    --start) START=1 ;;
    --staging-dir) STAGING="${2:?--staging-dir needs a value}"; shift ;;
    --prefix) PREFIX="${2:?--prefix needs a value}"; shift ;;
    --service-user) SERVICE_USER="${2:?--service-user needs a value}"; shift ;;
    --config) CONFIG_SRC="${2:?--config needs a value}"; shift ;;
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
    else
      say "Unit installed (not started — rerun with --start or: systemctl enable --now speedtestserver)"
    fi
  else
    warn "systemd not running in this environment — service NOT started (BLOCKED)."
    warn "When systemd is available: systemctl enable --now speedtestserver"
    [ "$START" = 1 ] && warn "--start was requested but could not be honored here."
  fi
else
  say "Staged install complete. Unit file: $SYSTEMD_DIR/speedtestserver.service"
  say "Run manually: node $PREFIX/dist/bin/ooklaserver.js --config $CONFIG_INSTALLED"
fi

say "Done. Upgrade: re-run this script (configuration and certificates are preserved)."
say "Recovery: systemctl restart speedtestserver  (or re-run with --start)"
