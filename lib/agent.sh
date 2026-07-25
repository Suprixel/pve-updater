#!/bin/sh
# ---------------------------------------------------------------------------
# pve-updater agent
#
# Runs on the Proxmox host itself and inside every LXC container.
# Written in POSIX sh so it works on Debian, Ubuntu, Alpine, Fedora, Arch...
#
#   stdout -> structured records, parsed by the orchestrator (never free text)
#   stderr -> human readable log, appended to the run log
#
# Usage: sh agent.sh [flags]
#   --no-packages     skip OS package updates
#   --no-docker       skip docker compose updates
#   --prune           docker image prune -f      (dangling images only)
#   --prune-all       docker image prune -af     (every unused image)
#   --no-discover     do not search the filesystem for unmanaged compose files
#   --adopt-orphans   also pull/up compose files found on disk but not running
#   --dry-run         report what would change, change nothing
# ---------------------------------------------------------------------------

LC_ALL=C
export LC_ALL
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH

DO_PACKAGES=1
DO_DOCKER=1
DO_PRUNE=0
PRUNE_ALL=0
DISCOVER=1
ADOPT=0
DRY=0

while [ $# -gt 0 ]; do
    case "$1" in
        --no-packages)   DO_PACKAGES=0 ;;
        --no-docker)     DO_DOCKER=0 ;;
        --prune)         DO_PRUNE=1 ;;
        --prune-all)     DO_PRUNE=1; PRUNE_ALL=1 ;;
        --no-discover)   DISCOVER=0 ;;
        --adopt-orphans) ADOPT=1 ;;
        --dry-run)       DRY=1 ;;
        *)               : ;;
    esac
    shift
done

emit() { printf '%s\n' "$*"; }
say()  { printf '%s\n' "$*" >&2; }
rule() { say ""; say "--- $* ---"; }

# run a command, mirror its output into the log, and return the output
capture() {
    _out=$("$@" 2>&1)
    _rc=$?
    [ -n "$_out" ] && printf '%s\n' "$_out" >&2
    printf '%s' "$_out"
    return $_rc
}

# run a command, output goes to the log only
quiet() {
    say "+ $*"
    "$@" >&2 2>&1
}

# ---------------------------------------------------------------------------
# identity
# ---------------------------------------------------------------------------
OS_ID=unknown
OS_NAME=unknown
if [ -r /etc/os-release ]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    OS_ID="${ID:-unknown}"
    OS_NAME="${PRETTY_NAME:-${NAME:-$OS_ID}}"
fi
emit "OS_ID=$OS_ID"
emit "OS_NAME=$OS_NAME"
emit "GUEST_HOSTNAME=$(hostname 2>/dev/null || echo unknown)"
emit "KERNEL=$(uname -r 2>/dev/null || echo unknown)"

DISK_PCT=$(df -P / 2>/dev/null | awk 'NR==2 {gsub("%","",$5); print $5}')
[ -n "$DISK_PCT" ] && emit "DISK_USED_PCT=$DISK_PCT"

say "==========================================================="
say " agent on $(hostname 2>/dev/null) - $OS_NAME"
say " packages=$DO_PACKAGES docker=$DO_DOCKER prune=$DO_PRUNE dry_run=$DRY"
say "==========================================================="

# ---------------------------------------------------------------------------
# OS packages
# ---------------------------------------------------------------------------
PKG_MGR=none
PKG_STATUS=skipped
PKGS=0

# Package list emitters. Each reads a simulation on stdin and writes
# PKG|name|from|to records. Capped so a very stale container cannot produce
# a report too large to render.
PKG_CAP=500

emit_apt_pkgs() {
    awk -v cap="$PKG_CAP" '
        /^Inst / && n < cap {
            name = $2; old = ""; new = ""
            if (match($0, /\[[^]]+\]/)) old = substr($0, RSTART + 1, RLENGTH - 2)
            if (match($0, /\([^ )]+/))   new = substr($0, RSTART + 1, RLENGTH - 1)
            print "PKG|" name "|" old "|" new
            n++
        }'
}

emit_apk_pkgs() {
    awk -v cap="$PKG_CAP" '
        /Upgrading / && n < cap {
            for (i = 1; i <= NF; i++) if ($i == "Upgrading") break
            name = $(i + 1); old = ""; new = ""
            if (match($0, /\([^)]*\)/)) {
                v = substr($0, RSTART + 1, RLENGTH - 2)
                split(v, a, " -> ")
                old = a[1]; new = a[2]
            }
            print "PKG|" name "|" old "|" new
            n++
        }'
}

