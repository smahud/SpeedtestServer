# Auto-Update (v1.5)

The stack updates itself daily from the official repository — no manual
`git pull`, no manual reinstall.

## How it works

```
speedtest-autoupdate.timer (daily 04:30 + up to 30 min jitter, Persistent)
  └─ speedtest-autoupdate.service (oneshot)
       └─ auto-update.sh
            1. flock guard — never two updaters at once
            2. origin allowlist — ONLY github.com/smahud/SpeedtestServer
            3. clean-tree guard — refuses to run on locally modified files
            4. git fetch origin master; HEAD == origin/master → done
            5. ff-only pull
            6. install.sh --start  (idempotent reinstall:
               OoklaServer.properties/certs preserved; .env drives the
               hybrid stack; Cloudflare worker redeploy is
               fingerprint-gated — no redeploy when nothing changed)
            7. systemctl restart speedtestserver speedtest-hybrid-gateway
            8. post-checks + log
```

Docs-only commits (README/, `docs/`, `validation/`) are pulled but skip the
reinstall/restart step. Code changes trigger the full reinstall; the VERSION
file (bumped on every functional release) makes the update visible in
`/api/health` and in the log.

## Manual use

```bash
systemctl start speedtest-autoupdate.service   # run once now
bash /opt/SpeedtestServer-src/auto-update.sh   # or directly
journalctl -u speedtest-autoupdate.service -n 50
tail -f /var/lib/speedtestserver/autoupdate.log
```

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `AUTO_UPDATE_BRANCH` | `master` | branch to track (env of the service unit) |
| `AUTO_UPDATE_LOG` | `/var/lib/speedtestserver/autoupdate.log` | append log |
| — | `OnCalendar=*-*-* 04:30:00` | edit `speedtest-autoupdate.timer` to change the schedule |

Disable: `systemctl disable --now speedtest-autoupdate.timer`.

## Safety

- `OoklaServer.properties` is never overwritten (install preserves it).
- `.env` is untracked and never committed or touched.
- A failed install keeps the previously running services (restart happens
  only after a successful install).
- The timer is `Persistent=true`: a powered-off VPS catches up on boot.
