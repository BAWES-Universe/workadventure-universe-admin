/**
 * The command that puts one job's browser sign-ins away on its Brick's computer, brings them back, or throws them away (piece 4 of the
 * computers plan: a paused job keeps its own sign-ins and open pages, and no other job can reach them).
 *
 * WHERE THEY ARE KEPT. The agent runs as the image's own user (node). A parked browser is moved into a folder that belongs to root and is
 * closed to everyone else (`/var/lib/universe/signins/<job id>`, mode 0700 all the way down), so no agent, of this job or any other, can read
 * it. It is outside the home folder, so it is never in the Files list, never in a cold-storage copy (that copies the home folder and a fixed
 * list of system folders this is not in) and goes with the machine when the machine goes.
 *
 * WHAT IS KEPT. The browser's profile folder (its cookies that last, its site storage, its history) and, read from the browser's own DevTools
 * just before it is stopped, every cookie it holds (session cookies too, which a stopped browser never writes to disk: most sign-ins are
 * those) and the address of every open page. The cache is not kept (it is thrown away, as the cleanup between jobs does).
 *
 * HOW IT RUNS. One `sh` command run as root through the provider's command runner. Nothing in it is a secret (the command line of a running
 * command can be read by the agent): it names the job and the jobs that may keep a parked browser, nothing else. It never edits a file the
 * agent can write as root (the profile is only moved, removed or handed back to node with `chown -h`, which never follows a link), and the
 * browser is started again as node, never as root. It holds the same lock as the image's `universe-up` and `universe-clean`, and it marks
 * the profile "dirty" (the image's own mark) before it touches it and unmarks it only when it is proved put away or handed back: a command
 * cut off in between leaves the mark, and the next `universe-up` (which the supervisor runs every few seconds) removes the profile before any
 * job can use it. So a failure loses sign-ins, never shows them to another job.
 *
 * Actions:
 *   park     the browser of this job, now on the machine, is put away (and comes back empty for the next job). Prints parked=1 cookies=N pages=N,
 *            or parked=0 reason=already (this job's browser is already put away: nothing is touched).
 *   restore  the live browser is ALWAYS replaced: by this job's own parked browser when there is one (restored=1), or by an empty one
 *            (restored=0 reason=none). Its cookies and pages are put back once the browser answers (cookies=N pages=N).
 *   drop     this job's parked browser is removed. Prints dropped=1.
 *   clear    the live browser is emptied (nothing is kept), for a job whose browser was shared with another job still on the machine. Prints cleared=1.
 *   prune    only the removal below. Prints pruned=1.
 * Every action also removes parked browsers of jobs not in the keep list (older than two minutes, so one being put away right now is never
 * taken), and every parked browser older than the Limits value for paused sign-ins whatever the list says, so a drop that was missed is made
 * good by the next command on the machine.
 *
 * The script avoids backticks and dollar-braces on purpose, so it sits in a plain template string without escaping (same as the image's).
 */

export type SignInsAction = 'park' | 'restore' | 'drop' | 'clear' | 'prune';

/** Where things are on the machine. Only tests change these (to run the same script in a folder of their own). */
export interface SignInsPlaces {
  /** Root-only folder the parked browsers are kept in. */
  parkRoot: string;
  /** The user the agent and the browser run as. */
  user: string;
  /** That user's home folder; empty = read from the user database. */
  home: string;
  /** The browser's DevTools address (loopback). */
  devtools: string;
  /** Starts the browser again as `user` (and the screen's parts with it). */
  start: string;
  /** Seconds to wait for the browser to answer after it was started again. */
  answerWait: number;
}

export const MACHINE_PLACES: SignInsPlaces = {
  parkRoot: '/var/lib/universe/signins',
  user: 'node',
  home: '',
  devtools: '127.0.0.1:9222',
  start: 'runuser -u "$NODE_USER" -- env HOME="$HOME_DIR" /usr/local/bin/universe-up --child',
  answerWait: 30,
};

/** A job id that may be written into the command: Orbit's ids are UUIDs; anything else is refused before a command is made. */
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;

export function isSafeJobId(id: string): boolean {
  return JOB_ID.test(id);
}

