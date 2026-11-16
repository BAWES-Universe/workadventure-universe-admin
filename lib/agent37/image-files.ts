/**
 * What goes into the image every Brick computer is made from (build handoff v2, step 4), as text, so Orbit builds it on Agent37 itself and
 * no registry or local Docker is needed. Agent37's cloud build takes a gzipped folder with a Dockerfile at its root.
 *
 * The image keeps the base image's own ENTRYPOINT (it starts Hermes and its gateway; a Dockerfile that replaces it loses the chat API) and
 * adds, in /usr/local/bin:
 *   universe-up       brings the parts up and is safe to run any number of times: a screen (the base's Xvfb on :99 and openbox; x11vnc and websockify on 6901), a visible Chromium
 *                     for Hermes' browser tool (DevTools on 9222, loopback), and the local model address; writes Hermes' config once.
 *   universe-proxy    the model address on 127.0.0.1:8650. It reads the relay's address and the job's key from a file on EVERY call, so a new
 *                     key never needs Hermes restarted. Hermes holds no real key at all.
 *   universe-supervise brings a part back that stopped.
 *   universe-fence    take-over fence: stops every process the agent started (the screen, the browser and the gateway stay).
 *   universe-clean    clears the browser's sign-in state between jobs.
 *   universe-mark     run by Orbit as root once a computer is ready: records the moment from which everything that runs is the agent's (see the fence).
 *
 * Nothing here is written under /home/node at build time (it is masked at runtime): the scripts run from /usr/local/bin and write
 * their state under the home folder when they run.
 *
 * The scripts avoid backticks and dollar-braces on purpose, so they sit in plain template strings without escaping.
 */

/** Goes up when anything in the image changes; the machine's own set-up (`universe-up`) is redone when it differs from the one it saw. */
export const IMAGE_SETUP_VERSION = '1';

/** The base image. A dated tag is better for reproducible builds; the registered image is pinned by digest at build anyway. */
export const BASE_IMAGE = 'ghcr.io/agent37-platform/hermes-base';
export const BASE_TAG = 'latest';

/** Where the local model address listens inside the machine, and where Orbit writes the relay's address and the job's key. */
export const LOCAL_MODEL_PORT = 8650;
export const RELAY_FILE = '.universe/relay.json';

export const DOCKERFILE = String.raw`FROM ${BASE_IMAGE}:${BASE_TAG}

USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends xvfb x11vnc novnc websockify chromium x11-utils procps python3 fonts-liberation fonts-noto-color-emoji ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY universe-up universe-supervise universe-proxy universe-fence universe-clean universe-files universe-mark /usr/local/bin/
RUN chmod 0755 /usr/local/bin/universe-up /usr/local/bin/universe-supervise /usr/local/bin/universe-proxy /usr/local/bin/universe-fence /usr/local/bin/universe-clean /usr/local/bin/universe-files /usr/local/bin/universe-mark
# Hermes' browser tool drives the visible Chromium that the screen shows
ENV DISPLAY=:99 BROWSER_CDP_URL=http://127.0.0.1:9222 AGENT37_SCREEN_GEOMETRY=1440x900
USER node
`;

