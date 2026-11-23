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
  if (exitCode === 0 && said === '0' && action === 'park' && reason === 'nothing') return { done: 'none', reason, cookies: 0, pages: 0 };
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

# Marked before the profile is touched, unmarked only when it is proved moved: until then the image's start-up removes it before any job can use it.
# The mark is a FOLDER made with mkdir, never a file opened with ">": this command runs as root over a path the agent owns, and an open for
# writing would follow a link the agent put there and empty whatever it points at (/etc/sudoers, say). mkdir follows no link and truncates
# nothing: anything already at that name makes it fail, and the action is refused, which is the safe way to fail. Nothing else root does here
# opens a path under the agent's home for writing.
mark() {
  [ -d "$STATE" ] && [ ! -L "$STATE" ] || return 1
  rm -rf "$STATE/profile.dirty" 2>/dev/null
  mkdir "$STATE/profile.dirty" 2>/dev/null || return 1
  chown -h "$NODE_USER" "$STATE/profile.dirty" 2>/dev/null
  [ -d "$STATE/profile.dirty" ] && [ ! -L "$STATE/profile.dirty" ]
}
unmark() {
  rm -rf "$STATE/profile.dirty" 2>/dev/null
  [ ! -e "$STATE/profile.dirty" ] && [ ! -L "$STATE/profile.dirty" ]
}

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
    if not isinstance(saved, dict):
        raise ValueError("not a snapshot")
except Exception:
    # A snapshot that cannot be read is NOT an empty one: it is kept and the replay is said to be incomplete (CodeRabbit on #1025)
    print("cookies=0 pages=0 answer=0")
    sys.exit(0)
cookies = [item for item in saved.get("cookies") or [] if isinstance(item, dict) and item.get("name") is not None]
pages = [url for url in saved.get("pages") or [] if isinstance(url, str) and url.startswith(("http://", "https://"))]
# Nothing was saved to put back (the park found no browser answering either): there is nothing a browser could lose, so the restore is not
# held up waiting for one to answer (CodeRabbit N6 on #1025: only a replay that LOSES something counts as a failed restore)
if not cookies and not pages:
    print("cookies=0 pages=0 answer=1")
    sys.exit(0)
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
complete = True
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
                complete = False
# A retry after a partial replay opens only the pages that are not open yet (a page that already came back is never opened twice).
# Tabs are counted PER ADDRESS: two saved tabs on one address are two tabs to bring back, and one already open satisfies only one of them.
def open_tabs():
    return [str(item.get("url", "")) for item in http("GET", "/json/list") or [] if item.get("type") == "page"]

present = {}
if pages:
    try:
        for tab in open_tabs():
            present[tab] = present.get(tab, 0) + 1
    except Exception:
        # A list that cannot be read is NOT an empty one: opening every page again would double the tabs a partial replay already brought back.
        # The replay is said to be incomplete and the saved session is kept (the retry lists again)
        print("cookies=%d pages=0 answer=0" % put)
        sys.exit(0)
opened = 0
for url in pages:
    if present.get(url, 0) > 0:
        present[url] -= 1
        opened += 1
        continue
    try:
        http("PUT", "/json/new?" + urllib.parse.quote(url, safe=""))
        opened += 1
    except Exception:
        complete = False
# Only a replay that put back EVERY cookie and page is a finished one: the saved session is kept until then
print("cookies=%d pages=%d answer=%d" % (put, opened, 1 if complete else 0))
PYEND
}

# Puts the saved session back (when there is one) into "loaded". Only a replay that EXITED CLEANLY and said answer=1 is an acknowledged one: a saved
# session the replay could not even read (it dies before it prints anything) or one that is not whole is never taken for one that worked, because the
# saved session is the only copy. No saved session is a restore with nothing to replay (answered separately: nothing is held back).
replay() {
  loaded=""
  [ -f "$JOBDIR/session.json" ] || return 0
  loaded="$(devtools load "$JOBDIR/session.json" 2>/dev/null)" || return 1
  [ "$(echo "$loaded" | tail -n 1 | grep -c '^cookies=[0-9]* pages=[0-9]* answer=1$')" = "1" ]
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
  had_profile=0
  if [ -d "$PROFILE" ] && [ ! -L "$PROFILE" ]; then had_profile=1; mv "$PROFILE" "$JOBDIR.new/profile" || { say "0 reason=move"; exit 1; }; else rm -rf "$PROFILE"; fi
  if [ -e "$PROFILE" ] || [ -L "$PROFILE" ] || [ -e "$CACHE" ]; then say "0 reason=profile_not_removed"; exit 1; fi
  # Neither a browser profile nor a readable session (no cookie, no open page) was there to put away: nothing is kept, and it is NOT said as parked
  # (the pause must not tell the person their sign-ins are kept; CodeRabbit on #1025). The browser is started empty again and the machine waits for nothing
  case "$(counts "$saved")" in
    "cookies=0 pages=0"|"") if [ "$had_profile" = "0" ]; then rm -rf "$JOBDIR.new"; unmark; unlock; start_browser; say "0 reason=nothing"; exit 0; fi ;;
  esac
  chown -R -h root:root "$JOBDIR.new" && chmod -R go-rwx "$JOBDIR.new" || { rm -rf "$JOBDIR.new"; unmark; say "0 reason=folder"; exit 1; }
  mv "$JOBDIR.new" "$JOBDIR" || { rm -rf "$JOBDIR.new"; unmark; say "0 reason=folder"; exit 1; }
  unmark
  unlock
  start_browser
  say "1 $(counts "$saved")"
  ;;
