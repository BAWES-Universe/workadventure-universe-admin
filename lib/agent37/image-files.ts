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
COPY universe-up universe-supervise universe-proxy universe-fence universe-clean universe-files universe-mark universe-egress universe-egress-forward universe-cold /usr/local/bin/
RUN chmod 0755 /usr/local/bin/universe-up /usr/local/bin/universe-supervise /usr/local/bin/universe-proxy /usr/local/bin/universe-fence /usr/local/bin/universe-clean /usr/local/bin/universe-files /usr/local/bin/universe-mark /usr/local/bin/universe-egress /usr/local/bin/universe-egress-forward /usr/local/bin/universe-cold
# What the image holds at the moment it is built: the software it was made with, and when. Cold storage compares a computer with these to know what the
# agent added (universe-cold).
RUN mkdir -p /usr/local/share/universe \
 && apt-mark showmanual | sort > /usr/local/share/universe/manual-packages.txt \
 && date +%s > /usr/local/share/universe/built
# Hermes' browser tool drives the visible Chromium that the screen shows
ENV DISPLAY=:99 BROWSER_CDP_URL=http://127.0.0.1:9222 AGENT37_SCREEN_GEOMETRY=1440x900
# The computer's only way out is Universe's egress gateway, through the forwarder on this machine (universe-egress-forward), which holds the
# gateway key. The address is the machine's own, so no secret is in the image; a program that ignores these has no internet at all.
ENV http_proxy=http://127.0.0.1:3128 https_proxy=http://127.0.0.1:3128 HTTP_PROXY=http://127.0.0.1:3128 HTTPS_PROXY=http://127.0.0.1:3128 no_proxy=localhost,127.0.0.1,::1 NO_PROXY=localhost,127.0.0.1,::1
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
# The forwarder in front of the egress gateways (the computer's only way out). It starts before the browser, which is told to use it.
if ! pgrep -f universe-egress-forward >/dev/null 2>&1; then
  nohup setsid python3 /usr/local/bin/universe-egress-forward >>"$LOGS/egress.log" 2>&1 </dev/null &
fi
run x11vnc x11vnc -display :99 -rfbport 5900 -localhost -forever -shared -nopw -quiet
run websockify websockify --web /usr/share/novnc 6901 127.0.0.1:5900
if ! pgrep -x chromium >/dev/null 2>&1; then
  nohup setsid chromium --user-data-dir="$HOME_DIR/.config/universe-chromium" --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1 \
    --no-sandbox --test-type --disable-dev-shm-usage --no-first-run --no-default-browser-check --hide-crash-restore-bubble --start-maximized \
    --proxy-server=http://127.0.0.1:3128 \
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
  if answers 9222 && answers __PORT__ && answers 6901 && answers 3128; then break; fi
  sleep 0.2
  i=$((i+1))
done
if ! answers 9222; then echo "ready=0 reason=browser"; exit 1; fi
if ! answers __PORT__; then echo "ready=0 reason=model_address"; exit 1; fi
if ! answers 6901; then echo "ready=0 reason=screen"; exit 1; fi
if ! answers 3128; then echo "ready=0 reason=egress_forwarder"; exit 1; fi

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
    if name in DESKTOP_PROGRAMS:
        return True
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
    seen = set(desktop)
    stack = list(desktop)
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

