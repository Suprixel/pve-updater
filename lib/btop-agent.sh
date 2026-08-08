#!/bin/sh
# ---------------------------------------------------------------------------
# pve-updater btop-agent
#
# Pushed into a container by the orchestrator only when BTOP_MONITOR=true.
# Installs btop + ttyd + tmux, then runs btop in a detached tmux session
# (history persists) with ttyd attaching read-only over the web.
#
# Idempotent: safe to run every weekly pass. POSIX sh, multi-distro.
#
# Usage: sh btop-agent.sh [PORT]      (default 7681)
# ---------------------------------------------------------------------------
LC_ALL=C; export LC_ALL
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin; export PATH

PORT=${1:-7681}
case "$PORT" in *[!0-9]*|'') PORT=7681 ;; esac

# --- install (only what is missing) ----------------------------------------
need=''
command -v btop >/dev/null 2>&1 || need="$need btop"
command -v ttyd >/dev/null 2>&1 || need="$need ttyd"
command -v tmux >/dev/null 2>&1 || need="$need tmux"

if [ -n "$need" ]; then
    if command -v apt-get >/dev/null 2>&1; then
        DEBIAN_FRONTEND=noninteractive apt-get update -qq || true
        # shellcheck disable=SC2086
        DEBIAN_FRONTEND=noninteractive apt-get install -y -qq $need 2>/dev/null || true
    elif command -v apk >/dev/null 2>&1; then
        # shellcheck disable=SC2086
        apk add --no-cache $need || true
    elif command -v dnf >/dev/null 2>&1; then
        # shellcheck disable=SC2086
        dnf install -y $need 2>/dev/null || true
    elif command -v yum >/dev/null 2>&1; then
        # shellcheck disable=SC2086
        yum install -y $need 2>/dev/null || true
    elif command -v pacman >/dev/null 2>&1; then
        # shellcheck disable=SC2086
        pacman -Sy --noconfirm $need || true
    elif command -v zypper >/dev/null 2>&1; then
        # shellcheck disable=SC2086
        zypper -n install $need || true
    fi
fi

# --- ttyd fallback: static binary ------------------------------------------
if ! command -v ttyd >/dev/null 2>&1; then
    case "$(uname -m)" in
        x86_64) A=x86_64 ;; aarch64|arm64) A=aarch64 ;; armv7l) A=armhf ;; *) A=x86_64 ;;
    esac
    command -v wget >/dev/null 2>&1 || \
        (command -v apt-get >/dev/null 2>&1 && apt-get install -y -qq wget) || true
    wget -qO /usr/local/bin/ttyd \
        "https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.${A}" \
        && chmod +x /usr/local/bin/ttyd || true
fi

command -v btop >/dev/null 2>&1 || { echo "btop-agent: btop missing on $(hostname)" >&2; exit 0; }

TTYD=$(command -v ttyd || echo /usr/local/bin/ttyd)
BTOP=$(command -v btop || echo /usr/bin/btop)
TMUX=$(command -v tmux || echo /usr/bin/tmux)

# --- pick a UTF-8 locale that actually exists on this container ------------
# The name varies by distro and by how the image was built: Debian trixie
# usually has "C.UTF-8", others only register the lowercase "C.utf8", and
# some minimal images (Alpine without the locale package, some LXC templates)
# have neither and only expose en_US.UTF-8 or nothing at all. Asking glibc for
# a locale that isn't installed doesn't error loudly -- it silently falls back
# to C, which is not UTF-8, and btop's own UTF-8 check then fails even with
# --utf-force. So the agent asks the container what it actually has instead
# of assuming a spelling.
UTF8_LOCALE=$(locale -a 2>/dev/null \
    | grep -iE '^(C\.utf-?8|POSIX\.utf-?8)$' | head -n1)
[ -z "$UTF8_LOCALE" ] && UTF8_LOCALE=$(locale -a 2>/dev/null \
    | grep -iE '\.utf-?8$' | head -n1)
[ -z "$UTF8_LOCALE" ] && UTF8_LOCALE='C.UTF-8'   # last resort, matches old behaviour

echo "btop-agent: using locale $UTF8_LOCALE" >&2

# --- tmux config: quiet, follows the active client's size ------------------
cat > /root/.tmux.conf <<'TCONF'
set -g default-terminal "tmux-256color"
set -ga terminal-overrides ",*256col*:RGB"
set -g status off
setw -g aggressive-resize on
set -g window-size latest
TCONF

if [ -d /run/systemd/system ]; then
    cat > /etc/systemd/system/btop-session.service <<EOF
[Unit]
Description=persistent btop (tmux)
After=network.target

[Service]
Type=forking
Environment=HOME=/root LANG=$UTF8_LOCALE LC_ALL=$UTF8_LOCALE TERM=xterm-256color
ExecStart=$TMUX new-session -d -s btop "while true; do $BTOP --utf-force; sleep 1; done"
ExecStop=$TMUX kill-session -t btop
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF

    cat > /etc/systemd/system/btop-web.service <<EOF
[Unit]
Description=btop over web (ttyd)
After=btop-session.service
Requires=btop-session.service

[Service]
Environment=HOME=/root TERM=xterm-256color
ExecStart=$TTYD -p $PORT -t fontSize=11 -t 'theme={"background":"#0d1117","foreground":"#adbac7","selectionBackground":"#264166","cursor":"#0d1117"}' -t disableLeaveAlert=true -t titleFixed=btop $TMUX attach -t btop -r
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF

    systemctl daemon-reload
    systemctl enable btop-session.service btop-web.service >/dev/null 2>&1 || true
    # start if new, pick up upgraded binaries and a corrected locale if already running
    systemctl restart btop-session.service
    sleep 1
    systemctl restart btop-web.service
else
    # OpenRC (Alpine): non-persistent fallback (fresh btop per connection)
    cat > /etc/init.d/btop-web <<EOF
#!/sbin/openrc-run
name="btop-web"
command="$TTYD"
command_args="-p $PORT -W -t fontSize=11 -t titleFixed=btop env HOME=/root LANG=$UTF8_LOCALE LC_ALL=$UTF8_LOCALE TERM=xterm-256color $BTOP --utf-force"
command_background=true
pidfile="/run/btop-web.pid"
depend() { need net; }
EOF
    chmod +x /etc/init.d/btop-web
    rc-update add btop-web default >/dev/null 2>&1 || true
    rc-service btop-web restart || rc-service btop-web start || true
fi

echo "btop-agent: ttyd :$PORT ready on $(hostname)" >&2