/** The command for one action on one job. `keep`: the jobs of this Brick that may keep a parked browser (this job is taken out of it for a drop). */
export function signInsCommand(action: SignInsAction, jobId: string, keep: string[], keepHours: number, places: SignInsPlaces = MACHINE_PLACES): string {
  if (!isSafeJobId(jobId)) throw new Error('Not a job id');
  const kept = keep.filter((id) => isSafeJobId(id) && !(action === 'drop' && id === jobId));
  return SIGNINS_SCRIPT.replace('__ACTION__', action)
    .replace('__JOB__', jobId)
    .replace('__KEEP__', kept.join(' '))
    .replace('__KEEP_MINUTES__', String(Math.max(1, Math.round(keepHours * 60))))
    .replace('__PARK_ROOT__', places.parkRoot)
    .replace('__NODE_USER__', places.user)
    .replace('__HOME__', places.home)
    .replace('__DEVTOOLS__', places.devtools)
    .replace('__ANSWER_WAIT__', String(Math.max(1, Math.round(places.answerWait))))
    .replace('__START__', places.start);
}

export interface SignInsAnswer {
  /** What the machine said it did: kept (parked or restored with this job's own browser), none (nothing of this job's was there), dropped, or failed. */
  done: 'kept' | 'none' | 'dropped' | 'already' | 'failed';
  reason: string | null;
  cookies: number;
  pages: number;
}

const KEYS: Record<SignInsAction, string> = { park: 'parked', restore: 'restored', drop: 'dropped', clear: 'cleared', prune: 'pruned' };

/** Reads the last line the command printed. Anything that is not one of its own lines is a failure. */
export function readSignInsAnswer(action: SignInsAction, exitCode: number, stdout: string): SignInsAnswer {
  const key = KEYS[action];
  const line = stdout.split('\n').map((one) => one.trim()).filter((one) => one.startsWith(key + '=')).at(-1) ?? '';
  const field = (name: string): string | null => new RegExp('(?:^|\\s)' + name + '=([a-z0-9_]+)').exec(line)?.[1] ?? null;
  const count = (name: string): number => {
    const value = Number(field(name));
    return Number.isFinite(value) && value >= 0 ? value : 0;
  };
  const reason = field('reason');
  const said = field(key);
  if (exitCode === 0 && said === '1') return { done: action === 'park' || action === 'restore' ? 'kept' : 'dropped', reason: null, cookies: count('cookies'), pages: count('pages') };
  if (exitCode === 0 && said === '0' && action === 'restore' && reason === 'none') return { done: 'none', reason, cookies: 0, pages: 0 };
  if (exitCode === 0 && said === '0' && action === 'park' && reason === 'already') return { done: 'already', reason, cookies: 0, pages: 0 };
  return { done: 'failed', reason: reason ?? (line ? 'unknown' : `exit_${exitCode}`), cookies: 0, pages: 0 };
}

