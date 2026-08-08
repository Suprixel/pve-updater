#!/usr/bin/env python3
"""
pve-updater web backend.

Serves the dashboard and a small API:

    GET  /api/state           node name, guest list, timer schedule, run state
    GET  /api/config          current settings, parsed          [token]
    PUT  /api/config          write settings back               [token]
    POST /api/run             start a run                       [token]
    GET  /api/run/log?from=N  new bytes of the running log
    POST /api/run/stop        signal a running update           [token]

Everything under [token] requires the X-PVE-Token header to match
/etc/pve-updater/web.token. That token is root on this node: starting a run
executes pve-updater, which runs as root by design. Treat it like a password.

Python standard library only.
"""
import hmac
import json
import os
import re
import shlex
import signal
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

WEB_DIR = "/var/lib/pve-updater/web"
CONF = "/etc/pve-updater/pve-updater.conf"
TOKEN_FILE = "/etc/pve-updater/web.token"
BIN = "/usr/local/bin/pve-updater"
LIVE_LOG = "/var/lib/pve-updater/live.log"
BIND = os.environ.get("PVE_UPDATER_BIND", "0.0.0.0")
PORT = int(os.environ.get("PVE_UPDATER_PORT", "8099"))

# --------------------------------------------------------------------------
# settings schema. Anything not listed here is refused: this file is sourced
# as bash by a root script, so a loose value is a root shell.
# --------------------------------------------------------------------------
BOOL = ("bool", re.compile(r"^(true|false)$"))
INT = ("int", re.compile(r"^\d{1,6}$"))
IDS = ("ids", re.compile(r"^(\d{1,9})(\s+\d{1,9})*$|^$"))
URL = ("url", re.compile(r"^(https?://[A-Za-z0-9._~:/?#@!&+,;=%\[\]-]{1,300})?$"))
WORD = ("word", re.compile(r"^[A-Za-z0-9._~+/=-]{0,300}$"))

# Anything that bash would expand inside a double quoted string. No setting
# has a legitimate reason to contain these, and this file is sourced as root.
DANGEROUS = re.compile(r"[$`\"\\\n\r]")

SCHEMA = {
    "UPDATE_HOST": BOOL, "UPDATE_GUESTS": BOOL, "UPDATE_PACKAGES": BOOL,
    "UPDATE_DOCKER": BOOL, "INCLUDE_STOPPED": BOOL,
    "SNAPSHOT_BEFORE_UPDATE": BOOL, "DOCKER_PRUNE": BOOL,
    "DOCKER_PRUNE_ALL": BOOL, "DISCOVER_COMPOSE_FILES": BOOL,
    "ADOPT_ORPHAN_STACKS": BOOL, "REBOOT_HOST_IF_REQUIRED": BOOL,
    "POST_START_WAIT": INT, "SNAPSHOT_KEEP": INT, "REPORT_RETENTION": INT,
    "EXCLUDE_CTIDS": IDS,
    "NTFY_URL": URL, "WEBHOOK_URL": URL, "NTFY_TOKEN": WORD,
    "BTOP_MONITOR": BOOL, "BTOP_PORT": INT,
}

# mode -> extra CLI flags. "monitor" always needs "only" to be meaningful,
# but is not rejected without it: an unrestricted --monitor-only just walks
# every running guest, which is a legitimate "fix them all" action too.
RUN_MODES = {
    "full": [],
    "dry": ["--dry-run"],
    "inventory": ["--inventory"],
    "monitor": ["--monitor-only"],
}

_run_lock = threading.Lock()
_run = {"proc": None, "mode": None, "started": None, "exit": None, "unit": None}


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------
def token():
    try:
        with open(TOKEN_FILE) as f:
            return f.read().strip()
    except OSError:
        return ""


def node_name():
    return os.uname().nodename.split(".")[0]


def sh(args, timeout=20):
    try:
        p = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
        return p.stdout
    except Exception:
        return ""


def guests():
    """Every guest on this node, containers and VMs alike."""
    out = sh(["pvesh", "get", "/cluster/resources", "--type", "vm",
              "--output-format", "json"])
    me = node_name()
    result = []
    try:
        for g in json.loads(out or "[]"):
            if g.get("node") != me or g.get("template"):
                continue
            result.append({
                "id": str(g.get("vmid")),
                "name": g.get("name") or "guest-%s" % g.get("vmid"),
                "type": "lxc" if g.get("type") == "lxc" else "qemu",
                "status": g.get("status", "unknown"),
            })
    except Exception:
        pass
    result.sort(key=lambda g: int(g["id"]))
    return result


def next_run():
    v = sh(["systemctl", "show", "-p", "NextElapseUSecRealtime", "--value",
            "pve-updater.timer"]).strip()
    return v or "not scheduled"