export const UNIVERSE_UP = String.raw`#!/bin/sh
# Brings this computer's parts up. Safe to run any number of times, and the supervisor at the end runs it again every few seconds.
# Prints lines Orbit reads: ready=1 or ready=0 reason=..., and restart=1 while Hermes' newly written config still waits for a restart.
HOME_DIR="$HOME"
[ -n "$HOME_DIR" ] || HOME_DIR=/home/node
STATE="$HOME_DIR/.universe"
VERSION="__VERSION__"
GEOMETRY="$AGENT37_SCREEN_GEOMETRY"
[ -n "$GEOMETRY" ] || GEOMETRY=1440x900
WIDTH="$(echo "$GEOMETRY" | cut -dx -f1)"
HEIGHT="$(echo "$GEOMETRY" | cut -dx -f2)"
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
export DISPLAY=:99
CHILD=0
[ "$1" = "--child" ] && CHILD=1

mkdir -p "$STATE" "$HOME_DIR/.hermes" "$HOME_DIR/.config" 2>/dev/null || { echo "ready=0 reason=state_folder"; exit 1; }
LOGS="$STATE/logs"
mkdir -p "$LOGS" 2>/dev/null

# One at a time: the supervisor's run yields to whoever is bringing the parts up, and a person's run waits its turn. A lock left by a
# run that died is old and is taken over.
LOCK="$STATE/up.lock"
if [ -d "$LOCK" ] && [ -n "$(find "$LOCK" -maxdepth 0 -mmin +1 2>/dev/null)" ]; then rmdir "$LOCK" 2>/dev/null; fi
waited=0
until mkdir "$LOCK" 2>/dev/null; do
  [ "$CHILD" = "1" ] && exit 0
  waited=$((waited+1))
  [ "$waited" -gt 150 ] && { echo "ready=0 reason=busy"; exit 1; }
  sleep 0.2
done
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

# The agent reads its model config only when it starts. A config written here leaves a restart pending that stays until the machine has
# really restarted (the boot is a new one), whatever else fails in between: a later run that succeeds still asks for it.
# Which start this is: the kernel's id for this boot. (The first process's start time says nothing here: on a computer it is 0 or 1 on every boot.)
INIT="$(cat /proc/sys/kernel/random/boot_id 2>/dev/null)"
[ -n "$INIT" ] || INIT="$(sed 's/.*) //' /proc/1/stat 2>/dev/null | cut -d' ' -f20)"
if [ "$(cat "$STATE/setup" 2>/dev/null)" != "$VERSION" ]; then
  CONFIG="$HOME_DIR/.hermes/config.yaml"
  if [ -f "$CONFIG" ] && [ ! -f "$CONFIG.stock" ]; then cp "$CONFIG" "$CONFIG.stock" 2>/dev/null; fi
  cat > "$CONFIG.new" <<CONFIGEND
model:
  default: universe-ai
  provider: custom
  base_url: http://127.0.0.1:__PORT__/v1
  api_key: universe-local
custom_providers:
  - name: universe
    base_url: http://127.0.0.1:__PORT__/v1
    api_key: universe-local
    api_mode: chat_completions
CONFIGEND
  mv "$CONFIG.new" "$CONFIG" || { echo "ready=0 reason=config"; exit 1; }
  printf '%s' "$INIT" > "$STATE/restart.pending" || { echo "ready=0 reason=config"; exit 1; }
  printf '%s' "$VERSION" > "$STATE/setup.new" && mv "$STATE/setup.new" "$STATE/setup"
fi
restart=0
if [ -f "$STATE/restart.pending" ]; then
  # Without the machine's first process there is no proof of a restart: the marker is kept, and the restart is asked for until one can be told
  if [ -z "$INIT" ]; then restart=1
  elif [ "$(cat "$STATE/restart.pending" 2>/dev/null)" = "$INIT" ]; then restart=1
  else rm -f "$STATE/restart.pending"; fi
fi

# A cleanup that could not remove the browser's profile left a mark: no job may use that profile. It is removed here, before the browser
# runs, and a profile that still cannot be removed means the machine is not ready.
PROFILE_DIR="$HOME_DIR/.config/universe-chromium"
if [ -f "$STATE/profile.dirty" ]; then
  pkill -x chromium 2>/dev/null
  pkill -x chrome 2>/dev/null
  i=0
  while pgrep -x chromium >/dev/null 2>&1 || pgrep -x chrome >/dev/null 2>&1; do
    i=$((i+1))
    if [ "$i" -eq 20 ]; then pkill -9 -x chromium 2>/dev/null; pkill -9 -x chrome 2>/dev/null; fi
    [ "$i" -gt 50 ] && { echo "ready=0 reason=profile_not_cleared"; exit 1; }
    sleep 0.2
  done
  rm -rf "$PROFILE_DIR" "$HOME_DIR/.cache/chromium" 2>/dev/null
  if [ -e "$PROFILE_DIR" ] || [ -e "$HOME_DIR/.cache/chromium" ]; then echo "ready=0 reason=profile_not_cleared"; exit 1; fi
  rm -f "$STATE/profile.dirty"
fi

# Starts a part unless it is running. Each is its own session, so it outlives the command that started it.
run() {
  name="$1"
  shift
  if pgrep -x "$name" >/dev/null 2>&1; then return 0; fi
  nohup setsid "$@" >>"$LOGS/$name.log" 2>&1 </dev/null &
}

# The base image's own start-up brings up the screen (Xvfb on :99 and the openbox window manager); give it time, and only if it never
# appears start a screen of our own on the same address.
i=0
while [ ! -S /tmp/.X11-unix/X99 ] && [ "$i" -lt 300 ]; do sleep 0.1; i=$((i+1)); done
if [ ! -S /tmp/.X11-unix/X99 ]; then
  run Xvfb Xvfb :99 -screen 0 "$GEOMETRY"x24 -nolisten tcp
  i=0
  while [ ! -S /tmp/.X11-unix/X99 ] && [ "$i" -lt 50 ]; do sleep 0.1; i=$((i+1)); done
fi
run x11vnc x11vnc -display :99 -rfbport 5900 -localhost -forever -shared -nopw -quiet
run websockify websockify --web /usr/share/novnc 6901 127.0.0.1:5900
if ! pgrep -x chromium >/dev/null 2>&1; then
  nohup setsid chromium --user-data-dir="$HOME_DIR/.config/universe-chromium" --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1 \
    --no-sandbox --test-type --disable-dev-shm-usage --no-first-run --no-default-browser-check --hide-crash-restore-bubble --start-maximized \
    about:blank >>"$LOGS/chromium.log" 2>&1 </dev/null &
fi
if ! pgrep -f universe-proxy >/dev/null 2>&1; then
  nohup setsid python3 /usr/local/bin/universe-proxy >>"$LOGS/proxy.log" 2>&1 </dev/null &
fi

# The parts must answer before this says ready (the browser's DevTools and the model address)
answers() {
  python3 - "$1" <<'PYEND'
import socket, sys
s = socket.socket()
s.settimeout(0.5)
try:
    s.connect(("127.0.0.1", int(sys.argv[1])))
    sys.exit(0)
except Exception:
    sys.exit(1)
PYEND
}
i=0
while [ "$i" -lt 100 ]; do
  if answers 9222 && answers __PORT__ && answers 6901; then break; fi
  sleep 0.2
  i=$((i+1))
done
if ! answers 9222; then echo "ready=0 reason=browser"; exit 1; fi
if ! answers __PORT__; then echo "ready=0 reason=model_address"; exit 1; fi
if ! answers 6901; then echo "ready=0 reason=screen"; exit 1; fi

# A part that stops later (the browser crashing) is brought back by this supervisor
if [ "$CHILD" = "0" ] && ! pgrep -f universe-supervise >/dev/null 2>&1; then
  nohup setsid /usr/local/bin/universe-supervise >/dev/null 2>&1 </dev/null &
fi
echo "ready=1 restart=$restart"
exit 0
`
  .replace(/__VERSION__/g, IMAGE_SETUP_VERSION)
  .replace(/__PORT__/g, String(LOCAL_MODEL_PORT));