/** The local forwarder: 127.0.0.1:3128, in front of the egress gateways. It adds this computer's gateway key and passes the request on. */
export const UNIVERSE_EGRESS_FORWARD = String.raw`#!/usr/bin/env python3
# Listens on 127.0.0.1:3128 and passes every proxy request to the first egress gateway that answers, adding this computer's key (read from
# /etc/universe/egress.json on EVERY connection, so a new key never needs a restart). Nothing is looked at beyond the request's headers: a
# tunnel is opened by the gateway, the bytes after them are only passed along. Without that file it answers 503 and nothing goes out.
import asyncio, base64, json, os, sys

# The settings file and the port can be moved for a test; on a computer they are these
CONF = os.environ.get("UNIVERSE_EGRESS_CONF", "/etc/universe/egress.json")
PORT = int(os.environ.get("UNIVERSE_EGRESS_PORT", "3128"))

def conf():
    try:
        with open(CONF) as handle:
            data = json.load(handle)
        if data.get("gateways") and data.get("user") and data.get("pass"):
            return data
    except Exception:
        pass
    return None

async def pipe(reader, writer):
    try:
        while True:
            chunk = await reader.read(65536)
            if not chunk:
                break
            writer.write(chunk)
            await writer.drain()
    except Exception:
        pass
    finally:
        try:
            writer.close()
        except Exception:
            pass

async def reply(writer, status, text):
    writer.write(("HTTP/1.1 %d %s\r\nContent-Length: 0\r\nConnection: close\r\nX-Egress-Reason: %s\r\n\r\n" % (status, text, text)).encode("latin1"))
    try:
        await writer.drain()
    except Exception:
        pass
    writer.close()

async def connect_gateway(data):
    for gateway in data["gateways"]:
        host, _, port = gateway.rpartition(":")
        try:
            return await asyncio.wait_for(asyncio.open_connection(host, int(port)), 4)
        except Exception:
            continue
    return None

async def handle(reader, writer):
    try:
        head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 15)
    except Exception:
        writer.close()
        return
    data = conf()
    if data is None:
        await reply(writer, 503, "egress_not_set")
        return
    lines = head.decode("latin1").split("\r\n")[:-2]
    if not lines:
        writer.close()
        return
    drop = ("proxy-authorization:", "proxy-connection:", "connection:")
    kept = [line for line in lines[1:] if not line.lower().startswith(drop)]
    token = base64.b64encode((data["user"] + ":" + data["pass"]).encode()).decode()
    request = lines[0] + "\r\n" + "".join(line + "\r\n" for line in kept) + "Proxy-Authorization: Basic " + token + "\r\nConnection: close\r\n\r\n"
    upstream = await connect_gateway(data)
    if upstream is None:
        await reply(writer, 502, "no_gateway")
        return
    up_reader, up_writer = upstream
    up_writer.write(request.encode("latin1"))
    await up_writer.drain()
    await asyncio.gather(pipe(reader, up_writer), pipe(up_reader, writer))

async def main():
    server = await asyncio.start_server(handle, "127.0.0.1", PORT, limit=1 << 16)
    async with server:
        await server.serve_forever()

try:
    asyncio.run(main())
except OSError as error:
    # Already running (the port is taken): that one serves
    sys.exit(0)
`;

/** Run as root by Orbit each time a computer is made ready: puts the gateway settings in place and proves the way out is the gateway and nothing else. */
export const UNIVERSE_EGRESS = String.raw`#!/bin/sh
# universe-egress apply <name>...   (root; the settings come on standard input as JSON: gateways, user, pass)
#     Writes /etc/universe/egress.json for the forwarder, the settings of tools that read files and not the environment (apt, git), and,
#     as an extra layer, the names after "apply" into the hosts file pointing nowhere. Prints egress=1 hosts=1|0, or egress=0 reason=...
# universe-egress check             (anyone)
#     Proves the gateway answers with this computer's key, and that a direct connection to the internet does not get out.
#     Prints egress=1 gateway=ok direct=blocked, or egress=0 reason=...
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
CONF=/etc/universe/egress.json
case "$1" in
apply)
  shift
  [ "$(id -u)" = "0" ] || { echo "egress=0 reason=not_root"; exit 1; }
  mkdir -p /etc/universe || { echo "egress=0 reason=folder"; exit 1; }
  umask 022
  cat > "$CONF.new" || { echo "egress=0 reason=write"; exit 1; }
  python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert d["gateways"] and d["user"] and d["pass"]' "$CONF.new" 2>/dev/null || { rm -f "$CONF.new"; echo "egress=0 reason=bad_settings"; exit 1; }
  chmod 0644 "$CONF.new" && mv -f "$CONF.new" "$CONF" || { echo "egress=0 reason=write"; exit 1; }
  if [ -d /etc/apt/apt.conf.d ]; then
    printf 'Acquire::http::Proxy "http://127.0.0.1:3128";\nAcquire::https::Proxy "http://127.0.0.1:3128";\n' > /etc/apt/apt.conf.d/99universe-egress 2>/dev/null
  fi
  git config --system http.proxy http://127.0.0.1:3128 2>/dev/null
  hosts=0
  if [ -w /etc/hosts ]; then
    BEGIN="# universe-egress begin"
    END="# universe-egress end"
    tmp="$(mktemp 2>/dev/null)" || tmp=/tmp/universe-hosts.$$
    awk -v b="$BEGIN" -v e="$END" '$0==b{skip=1} !skip{print} $0==e{skip=0}' /etc/hosts > "$tmp" 2>/dev/null
    { echo "$BEGIN"; for name in "$@"; do echo "0.0.0.0 $name"; done; echo "$END"; } >> "$tmp"
    if cat "$tmp" > /etc/hosts 2>/dev/null; then hosts=1; fi
    rm -f "$tmp"
  fi
  echo "egress=1 hosts=$hosts"
  ;;
check)
  python3 - <<'PYEND'
import json, socket, sys, urllib.request

def say(text):
    print(text)
    sys.exit(0 if text.startswith("egress=1") else 1)

# 1. The gateway answers through the forwarder, and takes this computer's key
try:
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open("http://127.0.0.1:3128/__egress/whoami", timeout=8) as response:
        body = json.loads(response.read().decode())
    if not body.get("ok"):
        say("egress=0 reason=key_refused")
except urllib.error.HTTPError as error:
    say("egress=0 reason=key_refused" if error.code == 407 else "egress=0 reason=gateway_error")
except Exception:
    say("egress=0 reason=gateway_unreachable")

# 2. A connection that does not use the gateway gets nowhere (IPv4 and IPv6), so nothing can go out direct
for family, address in ((socket.AF_INET, "1.1.1.1"), (socket.AF_INET6, "2606:4700:4700::1111")):
    try:
        probe = socket.socket(family, socket.SOCK_STREAM)
        probe.settimeout(4)
        probe.connect((address, 443))
        probe.close()
        say("egress=0 reason=direct_reachable")
    except OSError:
        pass
say("egress=1 gateway=ok direct=blocked")
PYEND
  ;;
*)
  echo "egress=0 reason=usage"
  exit 2
  ;;
esac
`;

