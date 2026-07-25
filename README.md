# pve-updater

One command, run weekly by a systemd timer, that updates a whole Proxmox node:

1. **The PVE host** — `apt-get update && apt-get dist-upgrade` (`dist-upgrade` is the same
   thing as `apt full-upgrade`), then `autoremove` and `clean`.
2. **Every LXC container** — detects the package manager per container
   (apt, apk, dnf, yum, pacman, zypper) and updates it.
3. **Every docker compose stack inside those containers** — `pull` then `up -d`,
   with the compose files discovered automatically. You do not maintain a list.

Each run writes a JSON report and a full log. A small dashboard reads them.

QEMU VMs are listed by Proxmox but skipped: a guest without apt, or one whose updates
are handled by its own OS, is not something to upgrade unattended.

## Install

Clone it on the node and run the installer:

```bash
git clone https://github.com/Suprixel/pve-updater.git
cd pve-updater
./install.sh
```

It installs `jq`, drops the files in place, and enables two units:

| unit | what it does |
|---|---|
| `pve-updater.timer` | fires `pve-updater` every Sunday at 03:00 |
| `pve-updater-web.service` | serves the dashboard and its API on port 8099 |

Change the port with `WEB_PORT=9000 ./install.sh`, the schedule with
`systemctl edit pve-updater.timer`.

## Use it

```bash
pve-updater --inventory     # discover services, change nothing. Start here.
pve-updater --dry-run       # list pending packages and stacks, change nothing
pve-updater                 # the real thing
pve-updater --only 105      # one container, by ID
pve-updater --host-only     # just the node
pve-updater --snapshot      # snapshot every container first
journalctl -u pve-updater -f
```

Exit codes: `0` clean, `1` finished with something worth a look (pending reboot,
a repo that failed to refresh), `2` at least one target failed. The systemd unit
treats `1` as success so a pending reboot does not show up as a red unit.

## How the discovery works

Inside each container the agent asks Docker itself rather than guessing:

```bash
docker ps -a --format '{{.Label "com.docker.compose.project"}}|...'
```

Every container Docker creates through compose carries the project name, the
config file path and the working directory as labels. So any stack that has ever
been brought up is found, whatever the file is called and wherever it lives —
including stacks whose containers are currently stopped. `docker compose ls` is
used as a second source.

The agent then also walks `/opt /srv /root /home /docker /data /mnt` four levels
deep looking for compose files that belong to no project. Those are **reported
but not touched**, and show up in the dashboard under "Compose files nobody is
running".

Bare `docker run` containers and Portainer-managed stacks are inventoried but
not updated — there is no compose file to pull against.

## The API

Anything the dashboard does, curl can do too.

```bash
TOKEN=$(cat /etc/pve-updater/web.token)
curl -s localhost:8099/api/state | jq                       # guests, schedule, run state
curl -s -H "X-PVE-Token: $TOKEN" localhost:8099/api/config  # current settings
curl -s -X POST -H "X-PVE-Token: $TOKEN" \
     -d '{"mode":"dry"}' localhost:8099/api/run             # start a run
curl -s "localhost:8099/api/run/log?from=0" | jq -r .data   # follow it
```

`mode` is one of `full`, `dry`, `inventory`. Add `"only": ["105"]` to restrict it.

## Whether an image actually changed

Before pulling, the agent records the image ID of every service in the stack.
After the pull it compares. Only real changes are counted as "pulled", so the
dashboard tells you what moved rather than that a pull command ran.

This is the fix for the stale image problem: a container left running an image older
than the data it sits on, which usually surfaces as a service that refuses to come back
up after a restart. A weekly `pull` + `up -d` keeps that from building
up. `up -d` only recreates containers whose image changed, so nothing else is
disturbed.

## The dashboard

`http://<node-ip>:8099/`

- **Overview** — one card per guest: the node, every LXC, and every VM. The card shows
  what happened to it in the last run, and clicking it opens the detail below with the
  full list of packages that changed, name and version, from and to. VMs appear so the
  picture is complete but are greyed out, since the updater does not touch them.
