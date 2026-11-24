/**
 * The take-over fence and its starting mark, held by Orbit instead of by the computer (root-agent item 3A, opus-agent-root-design-24-nov.md).
 *
 * WHY. The agent on a Brick's computer has admin rights. A mark kept on that computer can be rewritten by it, and "a program that root owns"
 * proves nothing about who started it. So the mark now lives in Orbit's database (the boot id, the kernel's clock reading when the computer
 * was made ready, and the processes the computer's own start-up made), and Orbit sends it to the fence with every call. The fence keeps
 * what Orbit says is the computer's own and stops everything else, whoever owns it.
 *
 * SENT WITH EVERY CALL, never kept in the image: the same way the sign-ins command is. A change here needs no new image revision, and Orbit
 * and the fence can never be of two versions.
 *
 * TWO COMMANDS, both run as the computer's normal user (root cannot read the programs of the agent's processes on a real Agent37 machine):
 *   markCommand()          reads, writes nothing: boot id, clock, the computer's own parts, the fingerprint of Agent37's own command runner.
 *   fenceCommand(mark)     stops everything the mark does not name; fenceCommand(mark, true) only counts what is left (`remaining=N`).
 *
 * WHAT THE FENCE KEEPS (and nothing else):
 *   - process 1, the fence's own chain up to process 1 (the computer's command runner it runs under);
 *   - everything that was already running at the mark (started at or before the saved clock reading): the computer's own, because nothing
 *     the agent started can be older than the mark;
 *   - the parts the mark names (pid AND start tick, so a reused pid is not one): the screen, the browser, the model address, the recorder,
 *     the supervisor and the agent's gateway; whatever the browser and the other parts started below them; the chain above the gateway;
 *   - Agent37's command runner, told by the fingerprint of its program file (never by who owns it);
 *   - the short waits process 1's own start-up loop runs (killing one stops the computer).
 *
 * HONEST LIMITS (the words for the person must not promise more):
 *   - A program built to hide inside one of the kept parts (memory edits in a running browser, say) is not seen by this.
 *   - A program the agent ran as root stays running (the fence runs as the normal user and cannot stop it); the fence counts it (every process
 *     that still exists counts, also one whose stat or command line it cannot read), cannot prove the machine clear, and the machine is
 *     stopped. That fails safe.
 *   - What is on the list is whatever ran the desktop's program with the desktop's arguments when Orbit read it, whoever started it: the
 *     agent's own ordinary processes too. So the fence narrows the window from "any time" to "alive at one of Orbit's own read moments"; it
 *     does not stop everything the agent started, and no words may say it does.
 *   - Each stop is sent through a process handle (pidfd) opened on the process the scan classified; a kernel or sandbox without handles gets the start tick
 *     read again just before the signal, which narrows the window and does not close it.
 *   - Parts are saved when the computer is made ready and again after each restart Orbit itself does (the browser after a clean-up or a
 *     sign-ins command). A part the computer restarted by itself in between (a browser that crashed) is not on the list: the fence stops it
 *     and the supervisor brings a fresh one up within seconds.
 *
 * The scripts avoid backticks and dollar-braces so they sit in a plain template string without escaping.
 */

/** What Orbit keeps on the computer's row: read once through the mark command, and sent back with every fence. */
export interface MachineMark {
  /** The kernel's boot id when the mark was taken: a stop and start is a new one, and then the mark is taken again. */
  bootId: string;
  /** The kernel's clock reading (in ticks since boot) when the mark was taken. Everything running at or before it is the computer's own. */
  ticks: number;
  /** The computer's own parts that were started after the cutoff or may be: process id, the tick it started at, and what kind. */
  parts: MarkPart[];
  /** Fingerprints (sha256) of the program files of Agent37's own command runner. */
  runners: string[];
}

/** `screen`: the screen's server or window manager (kept, but nothing below it); `part`: kept with everything it started; `gateway`: kept with the chain above it. */
export type MarkPartKind = 'screen' | 'part' | 'gateway';
export interface MarkPart {
  pid: number;
  start: number;
  kind: MarkPartKind;
}

const KIND_LETTER: Record<MarkPartKind, string> = { screen: 's', part: 'p', gateway: 'g' };
const LETTER_KIND: Record<string, MarkPartKind> = { s: 'screen', p: 'part', g: 'gateway' };
const BOOT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
/** More than this many parts means something is wrong with the list: it is refused rather than sent. */
export const MARK_PARTS_MAX = 200;

