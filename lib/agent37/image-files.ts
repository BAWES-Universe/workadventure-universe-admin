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
 *   universe-visits   the record of where the browser went (R06): listens to the browser's DevTools and keeps host and path of every page it opened
 *                     and every post it sent, never a query string or a body; Orbit reads it back when a job ends.
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
export const IMAGE_SETUP_VERSION = '2';

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
COPY universe-up universe-supervise universe-proxy universe-fence universe-clean universe-files universe-mark universe-visits universe-cold /usr/local/bin/
RUN chmod 0755 /usr/local/bin/universe-up /usr/local/bin/universe-supervise /usr/local/bin/universe-proxy /usr/local/bin/universe-fence /usr/local/bin/universe-clean /usr/local/bin/universe-files /usr/local/bin/universe-mark /usr/local/bin/universe-visits /usr/local/bin/universe-cold
# What the image holds at the moment it is built: the software it was made with, and when. Cold storage compares a computer with these to know what the
# agent added (universe-cold).
RUN mkdir -p /usr/local/share/universe \
 && apt-mark showmanual | sort > /usr/local/share/universe/manual-packages.txt \
 && date +%s > /usr/local/share/universe/built
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
if [ -e "$STATE/profile.dirty" ]; then
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
  rm -rf "$STATE/profile.dirty"
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
# The record of where the browser went listens to the browser's DevTools and waits for it, so it may start before or after the browser
if ! pgrep -f "universe-visits run" >/dev/null 2>&1; then
  nohup setsid python3 /usr/local/bin/universe-visits run >>"$LOGS/visits.log" 2>&1 </dev/null &
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
# On EVERY call it reads the relay's address and a job's key and passes the call on, so a new key never needs Hermes restarted. Every turn
# sent to the agent starts with the job's tag ("[universe-job:<id>]"): the tag at the start of a user message in a call's body names the job, and the call goes on
# with that job's own key (~/.universe/jobs/<id>.json), so jobs that run at once are each booked their own calls. A call with no tag, or for a
# job this computer holds no key of, goes on the key last written (~/.universe/relay.json). The tag is never authority: Orbit decides from the key.
# It logs the method, the path and the status, never a body or a key.
import http.client
import json
import os
import re
import sys
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("UNIVERSE_PROXY_PORT") or __PORT__)
HOME = os.environ.get("HOME") or "/home/node"
RELAY = os.path.join(HOME, ".universe", "relay.json")
JOBS = os.path.join(HOME, ".universe", "jobs")
TAG = re.compile(r"^\[universe-job:([A-Za-z0-9-]{8,64})\]")
CONNECT_SECONDS = 10
READ_SECONDS = 900
SKIP = {"connection", "keep-alive", "transfer-encoding", "content-length", "host", "authorization", "upgrade", "proxy-authorization", "te", "trailer"}


def tag_of(body):
    # The tag is read only from the START of a user message's text: the system message (the agent's own memory and skills), the agent's own
    # answers and the tools' results are never where a job's tag is looked for. A body that is not JSON names no job.
    try:
        data = json.loads(body)
    except Exception:
        return None
    if not isinstance(data, dict):
        return None
    items = []
    for key in ("messages", "input"):
        value = data.get(key)
        if isinstance(value, list):
            items.extend(value)
        elif isinstance(value, str) and key == "input":
            items.append({"role": "user", "content": value})
    for item in items:
        if not isinstance(item, dict) or item.get("role") != "user":
            continue
        content = item.get("content")
        if isinstance(content, list):
            content = next((part.get("text") for part in content if isinstance(part, dict) and isinstance(part.get("text"), str)), None)
        if isinstance(content, str):
            found = TAG.match(content)
            if found:
                return found.group(1)
    return None


def relay(body=None):
    job = tag_of(body) if body else None
    if job:
        own = read_relay(os.path.join(JOBS, job + ".json"))
        if own:
            return own
    return read_relay(RELAY)


def read_relay(path):
    try:
        with open(path, "r", encoding="utf-8") as handle:
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
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length > 0 else None
        found = relay(body)
        if not found:
            self.say(503, "This computer has no model key yet.", "no_relay")
            return
        url, token = found
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