export const UNIVERSE_PROXY = String.raw`#!/usr/bin/env python3
# The model address on this computer: 127.0.0.1:__PORT__. Hermes talks to it as if it were any OpenAI-format server and holds no real key.
# On EVERY call it reads the relay's address and this job's key from ~/.universe/relay.json and passes the call on, so a new key never
# needs Hermes restarted. It logs the method, the path and the status, never a body or a key.
import http.client
import json
import os
import sys
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("UNIVERSE_PROXY_PORT") or __PORT__)
HOME = os.environ.get("HOME") or "/home/node"
RELAY = os.path.join(HOME, ".universe", "relay.json")
CONNECT_SECONDS = 10
READ_SECONDS = 900
SKIP = {"connection", "keep-alive", "transfer-encoding", "content-length", "host", "authorization", "upgrade", "proxy-authorization", "te", "trailer"}


def relay():
    try:
        with open(RELAY, "r", encoding="utf-8") as handle:
            data = json.load(handle)
        url = urllib.parse.urlparse(data["url"])
        token = data["token"]
        if url.scheme not in ("http", "https") or not url.hostname or not isinstance(token, str) or not token:
            return None
        return url, token
    except Exception:
        return None


class Handler(BaseHTTPRequestHandler):
    # The answer ends when the connection closes: a streamed reply is passed on as it comes, with no length known up front
    protocol_version = "HTTP/1.0"
    server_version = "universe-proxy"

    def log_message(self, fmt, *args):
        pass

    def say(self, status, message, code):
        body = json.dumps({"error": {"message": message, "type": "server_error", "code": code}}).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def handle_any(self):
        found = relay()
        if not found:
            self.say(503, "This computer has no model key yet.", "no_relay")
            return
        url, token = found
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length > 0 else None
        headers = {name: value for name, value in self.headers.items() if name.lower() not in SKIP}
        headers["Authorization"] = "Bearer " + token
        if body is not None:
            headers["Content-Length"] = str(len(body))
        path = url.path.rstrip("/") + self.path
        try:
            make = http.client.HTTPSConnection if url.scheme == "https" else http.client.HTTPConnection
            connection = make(url.hostname, url.port, timeout=CONNECT_SECONDS)
            connection.connect()
            connection.sock.settimeout(READ_SECONDS)
            connection.request(self.command, path, body=body, headers=headers)
            answer = connection.getresponse()
        except Exception:
            sys.stderr.write("%s %s -> not reached\n" % (self.command, self.path))
            self.say(502, "The model address could not be reached.", "upstream_unreachable")
            return
        self.send_response(answer.status)
        for name, value in answer.getheaders():
            if name.lower() not in SKIP:
                self.send_header(name, value)
        self.end_headers()
        try:
            while True:
                chunk = answer.read1(65536)
                if not chunk:
                    break
                self.wfile.write(chunk)
                self.wfile.flush()
        except Exception:
            pass
        finally:
            connection.close()
        sys.stderr.write("%s %s -> %s\n" % (self.command, self.path, answer.status))

    do_GET = handle_any
    do_POST = handle_any


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
`.replace(/__PORT__/g, String(LOCAL_MODEL_PORT));