/** The first line of every command sent: how a command is told apart (logs, the pretend provider, tests) without reading the script. */
const FENCE_TAG = '# universe-fence';
const FENCE_CHECK_TAG = '# universe-fence --check';
const MARK_TAG = '# universe-mark';
const END = 'UNIVERSE_SCRIPT_END';

export const isFenceCommand = (command: string): boolean => command.startsWith(FENCE_TAG);
export const isFenceCheckCommand = (command: string): boolean => command.startsWith(FENCE_CHECK_TAG);
export const isMarkCommand = (command: string): boolean => command.startsWith(MARK_TAG);

/** What both scripts share: reading a process, its start, the clock. */
const COMMON = String.raw`
import hashlib
import os
import re
import sys

BOOT_ID = "/proc/sys/kernel/random/boot_id"
AGENT37_DIR = "/.agent37/"
CLOCK_TICKS = os.sysconf("SC_CLK_TCK")


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


def started(pid):
    try:
        return int(stat_fields(pid)[19])
    except Exception:
        return None


def trusted(path):
    # A program file that root owns and nobody else can write. This is NOT proof the agent did not make it (the agent has admin rights): it is
    # only one more thing a program must be, never the reason it is kept
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


def ticks_now():
    try:
        with open("/proc/uptime", "r", encoding="utf-8") as handle:
            return int(float(handle.read().split()[0]) * CLOCK_TICKS)
    except Exception:
        return None


def boot_id():
    try:
        with open(BOOT_ID, "r", encoding="utf-8") as handle:
            return handle.read().strip()
    except Exception:
        return None


_hashes = {}


def fingerprint(path):
    # What a program file IS, whoever owns it: its sha256 (read once per file in one run)
    if path in _hashes:
        return _hashes[path]
    digest = None
    try:
        sha = hashlib.sha256()
        with open(path, "rb") as handle:
            for block in iter(lambda: handle.read(1 << 20), b""):
                sha.update(block)
        digest = sha.hexdigest()
    except Exception:
        digest = None
    _hashes[path] = digest
    return digest


def runner_program(pid):
    # Agent37's own command runner: a program file of theirs, under their folder
    path = program(pid)
    return path if path and path.startswith(AGENT37_DIR) else None
`;

/** The mark: what the computer is made of at the moment it is ready. Run as the normal user; writes nothing. */
const MARK_BODY = String.raw`
PROFILE = os.path.join(os.environ.get("HOME") or "/home/node", ".config", "universe-chromium")
SCRIPTS_DIR = "/usr/local/bin"
# The desktop's parts are told by what they ARE and how they were started (the program file, and the arguments universe-up starts it with). The
# agent can run these same programs itself, which is why this only builds the list at the moment Orbit asks for it (before a job uses the
# computer, or right after Orbit's own restart of them), and the fence keeps only what is on it
DESKTOP_PROGRAMS = {"Xvfb", "openbox"}
OPENBOX_RUNS = ("--startup", "--config-file", "--exec")
INTERPRETERS = re.compile(r"^(python3(\.\d+)?|sh|dash|bash)$")
OWN_SCRIPTS = {os.path.join(SCRIPTS_DIR, name) for name in ("universe-proxy", "universe-supervise", "universe-up", "universe-visits")}
X11VNC_ARGS = ["-display", ":99", "-rfbport", "5900", "-localhost", "-forever", "-shared", "-nopw", "-quiet"]
WEBSOCKIFY_ARGS = ["--web", "/usr/share/novnc", "6901", "127.0.0.1:5900"]
CHROMIUM_FLAGS = ["--user-data-dir=" + PROFILE, "--remote-debugging-port=9222", "--remote-debugging-address=127.0.0.1"]
GATEWAY_PORTS = {3737, 8642}


def desktop_part(pid):
    path = program(pid)
    if not path:
        return False
    name = os.path.basename(path)
    args = argv(pid)
    if name == "Xvfb":
        # Xvfb ignores everything after -I, so a display number placed there is not one it uses
        rest = args[1:]
        if "-I" in rest:
            rest = rest[:rest.index("-I")]
        return [part for part in rest if re.match(r"^:\d+$", part)] == [":99"]
    if name == "openbox":
        return not any(part.split("=")[0] in OPENBOX_RUNS for part in args[1:])
    if name == "x11vnc":
        return args[1:] == X11VNC_ARGS
    if name in ("chromium", "chrome"):
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


boot = boot_id()
now = ticks_now()
if not boot or now is None:
    print("marked=0 reason=clock")
    sys.exit(1)
# Two ticks on, as the old note did: a process started within the same tick as the reading is the computer's own
print("boot=" + boot)
print("ticks=%d" % (now + 2))
gateway = listeners()
me = os.getpid()
for pid in pids():
    if pid == me:
        continue
    begun = started(pid)
    if begun is None:
        continue
    if pid in gateway:
        print("part=%d:%d:g" % (pid, begun))
    elif desktop_part(pid):
        path = program(pid) or ""
        print("part=%d:%d:%s" % (pid, begun, "s" if os.path.basename(path) in DESKTOP_PROGRAMS else "p"))
    path = runner_program(pid)
    if path:
        digest = fingerprint(path)
        if digest:
            print("runner=" + digest)
print("marked=1")
`;

