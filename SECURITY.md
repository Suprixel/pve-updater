# Security

## What this tool is

`pve-updater` runs as root on a Proxmox node. It executes `apt`, `pct` and
`docker compose`, and it exposes an HTTP API that can start those runs and
rewrite its own config file. Treat it accordingly.

## The access key

Generated at install into `/etc/pve-updater/web.token`, mode 0600, unique per
install. It is never committed to this repository and there is no default value.

Reading the dashboard needs no key. Writing settings and starting runs do.
Anyone holding the key can run package and container management as root on the
node, so it is equivalent to a root password for that host.

Rotate it by writing a new value into the file and restarting
`pve-updater-web.service`.

## Config validation

`/etc/pve-updater/pve-updater.conf` is sourced as bash by a root script. Values
written through the API are checked against a per-key schema before the file is
touched: booleans must be `true` or `false`, container IDs must be digits, and
any string containing `$`, a backtick, a quote or a backslash is rejected. A
loose value here would be arbitrary root code execution rather than a typo.

## Network exposure

The web service binds all interfaces by default so it is reachable from the LAN.
To restrict it:

```
systemctl edit pve-updater-web.service
# [Service]
# Environment=PVE_UPDATER_BIND=192.0.2.10   # the node address to bind
```

There is no TLS. Put it behind a reverse proxy if it needs to leave the LAN,
and think hard before it does.

## Reporting a problem

Open an issue, or email the address on the repository owner's profile for
anything you would rather not post publicly.
