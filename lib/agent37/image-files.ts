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
COPY universe-up universe-supervise universe-proxy universe-fence universe-clean universe-files /usr/local/bin/
RUN chmod 0755 /usr/local/bin/universe-up /usr/local/bin/universe-supervise /usr/local/bin/universe-proxy /usr/local/bin/universe-fence /usr/local/bin/universe-clean /usr/local/bin/universe-files
# Hermes' browser tool drives the visible Chromium that the screen shows
ENV DISPLAY=:99 BROWSER_CDP_URL=http://127.0.0.1:9222 AGENT37_SCREEN_GEOMETRY=1440x900
USER node
`;

export const UNIVERSE_UP = String.raw`#!/bin/sh
# Brings this computer's parts up. Safe to run any number of times, and the supervisor at the end runs it again every few seconds.
# Prints lines Orbit reads: ready=1 or ready=0 reason=..., and restart=1 when Hermes' config was just written.
HOME_DIR="$HOME"
[ -n "$HOME_DIR" ] || HOME_DIR=/home/node
STATE="$HOME_DIR/.universe"
VERSION="__VERSION__"
GEOMETRY="$AGENT37_SCREEN_GEOMETRY"
[ -n "$GEOMETRY" ] || GEOMETRY=1440x900
WIDTH="$(echo "$GEOMETRY" | cut -dx -f1)"
HEIGHT="$(echo "$GEOMETRY" | cut -dx -f2)"
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

restart=0
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
  printf '%s' "$VERSION" > "$STATE/setup.new" && mv "$STATE/setup.new" "$STATE/setup"
  restart=1
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
#   universe-fence           stops them, prints killed=N
#   universe-fence --check   prints remaining=N and exits 0 only when N is 0
import os
import re
import signal
import sys
import time

KEEP = re.compile(r"(^|/)(Xvfb|openbox|x11vnc|websockify|chromium|chrome|chrome_crashpad_handler|universe-proxy|universe-supervise|universe-up|universe-fence)(\s|$)")
# The agent's gateway answers on these ports; whoever listens there stays, and so does everything above it
GATEWAY_PORTS = {3737, 8642}


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


def command(pid):
    text = read(pid, "cmdline").replace(b"\0", b" ").decode("utf-8", "replace").strip()
    return text or read(pid, "comm").decode("utf-8", "replace").strip()


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


def protected(tree):
    keep = {1, os.getpid()}
    # Whatever started this command, all the way up (the machine's own command runner), and the gateway's own chain
    for start in [os.getpid()] + list(listeners()):
        pid = start
        while pid > 1 and pid in tree and pid not in keep - {start}:
            keep.add(pid)
            pid = tree[pid]
    # The desktop's parts, and everything they started (the browser's own processes)
    desktop = {pid for pid in tree if pid != os.getpid() and KEEP.search(command(pid))}
    keep |= desktop
    below = {}
    for pid, up in tree.items():
        below.setdefault(up, []).append(pid)
    stack = list(desktop)
    while stack:
        for child in below.get(stack.pop(), []):
            if child not in keep:
                keep.add(child)
                stack.append(child)
    return keep


def alive(pid):
    state = (stat_fields(pid) or ["?"])[0]
    # Kernel threads have no command line; a process waiting to be collected runs nothing
    return state not in ("Z", "X", "?") and read(pid, "cmdline") != b""


def others():
    tree = {pid: parent(pid) for pid in pids()}
    keep = protected(tree)
    return [pid for pid in tree if pid not in keep and alive(pid)]


if "--check" in sys.argv:
    left = others()
    print("remaining=%d" % len(left))
    sys.exit(0 if not left else 1)

killed = 0
for _ in range(5):
    victims = others()
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
# stopped, its profile removed, and it comes back clean (the supervisor in universe-up starts it again). Every screen link still open
# is closed too (the web screen is restarted), so a tab left open on a job that is over shows nothing and a new link is needed.
HOME_DIR="$HOME"
[ -n "$HOME_DIR" ] || HOME_DIR=/home/node
pkill -x websockify 2>/dev/null
pkill -x chromium 2>/dev/null
pkill -x chrome 2>/dev/null
sleep 0.5
rm -rf "$HOME_DIR/.config/universe-chromium" "$HOME_DIR/.cache/chromium" 2>/dev/null
/usr/local/bin/universe-up --child >/dev/null 2>&1
echo "cleaned=1"
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
  ];
}