export const UNIVERSE_VISITS = String.raw`#!/usr/bin/env python3
# The record of where the browser went. It listens to the browser's DevTools (loopback only, port 9222) and writes one line for each page the
# browser opened and each post it sent: the kind, the time, the host and the path. NEVER the query string, the fragment, a sign-in name in the
# address, a header, a cookie or a body: the address is cut down to host and path here, and Orbit cuts it again when it reads it back, so the
# machine's word is never trusted as it comes. The agent's own stream drops what a tool was given on purpose; this is where a visit or a form
# post that it made can still be looked at later.
#
#   universe-visits run          the listener (universe-up starts it, universe-supervise brings it back)
#   universe-visits read SINCE   what was recorded from SINCE (milliseconds on this machine's clock) on, for Orbit to take at the end of a job: the
#                                 machine's clock now, the last connection line before SINCE, whether the listener runs, and then the lines
#
# A line is a JSON object: {"k": "visit"|"post"|"on"|"off"|"cut", "at": ms, "m": method, "h": host, "p": path, "n": times in a row, "f": 1 if
# the page did not load, "form": 1 if the post was a page's own form}. "on" and "off" say when the listener was connected to the browser ("off"
# says with "b" whether the browser was still there to be used), and
# "cut" says older lines were dropped to keep the file small, so a gap in the record can be told from a quiet browser.
import base64
import hashlib
import http.client
import json
import os
import re
import select
import signal
import socket
import struct
import sys
import time
import urllib.parse

HOME = os.environ.get("HOME") or "/home/node"
STATE = os.path.join(HOME, ".universe")
LOG = os.path.join(STATE, "visits.jsonl")
PORT = int(os.environ.get("UNIVERSE_DEVTOOLS_PORT") or 9222)
# The file stays small: past this size the oldest lines go (and a "cut" line says so), keeping the newest ones and the last connection line
MAX_BYTES = 512 * 1024
KEEP_LINES = 1500
# A read gives at most this many lines (the oldest first); "more=N" says how many were left out
READ_LINES = 1200
PATH_MAX = 300
HOST_MAX = 255
# The same page or post again within this long is one line with a count
JOIN_MS = 3000
PLAIN = {"GET", "HEAD", "OPTIONS"}
HEX = re.compile(r"^(v[0-9]+-)?[0-9a-fA-F-]{20,}$")
TOKEN = re.compile(r"^[A-Za-z0-9_-]{24,}$")
PLAIN_TOKEN = re.compile(r"^[A-Za-z0-9]{24,}$")


def now_ms():
    return int(time.time() * 1000)


def is_code(part):
    if HEX.match(part):
        return True
    # A long run of mixed case is a random code (a readable address is lower case with hyphens); a long run with no hyphen that mixes letters and digits is one too
    if TOKEN.match(part) and re.search(r"[A-Z]", part) and re.search(r"[a-z]", part):
        return True
    return bool(PLAIN_TOKEN.match(part) and re.search(r"[0-9]", part) and re.search(r"[A-Za-z]", part))


def segment(part):
    # An address can carry a one-time code or a private link in its path (a reset or share link): a part that looks like one is not kept.
    # It is judged as the page reads it: a code written with percent signs (once or twice over, or behind an encoded slash) is the same code.
    seen = part
    for _ in range(4):
        if any(is_code(piece) for piece in seen.split("/")):
            return "…"
        decoded = urllib.parse.unquote(seen)
        if decoded == seen:
            break
        seen = decoded
    return part


def cut(url):
    # (host, path) of a web address, or None for anything that is not a plain http or https page
    try:
        parts = urllib.parse.urlsplit(url)
        if parts.scheme not in ("http", "https") or not parts.hostname:
            return None
        host = parts.hostname.lower()
        if ":" in host:
            host = "[" + host + "]"
        port = parts.port
        if port and not ((parts.scheme == "http" and port == 80) or (parts.scheme == "https" and port == 443)):
            host = "%s:%d" % (host, port)
        path = "/".join(segment(part) for part in (parts.path or "/").split("/"))
        if len(host) > HOST_MAX:
            return None
        return host, path[:PATH_MAX]
    except Exception:
        return None


def last_state(lines):
    for line in reversed(lines):
        try:
            entry = json.loads(line)
        except Exception:
            continue
        if entry.get("k") in ("on", "off"):
            return entry
    return None


def listeners():
    # The listener's process ids: processes that are this script with "run"
    me = os.getpid()
    found = []
    for name in os.listdir("/proc"):
        if not name.isdigit() or int(name) == me:
            continue
        try:
            with open("/proc/%s/cmdline" % name, "rb") as handle:
                args = handle.read().split(b"\0")
        except Exception:
            continue
        if len(args) >= 3 and args[1].endswith(b"/universe-visits") and args[2] == b"run":
            found.append(int(name))
    return found


def alive():
    return len(listeners()) > 0


def settle():
    # What the listener holds in memory (the latest line waits a moment to be joined with the same again) is written out first, so the
    # last seconds before a read are in it: the listener is asked to, and given a moment
    asked = False
    for pid in listeners():
        try:
            os.kill(pid, signal.SIGUSR1)
            asked = True
        except Exception:
            pass
    if asked:
        time.sleep(0.4)


def read(since):
    settle()
    try:
        with open(LOG, "r", encoding="utf-8", errors="replace") as handle:
            lines = handle.read().splitlines()
    except Exception:
        lines = []
    before, wanted = [], []
    for line in lines:
        try:
            entry = json.loads(line)
            at = int(entry.get("at"))
        except Exception:
            continue
        (wanted if at >= since else before).append(line)
    print("now=%d" % now_ms())
    state = last_state(before)
    print("state=%s" % (state["k"] if state else "none"))
    # An "off" with the browser still there is a stretch nobody was watching (see run)
    print("open=%d" % (1 if state and state["k"] == "off" and state.get("b") != 0 else 0))
    print("alive=%d" % (1 if alive() else 0))
    for line in wanted[:READ_LINES]:
        print("line=" + line)
    if len(wanted) > READ_LINES:
        print("more=%d" % (len(wanted) - READ_LINES))
    print("end=1")


class Socket:
    # The smallest WebSocket client that DevTools needs: text messages, both ways, nothing else
    def __init__(self, url):
        parts = urllib.parse.urlsplit(url)
        self.sock = socket.create_connection((parts.hostname, parts.port), timeout=5)
        key = base64.b64encode(os.urandom(16)).decode()
        request = "GET %s HTTP/1.1\r\nHost: %s:%d\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n" % (parts.path, parts.hostname, parts.port, key)
        self.sock.sendall(request.encode())
        head = b""
        while b"\r\n\r\n" not in head:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise IOError("closed")
            head += chunk
            if len(head) > 65536:
                raise IOError("bad answer")
        head, self.buffer = head.split(b"\r\n\r\n", 1)
        expect = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
        if b" 101 " not in head.split(b"\r\n")[0] + b" " or expect.lower().encode() not in head.lower():
            raise IOError("not accepted")
        self.sock.settimeout(None)
        self.message = b""

    def send(self, data):
        payload = data.encode()
        mask = os.urandom(4)
        size = len(payload)
        head = b"\x81"
        if size < 126:
            head += bytes([0x80 | size])
        elif size < 65536:
            head += bytes([0x80 | 126]) + struct.pack(">H", size)
        else:
            head += bytes([0x80 | 127]) + struct.pack(">Q", size)
        self.sock.sendall(head + mask + bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload)))

    def need(self, count):
        while len(self.buffer) < count:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise IOError("closed")
            self.buffer += chunk
        taken, self.buffer = self.buffer[:count], self.buffer[count:]
        return taken

    def frame(self):
        first, second = self.need(2)
        opcode = first & 0x0F
        size = second & 0x7F
        if size == 126:
            size = struct.unpack(">H", self.need(2))[0]
        elif size == 127:
            size = struct.unpack(">Q", self.need(8))[0]
        mask = self.need(4) if second & 0x80 else None
        payload = self.need(size)
        if mask:
            payload = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
        return first & 0x80, opcode, payload

    def ready(self, seconds):
        return bool(self.buffer) or bool(select.select([self.sock], [], [], seconds)[0])

    def receive(self):
        # The next whole text message; None when only a ping or pong came
        fin, opcode, payload = self.frame()
        if opcode == 8:
            raise IOError("closed")
        if opcode == 9:
            # A ping is answered with the same bytes (a masked pong), which a short payload makes simple
            if len(payload) < 126:
                mask = os.urandom(4)
                self.sock.sendall(b"\x8a" + bytes([0x80 | len(payload)]) + mask + bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload)))
            return None
        if opcode == 10:
            return None
        if opcode in (1, 0):
            self.message += payload
            if fin:
                text, self.message = self.message, b""
                return text.decode("utf-8", "replace")
        return None


class Log:
    def __init__(self):
        self.pending = None
        os.makedirs(STATE, exist_ok=True)

    def write(self, entry):
        line = json.dumps(entry, separators=(",", ":"))
        try:
            with open(LOG, "a", encoding="utf-8") as handle:
                handle.write(line + "\n")
            if os.path.getsize(LOG) > MAX_BYTES:
                self.trim()
        except Exception:
            pass

    def trim(self):
        with open(LOG, "r", encoding="utf-8", errors="replace") as handle:
            lines = handle.read().splitlines()
        state = None
        for line in reversed(lines):
            try:
                if json.loads(line).get("k") in ("on", "off"):
                    state = line
                    break
            except Exception:
                continue
        kept = lines[-KEEP_LINES:]
        head = [json.dumps({"k": "cut", "at": now_ms()}, separators=(",", ":"))]
        if state and state not in kept:
            head.append(state)
        with open(LOG + ".new", "w", encoding="utf-8") as handle:
            handle.write("\n".join(head + kept) + "\n")
        os.replace(LOG + ".new", LOG)

    def add(self, kind, method, host, path, failed=False, form=False):
        # One line for the same thing again within a moment: the count goes up
        at = now_ms()
        key = (kind, method, host, path, failed, form)
        if self.pending and self.pending["key"] == key and at - self.pending["last"] <= JOIN_MS:
            self.pending["n"] += 1
            self.pending["last"] = at
            return
        self.flush()
        self.pending = {"key": key, "at": at, "last": at, "n": 1}

    def flush(self, force=True):
        if not self.pending:
            return
        kind, method, host, path, failed, form = self.pending["key"]
        entry = {"k": kind, "at": self.pending["at"], "m": method, "h": host, "p": path, "n": self.pending["n"]}
        if failed:
            entry["f"] = 1
        if form:
            entry["form"] = 1
        self.pending = None
        self.write(entry)

    def tick(self):
        if self.pending and now_ms() - self.pending["last"] > JOIN_MS:
            self.flush()


def browser_address():
    connection = http.client.HTTPConnection("127.0.0.1", PORT, timeout=3)
    try:
        connection.request("GET", "/json/version")
        answer = json.loads(connection.getresponse().read().decode())
        url = urllib.parse.urlsplit(answer["webSocketDebuggerUrl"])
        # Only the browser on this machine's own loopback: whatever address it names, the path is used on the loopback port
        return "ws://127.0.0.1:%d%s" % (PORT, url.path)
    finally:
        connection.close()


def listen(log):
    link = Socket(browser_address())
    ids = [0]
    sessions = {}
    targets = set()
    mains = {}

    def command(method, params=None, session=None):
        ids[0] += 1
        message = {"id": ids[0], "method": method, "params": params or {}}
        if session:
            message["sessionId"] = session
        link.send(json.dumps(message))

    def attach(session, info, waiting):
        kind = info.get("type")
        sessions[session] = kind
        targets.add(info.get("targetId"))
        # Every kind of target is watched for posts; only a page's own frame says where the browser went
        command("Network.enable", {}, session)
        if kind in ("page", "iframe"):
            command("Page.enable", {}, session)
        command("Target.setAutoAttach", {"autoAttach": True, "waitForDebuggerOnStart": True, "flatten": True}, session)
        # A target that was started paused is let go at once, whatever else happened
        if waiting:
            command("Runtime.runIfWaitingForDebugger", {}, session)

    command("Target.setAutoAttach", {"autoAttach": True, "waitForDebuggerOnStart": True, "flatten": True})
    command("Target.setDiscoverTargets", {"discover": True})
    command("Target.getTargets")
    log.write({"k": "on", "at": now_ms()})
    started = time.time()
    swept = False
    while True:
        if not link.ready(1.0):
            log.tick()
            continue
        text = link.receive()
        log.tick()
        if text is None:
            continue
        try:
            message = json.loads(text)
        except Exception:
            continue
        method = message.get("method")
        params = message.get("params") or {}
        session = message.get("sessionId")
        if method is None and message.get("result") is not None and "targetInfos" in message["result"]:
            # The tabs that were open before this listener came: any not attached by now is attached
            if not swept:
                swept = True
                time.sleep(0.3)
                for info in message["result"]["targetInfos"]:
                    if info.get("type") == "page" and info.get("targetId") not in targets:
                        targets.add(info["targetId"])
                        command("Target.attachToTarget", {"targetId": info["targetId"], "flatten": True})
            continue
        if method is None and message.get("result") is not None and "sessionId" in message["result"]:
            # The answer to attachToTarget: the event below carries the same session, so nothing is done twice
            continue
        if method == "Target.attachedToTarget":
            attach(params["sessionId"], params.get("targetInfo") or {}, params.get("waitingForDebugger"))
        elif method == "Target.detachedFromTarget":
            sessions.pop(params.get("sessionId"), None)
            mains.pop(params.get("sessionId"), None)
        elif method == "Network.requestWillBeSent":
            request = params.get("request") or {}
            verb = str(request.get("method") or "GET").upper()
            if verb in PLAIN:
                continue
            address = cut(request.get("url") or "")
            if address:
                log.add("post", verb[:8], address[0], address[1], form=(params.get("type") == "Document"))
        elif method == "Page.frameNavigated" and sessions.get(session) == "page":
            frame = params.get("frame") or {}
            if frame.get("parentId"):
                continue
            mains.setdefault(session, set()).add(frame.get("id"))
            failed = bool(frame.get("unreachableUrl"))
            address = cut(frame.get("unreachableUrl") or frame.get("url") or "")
            if address:
                log.add("visit", "GET", address[0], address[1], failed=failed)
        elif method == "Page.navigatedWithinDocument" and sessions.get(session) == "page":
            if params.get("frameId") in mains.get(session, set()):
                address = cut(params.get("url") or "")
                if address:
                    log.add("visit", "GET", address[0], address[1])


def run():
    log = Log()
    # A read asks for what is held in memory to be written out now
    signal.signal(signal.SIGUSR1, lambda number, frame: log.flush())
    while True:
        try:
            listen(log)
        except Exception:
            pass
        log.flush()
        # Said when the listener lost the browser: "b" is 0 when the browser itself was gone (a crash, or the cleanup between jobs: nothing
        # could be opened), and 1 when it was still there and nobody was watching it
        try:
            browser_address()
            there = 1
        except Exception:
            there = 0
        log.write({"k": "off", "at": now_ms(), "b": there})
        # Waits for the browser to answer again
        while True:
            time.sleep(1)
            try:
                browser_address()
                break
            except Exception:
                continue


if __name__ == "__main__":
    command = sys.argv[1] if len(sys.argv) > 1 else ""
    if command == "run":
        run()
    elif command == "read" and len(sys.argv) == 3 and re.match(r"^[0-9]{1,16}$", sys.argv[2]):
        read(int(sys.argv[2]))
    else:
        sys.stderr.write("usage: universe-visits run | read SINCE\n")
        sys.exit(2)
`;

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
OWN_SCRIPTS = {os.path.join(SCRIPTS_DIR, name) for name in ("universe-proxy", "universe-supervise", "universe-up", "universe-fence", "universe-visits")}
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
        # Xvfb ignores everything after -I, so a display number placed there is not one it uses: Xvfb -I :99 runs on :0 and is not the supervisor's
        rest = args[1:]
        if "-I" in rest:
            rest = rest[:rest.index("-I")]
        return [part for part in rest if re.match(r"^:\d+$", part)] == [":99"]
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
# Marked first, unmarked only when the profile is proved gone: until then the next start-up removes it before any job can use it.
# A FOLDER made with mkdir, never a file opened with ">": this runs as root over a path the agent owns, and an open for writing would follow
# a link the agent put there and empty its target. mkdir follows no link and truncates nothing; anything already at that name fails the run
[ -d "$STATE" ] && [ ! -L "$STATE" ] || { echo "cleaned=0 reason=mark"; exit 1; }
rm -rf "$STATE/profile.dirty" 2>/dev/null
mkdir "$STATE/profile.dirty" 2>/dev/null || { echo "cleaned=0 reason=mark"; exit 1; }
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
rm -rf "$STATE/profile.dirty"
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