export const UNIVERSE_SUPERVISE = String.raw`#!/bin/sh
# Brings a part back that stopped (the browser crashing): runs universe-up again every few seconds.
# Every program it runs is the system's own, whatever PATH it was started with: the fence keeps what this script starts, so a program the
# agent put first in PATH must never be one of them.
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
while :; do
  sleep 5
  /usr/local/bin/universe-up --child >/dev/null 2>&1
done
`;

export const UNIVERSE_FENCE = String.raw`#!/usr/bin/env python3
# The take-over fence on the machine. Before the person has the keyboard, every process the agent started is stopped, and a second look
# proves none is left. What stays: the screen, the browser, the model address, this machine's own agent gateway, and whatever started
# this command. Everything else is the agent's (or something it started) and goes.
#
# "Started by the agent" is told by TIME, because the agent runs as the same user as the computer's own parts (Agent37's gateway, Hermes, the
# terminal and file services, the command runner) and anything can be started under any name. Orbit runs universe-mark as root once the
# computer is ready, before any job has used it; that writes a root-owned note (this boot, and the moment). A process that was already
# running at that moment is the computer's own, because nothing the agent started can be older than the note, and one started after it is not.
# The agent cannot write the note. A computer with no note for this boot is not fenced: nothing is stopped and nothing is proved.
#
#   universe-fence           stops them, prints killed=N (or unmarked=1 and exits 3)
#   universe-fence --check   prints remaining=N and exits 0 only when N is 0 (or unmarked=1 and exits 3)
import os
import re
import signal
import sys
import time

HOME = os.environ.get("HOME") or "/home/node"
PROFILE = os.path.join(HOME, ".config", "universe-chromium")
SCRIPTS_DIR = "/usr/local/bin"
# The desktop's parts are known by what they ARE, never by the words on their command line (the agent can start anything under any
# name): the program file must belong to root and be closed to everyone else (the agent cannot make one), and the arguments must be the ones
# universe-up starts it with. The screen's own server and window manager are the base image's, so only the program is checked.
DESKTOP_PROGRAMS = {"Xvfb", "openbox"}
# What the screen's server and window manager must NOT be started with: the agent can run these root-owned programs itself, so a second
# screen (any display but :99), or a window manager that runs a command of its own, is the agent's and is never kept. And what they
# start is not kept below them: only the browser's own helpers are.
OPENBOX_RUNS = ("--startup", "--config-file", "--exec")
INTERPRETERS = re.compile(r"^(python3(\.\d+)?|sh|dash|bash)$")
OWN_SCRIPTS = {os.path.join(SCRIPTS_DIR, name) for name in ("universe-proxy", "universe-supervise", "universe-up", "universe-fence")}
X11VNC_ARGS = ["-display", ":99", "-rfbport", "5900", "-localhost", "-forever", "-shared", "-nopw", "-quiet"]
WEBSOCKIFY_ARGS = ["--web", "/usr/share/novnc", "6901", "127.0.0.1:5900"]
CHROMIUM_FLAGS = ["--user-data-dir=" + PROFILE, "--remote-debugging-port=9222", "--remote-debugging-address=127.0.0.1"]
# The agent's gateway answers on these ports; whoever listens there stays, and so does everything above it
GATEWAY_PORTS = {3737, 8642}
# The note universe-mark writes as root, and the folder it is in: both must belong to root and be closed to everyone else
MARK_DIR = "/run/universe"
MARK = MARK_DIR + "/mark"
BOOT_ID = "/proc/sys/kernel/random/boot_id"
# What the computer's own command runner is made of: a program file of Agent37's, root's and closed to everyone else
AGENT37_DIR = "/.agent37/"


def pids():
    return [int(name) for name in os.listdir("/proc") if name.isdigit()]


def read(pid, name):
    try:
        with open("/proc/%d/%s" % (pid, name), "rb") as handle:
            return handle.read()
    except Exception:
        return b""


def stat_fields(pid):
    # The fields after the command's name (which may hold spaces and brackets) start after the last closing bracket
    text = read(pid, "stat").decode("utf-8", "replace")
    return text[text.rfind(")") + 2:].split()


def parent(pid):
    try:
        return int(stat_fields(pid)[1])
    except Exception:
        return 0


def argv(pid):
    return [part.decode("utf-8", "replace") for part in read(pid, "cmdline").split(b"\0") if part]


def trusted(path):
    # A program file that root owns and nobody else can write: the agent (which is not root) cannot have made it, copied it or changed it
    try:
        info = os.stat(path)
    except Exception:
        return False
    return info.st_uid == 0 and not (info.st_mode & 0o022)


def program(pid):
    try:
        path = os.path.realpath(os.readlink("/proc/%d/exe" % pid))
    except Exception:
        return None
    return path if trusted(path) else None


def desktop_part(pid):
    path = program(pid)
    if not path:
        return False
    name = os.path.basename(path)
    args = argv(pid)
    if name == "Xvfb":
        return [part for part in args[1:] if re.match(r"^:\d+$", part)] == [":99"]
    if name == "openbox":
        return not any(part.split("=")[0] in OPENBOX_RUNS for part in args[1:])
    if name == "x11vnc":
        return args[1:] == X11VNC_ARGS
    if name in ("chromium", "chrome"):
        # The browser the supervisor starts: on its own profile and its own debugging address. Its helper processes are kept as its children.
        return all(flag in args for flag in CHROMIUM_FLAGS)
    if INTERPRETERS.match(name) and len(args) >= 2 and os.path.isabs(args[1]):
        script = os.path.realpath(args[1])
        if script in OWN_SCRIPTS and trusted(script):
            return True
        if os.path.basename(script) == "websockify" and trusted(script):
            return args[2:] == WEBSOCKIFY_ARGS
    return False


def listeners():
    inodes = set()
    for table in ("tcp", "tcp6"):
        try:
            with open("/proc/net/" + table, "r", encoding="utf-8") as handle:
                rows = handle.read().splitlines()[1:]
        except Exception:
            continue
        for row in rows:
            fields = row.split()
            if len(fields) > 9 and fields[3] == "0A" and int(fields[1].rsplit(":", 1)[1], 16) in GATEWAY_PORTS:
                inodes.add(fields[9])
    found = set()
    if not inodes:
        return found
    for pid in pids():
        try:
            for name in os.listdir("/proc/%d/fd" % pid):
                try:
                    link = os.readlink("/proc/%d/fd/%s" % (pid, name))
                except Exception:
                    continue
                if link.startswith("socket:[") and link[8:-1] in inodes:
                    found.add(pid)
        except Exception:
            continue
    return found


def marked_at():
    # The moment (in clock ticks since the machine started) from which the agent is running, or None when this boot has no note
    try:
        for path in (MARK_DIR, MARK):
            info = os.stat(path)
            if info.st_uid != 0 or info.st_mode & 0o022:
                return None
        with open(MARK, "r", encoding="utf-8") as handle:
            boot, ticks = handle.read().split()[:2]
        with open(BOOT_ID, "r", encoding="utf-8") as handle:
            if handle.read().strip() != boot:
                return None
        return int(ticks)
    except Exception:
        return None


def started(pid):
    try:
        return int(stat_fields(pid)[19])
    except Exception:
        return None


def runner_part(pid):
    # Agent37's own command runner (it is what this very command runs under): a program file of theirs that root owns
    path = program(pid)
    return bool(path) and path.startswith(AGENT37_DIR)


CLOCK_TICKS = os.sysconf("SC_CLK_TCK")
SYSTEM_FOLDERS = ("/usr/", "/lib/", "/lib64/", "/bin/", "/sbin/", "/etc/ld.so.cache")
SHORT_SLEEP = re.compile(r"^\d{1,2}(\.\d+)?$")


def ticks_now():
    try:
        with open("/proc/uptime", "r", encoding="utf-8") as handle:
            return int(float(handle.read().split()[0]) * CLOCK_TICKS)
    except Exception:
        return None


def short_sleep(pid):
    # A short wait that does nothing and ends by itself. The computer's own start-up loop runs them as its children (process 1 waits
    # for each one), and it stops the whole computer when one is killed, so these are never touched. What keeps the exemption from being a
    # place to hide, all of it read from the process itself (an environment can be wiped from inside, so it is never the only proof):
    #   - it is what process 1 starts: a child of process 1 in process 1's own session and group (anything the agent starts is in the
    #     session of the command that started it, or in one of its own, and cannot join another session's group);
    #   - it is young (a real one ends within 30 seconds), is a real "sleep" with one number, and no one is tracing it;
    #   - no loader override in its environment, and nothing in its memory that is not the system's: every file mapped from a system folder,
    #     none deleted, and no memory that is both code and nameless (a library can copy itself there and unmap itself).
    path = program(pid)
    args = argv(pid)
    if not (bool(path) and os.path.basename(path) == "sleep" and len(args) == 2 and bool(SHORT_SLEEP.match(args[1])) and float(args[1]) <= 30):
        return False
    mine, first = stat_fields(pid), stat_fields(1)
    if len(mine) < 4 or len(first) < 4 or mine[1] != "1" or mine[2] != first[2] or mine[3] != first[3]:
        return False
    begun, now = started(pid), ticks_now()
    if begun is None or now is None or now - begun > 60 * CLOCK_TICKS:
        return False
    for line in read(pid, "status").decode("utf-8", "replace").splitlines():
        if line.startswith("TracerPid:") and line.split()[1] != "0":
            return False
    if any(entry.startswith(b"LD_") for entry in read(pid, "environ").split(b"\0")):
        return False
    seen, before = False, ""
    for line in read(pid, "maps").decode("utf-8", "replace").splitlines():
        parts = line.split(None, 5)
        if len(parts) < 5:
            continue
        seen = True
        code = "x" in parts[1]
        where = parts[5] if len(parts) == 6 else ""
        if where.endswith("(deleted)"):
            return False
        if where.startswith("/"):
            if not where.startswith(SYSTEM_FOLDERS):
                return False
        elif code and where not in ("[vdso]", "[vsyscall]", "[usertrap]") and not (where == "" and before == "[vvar]"):
            # The sandbox's own pages (the system call page, and the kernel's code page that comes straight after its data page) are
            # the only code that has no file
            return False
        before = where
    return seen


def protected(tree, cutoff):
    keep = {1, os.getpid()}
    # What was already running when the computer was made ready is the computer's own, and so is Agent37's command runner
    for pid in tree:
        begun = started(pid)
        if (begun is not None and begun <= cutoff) or runner_part(pid) or short_sleep(pid):
            keep.add(pid)
    # Whatever started this command, all the way up (the machine's own command runner), and the gateway's own chain
    for start in [os.getpid()] + list(listeners()):
        pid = start
        while pid > 1 and pid in tree and pid not in keep - {start}:
            keep.add(pid)
            pid = tree[pid]
    # The desktop's parts, and everything they started (the browser's own processes)
    desktop = {pid for pid in tree if pid != os.getpid() and desktop_part(pid)}
    keep |= desktop
    below = {}
    for pid, up in tree.items():
        below.setdefault(up, []).append(pid)
    # Everything below a desktop part is its own, whether or not it was already kept for another reason: a helper that was running before
    # the note was written still has children (a new tab's renderer) that were not. Its own record of what was visited, apart from the kept set.
    # (Not below the screen's server or window manager: the agent can run those programs itself, and what they start is the agent's.)
    parents = {pid for pid in desktop if os.path.basename(program(pid) or "") not in DESKTOP_PROGRAMS}
    seen = set(parents)
    stack = list(parents)
    while stack:
        for child in below.get(stack.pop(), []):
            if child not in seen:
                seen.add(child)
                keep.add(child)
                stack.append(child)
    return keep


def alive(pid):
    state = (stat_fields(pid) or ["?"])[0]
    # Kernel threads have no command line; a process waiting to be collected runs nothing
    return state not in ("Z", "X", "?") and read(pid, "cmdline") != b""


def others(cutoff):
    tree = {pid: parent(pid) for pid in pids()}
    keep = protected(tree, cutoff)
    return [pid for pid in tree if pid not in keep and alive(pid)]


cutoff = marked_at()
if cutoff is None:
    print("unmarked=1")
    sys.exit(3)

if "--check" in sys.argv:
    left = others(cutoff)
    print("remaining=%d" % len(left))
    sys.exit(0 if not left else 1)

killed = 0
for _ in range(5):
    victims = others(cutoff)
    if not victims:
        break
    for pid in victims:
        try:
            os.kill(pid, signal.SIGKILL)
            killed += 1
        except Exception:
            pass
    time.sleep(0.2)
print("killed=%d" % killed)
`;