def read_conf():
    """Parse KEY=value out of the config, keeping the file itself untouched."""
    values, order = {}, []
    try:
        with open(CONF) as f:
            for line in f:
                m = re.match(r"^\s*([A-Z_]+)=([^#]*?)\s*(#.*)?$", line.rstrip("\n"))
                if not m or m.group(1) not in SCHEMA:
                    continue
                key, raw = m.group(1), m.group(2).strip()
                kind = SCHEMA[key][0]
                if kind == "ids":
                    raw = raw.strip("()").strip()
                    values[key] = [x for x in raw.split() if x]
                elif kind == "bool":
                    values[key] = raw == "true"
                elif kind == "int":
                    values[key] = int(raw or 0)
                else:
                    values[key] = raw.strip('"').strip("'")
                order.append(key)
    except OSError:
        pass
    return values, order


def format_value(key, val):
    kind = SCHEMA[key][0]
    if kind == "bool":
        return "true" if val else "false"
    if kind == "int":
        return str(int(val))
    if kind == "ids":
        items = val if isinstance(val, list) else str(val).split()
        return "(%s)" % " ".join(str(int(x)) for x in items)
    return '"%s"' % str(val)


def validate(key, val):
    kind, rx = SCHEMA[key]
    if kind == "bool":
        return isinstance(val, bool)
    if kind == "int":
        return isinstance(val, int) and 0 <= val <= 999999
    if kind == "ids":
        items = val if isinstance(val, list) else []
        return all(re.match(r"^\d{1,9}$", str(x)) for x in items)
    if not isinstance(val, str) or DANGEROUS.search(val):
        return False
    return bool(rx.match(val))


def write_conf(updates):
    """Rewrite only the values, leaving every comment and blank line in place."""
    for key, val in updates.items():
        if key not in SCHEMA:
            raise ValueError("unknown setting: %s" % key)
        if not validate(key, val):
            raise ValueError("bad value for %s" % key)

    with open(CONF) as f:
        lines = f.read().split("\n")

    seen = set()
    for i, line in enumerate(lines):
        m = re.match(r"^(\s*([A-Z_]+)=)([^#]*?)(\s*)(#.*)?$", line)
        if not m:
            continue
        key = m.group(2)
        if key not in updates:
            continue
        new = format_value(key, updates[key])
        pad = m.group(4) or ""
        # keep the inline comment aligned where it already sits
        if m.group(5):
            width = len(m.group(3)) + len(pad)
            pad = " " * max(1, width - len(new))
            lines[i] = m.group(1) + new + pad + m.group(5)
        else:
            lines[i] = m.group(1) + new
        seen.add(key)

    missing = [k for k in updates if k not in seen]
    if missing:
        lines.append("")
        lines.append("# added from the dashboard")
        for key in missing:
            lines.append("%s=%s" % (key, format_value(key, updates[key])))

    body = "\n".join(lines)
    tmp = CONF + ".tmp"
    with open(tmp, "w") as f:
        f.write(body)
    os.chmod(tmp, 0o644)

    check = subprocess.run(["bash", "-n", tmp], capture_output=True, text=True)
    if check.returncode != 0:
        os.unlink(tmp)
        raise ValueError("refused to write a file bash cannot parse: %s"
                         % check.stderr.strip())
    try:
        os.replace(CONF, CONF + ".bak")
    except OSError:
        pass
    os.replace(tmp, CONF)


def have(prog):
    return subprocess.run(["sh", "-c", "command -v " + prog],
                          capture_output=True).returncode == 0


def systemd_running():
    """systemd-run is only useful when systemd is actually PID 1."""
    try:
        with open("/proc/1/comm") as f:
            return f.read().strip() == "systemd" and have("systemd-run")
    except OSError:
        return False


def start_run(mode, only):
    """
    Launch the updater.

    Whenever systemd is available the run goes into its own transient unit via
    systemd-run rather than being forked from this process. That matters: this
    service could be sandboxed, and pct needs capabilities and namespace access
    that a sandbox takes away. A transient unit is created by PID 1, so it
    starts from a clean slate no matter how this process is confined.
    """
    with _run_lock:
        p = _run["proc"]
        if p and p.poll() is None:
            raise RuntimeError("a run is already going")

        if mode not in RUN_MODES:
            raise ValueError("unknown mode")

        args = [BIN] + RUN_MODES[mode]
        if only:
            args += ["--only", ",".join(str(int(x)) for x in only)]

        log = open(LIVE_LOG, "wb", buffering=0)
        log.write(("$ %s\n\n" % " ".join(shlex.quote(a) for a in args)).encode())

        unit = None
        if systemd_running():
            unit = "pve-updater-manual-%d" % int(time.time())
            inner = "%s >>%s 2>&1" % (" ".join(shlex.quote(a) for a in args),
                                      shlex.quote(LIVE_LOG))
            cmd = ["systemd-run", "--wait", "--quiet", "--collect",
                   "--unit", unit,
                   "--property=Type=oneshot",
                   "--property=TimeoutStartSec=3h",
                   "--property=SuccessExitStatus=1",
                   "/bin/sh", "-c", inner]
            proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=log,
                                    stdin=subprocess.DEVNULL, close_fds=True,
                                    preexec_fn=os.setsid)
        else:
            proc = subprocess.Popen(args, stdout=log, stderr=subprocess.STDOUT,
                                    stdin=subprocess.DEVNULL, close_fds=True,
                                    preexec_fn=os.setsid)

        _run.update({"proc": proc, "mode": mode, "started": time.time(),
                     "exit": None, "unit": unit})
        return args


