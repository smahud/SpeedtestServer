#!/usr/bin/env bash
# install.sh — SpeedtestServer STABLE BOOTSTRAP (the ONLY file an operator
# needs to download — once, and keep forever).
#
# ============================================================================
# FROZEN-INSTALLER CONTRACT (operator request, 27 Nov 2026 — modeled on the
# uaeg U-13 "bootstrap permanen" pattern, see docs/INSTALL_BOOTSTRAP.md)
# ============================================================================
# 1. This file is a STABLE BOOTSTRAP. It contains NO project logic and must
#    NEVER change when the project code changes. Its only job: fetch the
#    LATEST installer core and run it.
# 2. The real installer logic lives in installer/install-core.sh in the repo
#    and is fetched fresh FROM GITHUB AT RUN TIME (default: branch `master`;
#    override with --installer-ref <git-ref> or SPEEDTEST_INSTALLER_REF).
#    The core may change freely with the code — an operator holding an OLD
#    checkout (or an OLD copy of this bootstrap) still always installs with
#    the CURRENT logic. Code can change massively; this bootstrap stays.
# 3. Offline fallback: when GitHub is unreachable and a local
#    installer/install-core.sh sits next to this bootstrap, that local copy
#    is used with a clear warning (it may be older than the remote default
#    ref — acceptable only when offline).
# 4. All arguments (except --installer-ref / --bootstrap-version) and the
#    whole environment are passed through to the core unchanged.
# 5. The bootstrap exports SPEEDTEST_BOOTSTRAP_DIR (the directory of THIS
#    file) so the fetched core can find the repository tree / .env it is
#    being invoked against.
#
# Usage (identical to the historical installer):
#   sudo ./install.sh [--start] [--dry-run] [--config FILE] [--prefix DIR]
#        [--service-user N] [--env-file FILE] [--no-hybrid] [--no-workers]
#        [--installer-ref REF]
#   ./install.sh --bootstrap-version      # print bootstrap version + core ref
# ============================================================================
set -euo pipefail

BOOTSTRAP_VERSION=2
REPO_RAW_BASE="https://raw.githubusercontent.com/smahud/SpeedtestServer"
CORE_REF="${SPEEDTEST_INSTALLER_REF:-master}"
BOOTSTRAP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ---- argument scan: peel off the bootstrap's own flags, pass the rest ----
PASS_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --installer-ref) CORE_REF="${2:?--installer-ref needs a value (git ref)}"; shift ;;
    --bootstrap-version)
      echo "SpeedtestServer install.sh — STABLE BOOTSTRAP v$BOOTSTRAP_VERSION"
      echo "  core ref:        ${CORE_REF}"
      echo "  core URL:        ${REPO_RAW_BASE}/${CORE_REF}/installer/install-core.sh"
      echo "  local fallback:  ${BOOTSTRAP_DIR}/installer/install-core.sh"
      echo "This file never changes; the installer logic is fetched fresh per run."
      exit 0 ;;
    --bootstrap-help|-h|--help)
      sed -n '2,42p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      echo "Run WITHOUT --help to fetch and execute the latest installer core"
      echo "(its own --help documents the full, current flag set)."
      exit 0 ;;
    *) PASS_ARGS+=("$1") ;;
  esac
  shift
done

fetch_core() { # fetch_core <url> <dest> — curl preferred, wget fallback
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 2 --connect-timeout 15 -m 120 "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -T 15 -O "$2" "$1"
  else
    return 127
  fi
}

CORE_URL="${REPO_RAW_BASE}/${CORE_REF}/installer/install-core.sh"
CORE_TMP="$(mktemp /tmp/speedtestserver-install-core.XXXXXX.sh)"
trap 'rm -f "$CORE_TMP"' EXIT

CORE_FROM=""
if fetch_core "$CORE_URL" "$CORE_TMP" && [ -s "$CORE_TMP" ] \
   && head -n 1 "$CORE_TMP" | grep -q '^#!'; then
  CORE_FROM="fetched: $CORE_URL"
else
  LOCAL_CORE="$BOOTSTRAP_DIR/installer/install-core.sh"
  if [ -s "$LOCAL_CORE" ] && head -n 1 "$LOCAL_CORE" | grep -q '^#!'; then
    cp "$LOCAL_CORE" "$CORE_TMP"
    CORE_FROM="LOCAL FALLBACK: $LOCAL_CORE (GitHub unreachable or empty download — may be OLDER than ${CORE_REF})"
    printf '\033[1;33m[bootstrap]\033[0m %s\n' "offline — using $CORE_FROM" >&2
  else
    printf '\033[1;31m[bootstrap FATAL]\033[0m cannot fetch %s and no local installer/install-core.sh next to this bootstrap.\n' "$CORE_URL" >&2
    exit 1
  fi
fi

export SPEEDTEST_BOOTSTRAP_DIR="$BOOTSTRAP_DIR"
bash "$CORE_TMP" "${PASS_ARGS[@]+"${PASS_ARGS[@]}"}"