export const UNIVERSE_CLEAN = String.raw`#!/bin/sh
# Clears the browser's sign-in state between jobs: a signed-in page one job was handed never carries into the next. The browser is
# stopped, its profile removed, and it comes back clean. Every screen link still open is closed too (the web screen is restarted), so a
# tab left open on a job that is over shows nothing and a new link is needed.
# It holds the same lock as universe-up, so the supervisor cannot start the browser again between the stop and the removal; the browser is
# proved gone before the profile is deleted, and the parts come back only after the lock is let go.
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
HOME_DIR="$HOME"
[ -n "$HOME_DIR" ] || HOME_DIR=/home/node
STATE="$HOME_DIR/.universe"
mkdir -p "$STATE" 2>/dev/null
LOCK="$STATE/up.lock"
if [ -d "$LOCK" ] && [ -n "$(find "$LOCK" -maxdepth 0 -mmin +1 2>/dev/null)" ]; then rmdir "$LOCK" 2>/dev/null; fi
waited=0
until mkdir "$LOCK" 2>/dev/null; do
  waited=$((waited+1))
  [ "$waited" -gt 150 ] && { echo "cleaned=0 reason=busy"; exit 1; }
  sleep 0.2
done
trap 'rmdir "$LOCK" 2>/dev/null' EXIT
# Marked first, unmarked only when the profile is proved gone: until then the next start-up removes it before any job can use it
: > "$STATE/profile.dirty" 2>/dev/null || { echo "cleaned=0 reason=mark"; exit 1; }
pkill -x websockify 2>/dev/null
pkill -x chromium 2>/dev/null
pkill -x chrome 2>/dev/null
i=0
while pgrep -x chromium >/dev/null 2>&1 || pgrep -x chrome >/dev/null 2>&1; do
  i=$((i+1))
  if [ "$i" -eq 20 ]; then pkill -9 -x chromium 2>/dev/null; pkill -9 -x chrome 2>/dev/null; fi
  [ "$i" -gt 50 ] && { echo "cleaned=0 reason=browser_running"; exit 1; }
  sleep 0.2
done
rm -rf "$HOME_DIR/.config/universe-chromium" "$HOME_DIR/.cache/chromium" 2>/dev/null
if [ -e "$HOME_DIR/.config/universe-chromium" ] || [ -e "$HOME_DIR/.cache/chromium" ]; then echo "cleaned=0 reason=profile_not_removed"; exit 1; fi
rm -f "$STATE/profile.dirty"
rmdir "$LOCK" 2>/dev/null
trap - EXIT
/usr/local/bin/universe-up --child >/dev/null 2>&1
echo "cleaned=1"
`;

