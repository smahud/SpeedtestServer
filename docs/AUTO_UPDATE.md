# Auto-Update (v2.0 — frozen updater)

The stack updates itself daily from the official repository — no manual
`git pull`, no manual reinstall. `auto-update.sh` is a **frozen wrapper**
(the installer-bootstrap contract, docs/INSTALL_BOOTSTRAP.md): it contains
no project logic, so it never changes when the code changes.

## How it works

```
speedtest-autoupdate.timer (daily 04:30 + up to 30 min jitter, Persistent)
  └─ speedtest-autoupdate.service (oneshot)
       └─ auto-update.sh  (FROZEN wrapper — no project logic)
            1. flock guard — never two updaters at once
            2. origin allowlist — ONLY github.com/smahud/SpeedtestServer
            3. clean-tree guard — refuses to run on locally modified files
            4. git fetch origin master; HEAD == origin/master → done
            5. ff-only pull (fresh tree includes installer/install-core.sh)
            6. install.sh --start  (the FROZEN BOOTSTRAP → fetches the
               LATEST installer core from GitHub and runs it; the core does
               the idempotent reinstall: OoklaServer.properties/certs
               preserved and NEVER written; .env drives the hybrid stack;
               Cloudflare worker redeploy is fingerprint-gated; ALL unit
               transitions (bridge on / daemon parked / standalone restore)
               and restarts are the core's job)
            7. log the result
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

- `OoklaServer.properties` is never overwritten — it is never written at
  all (it is the single source of truth for every port; the installer only
  reads it).
- `.env` is untracked and never committed or touched.
- A failed install keeps the previously running services (restart happens
  only after a successful install).
- The timer is `Persistent=true`: a powered-off VPS catches up on boot.