/** The fence. Run as the normal user, with the mark Orbit holds. */
const FENCE_BODY = String.raw`
import errno
import select
import signal

SYSTEM_FOLDERS = ("/usr/", "/lib/", "/lib64/", "/bin/", "/sbin/", "/etc/ld.so.cache")
SHORT_SLEEP = re.compile(r"^\d{1,2}(\.\d+)?$")


def option(name):
    for part in sys.argv[1:]:
        if part.startswith("--" + name + "="):
            return part.split("=", 1)[1]
    return None


def given_parts():
    out = {}
    for item in (option("parts") or "").split(","):
        bits = item.split(":")
        if len(bits) == 3 and bits[0].isdigit() and bits[1].isdigit() and bits[2] in ("s", "p", "g"):
            out[int(bits[0])] = (int(bits[1]), bits[2])
    return out


def short_sleep(pid):
    # A short wait that does nothing and ends by itself. The computer's own start-up loop runs them as its children (process 1 waits
    # for each one), and it stops the whole computer when one is killed, so these are never touched. What keeps the exemption from being a
    # place to hide, all of it read from the process itself:
    #   - it is what process 1 starts: a child of process 1 in process 1's own session and group (anything the agent starts is in the
    #     session of the command that started it, or in one of its own, and cannot join another session's group);
    #   - it is young (a real one ends within 30 seconds), is a real "sleep" with one number, and no one is tracing it;
    #   - no loader override in its environment, and nothing in its memory that is not the system's.
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
            return False
        before = where
    return seen


def protected(tree, cutoff, saved, runners):
    keep = {1, os.getpid()}
    # What was already running when the computer was made ready is the computer's own, and so is Agent37's command runner (by its program's fingerprint)
    for pid in tree:
        begun = started(pid)
        if begun is not None and begun <= cutoff:
            keep.add(pid)
            continue
        path = runner_program(pid)
        if (path and fingerprint(path) in runners) or short_sleep(pid):
            keep.add(pid)
    # What started this command, all the way up (the machine's own command runner)
    pid = os.getpid()
    while pid > 1 and pid in tree:
        keep.add(pid)
        pid = tree[pid]
    # The parts the mark names: the same pid started at the same tick (a reused pid is not one)
    live = {pid: kind for pid, (begun, kind) in saved.items() if pid in tree and started(pid) == begun}
    keep |= set(live)
    for pid, kind in live.items():
        if kind == "g":
            # The gateway's own chain above it, all the way. An ancestor that is already kept (the command runner, by its fingerprint, or something that ran before
            # the mark) does not end the walk: what started that one, and what started that, are the gateway's chain too. Only a process this walk has already
            # been through ends it (a loop in the table), never a process that was kept for another reason (CodeRabbit on #1033)
            up = tree.get(pid, 0)
            walked = set()
            while up > 1 and up in tree and up not in walked:
                walked.add(up)
                keep.add(up)
                up = tree[up]
    below = {}
    for pid, up in tree.items():
        below.setdefault(up, []).append(pid)
    # Everything below a part is its own, whether or not it was already kept for another reason (a helper that was running before the mark
    # still has children, a new tab's renderer, that were not). Not below the screen's server or window manager: the agent can run those
    # programs itself, and what they start is the agent's.
    stack = [pid for pid, kind in live.items() if kind == "p"]
    seen = set(stack)
    while stack:
        for child in below.get(stack.pop(), []):
            if child not in seen:
                seen.add(child)
                keep.add(child)
                stack.append(child)
    return keep


PF_KTHREAD = 0x00200000


def alive(pid):
    # Everything that still exists counts, so a program the fence cannot read is never taken for "not running" (a root program on a sandbox where
    # a normal user may not read its stat or command line, or one that emptied its own command line, would otherwise be neither stopped nor counted
    # and the fence would prove a machine clear that it is not). Only what runs nothing is left out: a process waiting to be collected, one that has
    # just gone, and a kernel thread (by its flag, not by an empty command line).
    fields = stat_fields(pid)
    if not fields:
        return os.path.exists("/proc/%d" % pid)
    if fields[0] in ("Z", "X"):
        # A leader whose own thread ended while its other threads run on shows as Z too: that is a running program, not one waiting to be
        # collected. Each of its threads is read, and one that is not ended (or cannot be read) counts
        try:
            tasks = os.listdir("/proc/%d/task" % pid)
        except Exception:
            return os.path.exists("/proc/%d" % pid)
        for task in tasks:
            text = read(pid, "task/%s/stat" % task).decode("utf-8", "replace")
            if not text:
                if os.path.exists("/proc/%d/task/%s" % (pid, task)):
                    return True
                continue
            if text[text.rfind(")") + 2:].split()[:1] not in (["Z"], ["X"]):
                return True
        return False
    try:
        if int(fields[6]) & PF_KTHREAD:
            return False
    except Exception:
        pass
    return True


def others(cutoff, saved, runners):
    listed = pids()
    # Each process is written down with the tick it started at, in the same look as the table: the signal is later sent to THAT process, never to whatever
    # holds the number by then
    starts = {pid: started(pid) for pid in listed}
    tree = {pid: parent(pid) for pid in listed}
    keep = protected(tree, cutoff, saved, runners)
    return [(pid, starts[pid]) for pid in tree if pid not in keep and alive(pid)]


def stop(pid, begun):
    # Sends SIGKILL to the process the scan classified, or to none. A process number is given out again once its process is gone, so a bare number may by now be a
    # program the scan never saw (one it would have kept). With a process handle (pidfd, Linux 5.3 and Python 3.9) the signal goes to the process the handle was opened
    # on, and the handle is opened BEFORE the process is looked at again: while the process has not ended its number cannot be given out, so what is read through
    # /proc between the opening and the check is that process. Without handles the start tick is read just before the signal (a narrower window, not a closed one)
    if begun is None:
        return False
    if hasattr(os, "pidfd_open") and hasattr(signal, "pidfd_send_signal"):
        try:
            handle = os.pidfd_open(pid)
        except OSError as error:
            # Gone: nothing to stop. Any other refusal (a kernel or a sandbox with no handles) is the same as having none
            if error.errno == errno.ESRCH:
                return False
            handle = None
        if handle is not None:
            try:
                if started(pid) != begun:
                    return False
                # A handle is readable once its process has ended: then what was read above may be a process that took the number after it
                waiting = select.poll()
                waiting.register(handle, select.POLLIN)
                if waiting.poll(0):
                    return False
                signal.pidfd_send_signal(handle, signal.SIGKILL)
                return True
            except Exception:
                return False
            finally:
                os.close(handle)
    try:
        if started(pid) != begun:
            return False
        os.kill(pid, signal.SIGKILL)
        return True
    except Exception:
        return False


def proc_hides():
    # A /proc that hides other users' processes from this user (hidepid=2 or 4, "invisible", "ptraceable", or only some of them shown) cannot
    # show the fence everything that runs: nothing is proved on it. A mount table that cannot be read proves nothing either
    hiding = {"hidepid=2", "hidepid=invisible", "hidepid=4", "hidepid=ptraceable", "subset=pid"}
    try:
        with open("/proc/self/mountinfo", "r", encoding="utf-8") as handle:
            for line in handle:
                left, _, right = line.partition(" - ")
                where, kind = left.split(), right.split()
                if len(where) > 4 and where[4] == "/proc" and len(kind) > 2 and kind[0] == "proc" and hiding & set(kind[2].split(",")):
                    return True
    except Exception:
        return True
    return False


if proc_hides():
    print("hidden=1")
    sys.exit(1)

# Without Orbit's mark for THIS boot nothing is stopped and nothing is proved. The /proc check comes first: on a /proc that hides processes (subset=pid also hides the
# boot id) the cause is that, not a mark that does not fit
want = option("boot")
cutoff_text = option("cutoff")
if not want or want != boot_id() or not cutoff_text or not cutoff_text.isdigit():
    print("unmarked=1")
    sys.exit(3)
cutoff = int(cutoff_text)
saved = given_parts()
runners = set(item for item in (option("runners") or "").split(",") if item)

if "--check" in sys.argv:
    left = others(cutoff, saved, runners)
    print("remaining=%d" % len(left))
    sys.exit(0 if not left else 1)

import time

killed = 0
for _ in range(5):
    victims = others(cutoff, saved, runners)
    if not victims:
        break
    for pid, begun in victims:
        if stop(pid, begun):
            killed += 1
    time.sleep(0.2)
print("killed=%d" % killed)
`;