/** The note the fence reads: written by Orbit as root once a computer is ready, never by the agent. */
export const UNIVERSE_MARK = String.raw`#!/bin/sh
# Run by Orbit as root once a computer is ready, before a job uses it. Writes the moment from which everything that runs is the agent's:
# this boot's id and the machine's clock then, in ticks. Run again on the same boot it keeps the first note (a later moment would take
# in what the agent has started since); a new boot (a stop and start) gets a new one. Prints marked=1 when the note is in place.
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
[ "$(id -u)" = "0" ] || { echo "marked=0 reason=not_root"; exit 1; }
DIR=/run/universe
BOOT="$(cat /proc/sys/kernel/random/boot_id 2>/dev/null)"
[ -n "$BOOT" ] || { echo "marked=0 reason=boot"; exit 1; }
mkdir -p "$DIR" && chown root:root "$DIR" && chmod 0755 "$DIR" || { echo "marked=0 reason=folder"; exit 1; }
if [ -f "$DIR/mark" ] && [ "$(cut -d' ' -f1 "$DIR/mark" 2>/dev/null)" = "$BOOT" ]; then echo "marked=1 kept=1"; exit 0; fi
HZ="$(getconf CLK_TCK 2>/dev/null)"
[ -n "$HZ" ] || HZ=100
TICKS="$(cut -d' ' -f1 /proc/uptime | awk -v hz="$HZ" '{ printf "%d", $1 * hz + 2 }')"
[ -n "$TICKS" ] || { echo "marked=0 reason=clock"; exit 1; }
printf '%s %s\n' "$BOOT" "$TICKS" > "$DIR/mark.new" && chown root:root "$DIR/mark.new" && chmod 0644 "$DIR/mark.new" && mv -f "$DIR/mark.new" "$DIR/mark" || { echo "marked=0 reason=write"; exit 1; }
echo "marked=1"
`;