restore)
  prune
  # A try before this one already moved this job's profile into place and the browser never answered the session replay (the "moved" note). The profile
  # on the machine is this job's OWN, so nothing is wiped and nothing is moved: only the replay that failed is done again. Wiping here would
  # throw away the very profile the earlier try restored
  # A try that stopped between the move and its note: the move began ("moving") and the parked profile is no longer in the park folder, so it is already in place and is this job's own.
  # Its dirty mark may still be there (a try cut off after the move): it is cleared FIRST and under the lock, so the image's start-up (which removes a profile that is marked) cannot take it
  if [ -f "$JOBDIR/moving" ] && [ ! -f "$JOBDIR/moved" ] && [ ! -e "$JOBDIR/profile" ] && [ ! -L "$JOBDIR/profile" ] && [ -d "$PROFILE" ] && [ ! -L "$PROFILE" ]; then
    lock
    unmark || { say "0 reason=mark"; exit 1; }
    chown -R -h "$NODE_USER": "$PROFILE" || { say "0 reason=move"; exit 1; }
    # "moving" stays until "moved" is written: without both there is no record that the profile on the machine is this job's own
    # printf, not ":", because a failed redirection on a special builtin ends the shell without a word
    printf '' > "$JOBDIR/moved" || { say "0 reason=move"; exit 1; }
    rm -f "$JOBDIR/moving"
    unlock
  fi
  if [ -f "$JOBDIR/moved" ]; then
    # The live profile is this job's own. A mark left on it (by a try that was cut off) would have the start-up remove it before the browser runs:
    # it is cleared under the lock, and the browser is never started while it is there
    lock
    unmark || { say "0 reason=mark"; exit 1; }
    unlock
    start_browser
    replay || { say "0 reason=no_answer"; exit 1; }
    rm -rf "$JOBDIR" "$JOBDIR.new"
    say "1 $(counts "$loaded")"
    exit 0
  fi
  lock
  mark || { say "0 reason=mark"; exit 1; }
  stop_browser || { say "0 reason=browser_running"; exit 1; }
  rm -rf "$PROFILE" "$CACHE" 2>/dev/null
  if [ -e "$PROFILE" ] || [ -L "$PROFILE" ] || [ -e "$CACHE" ]; then say "0 reason=profile_not_removed"; exit 1; fi
  had=0
  if [ -d "$JOBDIR/profile" ] && [ ! -L "$JOBDIR/profile" ]; then
    mkdir -p "$(dirname "$PROFILE")" && chown -h "$NODE_USER": "$(dirname "$PROFILE")" 2>/dev/null
    # The move is noted BEFORE it is made: a try that stops anywhere after this knows whether the profile left the park folder (see above) and never wipes the one that did
    printf '' > "$JOBDIR/moving" || { say "0 reason=move"; exit 1; }
    mv "$JOBDIR/profile" "$PROFILE" || { say "0 reason=move"; exit 1; }
    # In place from here: the mark is cleared under the lock BEFORE any exit that lets the lock go, so the start-up never removes the moved profile
    unmark || { say "0 reason=mark"; exit 1; }
    chown -R -h "$NODE_USER": "$PROFILE" || { say "0 reason=move"; exit 1; }
    had=1
  fi
  [ -f "$JOBDIR/session.json" ] && had=1
  # From here the live profile IS this job's own: a try that stops after this must not wipe it (the folder is root's alone, so this note is root's alone).
  # "moving" is removed only once "moved" is written: if the note cannot be written the record of the move stays
  if [ -d "$JOBDIR" ]; then printf '' > "$JOBDIR/moved" || { say "0 reason=move"; exit 1; }; fi
  rm -f "$JOBDIR/moving"
  unmark || { say "0 reason=mark"; exit 1; }
  unlock
  start_browser
  # The browser did not answer, or the replay was not whole: the saved session is the ONLY copy of those cookies and open pages, so it is kept and the
  # restore is reported failed rather than said to have worked. Orbit leaves the job in recover and asks again, and the try above finishes the replay alone
  replay || { say "0 reason=no_answer"; exit 1; }
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