emit_rpm_pkgs() {
    awk -v cap="$PKG_CAP" '
        NF >= 3 && $1 ~ /^[a-zA-Z0-9]/ && $1 !~ /:$/ && n < cap {
            print "PKG|" $1 "||" $2
            n++
        }'
}

APT_INDEX_BROKEN=0

apt_path() {
    PKG_MGR=apt
    DEBIAN_FRONTEND=noninteractive
    export DEBIAN_FRONTEND
    rule "apt-get update"
    quiet apt-get update
    if [ $? -ne 0 ]; then
        # a single broken third party repo should not stop the whole upgrade
        say "apt-get update reported errors, continuing with the cached lists"
        APT_INDEX_BROKEN=1
        emit "PKG_NOTE=one or more apt repositories failed to refresh"
    fi
    if [ "$DRY" -eq 1 ]; then
        rule "apt-get dist-upgrade (simulated)"
        _o=$(capture apt-get -s dist-upgrade)
        printf '%s\n' "$_o" | emit_apt_pkgs
        PKGS=$(printf '%s\n' "$_o" | grep -c '^Inst ')
        PKG_STATUS=ok
        [ "$APT_INDEX_BROKEN" = 1 ] && PKG_STATUS=warn
        return
    fi
    # simulate first: this is where we learn the names and versions
    apt-get -s dist-upgrade 2>/dev/null | emit_apt_pkgs

    rule "apt-get dist-upgrade"
    _o=$(capture apt-get -y \
            -o Dpkg::Options::=--force-confdef \
            -o Dpkg::Options::=--force-confold \
            dist-upgrade)
    if [ $? -eq 0 ]; then
        PKG_STATUS=ok
        [ "$APT_INDEX_BROKEN" = 1 ] && PKG_STATUS=warn
    else
        PKG_STATUS=error
    fi
    PKGS=$(printf '%s\n' "$_o" | grep -E '^[0-9]+ upgraded' | head -n1 | awk '{print $1}')
    quiet apt-get -y --purge autoremove
    quiet apt-get clean
}

apk_path() {
    PKG_MGR=apk
    rule "apk update"
    quiet apk update
    if [ "$DRY" -eq 1 ]; then
        _o=$(capture apk upgrade --simulate)
        printf '%s\n' "$_o" | emit_apk_pkgs
        PKGS=$(printf '%s\n' "$_o" | grep -c 'Upgrading ')
        PKG_STATUS=ok
        return
    fi
    apk upgrade --simulate 2>/dev/null | emit_apk_pkgs

    rule "apk upgrade"
    _o=$(capture apk upgrade)
    if [ $? -eq 0 ]; then PKG_STATUS=ok; else PKG_STATUS=error; fi
    PKGS=$(printf '%s\n' "$_o" | grep -c 'Upgrading ')
}

dnf_path() {
    _bin="$1"
    PKG_MGR="$_bin"
    if [ "$DRY" -eq 1 ]; then
        _o=$(capture "$_bin" -q check-update)
        printf '%s\n' "$_o" | emit_rpm_pkgs
        PKGS=$(printf '%s\n' "$_o" | grep -cE '^[a-zA-Z0-9]')
        PKG_STATUS=ok
        return
    fi
    "$_bin" -q check-update 2>/dev/null | emit_rpm_pkgs

    rule "$_bin upgrade"
    _o=$(capture "$_bin" -y upgrade)
    if [ $? -eq 0 ]; then PKG_STATUS=ok; else PKG_STATUS=error; fi
    PKGS=$(printf '%s\n' "$_o" | grep -cE '^ (Upgrading|Installing)')
    quiet "$_bin" -y autoremove
}

pacman_path() {
    PKG_MGR=pacman
    if [ "$DRY" -eq 1 ]; then
        _o=$(capture pacman -Sup)
        PKGS=$(printf '%s\n' "$_o" | grep -c '^http')
        PKG_STATUS=ok
        return
    fi
    rule "pacman -Syu"
    _o=$(capture pacman -Syu --noconfirm)
    if [ $? -eq 0 ]; then PKG_STATUS=ok; else PKG_STATUS=error; fi
    PKGS=$(printf '%s\n' "$_o" | grep -cE '^(upgrading|installing) ')
}

zypper_path() {
    PKG_MGR=zypper
    rule "zypper update"
    if [ "$DRY" -eq 1 ]; then
        _o=$(capture zypper --non-interactive list-updates)
        PKGS=$(printf '%s\n' "$_o" | grep -c '^v *|')
        PKG_STATUS=ok
        return
    fi
    _o=$(capture zypper --non-interactive update)
    if [ $? -eq 0 ]; then PKG_STATUS=ok; else PKG_STATUS=error; fi
    PKGS=$(printf '%s\n' "$_o" | grep -cE '^Installing:')
}

