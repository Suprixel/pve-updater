# btop-monitor — integration into pve-updater

Adds an **opt-in** live btop dashboard, reusing the existing per-CT loop and the
:8099 web service. Off by default (it installs packages in guests, unlike the updater).

## New files
- `lib/btop-agent.sh`   — pushed into each CT when enabled; installs btop+ttyd+tmux,
                          runs btop in a detached tmux session, ttyd attaches read-only.
                          Idempotent; `try-restart` picks up upgraded binaries each run.
- `web/monitor.html`    — the dashboard (Focus / Grid, 1–4 per row), served at
                          `http://<node>:8099/monitor.html`.

## Changed files
- `bin/pve-updater`     — `BTOP_MONITOR`/`BTOP_PORT` defaults; `monitor_provision()`;
                          call in `update_guest` for already-running, non-excluded CTs;
                          writes `web/containers.json` (id/name/ip) at end of run.
- `web/server.py`       — `BTOP_MONITOR: BOOL`, `BTOP_PORT: INT` added to the settings
                          schema (validated; static server already serves the html/json).
- `web/index.html`      — "Monitor" link in the header; toggle + port in Settings.
- `etc/pve-updater.conf`— documented `BTOP_MONITOR` / `BTOP_PORT`.
- `install.sh`          — installs `btop-agent.sh` and `monitor.html`.

## Behaviour
- Enable via Settings → "Live btop monitor", or `BTOP_MONITOR=true` in the conf.
- Provisioning runs only on real runs (skipped on `--dry-run`/`--inventory`);
  `containers.json` is refreshed on every run so the map tracks CTs coming/going.
- Excluded CTs are left untouched (not provisioned, not on the map).
- Reboots/updates keep the session alive via the enabled units.

## Deploy (your usual flow)
    # from repo root, after extracting the tarball over it:
    chmod +x bin/pve-updater lib/*.sh install.sh
    git diff
    git commit -am "feat: opt-in btop live monitor"
    git push
    ./install.sh
    # then flip it on:
    #   dashboard Settings → Live btop monitor → Save, or edit the conf
    pve-updater --only <id>     # provisions that CT and writes the map
