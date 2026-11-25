#!/usr/bin/env bash
# auto-update.sh — daily self-update for the SpeedtestServer stack (v1.5).
#
# Installed by install.sh as speedtest-autoupdate.service, triggered daily by
# speedtest-autoupdate.timer (04:30 + up to 30 min jitter, Persistent=true so
# missed runs while powered off catch up on boot). Manual run:
#   systemctl start speedtest-autoupdate.service
#   bash /opt/SpeedtestServer-src/auto-update.sh
#
# Flow:
#   1. flock guard (never two updaters at once)
#   2. allowlist check: origin must be the official GitHub repo
#   3. clean-tree guard (untracked .env is fine — it is never committed)
#   4. git fetch origin <branch>; compare HEAD vs origin/<branch>
#   5. up to date → log VERSION and exit 0
#   6. ff-only pull; then reinstall via install.sh --start (idempotent:
#      OoklaServer.properties/certs preserved, .env drives the hybrid stack,
#      worker redeploy fingerprint-gated)
#   7. restart speedtestserver + speedtest-hybrid-gateway so running code
#      matches the new HEAD (install.sh only starts units, never restarts)
#   8. post-checks: units active + a health probe
#
# Safety: never touches /etc/speedtestserver/OoklaServer.properties,
# certificates, DNS, firewall rules, unrelated services, or .env.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BRANCH="${AUTO_UPDATE_BRANCH:-master}"
REMOTE_ALLOW="github.com/smahud/SpeedtestServer"
LOGFILE="${AUTO_UPDATE_LOG:-/var/lib/speedtestserver/autoupdate.log}"
LOCK=/run/speedtest-autoupdate.lock

log() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$LOGFILE" 2>/dev/null || printf '%s\n' "$*"
}
die() { log "FATAL: $*"; exit 1; }

mkdir -p "$(dirname "$LOGFILE")" 2>/dev/null || true
exec 9>"$LOCK" || die "cannot open lock file"
flock -n 9 || { log "another updater is running — exiting"; exit 0; }

cd "$REPO_ROOT"
command -v git >/dev/null 2>&1 || die "git not found"

REMOTE_URL="$(git remote get-url origin 2>/dev/null || true)"
case "$REMOTE_URL" in
  *"$REMOTE_ALLOW"*) : ;;
  *) die "origin is not $REMOTE_ALLOW (got: ${REMOTE_URL:-none}) — refusing to auto-update" ;;
esac

# Clean-tree guard: tracked files must not have local modifications.
if [ -n "$(git status --porcelain | grep -v '^??')" ]; then
  die "working tree has local modifications — refusing to auto-update (stash or commit them)"
fi

CURRENT_VERSION() { cat "$REPO_ROOT/VERSION" 2>/dev/null || echo unknown; }

OLD_V="$(CURRENT_VERSION)"
log "checking origin/$BRANCH (local HEAD $(git rev-parse --short HEAD), VERSION $OLD_V)…"
git fetch --quiet origin "$BRANCH" || die "git fetch failed (network?)"

LOCAL="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse "origin/$BRANCH")"
if [ "$LOCAL" = "$REMOTE" ]; then
  log "up to date (VERSION $OLD_V)."
  exit 0
fi

log "update available: $(git rev-parse --short HEAD) → $(git rev-parse --short "origin/$BRANCH")"
git merge --ff-only "origin/$BRANCH" >/dev/null 2>&1 || die "ff-only merge failed — manual intervention needed"
NEW_V="$(CURRENT_VERSION)"
log "pulled: HEAD $(git rev-parse --short HEAD), VERSION $OLD_V → $NEW_V"

CHANGED="$(git diff --name-only "$LOCAL" "$REMOTE" | grep -vE '^docs/|^README|^validation/|^\.github' | head -1 || true)"
if [ -z "$CHANGED" ] && [ "$OLD_V" = "$NEW_V" ]; then
  log "docs-only update — skipping reinstall/restart."
  exit 0
fi

log "reinstalling stack (install.sh --start)…"
if ! bash "$REPO_ROOT/install.sh" --start; then
  die "install.sh failed — services keep their previous state; check the log above"
fi

log "restarting services to load the new code…"
systemctl restart speedtestserver || log "WARN: speedtestserver restart failed"
if systemctl list-unit-files 2>/dev/null | grep -q '^speedtest-hybrid-gateway'; then
  systemctl restart speedtest-hybrid-gateway || log "WARN: hybrid gateway restart failed"
fi

sleep 2
systemctl is-active --quiet speedtestserver && log "speedtestserver: active" || log "WARN: speedtestserver NOT active"
if systemctl list-unit-files 2>/dev/null | grep -q '^speedtest-hybrid-gateway'; then
  systemctl is-active --quiet speedtest-hybrid-gateway && log "speedtest-hybrid-gateway: active" || log "WARN: speedtest-hybrid-gateway NOT active"
fi
log "update complete: VERSION $NEW_V @ $(git rev-parse --short HEAD)"
