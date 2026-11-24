/**
 * The take-over fence and its mark, held by Orbit (root-agent item 3A). The scripts are run for real here, in a process space of their own
 * (so only what a scenario starts can be touched), as ROOT: the agent on a Brick's computer has admin rights, so "a program root owns" proves
 * nothing, and the mark cannot live in a file the agent can write. What these prove (each fails on the old fence, whose mark was a root-only
 * file and which kept every root-owned lookalike of the desktop):
 *   - a mark file the agent rewrites changes nothing: the fence is told its boot and cutoff by Orbit;
 *   - a root-owned program with the desktop's name and arguments, started after the mark, is stopped;
 *   - a program on a port of the agent's gateway, started after the mark, is stopped;
 *   - a program in Agent37's folder is the command runner only when its fingerprint is the runner's;
 *   - a browser the computer restarted counts once its parts are saved again, not before.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { FENCE_SCRIPT, MARK_SCRIPT, MARK_PARTS_MAX, fenceCommand, isFenceCheckCommand, isFenceCommand, isMarkCommand, markCommand, parseMark, validMark } from '@/lib/computer-fence-script';
import type { MachineMark } from '@/lib/computer-fence-script';

const folder = mkdtempSync(join(tmpdir(), 'universe-fence-'));
afterAll(() => rmSync(folder, { recursive: true, force: true }));
const have = (command: string) => spawnSync('sh', ['-c', `command -v ${command}`]).status === 0;
const isolated = have('python3') && spawnSync('unshare', ['--pid', '--fork', '--mount-proc', 'true']).status === 0;
const scenario = isolated ? it : it.skip;

const BOOT = '3f2b6c1e-8a44-4d0b-9c15-5e7d2a9b1c33';
const HASH = 'b'.repeat(64);
const mark = (extra: Partial<MachineMark> = {}): MachineMark => ({ bootId: BOOT, ticks: 123456, parts: [{ pid: 41, start: 900, kind: 'part' }, { pid: 77, start: 950, kind: 'gateway' }], runners: [HASH], ...extra });

describe('the commands Orbit sends', () => {
  it('names itself on the first line, so a command is told apart without reading a script', () => {
    expect(isFenceCommand(fenceCommand(mark()))).toBe(true);
    expect(isFenceCheckCommand(fenceCommand(mark()))).toBe(false);
    expect(isFenceCheckCommand(fenceCommand(mark(), true))).toBe(true);
    expect(isFenceCommand(fenceCommand(mark(), true))).toBe(true);
    expect(isMarkCommand(markCommand())).toBe(true);
    expect(isFenceCommand(markCommand())).toBe(false);
  });

  it('carries the boot, the cutoff, the parts and the runner fingerprints as plain arguments', () => {
    const text = fenceCommand(mark(), true);
    expect(text).toContain(`python3 - --boot=${BOOT} --cutoff=123456 --parts=41:900:p,77:950:g --runners=${HASH} --check <<'UNIVERSE_SCRIPT_END'`);
    expect(text.endsWith('UNIVERSE_SCRIPT_END\n')).toBe(true);
    // A heredoc whose closing line is in the script would end it early
    expect(FENCE_SCRIPT + MARK_SCRIPT).not.toContain('UNIVERSE_SCRIPT_END');
  });

  it('never sends a value that is not a mark (a stored value is not trusted to be safe to put in a command)', () => {
    for (const bad of [
      mark({ bootId: 'x; rm -rf ~' }),
      mark({ ticks: -1 }),
      mark({ ticks: 1.5 }),
      mark({ parts: [{ pid: 0, start: 1, kind: 'part' }] }),
      mark({ parts: [{ pid: 1, start: 1, kind: 'part; id' as never }] }),
      mark({ runners: ['$(id)'] }),
      mark({ parts: Array.from({ length: MARK_PARTS_MAX + 1 }, (_, i) => ({ pid: i + 1, start: 1, kind: 'part' as const })) }),
    ]) {
      expect(validMark(bad)).toBe(false);
      expect(() => fenceCommand(bad)).toThrow('Not a mark');
    }
  });

  it('reads the mark command’s answer, and refuses an answer that is not one', () => {
    const answer = `boot=${BOOT}\nticks=222\npart=5:10:s\npart=6:11:p\npart=7:12:g\nrunner=${HASH}\nrunner=${HASH}\nmarked=1\n`;
    expect(parseMark(answer)).toEqual({ bootId: BOOT, ticks: 222, parts: [{ pid: 5, start: 10, kind: 'screen' }, { pid: 6, start: 11, kind: 'part' }, { pid: 7, start: 12, kind: 'gateway' }], runners: [HASH] });
    expect(parseMark(`boot=${BOOT}\nticks=222\n`)).toBeNull();
    expect(parseMark('marked=0 reason=clock\n')).toBeNull();
    expect(parseMark(`boot=nope\nticks=222\nmarked=1\n`)).toBeNull();
    expect(parseMark(`boot=${BOOT}\nticks=-5\nmarked=1\n`)).toBeNull();
    expect(parseMark(`boot=${BOOT}\nticks=1\nmarked=1\nmarked=0 reason=x\n`)).toBeNull();
  });

  it('writes nothing on the computer: no note, no folder, no link followed', () => {
    for (const text of [MARK_SCRIPT, FENCE_SCRIPT]) {
      expect(text).not.toMatch(/\/run\/universe/);
      expect(text).not.toMatch(/open\([^)]*["'][wa]b?\+?["']/);
      expect(text).not.toMatch(/chown|chmod|mkdir|os\.(remove|rename|unlink|symlink)/);
    }
  });

  scenario('is run as it is sent: a heredoc the shell runs, answering unmarked (exit 3) on a boot that is not this one', () => {
    const run = spawnSync('sh', ['-c', fenceCommand(mark({ bootId: '00000000-0000-4000-8000-000000000000' }))], { encoding: 'utf8' });
    expect(run.stdout.trim()).toBe('unmarked=1');
    expect(run.status).toBe(3);
    const read = spawnSync('sh', ['-c', markCommand()], { encoding: 'utf8' });
    const parsed = parseMark(read.stdout);
    expect(parsed).not.toBeNull();
    expect(parsed!.bootId).toMatch(/^[0-9a-f-]{36}$/);
    expect(parsed!.ticks).toBeGreaterThan(0);
  });
});

describe('the fence run as the computer’s normal user against a program of root’s', () => {
  const normalUser = isolated && have('runuser');
  (normalUser ? it : it.skip)('cannot stop it, counts it, and does not prove the machine clear (also when the sandbox hides what the program is)', () => {
    const dir = join(folder, 'normal');
    mkdirSync(dir, { recursive: true });
    chmodSync(folder, 0o755);
    chmodSync(dir, 0o755);
    writeFileSync(join(dir, 'fence.py'), FENCE_SCRIPT, { mode: 0o644 });
    writeFileSync(join(dir, 'mark.py'), MARK_SCRIPT, { mode: 0o644 });
    const script = `
D=${dir}
sleep 1
python3 $D/mark.py > $D/mark.out
BOOT=$(sed -n 's/^boot=//p' $D/mark.out)
TICKS=$(sed -n 's/^ticks=//p' $D/mark.out)
nfence() { runuser -u nobody -- python3 $D/fence.py --boot=$BOOT --cutoff=$TICKS --parts= --runners= "$@"; }
sleep 1
echo "control: $(nfence --check)"
# what the agent, with admin rights, leaves running after the mark: a program of root's
sh -c 'sleep 313' &
ROOTP=$!
sleep 1
echo "before: $(nfence --check)"
nfence
kill -0 $ROOTP 2>/dev/null && echo "root-program-alive" || echo "root-program-dead"
echo "after: $(nfence --check; echo rc=$?)"
# a sandbox where a normal user lists root's processes but cannot read them (hidepid=1 here): each one is still counted
if mount -o remount,hidepid=1 /proc 2>/dev/null; then
  runuser -u nobody -- sh -c 'cat /proc/'$ROOTP'/stat >/dev/null 2>&1' && echo "readable" || echo "unreadable"
  echo "hidden: $(nfence --check; echo rc=$?)"
fi
`;
    const run = spawnSync('unshare', ['--pid', '--fork', '--mount-proc', '--mount', 'sh', '-c', script], { encoding: 'utf8', timeout: 60_000 });
    const out = run.stdout;
    // Nothing of root's was running before the program: the normal user's fence reads the computer's own as such
    expect(out).toMatch(/control: remaining=0/);
    expect(out).toMatch(/before: remaining=[1-9]/);
    expect(out).toContain('root-program-alive');
    expect(out).toMatch(/after: remaining=[1-9]\s+rc=1/);
    if (out.includes("unreadable")) expect(out).toMatch(/hidden: remaining=[1-9]\s+rc=1/);
    else expect(out).toContain('readable');
  });
});

describe('what the fence cannot be told is not running', () => {
  const normalUser = isolated && have('runuser');
  (normalUser ? it : it.skip)('a program whose first thread ended while its others run on is counted and stopped; a /proc that hides root’s programs proves nothing', () => {
    const dir = join(folder, 'hidden');
    mkdirSync(dir, { recursive: true });
    chmodSync(folder, 0o755);
    chmodSync(dir, 0o755);
    writeFileSync(join(dir, 'fence.py'), FENCE_SCRIPT, { mode: 0o644 });
    writeFileSync(join(dir, 'mark.py'), MARK_SCRIPT, { mode: 0o644 });
    // The program's own first thread ends (it then reads as Z) and a second thread goes on working
    writeFileSync(join(dir, 'leader.py'), 'import ctypes, threading, time\n'
      + 'def work():\n    while True:\n        time.sleep(0.3)\n'
      + 'threading.Thread(target=work).start()\ntime.sleep(0.2)\nctypes.CDLL(None).pthread_exit(None)\n', { mode: 0o644 });
    const script = `
D=${dir}
sleep 1
python3 $D/mark.py > $D/mark.out
BOOT=$(sed -n 's/^boot=//p' $D/mark.out)
TICKS=$(sed -n 's/^ticks=//p' $D/mark.out)
f() { python3 $D/fence.py --boot=$BOOT --cutoff=$TICKS --parts= --runners= "$@"; }
nfence() { runuser -u nobody -- python3 $D/fence.py --boot=$BOOT --cutoff=$TICKS --parts= --runners= "$@"; }
sleep 1
python3 $D/leader.py &
L=$!
sleep 1
echo "state: $(cut -d' ' -f3 /proc/$L/stat) threads: $(ls /proc/$L/task | wc -l)"
echo "leader: $(f --check)"
f
sleep 0.5
[ -d /proc/$L ] && echo "leader-alive" || echo "leader-gone"
echo "after: $(f --check)"
sh -c 'sleep 313' &
sleep 1
if mount -o remount,hidepid=2 /proc 2>/dev/null; then
  echo "invisible: $(nfence --check; echo rc=$?)"
fi
`;
    const run = spawnSync('unshare', ['--pid', '--fork', '--mount-proc', '--mount', 'sh', '-c', script], { encoding: 'utf8', timeout: 60_000 });
    const out = run.stdout;
    expect(out).toMatch(/state: Z threads: 2/);
    expect(out).toMatch(/leader: remaining=1/);
    expect(out).toContain('leader-gone');
    expect(out).toMatch(/after: remaining=0/);
    if (out.includes('invisible:')) expect(out).toMatch(/invisible: hidden=1\s+rc=1/);
  });
});

describe('the fence, with the mark Orbit holds', () => {
  scenario('stops what the mark does not name, whoever owns it; keeps what it names; and proves none is left', () => {
    const dir = join(folder, 'run');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'fence.py'), FENCE_SCRIPT);
    writeFileSync(join(dir, 'mark.py'), MARK_SCRIPT);
    const flags = (home: string) => `--user-data-dir=${home}/.config/universe-chromium --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1`;
    const listener = (port: number, wait: number) =>
      `python3 -c "
import socket, time
s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); s.bind(('127.0.0.1', ${port})); s.listen()
time.sleep(${wait})" &`;
    const script = `
export HOME=${dir}/home
D=${dir}
mkdir -p $HOME $D/bin $D/lookalike /run/universe
# What a person of the computer's own would have: the real browser (a root-owned program) and the gateway, a plain sleep, and Agent37's runner (a program in its folder)
cp /bin/sh $D/bin/chromium
cp /bin/sh $D/lookalike/chromium
cp /bin/sh $D/lookalike/x11vnc
cp /bin/sh $D/lookalike/Xvfb
mkdir -p /.agent37 && mount -t tmpfs tmpfs /.agent37 && cp /bin/sh /.agent37/runner && cp /bin/sh /.agent37/evil && printf 'x' >> /.agent37/evil
${listener(3737, 300)}
GW=$!
$D/bin/chromium -c 'sleep 2; sleep 300; true' ${flags('$HOME')} &
BR=$!
sh -c 'sleep 306' &
OWN=$!
/.agent37/runner -c 'while :; do :; done' &
RUN1=$!
sleep 1
# THE MARK, as Orbit would read it: through the mark script, nothing written
python3 $D/mark.py > $D/mark.out
echo "mark-printed: $(tail -1 $D/mark.out)"
BOOT=$(sed -n 's/^boot=//p' $D/mark.out)
TICKS=$(sed -n 's/^ticks=//p' $D/mark.out)
PARTS=$(sed -n 's/^part=//p' $D/mark.out | paste -sd, -)
RUNNERS=$(sed -n 's/^runner=//p' $D/mark.out | sort -u | paste -sd, -)
echo "mark-has-browser: $(grep -c "^part=$BR:.*:p$" $D/mark.out)"
echo "mark-has-gateway: $(grep -c "^part=$GW:.*:g$" $D/mark.out)"
echo "mark-runners: $(echo "$RUNNERS" | tr ',' '\\n' | grep -c .)"
fence() { python3 $D/fence.py --boot=$BOOT --cutoff=$TICKS --parts=$PARTS --runners=$RUNNERS "$@"; }
# The agent, having admin rights, rewrites the note the OLD fence read, so that everything counts as the computer's own
printf '%s 99999999999\\n' "$BOOT" > /run/universe/mark
sleep 1
# What the agent starts after the mark. Each is root-owned and wears the desktop's name and arguments, or sits in a place the fence used to trust
$D/lookalike/chromium -c 'sleep 303; true' ${flags('$HOME')} &
LA1=$!
$D/lookalike/x11vnc -c 'sleep 304; true' -display :99 -rfbport 5900 -localhost -forever -shared -nopw -quiet &
LA2=$!
$D/lookalike/Xvfb -c 'while :; do :; done' :99 &
LA3=$!
${listener(8642, 305)}
LA4=$!
sh -c 'sleep 307' &
LA5=$!
/.agent37/evil -c 'while :; do :; done' &
LA6=$!
# The runner's own program, started again after the mark (what the computer's runner does for every command)
/.agent37/runner -c 'while :; do :; done' &
RUN2=$!
# the same short wait the computer's start-up loop runs: never touched; started in a session of its own: the agent's
sleep 9 </dev/null >/dev/null 2>&1 &
SHORT=$!
setsid sleep 9 </dev/null >/dev/null 2>&1 &
OTHER=$!
sleep 1
for p in $LA1 $LA2 $LA3 $LA4 $LA5 $LA6; do kill -0 $p 2>/dev/null && echo "agent-up"; done
echo "unmarked: $(python3 $D/fence.py --boot=00000000-0000-4000-8000-000000000000 --cutoff=$TICKS --parts=$PARTS --check; echo rc=$?)"
for p in $LA1 $LA5; do kill -0 $p 2>/dev/null && echo "still-up-after-unmarked"; done
echo "before: $(fence --check)"
fence
echo "after: $(fence --check)"
for p in $GW $BR $OWN $RUN1 $RUN2; do kill -0 $p 2>/dev/null && echo "kept" || echo "kept-DEAD:$p"; done
for p in $LA1 $LA2 $LA3 $LA4 $LA5 $LA6; do kill -0 $p 2>/dev/null && echo "agent-alive" || echo "agent-dead"; done
kill -0 $SHORT 2>/dev/null && echo "short-alive" || echo "short-dead"
kill -0 $OTHER 2>/dev/null && echo "other-alive" || echo "other-dead"
# THE BROWSER RESTARTED by the computer: until its parts are saved again it is not the computer's, after, it is (and a child it starts later is its own)
$D/bin/chromium -c 'sleep 2; sleep 310; true' ${flags('$HOME')} &
BR2=$!
sleep 1
echo "restart-unsaved: $(fence --check)"
python3 $D/mark.py > $D/mark2.out
PARTS=$(sed -n 's/^part=//p' $D/mark2.out | paste -sd, -)
echo "restart-saved: $(fence --check)"
sleep 2
echo "restart-child-kept: $(fence --check)"
fence
kill -0 $BR2 2>/dev/null && echo "browser2-alive" || echo "browser2-dead"
pgrep -P $BR2 -x sleep >/dev/null && echo "browser2-child-alive" || echo "browser2-child-dead"
# a lookalike started after the list was saved is the agent's
$D/lookalike/chromium -c 'sleep 311; true' ${flags('$HOME')} &
LA7=$!
sleep 1
echo "late-lookalike: $(fence --check)"
fence
kill -0 $LA7 2>/dev/null && echo "late-alive" || echo "late-dead"
echo "end: $(fence --check)"
umount /.agent37 2>/dev/null
`;
    const run = spawnSync('unshare', ['--pid', '--fork', '--mount-proc', '--mount', 'sh', '-c', script], { encoding: 'utf8', timeout: 90_000 });
    const out = run.stdout;
    // The mark is read from the computer and names the browser, the gateway and the runner
    expect(out).toContain('mark-printed: marked=1');
    expect(out).toContain('mark-has-browser: 1');
    expect(out).toContain('mark-has-gateway: 1');
    expect(out).toContain('mark-runners: 1');
    expect(out.match(/agent-up/g)).toHaveLength(6);
    // A boot that is not this one: nothing is stopped and nothing is proved
    expect(out).toMatch(/unmarked: unmarked=1\s+rc=3/);
    expect(out.match(/still-up-after-unmarked/g)).toHaveLength(2);
    // Everything the agent started stops, although the old note says all of it is the computer's own, and each is root-owned, wears the desktop's
    // name and arguments, listens where the gateway does, or sits in Agent37's folder
    expect(out).toMatch(/before: remaining=[1-9]/);
    expect(out).toMatch(/after: remaining=0/);
    expect(out.match(/agent-dead/g)).toHaveLength(6);
    expect(out).not.toContain('agent-alive');
    // What the mark names stays: the gateway, the browser, what was running before it, the runner (also when started again, by its fingerprint)
    expect(out.split('\n').filter((line) => line === 'kept')).toHaveLength(5);
    expect(out).not.toContain('kept-DEAD');
    expect(out).toContain('short-alive');
    expect(out).toContain('other-dead');
    // A browser the computer restarted is not on the list until the list is saved again; then it is, with what it starts
    expect(out).toMatch(/restart-unsaved: remaining=[1-9]/);
    expect(out).toMatch(/restart-saved: remaining=0/);
    expect(out).toMatch(/restart-child-kept: remaining=0/);
    expect(out).toContain('browser2-alive');
    expect(out).toContain('browser2-child-alive');
    // ... and a lookalike started after the list was saved is the agent's
    expect(out).toMatch(/late-lookalike: remaining=[1-9]/);
    expect(out).toContain('late-dead');
    expect(out).toMatch(/end: remaining=0/);
  });
});