export const MARK_SCRIPT = COMMON + MARK_BODY;
export const FENCE_SCRIPT = COMMON + FENCE_BODY;

/** The command that reads the mark. */
export function markCommand(): string {
  return `${MARK_TAG}\npython3 - <<'${END}'\n${MARK_SCRIPT}\n${END}\n`;
}

/** What the mark command answered, or null when the answer is not a mark (the computer is then not ready). */
export function parseMark(stdout: string): MachineMark | null {
  if (!/(^|\n)marked=1\s*$/.test(stdout)) return null;
  const bootId = /(^|\n)boot=([0-9a-f-]+)\n/.exec(stdout)?.[2];
  const ticks = /(^|\n)ticks=(\d+)\n/.exec(stdout)?.[2];
  if (!bootId || !BOOT_ID.test(bootId) || !ticks) return null;
  const count = Number(ticks);
  if (!Number.isSafeInteger(count) || count < 0) return null;
  const parts: MarkPart[] = [];
  for (const match of stdout.matchAll(/(?:^|\n)part=(\d+):(\d+):([spg])(?=\n)/g)) {
    const pid = Number(match[1]);
    const start = Number(match[2]);
    if (Number.isSafeInteger(pid) && Number.isSafeInteger(start)) parts.push({ pid, start, kind: LETTER_KIND[match[3]] });
  }
  const runnerLines = [...stdout.matchAll(/(?:^|\n)runner=([0-9a-f]{64})(?=\n)/g)].map((match) => match[1]);
  const runners = [...new Set(runnerLines)];
  if (parts.length > MARK_PARTS_MAX) return null;
  // Every `part=` and `runner=` line the computer printed must have been read whole: a malformed record is not skipped over, because a mark that quietly names fewer programs than the computer
  // listed would let the fence stop (or spare) the wrong ones (CodeRabbit on #1033). An empty list is a valid answer.
  const printed = (prefix: string): number => stdout.split('\n').filter((line) => line.startsWith(prefix)).length;
  if (printed('part=') !== parts.length || printed('runner=') !== runnerLines.length) return null;
  // Read whole is not the same as usable: a part with process number 0, say, passes the lines above and would be refused later, when Orbit reads the saved mark back. The same check that guards what Orbit sends is
  // made here, before the computer is called ready, so a mark that could never be fenced with is never saved
  const answered: MachineMark = { bootId, ticks: count, parts, runners };
  return validMark(answered) ? answered : null;
}