def run_state():
    with _run_lock:
        p = _run["proc"]
        if p is None:
            return {"running": False, "mode": None, "exit": _run["exit"],
                    "started": None}
        code = p.poll()
        if code is not None and _run["exit"] is None:
            _run["exit"] = code
        return {"running": code is None, "mode": _run["mode"],
                "exit": _run["exit"] if code is not None else None,
                "started": _run["started"]}


# --------------------------------------------------------------------------
# http
# --------------------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    server_version = "pve-updater"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass  # journald already has systemd's own record of the unit

    # ---------------------------------------------------------------- utils
    def send_json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def fail(self, code, msg):
        self.send_json({"error": msg}, code)

    def authed(self):
        want = token()
        if not want:
            self.fail(503, "no token file on the node, cannot authenticate")
            return False
        got = self.headers.get("X-PVE-Token", "")
        if not hmac.compare_digest(got, want):
            self.fail(401, "bad or missing token")
            return False
        return True

    def body_json(self):
        try:
            n = int(self.headers.get("Content-Length", "0"))
            if n <= 0 or n > 1_000_000:
                return {}
            return json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            return {}

    # ---------------------------------------------------------------- static
    def serve_static(self, path):
        rel = path.lstrip("/") or "index.html"
        full = os.path.realpath(os.path.join(WEB_DIR, rel))
        if not full.startswith(os.path.realpath(WEB_DIR) + os.sep) and \
           full != os.path.realpath(WEB_DIR):
            return self.fail(403, "nope")
        if os.path.isdir(full):
            full = os.path.join(full, "index.html")
        if not os.path.isfile(full):
            return self.fail(404, "not found")
        ext = os.path.splitext(full)[1]
        ctype = {".html": "text/html; charset=utf-8",
                 ".json": "application/json",
                 ".log": "text/plain; charset=utf-8",
                 ".css": "text/css", ".js": "text/javascript"}.get(ext,
                                                                   "application/octet-stream")
        with open(full, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    # ---------------------------------------------------------------- routes
    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)

        if u.path == "/api/state":
            return self.send_json({
                "node": node_name(),
                "guests": guests(),
                "next_run": next_run(),
                "run": run_state(),
                "has_token": bool(token()),
            })

        if u.path == "/api/config":
            if not self.authed():
                return
            values, _ = read_conf()
            return self.send_json({"values": values, "path": CONF})

        if u.path == "/api/run/log":
            try:
                start = int(q.get("from", ["0"])[0])
            except ValueError:
                start = 0
            data, size = "", 0
            try:
                size = os.path.getsize(LIVE_LOG)
                if start > size:
                    start = 0
                with open(LIVE_LOG, "rb") as f:
                    f.seek(start)
                    data = f.read(200_000).decode("utf-8", "replace")
            except OSError:
                pass
            return self.send_json({"data": data, "offset": start + len(data.encode()),
                                   "size": size, "run": run_state()})

        return self.serve_static(u.path)

    def do_PUT(self):
        if urlparse(self.path).path != "/api/config":
            return self.fail(404, "not found")
        if not self.authed():
            return
        body = self.body_json()
        values = body.get("values")
        if not isinstance(values, dict) or not values:
            return self.fail(400, "send {\"values\": {...}}")
        try:
            write_conf(values)
        except ValueError as e:
            return self.fail(400, str(e))
        except OSError as e:
            return self.fail(500, "could not write the config: %s" % e)
        fresh, _ = read_conf()
        return self.send_json({"ok": True, "values": fresh})

    def do_POST(self):
        u = urlparse(self.path)

        if u.path == "/api/run":
            if not self.authed():
                return
            body = self.body_json()
            mode = body.get("mode", "full")
            only = body.get("only") or []
            if not isinstance(only, list) or len(only) > 64:
                return self.fail(400, "bad target list")
            try:
                args = start_run(mode, only)
            except RuntimeError as e:
                return self.fail(409, str(e))
            except (ValueError, TypeError):
                return self.fail(400, "bad request")
            except OSError as e:
                return self.fail(500, "could not start: %s" % e)
            return self.send_json({"ok": True, "command": " ".join(args)})

        if u.path == "/api/run/stop":
            if not self.authed():
                return
            with _run_lock:
                p = _run["proc"]
                if not p or p.poll() is not None:
                    return self.fail(409, "nothing is running")
                unit = _run.get("unit")
                try:
                    if unit:
                        subprocess.run(["systemctl", "stop", unit + ".service"],
                                       capture_output=True, timeout=30)
                    else:
                        os.killpg(os.getpgid(p.pid), signal.SIGTERM)
                except (OSError, subprocess.SubprocessError) as e:
                    return self.fail(500, str(e))
            return self.send_json({"ok": True})

        return self.fail(404, "not found")


def main():
    os.chdir(WEB_DIR)
    srv = ThreadingHTTPServer((BIND, PORT), Handler)
    srv.daemon_threads = True
    srv.serve_forever()


if __name__ == "__main__":
    main()