if [ "$DO_PACKAGES" -eq 1 ]; then
    if   command -v apt-get >/dev/null 2>&1; then apt_path
    elif command -v apk     >/dev/null 2>&1; then apk_path
    elif command -v dnf     >/dev/null 2>&1; then dnf_path dnf
    elif command -v yum     >/dev/null 2>&1; then dnf_path yum
    elif command -v pacman  >/dev/null 2>&1; then pacman_path
    elif command -v zypper  >/dev/null 2>&1; then zypper_path
    else say "no supported package manager found"
    fi
fi

case "$PKGS" in ''|*[!0-9]*) PKGS=0 ;; esac
emit "PKG_MGR=$PKG_MGR"
emit "PKG_STATUS=$PKG_STATUS"
emit "PKGS_UPGRADED=$PKGS"

if [ -f /var/run/reboot-required ] || [ -f /run/reboot-required ]; then
    emit "REBOOT_REQUIRED=1"
fi
if command -v needrestart >/dev/null 2>&1 && [ "$DRY" -eq 0 ]; then
    quiet needrestart -r a
fi

# ---------------------------------------------------------------------------
# docker compose
# ---------------------------------------------------------------------------
if [ "$DO_DOCKER" -ne 1 ] || ! command -v docker >/dev/null 2>&1; then
    emit "DOCKER=0"
    emit "AGENT_DONE=1"
    exit 0
fi

if ! docker info >/dev/null 2>&1; then
    emit "DOCKER=0"
    say "docker binary present but the daemon is not reachable"
    emit "AGENT_DONE=1"
    exit 0
fi

emit "DOCKER=1"
DC_MODE=none
if docker compose version >/dev/null 2>&1; then
    DC_MODE=v2
elif command -v docker-compose >/dev/null 2>&1; then
    DC_MODE=v1
fi
emit "DOCKER_COMPOSE=$DC_MODE"

dc() {
    if [ "$DC_MODE" = v2 ]; then
        docker compose "$@"
    else
        docker-compose "$@"
    fi
}

STACKS=$(mktemp)
KNOWN_DIRS=$(mktemp)
trap 'rm -f "$STACKS" "$KNOWN_DIRS"' EXIT INT TERM

# Primary discovery: every container carries the compose labels that created it.
# Works with compose v1 and v2, running or stopped, whatever the file is named.
docker ps -a \
    --format '{{.Label "com.docker.compose.project"}}|{{.Label "com.docker.compose.project.config_files"}}|{{.Label "com.docker.compose.project.working_dir"}}' \
    2>/dev/null | grep -v '^|' | sort -u > "$STACKS"

# Secondary: ask compose itself (catches projects whose containers were removed)
if [ "$DC_MODE" = v2 ]; then
    docker compose ls --all --format json 2>/dev/null \
        | tr '}' '\n' \
        | sed -n 's/.*"Name":"\([^"]*\)".*"ConfigFiles":"\([^"]*\)".*/\1|\2|/p' \
        >> "$STACKS"
fi

sort -u -t'|' -k1,1 "$STACKS" -o "$STACKS"