/** What the database holds, checked once more before it is put in a command (a stored value is never trusted to be safe to send). */
export function validMark(mark: MachineMark): boolean {
  return (
    BOOT_ID.test(mark.bootId) &&
    Number.isSafeInteger(mark.ticks) &&
    mark.ticks >= 0 &&
    mark.parts.length <= MARK_PARTS_MAX &&
    mark.parts.every((part) => Number.isSafeInteger(part.pid) && part.pid > 0 && Number.isSafeInteger(part.start) && part.start >= 0 && part.kind in KIND_LETTER) &&
    mark.runners.every((runner) => SHA256.test(runner))
  );
}

/** The command that stops what the mark does not name (`check`: only counts what is left, printing `remaining=N`, exit 0 only when none is). */
export function fenceCommand(mark: MachineMark, check = false): string {
  if (!validMark(mark)) throw new Error('Not a mark');
  const parts = mark.parts.map((part) => `${part.pid}:${part.start}:${KIND_LETTER[part.kind]}`).join(',');
  const args = [`--boot=${mark.bootId}`, `--cutoff=${mark.ticks}`, `--parts=${parts}`, `--runners=${mark.runners.join(',')}`, ...(check ? ['--check'] : [])];
  return `${check ? FENCE_CHECK_TAG : FENCE_TAG}\npython3 - ${args.join(' ')} <<'${END}'\n${FENCE_SCRIPT}\n${END}\n`;
}
