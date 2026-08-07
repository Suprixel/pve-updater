#!/usr/bin/env bash
# Installs pve-updater on a Proxmox VE node. Run as root from this directory.
set -euo pipefail

WEB_PORT=${WEB_PORT:-8099}
SRC=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

[[ $EUID -eq 0 ]] || { echo "run this as root"; exit 1; }
command -v pct >/dev/null || { echo "pct not found - this is not a Proxmox VE node"; exit 1; }

echo "==> installing dependencies"
if ! command -v jq >/dev/null; then
    apt-get update -qq
    apt-get install -y jq
fi

echo "==> installing files"
install -d /usr/local/lib/pve-updater /etc/pve-updater \
           /var/lib/pve-updater/web/reports /var/lib/pve-updater/web/logs \
           /var/log/pve-updater /usr/local/share/doc/pve-updater

install -m 0755 "$SRC/bin/pve-updater"  /usr/local/bin/pve-updater
install -m 0755 "$SRC/lib/agent.sh"     /usr/local/lib/pve-updater/agent.sh
install -m 0755 "$SRC/lib/btop-agent.sh" /usr/local/lib/pve-updater/btop-agent.sh
install -m 0644 "$SRC/web/index.html"   /var/lib/pve-updater/web/index.html
install -m 0644 "$SRC/web/monitor.html" /var/lib/pve-updater/web/monitor.html
install -m 0755 "$SRC/web/server.py"    /usr/local/lib/pve-updater/server.py
install -m 0644 "$SRC/README.md"        /usr/local/share/doc/pve-updater/README.md

if [[ -f /etc/pve-updater/pve-updater.conf ]]; then
    install -m 0644 "$SRC/etc/pve-updater.conf" /etc/pve-updater/pve-updater.conf.new
    echo "    kept your existing config, new defaults written to pve-updater.conf.new"
else
    install -m 0644 "$SRC/etc/pve-updater.conf" /etc/pve-updater/pve-updater.conf
fi

echo "==> access key"
if [[ ! -s /etc/pve-updater/web.token ]]; then
    (openssl rand -hex 24 2>/dev/null || head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n') \
        >/etc/pve-updater/web.token
    echo >>/etc/pve-updater/web.token
    echo "    generated a new key"
else
    echo "    keeping the existing key"
fi
chmod 0600 /etc/pve-updater/web.token

echo "==> installing systemd units"
install -m 0644 "$SRC/systemd/pve-updater.service"     /etc/systemd/system/
install -m 0644 "$SRC/systemd/pve-updater.timer"       /etc/systemd/system/
sed "s/PVE_UPDATER_PORT=8099/PVE_UPDATER_PORT=$WEB_PORT/" \
    "$SRC/systemd/pve-updater-web.service" >/etc/systemd/system/pve-updater-web.service
chmod 0644 /etc/systemd/system/pve-updater-web.service

chmod -R a+rX /var/lib/pve-updater/web

systemctl daemon-reload
systemctl restart pve-updater-web.service 2>/dev/null || true
systemctl enable --now pve-updater-web.service
systemctl enable --now pve-updater.timer

IP=$(hostname -I | awk '{print $1}')
cat <<EOF

==> done

  dashboard      http://$IP:$WEB_PORT/
  access key     $(cat /etc/pve-updater/web.token)
  config         /etc/pve-updater/pve-updater.conf
  next run       $(systemctl show -p NextElapseUSecRealtime --value pve-updater.timer 2>/dev/null || echo 'see systemctl list-timers')

First, look around without changing anything:

  pve-updater --inventory

Then run a real one when you are ready:

  pve-updater
  journalctl -u pve-updater -f

EOF