update_stack() {
    _proj="$1"
    _files="$2"
    _wd="$3"

    # config_files may be a comma separated list for multi-file stacks
    _first=$(printf '%s' "$_files" | cut -d, -f1)
    if [ -z "$_first" ] && [ -n "$_wd" ]; then
        for _c in docker-compose.yml docker-compose.yaml compose.yml compose.yaml; do
            [ -f "$_wd/$_c" ] && _first="$_wd/$_c" && break
        done
    fi
    if [ -z "$_first" ] || [ ! -f "$_first" ]; then
        say "stack $_proj: compose file not found ($_files)"
        emit "STACK|$_proj|${_first:-unknown}|0|0|error|compose file not found"
        return
    fi

    _dir=$(dirname "$_first")
    printf '%s\n' "$_dir" >> "$KNOWN_DIRS"

    _fargs=""
    _oldifs=$IFS
    IFS=,
    for _f in $_files; do
        [ -f "$_f" ] && _fargs="$_fargs -f $_f"
    done
    IFS=$_oldifs
    [ -z "$_fargs" ] && _fargs="-f $_first"

    rule "stack $_proj  ($_first)"
    cd "$_dir" || { emit "STACK|$_proj|$_first|0|0|error|cannot enter directory"; return; }

    # shellcheck disable=SC2086
    _imgs=$(dc -p "$_proj" $_fargs config --images 2>/dev/null)
    if [ -z "$_imgs" ]; then
        # shellcheck disable=SC2086
        _imgs=$(dc -p "$_proj" $_fargs config 2>/dev/null \
                | sed -n 's/^[[:space:]]*image:[[:space:]]*//p' | tr -d '"'\''')
    fi
    if [ -z "$_imgs" ]; then
        say "stack $_proj: could not resolve any image, compose file may be invalid"
        emit "STACK|$_proj|$_first|0|0|error|cannot resolve images"
        return
    fi

    _before=$(mktemp)
    for _i in $_imgs; do
        _id=$(docker image inspect -f '{{.Id}}' "$_i" 2>/dev/null) || _id=absent
        [ -z "$_id" ] && _id=absent
        printf '%s %s\n' "$_i" "$_id" >> "$_before"
    done

    _total=0
    _updated=0
    _status=ok
    _note=""

    if [ "$DRY" -eq 1 ]; then
        for _i in $_imgs; do
            _total=$((_total + 1))
            emit "IMAGE|$_proj|$_i|0"
        done
        _note="dry run, nothing pulled"
        rm -f "$_before"
        emit "STACK|$_proj|$_first|$_total|0|ok|$_note"
        return
    fi

    # shellcheck disable=SC2086
    quiet dc -p "$_proj" $_fargs pull
    _pull_rc=$?
    [ $_pull_rc -ne 0 ] && { _status=warn; _note="pull returned $_pull_rc"; }

    for _i in $_imgs; do
        _total=$((_total + 1))
        _old=$(awk -v k="$_i" '$1==k {print $2}' "$_before")
        _new=$(docker image inspect -f '{{.Id}}' "$_i" 2>/dev/null) || _new=absent
        [ -z "$_new" ] && _new=absent
        if [ "$_old" != "$_new" ]; then
            _updated=$((_updated + 1))
            emit "IMAGE|$_proj|$_i|1"
            say "image updated: $_i"
        else
            emit "IMAGE|$_proj|$_i|0"
        fi
    done
    rm -f "$_before"

    # shellcheck disable=SC2086
    quiet dc -p "$_proj" $_fargs up -d --remove-orphans
    _up_rc=$?
    if [ $_up_rc -ne 0 ]; then
        _status=error
        _note="up -d returned $_up_rc"
    fi

    emit "STACK|$_proj|$_first|$_total|$_updated|$_status|$_note"
}

while IFS='|' read -r proj files wd; do
    [ -z "$proj" ] && continue
    update_stack "$proj" "$files" "$wd"
done < "$STACKS"

# ---------------------------------------------------------------------------
# compose files sitting on disk that are not part of any known project
# ---------------------------------------------------------------------------
cd / || exit 1

if [ "$DISCOVER" -eq 1 ]; then
    for base in /opt /srv /root /home /docker /data /var/lib/docker-compose /mnt /etc/docker-compose; do
        [ -d "$base" ] || continue
        find "$base" -maxdepth 4 -type f \
            \( -name 'docker-compose.yml'  -o -name 'docker-compose.yaml' \
            -o -name 'compose.yml'        -o -name 'compose.yaml' \) 2>/dev/null
    done | sort -u | while read -r cf; do
        d=$(dirname "$cf")
        grep -qxF "$d" "$KNOWN_DIRS" 2>/dev/null && continue
        if [ "$ADOPT" -eq 1 ] && [ "$DRY" -eq 0 ]; then
            say "adopting unmanaged compose file $cf"
            update_stack "$(basename "$d")" "$cf" "$d"
        else
            emit "ORPHAN|$cf"
            say "found unmanaged compose file (not touched): $cf"
        fi
    done
fi

# ---------------------------------------------------------------------------
# inventory + housekeeping
# ---------------------------------------------------------------------------
docker ps -a --format '{{.Names}}|{{.Image}}|{{.State}}|{{.Ports}}|{{.Label "com.docker.compose.project"}}' \
    2>/dev/null | while IFS= read -r c; do
    emit "CONTAINER|$c"
done

if [ "$DO_PRUNE" -eq 1 ] && [ "$DRY" -eq 0 ]; then
    rule "docker image prune"
    if [ "$PRUNE_ALL" -eq 1 ]; then
        _p=$(capture docker image prune -af)
    else
        _p=$(capture docker image prune -f)
    fi
    _rec=$(printf '%s\n' "$_p" | sed -n 's/^Total reclaimed space: *//p' | head -n1)
    [ -n "$_rec" ] && emit "RECLAIMED=$_rec"
fi

emit "AGENT_DONE=1"
exit 0