- **Services** — every service on the node in one searchable table: which container it
  runs in, which stack owns it, which port it answers on. Type `service name` and get
  the answer in one line.
- **History** — the last 40 runs, click one to open it.
- **Settings** — the config file as switches and inputs. Containers to exclude are
  tappable chips built from the live guest list, so you never type an ID. Saving keeps
  every comment in the file intact.
- **Run update** — starts a run from the browser with live output at the bottom of the
  screen. Three choices: update everything, dry run, or discover only. Each guest's
  detail panel also has *Update just this one*.

Behind a reverse proxy: forward to the node address on port 8099.

### How a run started from the browser is executed

The backend does not fork the updater itself. When systemd is PID 1 it hands the run to
`systemd-run --wait`, which asks PID 1 for a fresh transient unit. That is deliberate:
`pct exec` into an unprivileged container has to write a uid mapping into
`/proc/<pid>/uid_map` and join the container's cgroup, and `apt-get update` drops to the
`_apt` user to fetch. A sandboxed service cannot do either. Running under a unit created
by PID 1 means the update starts from a clean slate whatever the web service is confined
to. `pve-updater-web.service` is therefore deliberately unsandboxed; the access key is
the boundary, not the seccomp filter.

### The access key

Reading the dashboard is open. Saving settings and starting runs are not: those run as
root on the node. They require a key, generated at install and printed by the installer.

```bash
cat /etc/pve-updater/web.token
```

Paste it once with the **Key** button and the browser keeps it. To rotate it, write a
new value into that file and restart `pve-updater-web`.

Be clear-eyed about what this is: anyone holding that key can run apt and docker as root
on your node. The web service binds every interface by default so you can reach it from
your LAN. If you would rather it only listen on one address, edit the unit:

```bash
systemctl edit pve-updater-web.service
# [Service]
# Environment=PVE_UPDATER_BIND=xxx.xxx.xxx.xxx
```

Settings written through the API are validated against a strict schema before they touch
the file — booleans must be `true` or `false`, container IDs must be digits, and any
value containing `$`, a backtick, a quote or a backslash is rejected. That file is
sourced as bash by a root script, so a loose value would be a root shell rather than a
typo. The old file is kept as `pve-updater.conf.bak` on every save.

## Config

`/etc/pve-updater/pve-updater.conf`. The two settings worth deciding on:

```bash
EXCLUDE_CTIDS=()               # container IDs to skip, space separated
SNAPSHOT_BEFORE_UPDATE=false   # true if your storage supports snapshots
```

Snapshots need a snapshot-capable storage (ZFS, LVM-thin, qcow2 on a directory)
and no bind mounts on the container. If the snapshot fails, the update still
runs and the report says so.

## Things worth knowing

- **`:latest` is what makes this work, and also what makes it risky.** A weekly
  unattended pull of `:latest` can bring a breaking major version. For anything
  holding data you care about — password manager, a database — pin the major tag
  (`postgres:16`, not `postgres`) so the pull gets patches, not migrations.
- **The node needs a reboot for a new kernel.** Reported, never done for you
  unless you set `REBOOT_HOST_IF_REQUIRED=true`.
- **Overlapping runs are prevented** with a `flock` on
  `/var/lock/pve-updater.lock`.
- **Alternative worth knowing about:** Watchtower or Diun inside each container
  does the docker half of this. This does the docker half plus the host and the
  guests, from one place, with one report.

## Layout

```
/usr/local/bin/pve-updater              orchestrator, runs on the node
/usr/local/lib/pve-updater/agent.sh     pushed into each container per run
/usr/local/lib/pve-updater/server.py    dashboard and control API, stdlib only
/etc/pve-updater/pve-updater.conf       config
/etc/pve-updater/web.token              access key for the API, mode 0600
/var/lib/pve-updater/web/               dashboard + reports + logs
/var/log/pve-updater/<run-id>.log       full command output, kept 90 days
```

The agent is POSIX sh with no dependencies, copied in with `pct push` and
deleted afterwards. Nothing is installed inside your containers.