/**
 * Cold storage on the computer (lib/computer-cold.ts asks, this does):
 *   universe-cold prepack   (root)  copies what the agent changed outside the home folder into the home folder, so one copy carries it, and counts the home folder.
 *   universe-cold restore   (node)  reads {url, token, sha256} on standard input, fetches the copy straight from Orbit, checks its SHA-256, unpacks it
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
# The home folder can be moved for a test; on a computer it is the node user's home
HOME = os.environ.get("UNIVERSE_COLD_HOME", HOME)
STATE = os.path.join(HOME, ".universe")
OUTSIDE = os.path.join(STATE, "outside")
PACKAGES_FILE = os.path.join(STATE, "outside-packages.txt")
BUILT = "/usr/local/share/universe/built"
BASELINE = "/usr/local/share/universe/manual-packages.txt"
ROOTS = ["/etc", "/opt", "/srv", "/usr/local", "/root", "/var/www", "/var/spool/cron"]
# Ours or made again by the system: never part of a copy (and never written back from one)
SKIP = ("/etc/universe/", "/etc/hosts", "/etc/hostname", "/etc/resolv.conf", "/etc/mtab", "/etc/gitconfig",
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

def newer_than(info, reference):
    # True when a file was written or changed after the reference time: its modification time or its change time (which a copy cannot set back)
    return max(info.st_mtime, info.st_ctime) > reference

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
                    # A file the image did not have: written or changed here after the image was built. Its change time too, because a file that was
                    # copied or unpacked with its old time kept (cp -p, tar x, rsync -a) has an old modification time but a change time of the day it arrived
                    if not newer_than(info, reference):
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
    # Straight to Orbit: the computer has the open internet and no proxy, so whatever proxy settings the environment carries are not used
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
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
        # --no-overwrite-dir: the folders that already exist (the home folder itself, or "/" and "/home" when the names start at the root) keep their own
        # owner and times, so a restore run by the computer's own user does not fail on a folder it is not allowed to touch
        tar = subprocess.Popen(["tar", "-xzf", "-", "-C", base, "--no-same-owner", "--no-overwrite-dir"], stdin=subprocess.PIPE, stderr=subprocess.PIPE)
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
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        fed = {"whole": False}
        def pour():
            try:
                while True:
                    chunk = resp.read(1 << 20)
                    if not chunk:
                        break
                    compare.stdin.write(chunk)
                compare.stdin.close()
                fed["whole"] = True
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
    # Only a comparison that was given the whole copy and ended by itself counts: tar ends with 0 (all alike) or 1 (some differ); a signal (negative) or
    # 2 and above means it did not finish, and a restore is never called good on a comparison that did not
    if not fed["whole"] or code < 0 or code > 1:
        return fail("compare")
    if differing > 0 or code == 1:
        return fail("differs_%d" % max(1, min(differing, 99999)))
    # The job's key is never carried over: the new computer gets its own
    for name in ("relay.json", "relay.json.new", "relay.gen", "relay.lock"):
        try:
            os.remove(os.path.join(STATE, name))
        except OSError:
            pass
    print("restored=1 sha=%s bytes=%d" % (digest.hexdigest(), total))
    return 0

# A design that sent a computer's internet through a local proxy on 127.0.0.1:3128 was tried before launch and dropped. A copy or a machine from then
# may still point software at it, and nothing listens there now, so a restored computer is cleaned of every such setting (lines naming that address
# in the usual settings files, the apt setting, git's system setting, the hosts-file block and the old settings file). Never touches anything else.
LEGACY = "127.0.0.1:3128"

def drop_legacy_proxy():
    for path in ("/etc/apt/apt.conf.d/99universe-egress", "/etc/universe/egress.json"):
        try:
            os.remove(path)
        except OSError:
            pass
    try:
        got = subprocess.run(["git", "config", "--system", "--get-all", "http.proxy"], capture_output=True, text=True, timeout=30)
        if LEGACY in got.stdout:
            subprocess.run(["git", "config", "--system", "--unset-all", "http.proxy"], capture_output=True, timeout=30)
    except (OSError, subprocess.SubprocessError):
        pass
    targets = ["/etc/environment", "/etc/profile.d/proxy.sh", "/etc/hosts"] + [os.path.join(HOME, name) for name in (".gitconfig", ".npmrc", ".profile", ".bashrc", ".bash_profile", ".wgetrc", ".curlrc", ".pip/pip.conf", ".config/pip/pip.conf", ".hermes/.env")]
    for path in targets:
        try:
            with open(path) as handle:
                lines = handle.read().split("\n")
        except (OSError, UnicodeDecodeError):
            continue
        kept, inside, changed = [], False, False
        for line in lines:
            if line.startswith("# universe-egress begin"):
                inside, changed = True, True
                continue
            if inside:
                if line.startswith("# universe-egress end"):
                    inside = False
                continue
            if LEGACY in line:
                changed = True
                continue
            kept.append(line)
        if changed:
            try:
                with open(path, "w") as handle:
                    handle.write("\n".join(kept))
            except OSError:
                pass

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
    drop_legacy_proxy()
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
    { name: 'universe-visits', mode: 0o755, text: UNIVERSE_VISITS },
    { name: 'universe-cold', mode: 0o755, text: UNIVERSE_COLD },
  ];
}