/**
 * Cold storage on the computer (lib/computer-cold.ts asks, this does):
 *   universe-cold prepack   (root)  copies what the agent changed outside the home folder into the home folder, so one copy carries it, and counts the home folder.
 *   universe-cold restore   (node)  reads {url, token, sha256} on standard input, fetches the copy from Orbit through the gateway, checks its SHA-256, unpacks it
 *                                   into the home folder and compares EVERY file with the copy; prints restored=1, or restored=0 reason=...
 *   universe-cold finish    (root)  puts back what was outside the home folder and installs the software the agent had added; prints finished=1, or finished=0 reason=...
 */
export const UNIVERSE_COLD = String.raw`#!/usr/bin/env python3
import hashlib, json, os, pwd, re, shutil, subprocess, sys, tarfile, threading, urllib.request

try:
    NODE = pwd.getpwnam("node")
    HOME, UID, GID = NODE.pw_dir, NODE.pw_uid, NODE.pw_gid
except KeyError:
    HOME, UID, GID = "/home/node", 1000, 1000
# The home folder and the proxy can be moved for a test; on a computer they are the node user's home and the forwarder on this machine
HOME = os.environ.get("UNIVERSE_COLD_HOME", HOME)
PROXY = os.environ.get("UNIVERSE_COLD_PROXY", "http://127.0.0.1:3128")
STATE = os.path.join(HOME, ".universe")
OUTSIDE = os.path.join(STATE, "outside")
PACKAGES_FILE = os.path.join(STATE, "outside-packages.txt")
BUILT = "/usr/local/share/universe/built"
BASELINE = "/usr/local/share/universe/manual-packages.txt"
ROOTS = ["/etc", "/opt", "/srv", "/usr/local", "/root", "/var/www", "/var/spool/cron"]
# Ours or made again by the system: never part of a copy (and never written back from one)
SKIP = ("/etc/universe/", "/etc/hosts", "/etc/hostname", "/etc/resolv.conf", "/etc/mtab", "/etc/gitconfig", "/etc/apt/apt.conf.d/99universe-egress",
        "/usr/local/bin/universe-", "/usr/local/share/universe/", "/etc/ssl/certs/", "/etc/ld.so.cache", "/etc/alternatives/", "/etc/passwd", "/etc/shadow",
        "/etc/group", "/etc/gshadow", "/etc/subuid", "/etc/subgid", "/etc/machine-id", "/etc/profile.d/universe", "/etc/ca-certificates")
MAX_FILES = 5000
MAX_BYTES = 200 * 1024 * 1024
PACKAGE_NAME = re.compile(r"^[a-z0-9][a-z0-9+.:-]{0,100}$")

def skipped(path):
    return path.endswith("-") or any(path == item or path.startswith(item) for item in SKIP)

def home_stats():
    files = 0
    size = 0
    for root, _dirs, names in os.walk(HOME, followlinks=False):
        for name in names:
            path = os.path.join(root, name)
            try:
                if os.path.islink(path):
                    continue
                size += os.lstat(path).st_size
                files += 1
            except OSError:
                pass
    return files, size

def prepack():
    if os.getuid() != 0:
        print("prepack=" + json.dumps({"blocked": "not_root", "home_files": 0, "home_bytes": 0, "outside_files": 0, "outside_bytes": 0, "packages": []}))
        return 1
    os.makedirs(STATE, exist_ok=True)
    shutil.rmtree(OUTSIDE, ignore_errors=True)
    os.makedirs(OUTSIDE, exist_ok=True)
    # A job's key is never part of a copy
    for name in ("relay.json", "relay.json.new", "relay.gen", "relay.lock"):
        try:
            os.remove(os.path.join(STATE, name))
        except OSError:
            pass
    blocked = None
    found = []
    total = 0
    if os.path.exists(BUILT):
        reference = os.stat(BUILT).st_mtime
        for root in ROOTS:
            for current, dirs, names in os.walk(root, followlinks=False):
                if current.startswith("/usr/local/share/universe"):
                    dirs[:] = []
                    continue
                for name in names:
                    path = os.path.join(current, name)
                    if skipped(path):
                        continue
                    try:
                        info = os.lstat(path)
                    except OSError:
                        continue
                    if info.st_mtime <= reference:
                        continue
                    found.append(path)
                    total += info.st_size if not os.path.islink(path) else 0
                    if len(found) > MAX_FILES or total > MAX_BYTES:
                        blocked = "outside_too_big"
                        break
                if blocked:
                    break
            if blocked:
                break
    else:
        blocked = "image_marker_missing"
    copied = 0
    if blocked is None:
        for path in found:
            target = os.path.join(OUTSIDE, path.lstrip("/"))
            try:
                os.makedirs(os.path.dirname(target), exist_ok=True)
                if os.path.islink(path):
                    os.symlink(os.readlink(path), target)
                else:
                    shutil.copy2(path, target)
                copied += 1
            except OSError:
                blocked = "outside_not_copied"
                break
    packages = []
    if blocked is None:
        try:
            current = set(subprocess.run(["apt-mark", "showmanual"], capture_output=True, text=True, timeout=120, check=True).stdout.split())
            with open(BASELINE) as handle:
                base = set(handle.read().split())
            packages = sorted(name for name in current - base if PACKAGE_NAME.match(name))
            with open(PACKAGES_FILE, "w") as handle:
                handle.write("\n".join(packages) + ("\n" if packages else ""))
        except Exception:
            blocked = "packages_unknown"
    subprocess.run(["chown", "-R", "%d:%d" % (UID, GID), OUTSIDE, PACKAGES_FILE], capture_output=True)
    files, size = home_stats()
    out_bytes = 0
    for root, _d, names in os.walk(OUTSIDE):
        for name in names:
            try:
                out_bytes += os.lstat(os.path.join(root, name)).st_size
            except OSError:
                pass
    print("prepack=" + json.dumps({"home_files": files, "home_bytes": size, "outside_files": copied, "outside_bytes": out_bytes, "packages": packages[:500], "blocked": blocked}))
    return 0 if blocked is None else 1

def prefix_for(names):
    for name in names:
        clean = name[2:] if name.startswith("./") else name
        if clean in ("", "."):
            continue
        first = clean.split("/")[0]
        home = HOME.strip("/")
        if clean == home or clean.startswith(home + "/"):
            return "/"
        if first == os.path.basename(HOME):
            return os.path.dirname(HOME)
        return HOME
    return HOME

def restore():
    cfg = json.load(sys.stdin)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({"http": PROXY, "https": PROXY}))
    def fetch():
        return opener.open(urllib.request.Request(cfg["url"], headers={"Authorization": "Bearer " + cfg["token"]}), timeout=300)
    def fail(reason):
        print("restored=0 reason=" + reason)
        return 1
    # Where the copy's names start (the home folder itself, or inside it): read from its first entries
    base = HOME
    try:
        resp = fetch()
        names = []
        with tarfile.open(fileobj=resp, mode="r|gz") as archive:
            for member in archive:
                names.append(member.name)
                if len(names) >= 5:
                    break
        resp.close()
        if names:
            base = prefix_for(names)
    except OSError:
        return fail("unreachable")
    except Exception:
        return fail("unreadable")
    # 1. Unpack while hashing: the bytes must be the ones that were stored
    try:
        resp = fetch()
        length = resp.headers.get("Content-Length")
        digest = hashlib.sha256()
        total = 0
        tar = subprocess.Popen(["tar", "-xzf", "-", "-C", base, "--no-same-owner"], stdin=subprocess.PIPE, stderr=subprocess.PIPE)
        while True:
            chunk = resp.read(1 << 20)
            if not chunk:
                break
            digest.update(chunk)
            total += len(chunk)
            tar.stdin.write(chunk)
        tar.stdin.close()
        code = tar.wait()
    except Exception:
        return fail("download")
    if length is not None and int(length) != total:
        return fail("cut_short")
    if digest.hexdigest() != cfg["sha256"]:
        return fail("checksum")
    if code != 0:
        return fail("unpack")
    # 2. Compare every file on this computer with the copy (the copy is read again, so nothing is trusted from the first pass)
    try:
        resp = fetch()
        compare = subprocess.Popen(
            ["tar", "-dzf", "-", "-C", base, "--wildcards", "--exclude=*.universe/logs*", "--exclude=*.universe/up.lock*", "--exclude=*.universe/relay*", "--exclude=*.universe/restart.pending", "--exclude=*.cache/*"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        def pour():
            try:
                while True:
                    chunk = resp.read(1 << 20)
                    if not chunk:
                        break
                    compare.stdin.write(chunk)
                compare.stdin.close()
            except Exception:
                try:
                    compare.kill()
                except Exception:
                    pass
        pourer = threading.Thread(target=pour, daemon=True)
        pourer.start()
        differing = sum(1 for _ in compare.stdout)
        pourer.join()
        code = compare.wait()
    except Exception:
        return fail("compare")
    if code > 1:
        return fail("compare")
    if differing > 0:
        return fail("differs_%d" % min(differing, 99999))
    # The job's key is never carried over: the new computer gets its own
    for name in ("relay.json", "relay.json.new", "relay.gen", "relay.lock"):
        try:
            os.remove(os.path.join(STATE, name))
        except OSError:
            pass
    print("restored=1 sha=%s bytes=%d" % (digest.hexdigest(), total))
    return 0

def finish():
    if os.getuid() != 0:
        print("finished=0 reason=not_root")
        return 1
    files = 0
    if os.path.isdir(OUTSIDE):
        for root, _dirs, names in os.walk(OUTSIDE, followlinks=False):
            for name in names:
                source = os.path.join(root, name)
                target = "/" + os.path.relpath(source, OUTSIDE)
                if skipped(target) or not any(target.startswith(r + "/") for r in ROOTS):
                    continue
                try:
                    os.makedirs(os.path.dirname(target), exist_ok=True)
                    if os.path.islink(source):
                        if os.path.lexists(target):
                            os.remove(target)
                        os.symlink(os.readlink(source), target)
                    else:
                        shutil.copy2(source, target)
                        os.chown(target, 0, 0)
                    files += 1
                except OSError:
                    print("finished=0 reason=outside_not_written")
                    return 1
    packages = []
    try:
        with open(PACKAGES_FILE) as handle:
            packages = [name for name in handle.read().split() if PACKAGE_NAME.match(name)]
    except OSError:
        packages = []
    if packages:
        update = subprocess.run(["apt-get", "update", "-qq"], capture_output=True, timeout=600)
        install = subprocess.run(["apt-get", "install", "-y", "--no-install-recommends", "-qq"] + packages, capture_output=True, timeout=1800)
        if update.returncode != 0 or install.returncode != 0:
            print("finished=0 reason=packages")
            return 1
    print("finished=1 files=%d packages=%d" % (files, len(packages)))
    return 0

if __name__ == "__main__":
    command = sys.argv[1] if len(sys.argv) > 1 else ""
    code = {"prepack": prepack, "restore": restore, "finish": finish}.get(command, lambda: (print("usage: universe-cold prepack|restore|finish") or 2))()
    sys.exit(code)
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
    { name: 'universe-egress', mode: 0o755, text: UNIVERSE_EGRESS },
    { name: 'universe-egress-forward', mode: 0o755, text: UNIVERSE_EGRESS_FORWARD },
    { name: 'universe-cold', mode: 0o755, text: UNIVERSE_COLD },
  ];
}