/** Lists the files a person would look for: regular files in the home folder (not hidden ones, not the tools' own folders), newest first. */
export const UNIVERSE_FILES = String.raw`#!/bin/sh
# One line for each file: size in bytes, TAB, modified (seconds), TAB, path from the home folder. At most 201 lines (the caller says "more" for the 201st).
HOME_DIR="$HOME"
[ -n "$HOME_DIR" ] || HOME_DIR=/home/node
cd "$HOME_DIR" 2>/dev/null || exit 0
find . -maxdepth 5 \( -path './.*' -o -name node_modules -o -name __pycache__ \) -prune -o -type f -printf '%s\t%T@\t%P\n' 2>/dev/null | sort -t "$(printf '\t')" -k2,2nr | head -n 201
`;

/** Every file of the build context: the folder Agent37 builds. The Dockerfile is at its root. */
export function imageFiles(): Array<{ name: string; mode: number; text: string }> {
  return [
    { name: 'Dockerfile', mode: 0o644, text: DOCKERFILE },
    { name: 'universe-up', mode: 0o755, text: UNIVERSE_UP },
    { name: 'universe-supervise', mode: 0o755, text: UNIVERSE_SUPERVISE },
    { name: 'universe-proxy', mode: 0o755, text: UNIVERSE_PROXY },
    { name: 'universe-fence', mode: 0o755, text: UNIVERSE_FENCE },
    { name: 'universe-clean', mode: 0o755, text: UNIVERSE_CLEAN },
    { name: 'universe-files', mode: 0o755, text: UNIVERSE_FILES },
    { name: 'universe-mark', mode: 0o755, text: UNIVERSE_MARK },
  ];
}