export const SIGNINS_SCRIPT = String.raw`set -u
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
ACTION="__ACTION__"
JOB="__JOB__"
KEEP="__KEEP__"
KEEP_MINUTES="__KEEP_MINUTES__"
PARK_ROOT="__PARK_ROOT__"
NODE_USER="__NODE_USER__"
HOME_DIR="__HOME__"
DEVTOOLS="__DEVTOOLS__"
ANSWER_WAIT="__ANSWER_WAIT__"
case "$ACTION" in park) KEY=parked ;; restore) KEY=restored ;; drop) KEY=dropped ;; clear) KEY=cleared ;; prune) KEY=pruned ;; *) echo "signins=0 reason=action"; exit 1 ;; esac
say() { echo "$KEY=$*"; }
[ "$(id -u)" = "0" ] || { say "0 reason=not_root"; exit 1; }
umask 077
[ -n "$HOME_DIR" ] || HOME_DIR="$(getent passwd "$NODE_USER" | cut -d: -f6)"
[ -n "$HOME_DIR" ] || HOME_DIR=/home/node
STATE="$HOME_DIR/.universe"
PROFILE="$HOME_DIR/.config/universe-chromium"
CACHE="$HOME_DIR/.cache/chromium"
JOBDIR="$PARK_ROOT/$JOB"

# The folder the parked browsers are kept in: root's, closed to everyone else, and never a link the agent could have put there
PARENT="$(dirname "$PARK_ROOT")"
mkdir -p "$PARENT" && chown root:root "$PARENT" && chmod 0755 "$PARENT" || { say "0 reason=folder"; exit 1; }
if [ -L "$PARK_ROOT" ] || { [ -e "$PARK_ROOT" ] && [ ! -d "$PARK_ROOT" ]; }; then rm -f "$PARK_ROOT"; fi
mkdir -p "$PARK_ROOT" && chown root:root "$PARK_ROOT" && chmod 0700 "$PARK_ROOT" || { say "0 reason=folder"; exit 1; }
[ "$(stat -c '%u %a' "$PARK_ROOT" 2>/dev/null)" = "0 700" ] || { say "0 reason=folder"; exit 1; }

# Parked browsers of jobs that may no longer keep one are removed (one put away in the last two minutes is left, it may be a job just paused)
prune() {
  for dir in "$PARK_ROOT"/* "$PARK_ROOT"/.[!.]*; do
    [ -e "$dir" ] || [ -L "$dir" ] || continue
    name="$(basename "$dir")"
    base="$(echo "$name" | sed 's/\.new$//')"
    keep=0
    for one in $KEEP; do [ "$one" = "$base" ] && [ "$name" = "$base" ] && keep=1; done
    # Kept longer than paused sign-ins may be kept: removed whatever the list says
    if [ -n "$(find "$dir" -maxdepth 0 -mmin +"$KEEP_MINUTES" 2>/dev/null)" ]; then rm -rf "$dir"; continue; fi
    [ "$keep" = "1" ] && continue
    [ "$base" = "$JOB" ] && [ "$ACTION" = "park" ] && continue
    if [ -n "$(find "$dir" -maxdepth 0 -mmin -2 2>/dev/null)" ]; then continue; fi
    rm -rf "$dir"
  done
}

# The lock the image's universe-up and universe-clean hold: the supervisor cannot start the browser between its stop and the move
LOCK="$STATE/up.lock"
lock() {
  mkdir -p "$STATE" 2>/dev/null
  if [ -d "$LOCK" ] && [ -n "$(find "$LOCK" -maxdepth 0 -mmin +1 2>/dev/null)" ]; then rmdir "$LOCK" 2>/dev/null; fi
  waited=0
  until mkdir "$LOCK" 2>/dev/null; do
    waited=$((waited+1))
    [ "$waited" -gt 150 ] && { say "0 reason=busy"; exit 1; }
    sleep 0.2
  done
  trap 'rmdir "$LOCK" 2>/dev/null' EXIT
}
unlock() {
  rmdir "$LOCK" 2>/dev/null
  trap - EXIT
}

# Marked before the profile is touched, unmarked only when it is proved moved: until then the image's start-up removes it before any job can use it
mark() { : > "$STATE/profile.dirty" && chown -h "$NODE_USER" "$STATE/profile.dirty" 2>/dev/null; [ -f "$STATE/profile.dirty" ]; }
unmark() { rm -f "$STATE/profile.dirty"; }

stop_browser() {
  pkill -x websockify 2>/dev/null
  pkill -x chromium 2>/dev/null
  pkill -x chrome 2>/dev/null
  i=0
  while pgrep -x chromium >/dev/null 2>&1 || pgrep -x chrome >/dev/null 2>&1; do
    i=$((i+1))
    if [ "$i" -eq 20 ]; then pkill -9 -x chromium 2>/dev/null; pkill -9 -x chrome 2>/dev/null; fi
    [ "$i" -gt 50 ] && return 1
    sleep 0.2
  done
  return 0
}

start_browser() {
  ( __START__ ) >/dev/null 2>&1 </dev/null
  return 0
}

# Talks to the browser's DevTools (loopback only): "save FILE" writes every cookie it holds and the address of every open page; "load FILE"
# waits for the browser to answer, then puts the cookies back and opens the pages. Prints cookies=N pages=N.
devtools() {
  python3 - "$1" "$2" "$DEVTOOLS" "$ANSWER_WAIT" <<'PYEND'
import base64, json, os, socket, struct, sys, time, urllib.parse, urllib.request
mode, path, address, wait = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
host, port = address.rsplit(":", 1)
port = int(port)
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

def http(method, where):
    with opener.open(urllib.request.Request("http://%s:%d%s" % (host, port, where), method=method), timeout=5) as answer:
        return json.loads(answer.read().decode("utf-8") or "null")

class Socket:
    def __init__(self, url):
        rest = url.split("://", 1)[1]
        where = rest[rest.index("/"):]
        self.sock = socket.create_connection((host, port), timeout=10)
        key = base64.b64encode(os.urandom(16)).decode()
        self.sock.sendall(("GET %s HTTP/1.1\r\nHost: %s:%d\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n" % (where, host, port, key)).encode())
        head = b""
        while b"\r\n\r\n" not in head:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise IOError("closed")
            head += chunk
        if b" 101 " not in head.split(b"\r\n", 1)[0]:
            raise IOError("refused")
        self.buffer = head.split(b"\r\n\r\n", 1)[1]
        self.next = 0
    def take(self, n):
        while len(self.buffer) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise IOError("closed")
            self.buffer += chunk
        out, self.buffer = self.buffer[:n], self.buffer[n:]
        return out
    def send(self, method, params=None):
        self.next += 1
        data = json.dumps({"id": self.next, "method": method, "params": params or {}}).encode()
        mask = os.urandom(4)
        size = len(data)
        head = b"\x81" + (bytes([0x80 | size]) if size < 126 else (bytes([0x80 | 126]) + struct.pack(">H", size) if size < 65536 else bytes([0x80 | 127]) + struct.pack(">Q", size)))
        self.sock.sendall(head + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))
        while True:
            message = self.receive()
            if message.get("id") == self.next:
                if "error" in message:
                    raise IOError("devtools said no")
                return message.get("result") or {}
    def receive(self):
        parts = b""
        while True:
            first, second = self.take(2)
            size = second & 0x7F
            if size == 126:
                size = struct.unpack(">H", self.take(2))[0]
            elif size == 127:
                size = struct.unpack(">Q", self.take(8))[0]
            mask = self.take(4) if second & 0x80 else None
            payload = self.take(size)
            if mask:
                payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
            opcode = first & 0x0F
            if opcode == 8:
                raise IOError("closed")
            if opcode in (9, 10):
                continue
            parts += payload
            if first & 0x80:
                return json.loads(parts.decode("utf-8"))

def browser():
    return Socket(http("GET", "/json/version")["webSocketDebuggerUrl"])

ALLOWED = ("name", "value", "domain", "path", "secure", "httpOnly", "sameSite", "priority", "sourceScheme", "sourcePort", "partitionKey")

if mode == "save":
    cookies, pages = [], []
    try:
        cookies = browser().send("Storage.getCookies").get("cookies") or []
    except Exception:
        cookies = []
    try:
        pages = [item.get("url") for item in http("GET", "/json/list") or [] if item.get("type") == "page" and str(item.get("url", "")).startswith(("http://", "https://"))]
    except Exception:
        pages = []
    with open(path, "w") as handle:
        json.dump({"cookies": cookies, "pages": pages}, handle)
    print("cookies=%d pages=%d" % (len(cookies), len(pages)))
    sys.exit(0)

try:
    with open(path) as handle:
        saved = json.load(handle)
except Exception:
    saved = {}
cookies = [item for item in saved.get("cookies") or [] if isinstance(item, dict) and item.get("name") is not None]
pages = [url for url in saved.get("pages") or [] if isinstance(url, str) and url.startswith(("http://", "https://"))]
deadline = time.time() + wait
connection = None
while time.time() < deadline:
    try:
        connection = browser()
        break
    except Exception:
        time.sleep(0.5)
if connection is None:
    print("cookies=0 pages=0 answer=0")
    sys.exit(0)
put = 0
if cookies:
    ready = []
    for item in cookies:
        one = dict((name, item[name]) for name in ALLOWED if name in item)
        if not item.get("session") and isinstance(item.get("expires"), (int, float)) and item["expires"] > 0:
            one["expires"] = item["expires"]
        ready.append(one)
    try:
        connection.send("Storage.setCookies", {"cookies": ready})
        put = len(ready)
    except Exception:
        # One cookie the browser will not take must not lose the others
        for one in ready:
            try:
                connection.send("Storage.setCookies", {"cookies": [one]})
                put += 1
            except Exception:
                pass
opened = 0
for url in pages:
    try:
        http("PUT", "/json/new?" + urllib.parse.quote(url, safe=""))
        opened += 1
    except Exception:
        pass
print("cookies=%d pages=%d" % (put, opened))
PYEND
}

counts() { echo "$1" | grep -o 'cookies=[0-9]* pages=[0-9]*' | tail -1; }

case "$ACTION" in
park)
  prune
  if [ -d "$JOBDIR" ]; then say "0 reason=already"; exit 0; fi
  rm -rf "$JOBDIR.new"
  mkdir -m 0700 "$JOBDIR.new" || { say "0 reason=folder"; exit 1; }
  lock
  mark || { say "0 reason=mark"; exit 1; }
  saved="$(devtools save "$JOBDIR.new/session.json" 2>/dev/null)"
  stop_browser || { say "0 reason=browser_running"; exit 1; }
  rm -rf "$CACHE" 2>/dev/null
  if [ -d "$PROFILE" ] && [ ! -L "$PROFILE" ]; then mv "$PROFILE" "$JOBDIR.new/profile" || { say "0 reason=move"; exit 1; }; else rm -rf "$PROFILE"; fi
  if [ -e "$PROFILE" ] || [ -L "$PROFILE" ] || [ -e "$CACHE" ]; then say "0 reason=profile_not_removed"; exit 1; fi
  chown -R -h root:root "$JOBDIR.new" && chmod -R go-rwx "$JOBDIR.new" || { rm -rf "$JOBDIR.new"; unmark; say "0 reason=folder"; exit 1; }
  mv "$JOBDIR.new" "$JOBDIR" || { rm -rf "$JOBDIR.new"; unmark; say "0 reason=folder"; exit 1; }
  unmark
  unlock
  start_browser
  say "1 $(counts "$saved")"
  ;;
restore)
  prune
  lock
  mark || { say "0 reason=mark"; exit 1; }
  stop_browser || { say "0 reason=browser_running"; exit 1; }
  rm -rf "$PROFILE" "$CACHE" 2>/dev/null
  if [ -e "$PROFILE" ] || [ -L "$PROFILE" ] || [ -e "$CACHE" ]; then say "0 reason=profile_not_removed"; exit 1; fi
  had=0
  if [ -d "$JOBDIR/profile" ] && [ ! -L "$JOBDIR/profile" ]; then
    mkdir -p "$(dirname "$PROFILE")" && chown -h "$NODE_USER": "$(dirname "$PROFILE")" 2>/dev/null
    mv "$JOBDIR/profile" "$PROFILE" && chown -R -h "$NODE_USER": "$PROFILE" || { say "0 reason=move"; exit 1; }
    had=1
  fi
  [ -f "$JOBDIR/session.json" ] && had=1
  unmark
  unlock
  start_browser
  loaded=""
  if [ -f "$JOBDIR/session.json" ]; then loaded="$(devtools load "$JOBDIR/session.json" 2>/dev/null)"; fi
  rm -rf "$JOBDIR" "$JOBDIR.new"
  if [ "$had" = "1" ]; then say "1 $(counts "$loaded")"; else say "0 reason=none"; fi
  ;;
drop)
  rm -rf "$JOBDIR" "$JOBDIR.new"
  prune
  if [ -e "$JOBDIR" ] || [ -e "$JOBDIR.new" ]; then say "0 reason=not_removed"; exit 1; fi
  say "1"
  ;;
clear)
  prune
  lock
  mark || { say "0 reason=mark"; exit 1; }
  stop_browser || { say "0 reason=browser_running"; exit 1; }
  rm -rf "$PROFILE" "$CACHE" 2>/dev/null
  if [ -e "$PROFILE" ] || [ -L "$PROFILE" ] || [ -e "$CACHE" ]; then say "0 reason=profile_not_removed"; exit 1; fi
  unmark
  unlock
  start_browser
  say "1"
  ;;
prune)
  prune
  say "1"
  ;;

esac
exit 0
`;
