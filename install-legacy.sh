#!/usr/bin/env bash
# Install the separately licensed legacy JPEG bundle and the port-80 fallback.
# Run install.sh first. Usage: sudo bash install-legacy.sh [verified-archive.zip]
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ARCHIVE="${1:-/var/lib/speedtestserver/http_legacy_fallback.zip}"
ASSETS=/var/lib/speedtestserver/legacy
EXPECTED=e77a8fc73dbf725c6d529b389e2fa0af61fbad9be2240d79dc6db078f245463d
[ "$(id -u)" = 0 ] || { echo 'Run as root' >&2; exit 1; }
[ -f /opt/speedtestserver/dist/bin/legacy-http.js ] || { echo 'Run the updated install.sh first' >&2; exit 1; }
getent passwd speedtestserver >/dev/null
if ! systemctl is-active --quiet speedtestserver-legacy && ss -ltnH 'sport = :80' | grep -q .; then
  echo 'Port 80 is occupied; configure your existing web server for legacy fallback instead.' >&2
  exit 1
fi
if [ ! -f "$ARCHIVE" ]; then
  curl -fL --max-time 300 https://speedtest.lungit.com/http_legacy_fallback.zip -o "$ARCHIVE"
fi
printf '%s  %s\n' "$EXPECTED" "$ARCHIVE" | sha256sum -c -
# Extract only the ten known image names, never arbitrary paths or PHP code.
python3 - "$ARCHIVE" "$ASSETS" <<'PY'
import pathlib, sys, zipfile
root = pathlib.Path(sys.argv[2]) / 'speedtest'
root.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(sys.argv[1]) as archive:
    for dim in (350,500,750,1000,1500,2000,2500,3000,3500,4000):
        name = f'random{dim}x{dim}.jpg'
        data = archive.read(f'speedtest/{name}')
        if not data.startswith(b'\xff\xd8'):
            raise SystemExit(f'Invalid JPEG: {name}')
        (root / name).write_bytes(data)
PY
chmod -R u=rwX,go=rX "$ASSETS"
install -m 644 "$REPO_ROOT/config/speedtestserver-legacy.service" /etc/systemd/system/speedtestserver-legacy.service
systemd-analyze verify /etc/systemd/system/speedtestserver-legacy.service
systemctl daemon-reload
systemctl enable speedtestserver-legacy
systemctl restart speedtestserver-legacy
sleep 1
systemctl is-active --quiet speedtestserver-legacy
echo 'Legacy fallback active on port 80. Test using the public hostname with legacy port 80.'
