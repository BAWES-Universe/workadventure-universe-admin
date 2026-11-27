/**
 * The command that puts a paused job's browser sign-ins away, brings them back, and throws them away (lib/computer-browser-profile-script.ts),
 * run for real: as root, in a folder of its own, against a real Chromium (the one Playwright brings) and a real unprivileged user standing in
 * for the agent. What it must prove, above all: one job's sign-ins can never be read by, or restored into, another job.
 *
 * Needs root, python3, setpriv and Chromium; skipped where any is missing. Some tests run the command with a bug planted on purpose
 * ("planted-bug checks"): each shows the check above it would catch that bug, so a check that passes for the wrong reason is seen.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, chownSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { MACHINE_PLACES, isSafeJobId, readSignInsAnswer, signInsCommand, type SignInsAction, type SignInsPlaces } from '@/lib/computer-browser-profile-script';
import { CLEAN_CLAIM_STALE_MS, MACHINE_COMMAND_MS } from '@/lib/computer-values';
import { imageFiles, UNIVERSE_UP } from '@/lib/agent37/image-files';

const CHROME = ['/opt/pw-browsers/chromium-1243/chrome-linux64/chrome', process.env.CHROME_PATH ?? ''].find((path) => path && existsSync(path)) ?? '';
const have = (command: string) => spawnSync('sh', ['-c', `command -v ${command}`]).status === 0;
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const AGENT = 'nobody';
const agentUid = Number(spawnSync('id', ['-u', AGENT], { encoding: 'utf8' }).stdout.trim());
const usable = isRoot && have('python3') && have('setpriv') && Number.isFinite(agentUid) && !!CHROME;
// The browser tests also need Playwright to drive the page: the file tests above stay on where it is missing (CodeRabbit on #1025)
const havePlaywright = ((): boolean => {
  try {
    require.resolve('playwright');
    return true;
  } catch {
    return false;
  }
})();
const run = usable ? describe : describe.skip;
const runWithBrowser = usable && havePlaywright ? describe : describe.skip;

/** The line of the restore that notes the profile is in place ("moved"): a test cuts the command off there. */
const MOVED_NOTE = '  if [ -d "$JOBDIR" ]; then printf \'\' > "$JOBDIR/moved" || { say "0 reason=move"; exit 1; }; fi\n';

const JOB_A = '11111111-1111-4111-8111-111111111111';
const JOB_B = '22222222-2222-4222-8222-222222222222';
const JOB_C = '33333333-3333-4333-8333-333333333333';

let root: string;
let home: string;
let places: SignInsPlaces;
let port: number;
let shim: string;
/** Set by a test that starts a real browser: only then is there a browser of this test to stop at the end. */
let startedBrowser = false;

const profile = () => join(home, '.config', 'universe-chromium');
const parked = (job: string) => join(places.parkRoot, job);
/** The mark that says the live profile may hold a job's sign-ins: in a root-owned folder next to the park folder, out of the agent's reach to swap. */
const marksFolder = () => join(root, 'var', 'lib', 'universe', 'marks');
const dirtyMark = () => join(marksFolder(), 'profile.dirty');
/** The marks folder as the command makes it (root's, open to everyone to put a mark in and take it out, sticky), for a test that must put something in it first. */
function makeMarksFolder(): void {
  mkdirSync(marksFolder(), { recursive: true });
  chownSync(marksFolder(), 0, 0);
  chmodSync(marksFolder(), 0o1777);
}

function freePort(): number {
  const found = spawnSync('python3', ['-c', 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])'], { encoding: 'utf8' });
  return Number(found.stdout.trim());
}

/** Runs the command as root (what Orbit does through the provider), with an optional bug planted in it. */
function act(action: SignInsAction, job: string, keep: string[] = [], plant?: (script: string) => string, keepHours = 24, generation = 0): { code: number; out: string } {
  let script = signInsCommand(action, job, keep, keepHours, places, generation);
  if (plant) {
    const planted = plant(script);
    if (planted === script) throw new Error('The planted bug did not change the command');
    script = planted;
  }
  // The command stops "chromium", "chrome" and "websockify" by name, which on a shared machine would be every browser on it: its pkill and pgrep are the shims
  // (set up below), which only ever see this test's own browsers (CodeRabbit on #1025)
  const first = 'export PATH\n';
  if (!script.includes(first)) throw new Error('The command does not set its PATH where the test expects it');
  script = script.replace(first, `PATH="${shim}:$PATH"\nexport PATH\n`);
  const done = spawnSync('sh', ['-c', script], { encoding: 'utf8', timeout: 120_000 });
  return { code: done.status ?? -1, out: done.stdout };
}

/** What the agent (an unprivileged user) gets when it tries to read a path: true when it can. */
function agentCanRead(path: string): boolean {
  const tried = spawnSync('setpriv', [`--reuid=${agentUid}`, `--regid=${agentUid}`, '--clear-groups', '--', 'sh', '-c', `ls -A "${path}" >/dev/null 2>&1 && find "${path}" -type f -exec cat {} + >/dev/null 2>&1`], { encoding: 'utf8' });
  return tried.status === 0;
}

/** A profile with something in it that only this job may see, owned by the agent's user, as the browser leaves it. */
function fakeProfile(secret: string): void {
  mkdirSync(join(profile(), 'Default'), { recursive: true });
  writeFileSync(join(profile(), 'Default', 'Cookies'), secret);
  mkdirSync(join(home, '.cache', 'chromium'), { recursive: true });
  writeFileSync(join(home, '.cache', 'chromium', 'page'), 'cached');
  spawnSync('chown', ['-R', `${AGENT}:`, join(home, '.config'), join(home, '.cache')]);
}

/**
 * Stops only the browsers THIS test started, never another Chromium on the machine (CodeRabbit on #1025): every process of a browser (its helpers too) carries the test's own
 * temporary folder in its command line (its profile folder is under it), so that folder names them all. Nothing is stopped when the test made no browser folder.
 */
function killBrowsers(): void {
  if (!root || !startedBrowser) return;
  spawnSync('pkill', ['-f', '--', root]);
  for (let i = 0; i < 50 && spawnSync('pgrep', ['-f', '--', root]).status === 0; i++) spawnSync('sleep', ['0.1']);
}

beforeEach(() => {
  if (!usable) return;
  root = mkdtempSync(join(tmpdir(), 'signins-'));
  chmodSync(root, 0o755);
  home = join(root, 'home');
  mkdirSync(join(home, '.universe'), { recursive: true });
  // As on the machine: /var/lib is there already and open to read
  mkdirSync(join(root, 'var', 'lib'), { recursive: true, mode: 0o755 });
  chmodSync(join(root, 'var'), 0o755);
  chmodSync(join(root, 'var', 'lib'), 0o755);
  chownSync(home, agentUid, agentUid);
  chownSync(join(home, '.universe'), agentUid, agentUid);
  port = freePort();
  startedBrowser = false;
  // pkill and pgrep as the command sees them: whatever name it asks for, only a process that runs on THIS test's browser folder is ever named
  shim = join(root, 'shim');
  mkdirSync(shim);
  for (const tool of ['pkill', 'pgrep']) {
    const real = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
    writeFileSync(join(shim, tool), `#!/bin/sh\nsignal=""\n[ "$1" = "-9" ] && signal="-9"\nexec ${real} $signal -f -- "user-data-dir=${home}/"\n`, { mode: 0o755 });
  }
  places = {
    parkRoot: join(root, 'var', 'lib', 'universe', 'signins'),
    user: AGENT,
    home,
    devtools: `127.0.0.1:${port}`,
    // Only the real-browser tests start one (below); the file tests have none to start
    start: 'true',
    answerWait: 1,
    // The image's start-up as a file the command only reads: it carries the word that says it reads the marks folder
    up: join(root, 'universe-up'),
  };
  writeFileSync(places.up, '#!/bin/sh\n# universe-marks-v1\n');
});

afterEach(() => {
  if (!usable) return;
  killBrowsers();
  // A browser that was stopped may still be writing for a moment: the folder is removed again if it is not empty yet
  for (let tries = 0; tries < 20; tries++) {
    try {
      rmSync(root, { recursive: true, force: true });
      break;
    } catch (error) {
      if (tries === 19) throw error;
      spawnSync('sleep', ['0.25']);
    }
  }
});

describe('the command, as text', () => {
  it('names only job ids it can trust, and refuses anything else before a command is made', () => {
    expect(isSafeJobId('6f1c2a7e-8a43-4c4b-9a55-0d2c4f1d2e3f')).toBe(true);
    for (const bad of ['', '../x', 'a b', 'a;rm -rf /', '$(id)', 'a/b', '-rf', 'x'.repeat(65)]) expect(isSafeJobId(bad)).toBe(false);
    expect(() => signInsCommand('park', '../../etc', [], 24)).toThrow();
    // A job in the keep list that is not an id is left out, never written into the command
    expect(signInsCommand('drop', JOB_A, [JOB_B, '$(reboot)', JOB_A], 24)).toContain(`KEEP="${JOB_B}"`);
  });

  it('CodeRabbit N7: the cleanup claim is believed for LONGER than one command may take, so no second command starts beside a running one', () => {
    // A window shorter than a command would let the claim go stale while that command is still stopping, moving and starting the browser,
    // and a cleanup or another sign-ins command would take the claim and run beside it. One pair of values, shared by every holder
    expect(CLEAN_CLAIM_STALE_MS).toBeGreaterThan(MACHINE_COMMAND_MS);
  });

  it('holds no key, token or address of ours: only job ids and the machine’s own places', () => {
    const text = signInsCommand('restore', JOB_A, [JOB_B], 24);
    expect(text).not.toMatch(/__[A-Z_]+__/);
    expect(text).not.toMatch(/token|secret|password|bearer|authorization/i);
    // The only addresses in it: the browser's own DevTools on loopback, and the page addresses it reopens (kinds, not hosts)
    expect(new Set(text.match(/https?:\/\/[^\s"']*/g))).toEqual(new Set(['http://%s:%d%s', 'http://', 'https://']));
    expect(text).toContain(`PARK_ROOT="${MACHINE_PLACES.parkRoot}"`);
    // The browser is started again as the agent's user, never as root
    expect(text).toContain('runuser -u "$NODE_USER"');
  });

  it('keeps the parked browsers out of the home folder, so they are never in the Files list or a cold-storage copy', () => {
    expect(MACHINE_PLACES.parkRoot.startsWith('/home')).toBe(false);
    // Cold storage copies the home folder and these system folders only (lib/agent37/image-files.ts, universe-cold ROOTS)
    for (const copied of ['/etc', '/opt', '/srv', '/usr/local', '/root', '/var/www', '/var/spool/cron']) expect(MACHINE_PLACES.parkRoot.startsWith(copied + '/')).toBe(false);
  });

  it('reads only its own answer lines, and anything else is a failure', () => {
    expect(readSignInsAnswer('park', 0, 'noise\nparked=1 cookies=3 pages=2\n')).toEqual({ done: 'kept', reason: null, cookies: 3, pages: 2 });
    expect(readSignInsAnswer('park', 0, 'parked=0 reason=already\n').done).toBe('already');
    expect(readSignInsAnswer('park', 0, 'parked=0 reason=nothing\n').done).toBe('none');
    expect(readSignInsAnswer('park', 1, 'parked=0 reason=nothing\n').done).toBe('failed');
    expect(readSignInsAnswer('restore', 0, 'restored=0 reason=none\n').done).toBe('none');
    expect(readSignInsAnswer('restore', 1, 'restored=0 reason=busy\n')).toEqual({ done: 'failed', reason: 'busy', cookies: 0, pages: 0 });
    expect(readSignInsAnswer('drop', 0, 'dropped=1\n').done).toBe('dropped');
    expect(readSignInsAnswer('drop', 0, 'parked=1\n').done).toBe('failed');
    expect(readSignInsAnswer('clear', 0, '').reason).toBe('exit_0');
    // A line that only says so with the wrong exit is not believed
    expect(readSignInsAnswer('park', 1, 'parked=1\n').done).toBe('failed');
  });
});

run('putting a job’s browser away, on a real file system with a real unprivileged user', () => {
  it('moves the profile into a folder only root can open, throws the cache away, and leaves no mark', () => {
    fakeProfile('job A cookies');
    const done = act('park', JOB_A, [JOB_A]);
    expect(done.out).toMatch(/parked=1/);
    expect(done.code).toBe(0);
    expect(existsSync(profile())).toBe(false);
    expect(existsSync(join(home, '.cache', 'chromium'))).toBe(false);
    expect(existsSync(join(parked(JOB_A), 'profile', 'Default', 'Cookies'))).toBe(true);
    expect(existsSync(dirtyMark())).toBe(false);
    for (const path of [places.parkRoot, parked(JOB_A), join(parked(JOB_A), 'profile')]) {
      const info = statSync(path);
      expect(info.uid).toBe(0);
      expect(info.mode & 0o077).toBe(0);
    }
  });

  it('the agent cannot list or read a parked browser, by any path to it', () => {
    fakeProfile('job A cookies');
    act('park', JOB_A, [JOB_A]);
    // Control: the agent can read what is its own, so a "cannot" below is the folder's doing, not the test's
    writeFileSync(join(home, 'mine.txt'), 'x');
    chownSync(join(home, 'mine.txt'), agentUid, agentUid);
    expect(agentCanRead(join(home, 'mine.txt'))).toBe(true);
    for (const path of [places.parkRoot, parked(JOB_A), join(parked(JOB_A), 'profile', 'Default', 'Cookies')]) expect(agentCanRead(path)).toBe(false);
  });

  it('planted bug: a parked folder left open to others is caught by the check above', () => {
    fakeProfile('job A cookies');
    act('park', JOB_A, [JOB_A], (script) => script.replace('chmod 0700 "$PARK_ROOT"', 'chmod 0755 "$PARK_ROOT"').replace('[ "$(stat -c \'%u %a\' "$PARK_ROOT" 2>/dev/null)" = "0 700" ] || { say "0 reason=folder"; exit 1; }', '').replace('chmod -R go-rwx "$JOBDIR.new"', 'chmod -R go+rX "$JOBDIR.new"').replace('mkdir -m 0700 "$JOBDIR.new"', 'mkdir -m 0755 "$JOBDIR.new"'));
    expect(agentCanRead(join(parked(JOB_A), 'profile', 'Default', 'Cookies'))).toBe(true);
  });

  it('CodeRabbit on #1025 (F3): stopping the browser never touches a browser or screen program of anyone else on the machine, whatever the action', () => {
    // Stand-ins named exactly as the programs the command stops by name; none of them runs on this test's browser folder
    const decoys = join(root, 'decoys');
    mkdirSync(decoys);
    const alive: number[] = [];
    try {
      // Started inside the protected block: a later decoy that fails to write or start still has the ones before it stopped (CodeRabbit on #1025, N12)
      for (const name of ['chrome', 'chromium', 'websockify']) {
        writeFileSync(join(decoys, name), readFileSync(spawnSync('sh', ['-c', 'command -v sleep'], { encoding: 'utf8' }).stdout.trim()), { mode: 0o755 });
        const started = spawnSync('sh', ['-c', `"${join(decoys, name)}" 300 >/dev/null 2>&1 & echo $!`], { encoding: 'utf8' });
        alive.push(Number(started.stdout.trim()));
      }
      fakeProfile('job A cookies');
      expect(act('park', JOB_A, [JOB_A]).out).toMatch(/parked=1/);
      expect(act('restore', JOB_A, [JOB_A]).out).toMatch(/restored=1/);
      expect(act('clear', JOB_A, [JOB_A]).out).toMatch(/cleared=1/);
      // None of the three was stopped (and the command did not wait for them to go: it would have said the browser is still running)
      for (const pid of alive) expect(existsSync(`/proc/${pid}`) && !readFileSync(`/proc/${pid}/stat`, 'utf8').includes(') Z ')).toBe(true);
    } finally {
      for (const pid of alive) spawnSync('kill', ['-9', String(pid)]);
    }
  });

  describe('row 17: what the command asks to stop (the shims above hide it, so it is recorded here)', () => {
    /** Runs one action with pkill and pgrep replaced by recorders (nothing is ever stopped, and pgrep finds nothing so the wait ends at once). Returns every call as the command made it, one per line. */
    function asked(action: SignInsAction, plant?: (script: string) => string): string[] {
      const recorder = mkdtempSync(join(root, 'recorder-'));
      const log = join(recorder, 'asked.log');
      writeFileSync(log, '');
      for (const tool of ['pkill', 'pgrep', 'killall', 'kill']) writeFileSync(join(recorder, tool), `#!/bin/sh\necho "${tool} $*" >> "${log}"\nexit 1\n`, { mode: 0o755 });
      let script = signInsCommand(action, JOB_A, [JOB_A], 24, places, 0);
      if (plant) {
        const planted = plant(script);
        if (planted === script) throw new Error('The planted bug did not change the command');
        script = planted;
      }
      const first = 'export PATH\n';
      if (!script.includes(first)) throw new Error('The command does not set its PATH where the test expects it');
      script = script.replace(first, `PATH="${recorder}:$PATH"\nexport PATH\n`);
      spawnSync('sh', ['-c', script], { encoding: 'utf8', timeout: 120_000 });
      return readFileSync(log, 'utf8').split('\n').filter((line) => line !== '');
    }
    // The only way it ever stops anything: a process whose whole name is one of these three, optionally with the hard signal. Never a pattern (a name that merely contains one), never a command line (-f), never a user or a group, never a pid
    const SCOPED = /^(pkill|pgrep) (-9 )?-x (websockify|chromium|chrome)$/;

    it('only ever names a process by its exact whole name, one of websockify, chromium and chrome, and stops nothing else, for every action that stops the browser', () => {
      fakeProfile('job A cookies');
      for (const action of ['park', 'restore', 'clear'] as const) {
        const calls = asked(action);
        // The browser was stopped: all three names were asked for (the screen's bridge, and both names the browser goes by)
        for (const name of ['websockify', 'chromium', 'chrome']) expect(calls).toContain(`pkill -x ${name}`);
        for (const call of calls) expect(call).toMatch(SCOPED);
        expect(calls.some((call) => call.startsWith('kill'))).toBe(false);
      }
    });

    it('drop, prune and commit never stop the browser: they only touch what is put away', () => {
      for (const action of ['drop', 'prune', 'commit'] as const) expect(asked(action).filter((call) => call.startsWith('pkill'))).toEqual([]);
    });

    /** Every way the command text stops or looks for a process that is not the exact-name form (empty when it has none). */
    const strays = (text: string): string[] => {
      const found: string[] = [];
      for (const line of text.split('\n').map((l) => l.replace(/#.*$/, ''))) {
        if (/\b(killall|fuser)\b/.test(line) || /(^|[^p])kill\b/.test(line)) found.push(line.trim());
        for (const call of line.match(/\b(pkill|pgrep)\b[^;|)]*/g) ?? []) if (!/^(pkill|pgrep) (-9 )?-x (websockify|chromium|chrome)$/.test(call.replace(/\s*(\d?>\/dev\/null|2>&1)/g, '').trim())) found.push(call.trim());
      }
      return found;
    };

    it('nothing in the command text stops a process any other way (no kill, killall, pattern or command-line match, no signal to a group)', () => {
      const text = signInsCommand('park', JOB_A, [JOB_A], 24, places, 0);
      expect(text.split('\n').filter((line) => /\bpkill -x chrome\b/.test(line)).length).toBeGreaterThan(0);
      expect(strays(text)).toEqual([]);
    });

    it('planted bug: a name match without -x (any process whose name contains chrome), or a command-line match, is caught by the checks above', () => {
      for (const planted of [(script: string) => script.replace('pkill -x chrome 2>/dev/null\n', 'pkill chrome 2>/dev/null\n'), (script: string) => script.replace('pkill -x chromium 2>/dev/null\n', 'pkill -f chromium 2>/dev/null\n')]) {
        // A park that finds the browser already put away stops nothing: each try starts from a fresh profile
        fakeProfile('job A cookies');
        const calls = asked('park', planted);
        expect(calls.some((call) => !SCOPED.test(call))).toBe(true);
        spawnSync('rm', ['-rf', places.parkRoot]);
      }
      // The hard-signal step runs only when the browser outlives 20 waits, which the recorder never shows: the text check holds it
      const text = signInsCommand('park', JOB_A, [JOB_A], 24, places, 0);
      for (const bad of [text.replace('pkill -9 -x chrome', 'pkill -9 -u node'), text.replace('pgrep -x chrome ', 'pgrep -f chrome '), text.replace('sleep 0.2', 'killall -9 chrome')]) expect(strays(bad).length).toBeGreaterThan(0);
    });
  });

  it('takes back a parked folder the agent could have reached (a link, or a folder opened up) before it keeps anything in it', () => {
    mkdirSync(join(root, 'var', 'lib', 'universe'), { recursive: true });
    const elsewhere = join(root, 'agent-owned');
    mkdirSync(elsewhere);
    chownSync(elsewhere, agentUid, agentUid);
    symlinkSync(elsewhere, places.parkRoot);
    fakeProfile('job A cookies');
    expect(act('park', JOB_A, [JOB_A]).out).toMatch(/parked=1/);
    expect(readdirSync(elsewhere)).toEqual([]);
    expect(statSync(places.parkRoot).isDirectory()).toBe(true);
    chmodSync(places.parkRoot, 0o777);
    fakeProfile('job B cookies');
    expect(act('park', JOB_B, [JOB_A, JOB_B]).out).toMatch(/parked=1/);
    expect(statSync(places.parkRoot).mode & 0o777).toBe(0o700);
  });

  it('never follows a link the agent left as its profile: the link goes, what it points at stays', () => {
    const target = join(root, 'precious');
    mkdirSync(target);
    writeFileSync(join(target, 'keep.txt'), 'not the browser’s');
    mkdirSync(join(home, '.config'), { recursive: true });
    symlinkSync(target, profile());
    // A link is no profile and no browser answered: nothing was put away, and it is not said as kept
    expect(act('park', JOB_A, [JOB_A]).out).toMatch(/parked=0 reason=nothing/);
    expect(existsSync(join(target, 'keep.txt'))).toBe(true);
    expect(existsSync(profile())).toBe(false);
  });

  it('CodeRabbit on #1025: a park that saved neither a profile nor a session says nothing was kept, leaves no folder and no mark, and exits cleanly', () => {
    const done = act('park', JOB_A, [JOB_A]);
    expect(done.code).toBe(0);
    expect(done.out).toMatch(/parked=0 reason=nothing/);
    expect(done.out).not.toMatch(/parked=1/);
    expect(existsSync(parked(JOB_A))).toBe(false);
    expect(existsSync(`${parked(JOB_A)}.new`)).toBe(false);
    expect(existsSync(dirtyMark())).toBe(false);
    expect(readSignInsAnswer('park', done.code, done.out)).toEqual({ done: 'none', reason: 'nothing', cookies: 0, pages: 0 });
    // With a profile there is something to keep: said as kept
    fakeProfile('job A cookies');
    expect(act('park', JOB_A, [JOB_A]).out).toMatch(/parked=1/);
  });

  it('planted bug: a park that says kept whatever it saved is caught by the check above', () => {
    const done = act('park', JOB_A, [JOB_A], (script) => script.replace('"cookies=0 pages=0"|"") if [ "$had_profile" = "0" ]', '"cookies=0 pages=0"|"") if [ "$had_profile" = "9" ]'));
    expect(done.out).toMatch(/parked=1/);
  });

  it('leaves a job’s browser that is already put away exactly as it is (a second park takes nothing)', () => {
    fakeProfile('job A cookies');
    act('park', JOB_A, [JOB_A]);
    fakeProfile('whatever is live now');
    expect(act('park', JOB_A, [JOB_A]).out).toMatch(/parked=0 reason=already/);
    expect(spawnSync('cat', [join(parked(JOB_A), 'profile', 'Default', 'Cookies')], { encoding: 'utf8' }).stdout).toBe('job A cookies');
    expect(existsSync(profile())).toBe(true);
  });

  it('refuses to run as anyone but root, and makes nothing', () => {
    const script = signInsCommand('park', JOB_A, [JOB_A], 24, places);
    const done = spawnSync('setpriv', [`--reuid=${agentUid}`, `--regid=${agentUid}`, '--clear-groups', '--', 'sh', '-c', script], { encoding: 'utf8' });
    expect(done.stdout).toMatch(/parked=0 reason=not_root/);
    expect(existsSync(places.parkRoot)).toBe(false);
  });

  it('a park cut off half way leaves the dirty mark, so the image’s start-up removes the profile before any job can use it', () => {
    fakeProfile('job A cookies');
    act('park', JOB_A, [JOB_A], (script) => script.replace('  saved="$(devtools save', '  exit 1\n  saved="$(devtools save'));
    expect(existsSync(dirtyMark())).toBe(true);
  });
});

run('bringing a job’s browser back, and never into another job', () => {
  it('gives the job back exactly its own browser, owned by the agent’s user again, and nothing is left parked', () => {
    fakeProfile('job A cookies');
    act('park', JOB_A, [JOB_A]);
    const done = act('restore', JOB_A, [JOB_A]);
    expect(done.out).toMatch(/restored=1/);
    expect(spawnSync('cat', [join(profile(), 'Default', 'Cookies')], { encoding: 'utf8' }).stdout).toBe('job A cookies');
    expect(statSync(join(profile(), 'Default', 'Cookies')).uid).toBe(agentUid);
    expect(existsSync(parked(JOB_A))).toBe(false);
    expect(existsSync(dirtyMark())).toBe(false);
  });

  it('a different job gets an empty browser and never another job’s: A’s stays put away for A', () => {
    fakeProfile('job A cookies');
    act('park', JOB_A, [JOB_A]);
    fakeProfile('job C was here in between');
    const done = act('restore', JOB_B, [JOB_A, JOB_B]);
    expect(done.out).toMatch(/restored=0 reason=none/);
    expect(existsSync(profile())).toBe(false);
    expect(existsSync(join(parked(JOB_A), 'profile', 'Default', 'Cookies'))).toBe(true);
  });

  it('planted bug: a restore that takes whatever is parked, not this job’s, is caught by the check above', () => {
    fakeProfile('job A cookies');
    act('park', JOB_A, [JOB_A]);
    act('restore', JOB_B, [JOB_A, JOB_B], (script) => script.replace('JOBDIR="$PARK_ROOT/$JOB"', 'JOBDIR="$(ls -d "$PARK_ROOT"/* | head -1)"'));
    expect(spawnSync('cat', [join(profile(), 'Default', 'Cookies')], { encoding: 'utf8' }).stdout).toBe('job A cookies');
  });

  it('always replaces the live browser, so a resumed job never inherits the browser of the job that ran in between', () => {
    fakeProfile('job C left this behind');
    expect(act('restore', JOB_A, [JOB_A]).out).toMatch(/restored=0 reason=none/);
    expect(existsSync(profile())).toBe(false);
  });

  it('planted bug: a restore that leaves the live browser when nothing was parked is caught by the check above', () => {
    fakeProfile('job C left this behind');
    act('restore', JOB_A, [JOB_A], (script) => script.replace('  rm -rf "$PROFILE" "$CACHE" 2>/dev/null\n  if [ -e "$PROFILE" ] || [ -L "$PROFILE" ] || [ -e "$CACHE" ]; then say "0 reason=profile_not_removed"; exit 1; fi\n  had=0', '  had=0'));
    expect(existsSync(profile())).toBe(true);
  });

  it('CodeRabbit N5: root never empties a file the agent points the dirty mark at, whatever the action', () => {
    const rootFile = join(root, 'sudoers');
    writeFileSync(rootFile, 'root ALL=(ALL) ALL\n');
    chownSync(rootFile, 0, 0);
    chmodSync(rootFile, 0o600);
    fakeProfile('job A cookies');
    makeMarksFolder();
    // The agent can put a link in the marks folder where the mark goes. Every action that marks is tried
    for (const action of ['park', 'restore', 'clear'] as const) {
      rmSync(dirtyMark(), { recursive: true, force: true });
      symlinkSync(rootFile, dirtyMark());
      act(action, JOB_A, [JOB_A]);
      expect(spawnSync('cat', [rootFile], { encoding: 'utf8' }).stdout).toBe('root ALL=(ALL) ALL\n');
      expect(statSync(rootFile).uid).toBe(0);
    }
  });

  it('planted bug: a mark written with a redirection (the old way) empties the file the link points at', () => {
    const rootFile = join(root, 'sudoers');
    writeFileSync(rootFile, 'root ALL=(ALL) ALL\n');
    chownSync(rootFile, 0, 0);
    fakeProfile('job A cookies');
    makeMarksFolder();
    symlinkSync(rootFile, dirtyMark());
    act('park', JOB_A, [JOB_A], (script) => script.replace('  rm -rf "$DIRTY" 2>/dev/null\n  mkdir "$DIRTY" 2>/dev/null || return 1', '  : > "$DIRTY" || return 1'));
    expect(spawnSync('cat', [rootFile], { encoding: 'utf8' }).stdout).toBe('');
  });

  it('CodeRabbit N6: the browser not answering the session replay keeps the saved session and reports a failed restore, and the next try finishes it', () => {
    fakeProfile('job A cookies');
    // A park with a browser that answers, so there IS a session worth putting back
    const saved = { cookies: [{ name: 'sid', value: 'signed-in-as-A', domain: 'example.test', path: '/' }], pages: ['http://example.test/visa-form'] };
    act('park', JOB_A, [JOB_A]);
    writeFileSync(join(parked(JOB_A), 'session.json'), JSON.stringify(saved));
    // No browser answers (nothing is started in these tests): the restore is reported failed, NOT as a restore that worked
    const first = act('restore', JOB_A, [JOB_A]);
    expect(first.out).toMatch(/restored=0 reason=no_answer/);
    // The profile is back on the machine (that part worked), and the saved session is still there to be put back
    expect(spawnSync('cat', [join(profile(), 'Default', 'Cookies')], { encoding: 'utf8' }).stdout).toBe('job A cookies');
    expect(existsSync(join(parked(JOB_A), 'session.json'))).toBe(true);
    // The next try does not wipe the profile it already restored: it only replays. Still no browser, so it is still reported failed
    const again = act('restore', JOB_A, [JOB_A]);
    expect(again.out).toMatch(/restored=0 reason=no_answer/);
    expect(spawnSync('cat', [join(profile(), 'Default', 'Cookies')], { encoding: 'utf8' }).stdout).toBe('job A cookies');
    expect(existsSync(join(parked(JOB_A), 'session.json'))).toBe(true);
  });

  it('planted bug: a restore that deletes the saved session whatever the replay answered loses it for good', () => {
    fakeProfile('job A cookies');
    act('park', JOB_A, [JOB_A]);
    writeFileSync(join(parked(JOB_A), 'session.json'), JSON.stringify({ cookies: [{ name: 'sid', value: 'A', domain: 'example.test', path: '/' }], pages: [] }));
    act('restore', JOB_A, [JOB_A], (script) => script.replace('  replay || { say "0 reason=no_answer"; exit 1; }\n  # Kept until Orbit writes', '  replay\n  # Kept until Orbit writes'));
    expect(existsSync(join(parked(JOB_A), 'session.json'))).toBe(false);
  });

  it('CodeRabbit on #1025 (20): a saved session that cannot be read is kept and reported incomplete, never taken for an empty one', () => {
    fakeProfile('job A cookies');
    act('park', JOB_A, [JOB_A]);
    writeFileSync(join(parked(JOB_A), 'session.json'), '{ this is not a session');
    expect(act('restore', JOB_A, [JOB_A]).out).toMatch(/restored=0 reason=no_answer/);
    expect(existsSync(join(parked(JOB_A), 'session.json'))).toBe(true);
    // A valid EMPTY session still completes at once (nothing to put back)
    writeFileSync(join(parked(JOB_A), 'session.json'), JSON.stringify({ cookies: [], pages: [] }));
    expect(act('restore', JOB_A, [JOB_A]).out).toMatch(/restored=1/);
    expect(existsSync(parked(JOB_A))).toBe(false);
  });

  it('planted bug: a replay that takes an unreadable session for an empty one loses it', () => {
    fakeProfile('job A cookies');
    act('park', JOB_A, [JOB_A]);
    writeFileSync(join(parked(JOB_A), 'session.json'), '{ this is not a session');
    act('restore', JOB_A, [JOB_A], (script) => script.replace('    print("cookies=0 pages=0 answer=0")\n    sys.exit(0)\n', '    saved = {}\n'));
    expect(existsSync(join(parked(JOB_A), 'session.json'))).toBe(false);
  });

  it('CodeRabbit on #1025 (21): a try that stopped right after the profile was moved into place never wipes it on the next try', () => {
    fakeProfile('job A cookies');
    act('park', JOB_A, [JOB_A]);
    // Cut off after the move, before the note that it happened
    act('restore', JOB_A, [JOB_A], (script) => script.replace(MOVED_NOTE, '  exit 1\n'));
    expect(spawnSync('cat', [join(profile(), 'Default', 'Cookies')], { encoding: 'utf8' }).stdout).toBe('job A cookies');
    expect(existsSync(join(parked(JOB_A), 'profile'))).toBe(false);
    const next = act('restore', JOB_A, [JOB_A]);
    expect(next.out).toMatch(/restored=1/);
    expect(spawnSync('cat', [join(profile(), 'Default', 'Cookies')], { encoding: 'utf8' }).stdout).toBe('job A cookies');
    expect(statSync(join(profile(), 'Default', 'Cookies')).uid).toBe(agentUid);
    expect(existsSync(parked(JOB_A))).toBe(false);
  });

  it('a try that stopped BEFORE the profile left the park folder still moves it (the note alone is not taken for a move)', () => {
    fakeProfile('job A cookies');
    act('park', JOB_A, [JOB_A]);
    act('restore', JOB_A, [JOB_A], (script) => script.replace('    mv "$JOBDIR/profile" "$PROFILE" ||', '    exit 1\n    mv "$JOBDIR/profile" "$PROFILE" ||'));
    expect(existsSync(join(parked(JOB_A), 'moving'))).toBe(true);
    expect(existsSync(join(parked(JOB_A), 'profile', 'Default', 'Cookies'))).toBe(true);
    expect(act('restore', JOB_A, [JOB_A]).out).toMatch(/restored=1/);
    expect(spawnSync('cat', [join(profile(), 'Default', 'Cookies')], { encoding: 'utf8' }).stdout).toBe('job A cookies');
    expect(existsSync(parked(JOB_A))).toBe(false);
  });

  it('planted bug: a retry that does not know the move happened wipes the profile it was given', () => {
    fakeProfile('job A cookies');
    act('park', JOB_A, [JOB_A]);
    act('restore', JOB_A, [JOB_A], (script) => script.replace(MOVED_NOTE, '  exit 1\n'));
    act('restore', JOB_A, [JOB_A], (script) => script.replace('  if [ -f "$JOBDIR/moving" ] && [ ! -f "$JOBDIR/moved" ]', '  if [ -f "$JOBDIR/never" ] && [ ! -f "$JOBDIR/moved" ]'));
    expect(existsSync(join(profile(), 'Default', 'Cookies'))).toBe(false);
  });

  /** What the image's own start-up does at the browser's start: a profile that is still marked dirty is removed (lib/agent37/image-files.ts, universe-up). It notes what it saw. */
  function startUpLikeTheImage(): string {
    const seen = join(root, 'mark-at-start');
    places.start = `if [ -e "$DIRTY" ] || [ -L "$DIRTY" ]; then echo set > "${seen}"; rm -rf "$PROFILE"; else echo clear > "${seen}"; fi`;
    return seen;
  }
  const markPath = () => dirtyMark();
  /** A command that was killed after the move: the mark is still there and the lock is left behind (the command lock is taken over after a minute). */
  function leaveKilledTryBehind(): void {
    mkdirSync(markPath());
    const lock = join(home, '.universe', 'up.lock');
    mkdirSync(lock);
    const old = new Date(Date.now() - 5 * 60_000);
    utimesSync(lock, old, old);
  }

  /**
   * A checkpoint at the moment the command lets go of up.lock (its unlock, or the exit trap that frees it when the command stops): it writes down whether the dirty mark
   * is still there, one line per release, just before the lock is removed. A check made after the command has exited cannot tell "cleared before the lock was let go" from
   * "cleared afterwards" (CodeRabbit on #1025): this one can.
   */
  function noteMarkAtLockRelease(script: string, seen: string): string {
    const note = `if [ -e "$DIRTY" ] || [ -L "$DIRTY" ]; then echo mark-set >> "${seen}"; else echo mark-clear >> "${seen}"; fi; `;
    const trap = "  trap 'rmdir \"$LOCK\" 2>/dev/null' EXIT\n";
    const unlock = 'unlock() {\n  rmdir "$LOCK" 2>/dev/null\n';
    if (!script.includes(trap) || !script.includes(unlock)) throw new Error('The lock release is not where the checkpoint expects it');
    return script.replace(trap, `  trap '${note}rmdir "$LOCK" 2>/dev/null' EXIT\n`).replace(unlock, `unlock() {\n  ${note}rmdir "$LOCK" 2>/dev/null\n`);
  }
  const FAIL_HAND_BACK = (script: string) => script.replace('    chown -R -h "$NODE_USER": "$PROFILE" || { say "0 reason=move"; exit 1; }\n    had=1', '    false || { say "0 reason=move"; exit 1; }\n    had=1');

  it('CodeRabbit A3: once the profile is moved in, a failed hand-back clears the dirty mark under the lock before the lock is let go, and the next try finishes', () => {
    fakeProfile('job A cookies');
    act('park', JOB_A, [JOB_A]);
    const seen = join(root, 'mark-at-lock-release');
    const failed = act('restore', JOB_A, [JOB_A], (script) => noteMarkAtLockRelease(FAIL_HAND_BACK(script), seen));
    expect(failed.code).toBe(1);
    expect(failed.out).toMatch(/restored=0 reason=move/);
    // The lock was let go exactly once, and the mark was already gone at that moment (not cleared afterwards)
    expect(readFileSync(seen, 'utf8')).toBe('mark-clear\n');
    // The profile is in place, the mark is gone (the start-up would remove the profile if it were there), the lock is let go, the note of the move is kept
    expect(spawnSync('cat', [join(profile(), 'Default', 'Cookies')], { encoding: 'utf8' }).stdout).toBe('job A cookies');
    expect(existsSync(markPath())).toBe(false);
    expect(existsSync(join(home, '.universe', 'up.lock'))).toBe(false);
    expect(existsSync(join(parked(JOB_A), 'moving'))).toBe(true);
    const next = act('restore', JOB_A, [JOB_A]);
    expect(next.out).toMatch(/restored=1/);
    expect(statSync(join(profile(), 'Default', 'Cookies')).uid).toBe(agentUid);
    expect(spawnSync('cat', [join(profile(), 'Default', 'Cookies')], { encoding: 'utf8' }).stdout).toBe('job A cookies');
  });

  it('planted bug: a hand-back that fails with the mark still set leaves the moved profile to be removed by the start-up (the check above sees the mark)', () => {
    fakeProfile('job A cookies');
    act('park', JOB_A, [JOB_A]);
    const seen = join(root, 'mark-at-lock-release');
    act('restore', JOB_A, [JOB_A], (script) =>
      noteMarkAtLockRelease(script.replace('    unmark || { say "0 reason=mark"; exit 1; }\n    # The move is noted BEFORE', '    # The move is noted BEFORE').replace('    chown -R -h "$NODE_USER": "$PROFILE" || { say "0 reason=move"; exit 1; }\n    had=1', '    false || { say "0 reason=move"; exit 1; }\n    had=1'), seen),
    );
    expect(existsSync(markPath())).toBe(true);
    // The checkpoint sees it too: the lock was let go with the mark still set
    expect(readFileSync(seen, 'utf8')).toBe('mark-set\n');
  });

  it('CodeRabbit A3: a retry on the moved branch never starts the browser while a mark left by a cut-off try is set, and the profile survives the start-up', () => {
    fakeProfile('job A cookies');
    act('park', JOB_A, [JOB_A]);
    writeFileSync(join(parked(JOB_A), 'session.json'), JSON.stringify({ cookies: [{ name: 'sid', value: 'A', domain: 'example.test', path: '/' }], pages: [] }));
    // No browser answers: the profile is back, "moved" is noted and the session is kept
    expect(act('restore', JOB_A, [JOB_A]).out).toMatch(/restored=0 reason=no_answer/);
    expect(existsSync(join(parked(JOB_A), 'moved'))).toBe(true);
    leaveKilledTryBehind();
    const seen = startUpLikeTheImage();
    // The next try (the replay is still not answered: the stand-in start-up starts no browser)
    act('restore', JOB_A, [JOB_A]);
    expect(spawnSync('cat', [seen], { encoding: 'utf8' }).stdout.trim()).toBe('clear');
    expect(spawnSync('cat', [join(profile(), 'Default', 'Cookies')], { encoding: 'utf8' }).stdout).toBe('job A cookies');
    expect(existsSync(markPath())).toBe(false);
    expect(existsSync(join(home, '.universe', 'up.lock'))).toBe(false);
  });

  it('planted bug: a moved branch that starts the browser without clearing the mark loses the profile to the start-up', () => {
    fakeProfile('job A cookies');
    act('park', JOB_A, [JOB_A]);
    writeFileSync(join(parked(JOB_A), 'session.json'), JSON.stringify({ cookies: [{ name: 'sid', value: 'A', domain: 'example.test', path: '/' }], pages: [] }));
    act('restore', JOB_A, [JOB_A]);
    leaveKilledTryBehind();
    const seen = startUpLikeTheImage();
    act('restore', JOB_A, [JOB_A], (script) => script.replace('    lock\n    unmark || { say "0 reason=mark"; exit 1; }\n    unlock\n    start_browser', '    start_browser'));
    expect(spawnSync('cat', [seen], { encoding: 'utf8' }).stdout.trim()).toBe('set');
    expect(existsSync(join(profile(), 'Default', 'Cookies'))).toBe(false);
  });

  it('CodeRabbit A3: a try that finds the profile moved in but not noted clears a mark left behind before anything starts, and the start-up never sees it', () => {
    fakeProfile('job A cookies');
    act('park', JOB_A, [JOB_A]);
    act('restore', JOB_A, [JOB_A], (script) => script.replace(MOVED_NOTE, '  exit 1\n'));
    leaveKilledTryBehind();
    const seen = startUpLikeTheImage();
    expect(act('restore', JOB_A, [JOB_A]).out).toMatch(/restored=1/);
    expect(spawnSync('cat', [seen], { encoding: 'utf8' }).stdout.trim()).toBe('clear');
    expect(spawnSync('cat', [join(profile(), 'Default', 'Cookies')], { encoding: 'utf8' }).stdout).toBe('job A cookies');
    expect(existsSync(markPath())).toBe(false);
    expect(existsSync(parked(JOB_A))).toBe(false);
  });

  it('CodeRabbit A3: a try that finds the profile moved in but not noted, and cannot hand it back, clears a mark left behind under the lock before it lets the lock go', () => {
    fakeProfile('job A cookies');
    act('park', JOB_A, [JOB_A]);
    act('restore', JOB_A, [JOB_A], (script) => script.replace(MOVED_NOTE, '  exit 1\n'));
    leaveKilledTryBehind();
    const failed = act('restore', JOB_A, [JOB_A], (script) => script.replace('    chown -R -h "$NODE_USER": "$PROFILE" || { say "0 reason=move"; exit 1; }\n    # "moving" stays', '    false || { say "0 reason=move"; exit 1; }\n    # "moving" stays'));
    expect(failed.out).toMatch(/restored=0 reason=move/);
    expect(existsSync(markPath())).toBe(false);
    expect(existsSync(join(home, '.universe', 'up.lock'))).toBe(false);
    expect(spawnSync('cat', [join(profile(), 'Default', 'Cookies')], { encoding: 'utf8' }).stdout).toBe('job A cookies');
  });

  it('CodeRabbit A4: the note of the move stays until "moved" is written, on both paths, so the next try never wipes the profile that already moved in', () => {
    // Path 1: the move and the note in one command. The note cannot be written (a folder is where the file goes)
    fakeProfile('job A cookies');
    act('park', JOB_A, [JOB_A]);
    mkdirSync(join(parked(JOB_A), 'moved'));
    const first = act('restore', JOB_A, [JOB_A]);
    expect(first.code).toBe(1);
    expect(first.out).toMatch(/restored=0 reason=move/);
    expect(existsSync(join(parked(JOB_A), 'moving'))).toBe(true);
    expect(spawnSync('cat', [join(profile(), 'Default', 'Cookies')], { encoding: 'utf8' }).stdout).toBe('job A cookies');
    rmSync(join(parked(JOB_A), 'moved'), { recursive: true });
    expect(act('restore', JOB_A, [JOB_A]).out).toMatch(/restored=1/);
    expect(spawnSync('cat', [join(profile(), 'Default', 'Cookies')], { encoding: 'utf8' }).stdout).toBe('job A cookies');
    expect(existsSync(parked(JOB_A))).toBe(false);
    // Path 2: a try that found the profile moved in but not noted, and cannot write the note either
    expect(act('park', JOB_A, [JOB_A]).out).toMatch(/parked=1/);
    act('restore', JOB_A, [JOB_A], (script) => script.replace(MOVED_NOTE, '  exit 1\n'));
    mkdirSync(join(parked(JOB_A), 'moved'));
    const second = act('restore', JOB_A, [JOB_A]);
    expect(second.code).toBe(1);
    expect(second.out).toMatch(/restored=0 reason=move/);
    expect(existsSync(join(parked(JOB_A), 'moving'))).toBe(true);
    rmSync(join(parked(JOB_A), 'moved'), { recursive: true });
    expect(act('restore', JOB_A, [JOB_A]).out).toMatch(/restored=1/);
    expect(spawnSync('cat', [join(profile(), 'Default', 'Cookies')], { encoding: 'utf8' }).stdout).toBe('job A cookies');
  });

  it('planted bug: a restore that removes "moving" even when "moved" could not be written loses the profile on the next try', () => {
    fakeProfile('job A cookies');
    act('park', JOB_A, [JOB_A]);
    mkdirSync(join(parked(JOB_A), 'moved'));
    // (The restore note, which keeps a retry from emptying a browser that was restored, is left out too: this check is about the "moved" note alone)
    act('restore', JOB_A, [JOB_A], (script) =>
      script
        .replace(MOVED_NOTE, '  if [ -d "$JOBDIR" ]; then printf \'\' > "$JOBDIR/moved" 2>/dev/null; fi\n')
        .replace('  if [ "$had" = "1" ]; then printf \'%s\' "$GEN" > "$NOTE" || { say "0 reason=move"; exit 1; }; fi\n', () => ''),
    );
    rmSync(join(parked(JOB_A), 'moved'), { recursive: true, force: true });
    act('restore', JOB_A, [JOB_A]);
    expect(existsSync(join(profile(), 'Default', 'Cookies'))).toBe(false);
  });

  it('CodeRabbit B/C3: a saved session the replay cannot work through (valid JSON, wrong shape) is never taken for a replayed one, on either path, and is kept', () => {
    fakeProfile('job A cookies');
    act('park', JOB_A, [JOB_A]);
    writeFileSync(join(parked(JOB_A), 'session.json'), JSON.stringify({ cookies: 42, pages: [] }));
    // First path: the profile is moved in now
    const first = act('restore', JOB_A, [JOB_A]);
    expect(first.code).toBe(1);
    expect(first.out).toMatch(/restored=0 reason=no_answer/);
    expect(first.out).not.toMatch(/restored=1/);
    expect(existsSync(join(parked(JOB_A), 'session.json'))).toBe(true);
    // Second path (already moved in): the same
    const again = act('restore', JOB_A, [JOB_A]);
    expect(again.code).toBe(1);
    expect(again.out).toMatch(/restored=0 reason=no_answer/);
    expect(existsSync(join(parked(JOB_A), 'session.json'))).toBe(true);
    expect(spawnSync('cat', [join(profile(), 'Default', 'Cookies')], { encoding: 'utf8' }).stdout).toBe('job A cookies');
  });

  it('planted bug: a restore that only looks for answer=0 deletes a session the replay never acknowledged (both paths)', () => {
    const onlyZero = (script: string) =>
      script
        .replace('  loaded="$(devtools load "$JOBDIR/session.json" 2>/dev/null)" || return 1\n  [ "$(echo "$loaded" | tail -n 1 | grep -c \'^cookies=[0-9]* pages=[0-9]* answer=1$\')" = "1" ]', '  loaded="$(devtools load "$JOBDIR/session.json" 2>/dev/null)"\n  case "$loaded" in *answer=0*) return 1 ;; esac');
    for (const cutOff of [false, true]) {
      rmSync(places.parkRoot, { recursive: true, force: true });
      rmSync(profile(), { recursive: true, force: true });
      fakeProfile('job A cookies');
      act('park', JOB_A, [JOB_A]);
      writeFileSync(join(parked(JOB_A), 'session.json'), JSON.stringify({ cookies: 42, pages: [] }));
      if (cutOff) act('restore', JOB_A, [JOB_A]);
      const done = act('restore', JOB_A, [JOB_A], onlyZero);
      expect(done.out).toMatch(/restored=1/);
      expect(existsSync(parked(JOB_A))).toBe(false);
    }
  });

  it('CodeRabbit B/C3: a replay that printed answer=1 but did not exit cleanly is not an acknowledged one, and no saved session at all is still a plain restore', () => {
    fakeProfile('job A cookies');
    act('park', JOB_A, [JOB_A]);
    writeFileSync(join(parked(JOB_A), 'session.json'), JSON.stringify({ cookies: [], pages: [] }));
    const dies = (script: string) => script.replace('    print("cookies=0 pages=0 answer=1")\n    sys.exit(0)', '    print("cookies=0 pages=0 answer=1")\n    sys.exit(3)');
    expect(act('restore', JOB_A, [JOB_A], dies).out).toMatch(/restored=0 reason=no_answer/);
    expect(existsSync(join(parked(JOB_A), 'session.json'))).toBe(true);
    // The no-snapshot path stays separate: nothing to replay, the profile alone is restored
    rmSync(join(parked(JOB_A), 'session.json'));
    const plain = act('restore', JOB_A, [JOB_A]);
    expect(plain.out).toMatch(/restored=1/);
    expect(existsSync(parked(JOB_A))).toBe(false);
  });

  it('hands the profile back without following a link inside it to a file the agent does not own', () => {
    const rootFile = join(root, 'root-only');
    writeFileSync(rootFile, 'root');
    fakeProfile('job A cookies');
    symlinkSync(rootFile, join(profile(), 'Default', 'trap'));
    // The park and the restore both really happened (a pair of commands that failed would leave the root file root's as well)
    expect(act('park', JOB_A, [JOB_A]).out).toMatch(/parked=1/);
    expect(existsSync(join(parked(JOB_A), 'profile', 'Default', 'Cookies'))).toBe(true);
    expect(act('restore', JOB_A, [JOB_A]).out).toMatch(/restored=1/);
    expect(spawnSync('cat', [join(profile(), 'Default', 'Cookies')], { encoding: 'utf8' }).stdout).toBe('job A cookies');
    expect(statSync(rootFile).uid).toBe(0);
  });
});

run('throwing parked browsers away', () => {
  it('drop removes this job’s, and is safe to run when there is none', () => {
    fakeProfile('job A cookies');
    act('park', JOB_A, [JOB_A]);
    expect(act('drop', JOB_A, [JOB_A]).out).toMatch(/dropped=1/);
    expect(existsSync(parked(JOB_A))).toBe(false);
    expect(act('drop', JOB_A, []).out).toMatch(/dropped=1/);
  });

  it('every command also removes the parked browsers of jobs no longer allowed one, but never one put away in the last two minutes', () => {
    for (const job of [JOB_A, JOB_B, JOB_C]) {
      fakeProfile(job);
      act('park', job, [JOB_A, JOB_B, JOB_C]);
    }
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(parked(JOB_A), old, old);
    // A: old and no longer allowed (gone). B: allowed (kept). C: not allowed but just put away (kept, it may be a job being paused right now)
    expect(act('prune', JOB_B, [JOB_B]).out).toMatch(/pruned=1/);
    expect(existsSync(parked(JOB_A))).toBe(false);
    expect(existsSync(parked(JOB_B))).toBe(true);
    expect(existsSync(parked(JOB_C))).toBe(true);
  });

  it('removes a parked browser older than the time paused sign-ins may be kept, even for a job still allowed one', () => {
    fakeProfile('job A cookies');
    act('park', JOB_A, [JOB_A]);
    const old = new Date(Date.now() - 25 * 3600_000);
    utimesSync(parked(JOB_A), old, old);
    act('prune', JOB_B, [JOB_A], undefined, 24);
    expect(existsSync(parked(JOB_A))).toBe(false);
  });

  it('clear empties the live browser and keeps nothing', () => {
    fakeProfile('shared');
    expect(act('clear', JOB_A, []).out).toMatch(/cleared=1/);
    expect(existsSync(profile())).toBe(false);
    expect(existsSync(places.parkRoot) ? readdirSync(places.parkRoot) : []).toEqual([]);
  });
});

/** The little of Playwright these tests use. */
interface CdpPage {
  url(): string;
  goto(url: string): Promise<unknown>;
}
interface CdpBrowser {
  contexts(): { cookies(): Promise<{ name: string; value: string }[]>; pages(): CdpPage[]; newPage(): Promise<CdpPage> }[];
  close(): Promise<void>;
}

runWithBrowser('a real browser’s sign-ins and open pages', () => {
  let server: Server;
  let site: string;

  beforeAll(async () => {
    server = createServer((request, response) => {
      if (request.url === '/sign-in') {
        // A session cookie (most sign-ins: never written to disk by a browser that stops) and one that lasts
        response.setHeader('Set-Cookie', ['sid=signed-in-as-A; Path=/; HttpOnly', 'remember=A; Path=/; Max-Age=86400']);
      }
      response.setHeader('Content-Type', 'text/html');
      response.end(`<title>${request.url}</title>ok`);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    site = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    // The browser runs as the agent's own user, as on the machine (never as root with the permission boundary this suite is about out of the way);
    // its profile's parent and its cache are the agent's to write
    places.start = `nohup setsid setpriv --reuid=${agentUid} --regid=${agentUid} --clear-groups env HOME="${home}" "${CHROME}" --headless=new --no-sandbox --disable-gpu --no-first-run --user-data-dir="$PROFILE" --remote-debugging-port=${port} --remote-debugging-address=127.0.0.1 about:blank >/dev/null 2>&1 &`;
    places.answerWait = 20;
  });

  async function browser() {
    // Playwright is not one of Orbit's packages: it is the one this test machine has, and these tests are skipped where there is none
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { chromium } = require('playwright') as { chromium: { connectOverCDP(url: string): Promise<CdpBrowser> } };
    for (let i = 0; i < 100; i++) {
      try {
        return await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    throw new Error('The browser did not answer');
  }

  /**
   * The pages the browser has open at one address, once the replayed tabs have all arrived (CodeRabbit on #1025). It waits, bounded, until at least `expected` pages are
   * at that address AND the browser's whole list of pages has stopped changing for a quiet moment, so a tab still on its way (a delayed duplicate, a second tab on the same
   * address) is in the count before it is taken: the first tab arriving is not enough, and a late extra tab cannot slip past a check for fewer. The callers keep their exact
   * count assertions. `expected` 0 only waits for the browser to settle (the pages must not turn up).
   */
  async function pagesAt(live: CdpBrowser, url: string, expected: number): Promise<CdpPage[]> {
    const context = live.contexts()[0];
    const QUIET_POLLS = 10; // 1 s of an unchanged list
    let last = '';
    let quiet = 0;
    for (let i = 0; i < 150; i++) {
      const pages = context.pages().map((one) => one.url());
      const now = [...pages].sort().join('\n');
      quiet = now === last ? quiet + 1 : 0;
      last = now;
      // Returned from the sample that qualifies: the target count AND a list that has not changed for the quiet moment (`context.pages()` is a snapshot of the open pages, not a sign that the replay has finished)
      if (pages.filter((one) => one === url).length >= expected && quiet >= QUIET_POLLS) return context.pages().filter((one) => one.url() === url);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    // No sample qualified (another tab kept changing, or the target count never came): the check fails here, it never passes on a count taken from a list that was still moving
    throw new Error(`The browser's pages never settled with ${expected} at ${url}: ${last}`);
  }

  function startBrowser() {
    startedBrowser = true;
    mkdirSync(join(home, '.config'), { recursive: true });
    mkdirSync(join(home, '.cache'), { recursive: true });
    spawnSync('chown', [`${AGENT}:`, join(home, '.config'), join(home, '.cache')]);
    spawnSync('sh', ['-c', places.start.replace('"$PROFILE"', `"${profile()}"`)]);
  }

  it('A signs in and opens a page; while A is paused the next browser has none of it; A comes back signed in, on its page', async () => {
    startBrowser();
    let live = await browser();
    let context = live.contexts()[0];
    const page = await context.newPage();
    await page.goto(`${site}/sign-in`);
    await page.goto(`${site}/visa-form`);
    expect((await context.cookies()).map((cookie) => cookie.name).sort()).toEqual(['remember', 'sid']);
    await live.close().catch(() => undefined);

    const parkedNow = act('park', JOB_A, [JOB_A]);
    expect(parkedNow.out).toMatch(/parked=1 cookies=2 pages=1/);

    // The job that runs in between: a fresh browser, none of A's cookies, none of A's pages
    live = await browser();
    context = live.contexts()[0];
    expect(await context.cookies()).toEqual([]);
    expect(context.pages().map((one) => one.url())).not.toContain(`${site}/visa-form`);
    await live.close().catch(() => undefined);

    const back = act('restore', JOB_A, [JOB_A]);
    expect(back.out).toMatch(/restored=1 cookies=2 pages=1/);
    live = await browser();
    context = live.contexts()[0];
    const cookies = await context.cookies();
    expect(cookies.find((cookie) => cookie.name === 'sid')?.value).toBe('signed-in-as-A');
    expect(cookies.find((cookie) => cookie.name === 'remember')?.value).toBe('A');
    for (let i = 0; i < 50 && !context.pages().some((one) => one.url() === `${site}/visa-form`); i++) await new Promise((resolve) => setTimeout(resolve, 100));
    expect(context.pages().map((one) => one.url())).toContain(`${site}/visa-form`);
    await live.close().catch(() => undefined);
  }, 120_000);

  it('CodeRabbit on #1025 (20): a replay that cannot put everything back keeps the saved session, and a retry opens no page twice', async () => {
    startBrowser();
    const live = await browser();
    await live.close().catch(() => undefined);
    act('park', JOB_A, [JOB_A]);
    // A good cookie, one the browser will not take, and one page
    const good = { name: 'sid', value: 'signed-in-as-A', domain: '127.0.0.1', path: '/' };
    const bad = { name: '__Host-nope', value: 'x', domain: 'example.test', path: '/' };
    writeFileSync(join(parked(JOB_A), 'session.json'), JSON.stringify({ cookies: [good, bad], pages: [`${site}/visa-form`] }));
    const first = act('restore', JOB_A, [JOB_A]);
    expect(first.out).toMatch(/restored=0 reason=no_answer/);
    expect(existsSync(join(parked(JOB_A), 'session.json'))).toBe(true);
    // The first partial restore opened exactly one page (not skipped, not twice), before any retry
    let again = await browser();
    expect(await pagesAt(again, `${site}/visa-form`, 1)).toHaveLength(1);
    await again.close().catch(() => undefined);
    // The retry (the move is already noted, so only the replay is done again): the page that already came back is not opened a second time
    const second = act('restore', JOB_A, [JOB_A]);
    expect(second.out).toMatch(/restored=0 reason=no_answer/);
    again = await browser();
    expect(await pagesAt(again, `${site}/visa-form`, 1)).toHaveLength(1);
    await again.close().catch(() => undefined);
    // Once the session is whole the replay finishes and the saved session goes
    writeFileSync(join(parked(JOB_A), 'session.json'), JSON.stringify({ cookies: [good], pages: [`${site}/visa-form`] }));
    expect(act('restore', JOB_A, [JOB_A]).out).toMatch(/restored=1/);
    expect(existsSync(parked(JOB_A))).toBe(false);
    again = await browser();
    expect(await pagesAt(again, `${site}/visa-form`, 1)).toHaveLength(1);
    expect((await again.contexts()[0].cookies()).find((cookie) => cookie.name === 'sid')?.value).toBe('signed-in-as-A');
    await again.close().catch(() => undefined);
  }, 180_000);

  it('CodeRabbit B/C17: a replay that cannot list the open tabs does not open every page again, keeps the saved session, and a later try opens only what is missing', async () => {
    startBrowser();
    await (await browser()).close().catch(() => undefined);
    act('park', JOB_A, [JOB_A]);
    const good = { name: 'sid', value: 'signed-in-as-A', domain: '127.0.0.1', path: '/' };
    writeFileSync(join(parked(JOB_A), 'session.json'), JSON.stringify({ cookies: [good], pages: [`${site}/page-a`, `${site}/page-b`] }));
    // A try that opened page A and then failed on page B (nothing else is said about the tabs)
    const opened = act('restore', JOB_A, [JOB_A], (script) => script.replace("        http(\"PUT\", \"/json/new?\" + urllib.parse.quote(url, safe=\"\"))\n        opened += 1\n", "        if url.endswith('/page-b'):\n            raise IOError('planted')\n        http(\"PUT\", \"/json/new?\" + urllib.parse.quote(url, safe=\"\"))\n        opened += 1\n"));
    expect(opened.out).toMatch(/restored=0 reason=no_answer/);
    let live = await browser();
    expect(await pagesAt(live, `${site}/page-a`, 1)).toHaveLength(1);
    expect(await pagesAt(live, `${site}/page-b`, 0)).toHaveLength(0);
    await live.close().catch(() => undefined);
    // The retry cannot list the tabs: nothing is opened (page A is not opened a second time), the session is kept and the answer says incomplete
    const blind = act('restore', JOB_A, [JOB_A], (script) => script.replace('def open_tabs():\n', 'def open_tabs():\n    raise IOError("planted")\n'));
    expect(blind.out).toMatch(/restored=0 reason=no_answer/);
    expect(existsSync(join(parked(JOB_A), 'session.json'))).toBe(true);
    live = await browser();
    expect(await pagesAt(live, `${site}/page-a`, 1)).toHaveLength(1);
    expect(await pagesAt(live, `${site}/page-b`, 0)).toHaveLength(0);
    await live.close().catch(() => undefined);
    // The list works again: only the missing page is opened, and the replay finishes
    expect(act('restore', JOB_A, [JOB_A]).out).toMatch(/restored=1 cookies=1 pages=2/);
    expect(existsSync(parked(JOB_A))).toBe(false);
    live = await browser();
    expect(await pagesAt(live, `${site}/page-a`, 1)).toHaveLength(1);
    expect(await pagesAt(live, `${site}/page-b`, 1)).toHaveLength(1);
    await live.close().catch(() => undefined);
  }, 180_000);

  it('CodeRabbit B/C18: two saved tabs on one address are two tabs back, and a retry opens no more', async () => {
    startBrowser();
    await (await browser()).close().catch(() => undefined);
    act('park', JOB_A, [JOB_A]);
    const good = { name: 'sid', value: 'signed-in-as-A', domain: '127.0.0.1', path: '/' };
    const bad = { name: '__Host-nope', value: 'x', domain: 'example.test', path: '/' };
    writeFileSync(join(parked(JOB_A), 'session.json'), JSON.stringify({ cookies: [good, bad], pages: [`${site}/same`, `${site}/same`, `${site}/other`] }));
    expect(act('restore', JOB_A, [JOB_A]).out).toMatch(/restored=0 reason=no_answer/);
    let live = await browser();
    expect(await pagesAt(live, `${site}/same`, 2)).toHaveLength(2);
    expect(await pagesAt(live, `${site}/other`, 1)).toHaveLength(1);
    await live.close().catch(() => undefined);
    // The retry finds all three there and opens none
    expect(act('restore', JOB_A, [JOB_A]).out).toMatch(/restored=0 reason=no_answer/);
    live = await browser();
    expect(await pagesAt(live, `${site}/same`, 2)).toHaveLength(2);
    expect(await pagesAt(live, `${site}/other`, 1)).toHaveLength(1);
    await live.close().catch(() => undefined);
    // With one of the two already open, a whole session opens only the missing one
    writeFileSync(join(parked(JOB_A), 'session.json'), JSON.stringify({ cookies: [good], pages: [`${site}/same`, `${site}/same`, `${site}/same`] }));
    expect(act('restore', JOB_A, [JOB_A]).out).toMatch(/restored=1 cookies=1 pages=3/);
    live = await browser();
    expect(await pagesAt(live, `${site}/same`, 3)).toHaveLength(3);
    await live.close().catch(() => undefined);
  }, 180_000);

  it('B resumed after A was paused gets an empty browser, not A’s sign-ins', async () => {
    startBrowser();
    let live = await browser();
    let context = live.contexts()[0];
    await (await context.newPage()).goto(`${site}/sign-in`);
    await live.close().catch(() => undefined);
    act('park', JOB_A, [JOB_A]);
    expect(act('restore', JOB_B, [JOB_A, JOB_B]).out).toMatch(/restored=0 reason=none/);
    live = await browser();
    context = live.contexts()[0];
    expect(await context.cookies()).toEqual([]);
    await live.close().catch(() => undefined);
  }, 120_000);
});

run('the dirty mark and the restore note (CodeRabbit on #1025: F1, F2, I4)', () => {
  const sessionFile = { cookies: [{ name: 'sid', value: 'A', domain: 'example.test', path: '/' }], pages: [] };

  it('F1: the mark is in a folder that is root’s (sticky, open to the agent to put a mark in and take it out), not in the agent’s own folder', () => {
    fakeProfile('job A cookies');
    expect(act('park', JOB_A, [JOB_A]).out).toMatch(/parked=1/);
    const info = statSync(marksFolder());
    expect(info.uid).toBe(0);
    expect(info.mode & 0o7777).toBe(0o1777);
    // A try cut off after the mark is set leaves it, and the agent’s user can take it out (it owns it)
    fakeProfile('job A cookies again');
    act('park', JOB_B, [JOB_B], (script) => script.replace('  saved="$(devtools save', '  exit 1\n  saved="$(devtools save'));
    expect(existsSync(dirtyMark())).toBe(true);
    const removed = spawnSync('setpriv', [`--reuid=${agentUid}`, `--regid=${agentUid}`, '--clear-groups', '--', 'rmdir', dirtyMark()], { encoding: 'utf8' });
    expect(removed.status).toBe(0);
    expect(existsSync(dirtyMark())).toBe(false);
  });

  /** An rm that, the moment it is asked to remove a mark, has the agent swap its own state folder for a link to a folder of root's (the agent owns that folder, so it can). */
  function swapStateWhenMarkIsRemoved(): { decoy: string } {
    const decoy = join(root, 'decoy');
    mkdirSync(decoy);
    writeFileSync(join(decoy, 'profile.dirty'), 'root-owned file the agent must not be able to make root remove');
    const state = join(home, '.universe');
    // The command's own PATH is the system's: the real rm is there (not whatever a wrapper in this shell's PATH may be)
    const real = ['/usr/bin/rm', '/bin/rm'].find((path) => existsSync(path)) ?? 'rm';
    writeFileSync(
      join(shim, 'rm'),
      `#!/bin/sh\nfor a in "$@"; do case "$a" in *profile.dirty) if [ -d "${state}" ] && [ ! -L "${state}" ]; then mv "${state}" "${state}.real"; ln -s "${decoy}" "${state}"; fi ;; esac; done\nexec ${real} "$@"\n`,
      { mode: 0o755 },
    );
    return { decoy };
  }

  it('F1: an agent that swaps its state folder for a link while root removes the mark never makes root remove anything of its choosing', () => {
    fakeProfile('job A cookies');
    const { decoy } = swapStateWhenMarkIsRemoved();
    for (const action of ['park', 'clear'] as const) {
      act(action, JOB_A, [JOB_A]);
      expect(existsSync(join(decoy, 'profile.dirty'))).toBe(true);
      fakeProfile('job A cookies');
    }
  });

  it('planted bug: a mark kept in the agent’s own state folder (the old place) is removed through the swapped link', () => {
    fakeProfile('job A cookies');
    const { decoy } = swapStateWhenMarkIsRemoved();
    act('park', JOB_A, [JOB_A], (script) => script.replace('DIRTY="$MARKS/profile.dirty"', 'DIRTY="$STATE/profile.dirty"'));
    expect(existsSync(join(decoy, 'profile.dirty'))).toBe(false);
  });

  // A function as the replacement: in a string, "$$" would be read as a single "$"
  const KILL_AFTER_MOVE = (script: string) =>
    script.replace('    chown -R -h "$NODE_USER": "$PROFILE" || { say "0 reason=move"; exit 1; }\n    had=1', () => '    kill -9 $$\n    chown -R -h "$NODE_USER": "$PROFILE" || { say "0 reason=move"; exit 1; }\n    had=1');

  it('F2: a restore killed right after the move leaves no mark for the start-up to act on, and the profile that moved in stays closed to the agent until the retry hands it over', () => {
    fakeProfile('job A cookies');
    act('park', JOB_A, [JOB_A]);
    const killed = act('restore', JOB_A, [JOB_A], KILL_AFTER_MOVE);
    expect(killed.out).not.toMatch(/restored=/);
    // What the image's start-up would see before the retry runs: no mark, so it removes nothing
    expect(existsSync(dirtyMark())).toBe(false);
    expect(spawnSync('cat', [join(profile(), 'Default', 'Cookies')], { encoding: 'utf8' }).stdout).toBe('job A cookies');
    expect(statSync(profile()).uid).toBe(0);
    expect(agentCanRead(profile())).toBe(false);
    // The lock the killed try left is taken over after a minute; the retry finishes the hand-over
    const lock = join(home, '.universe', 'up.lock');
    const old = new Date(Date.now() - 5 * 60_000);
    utimesSync(lock, old, old);
    const retry = act('restore', JOB_A, [JOB_A]);
    expect(retry.out).toMatch(/restored=1/);
    expect(statSync(join(profile(), 'Default', 'Cookies')).uid).toBe(agentUid);
    expect(agentCanRead(profile())).toBe(true);
  });

  it('planted bug: the mark kept until after the move (the old order) is still set when a restore is killed after the move', () => {
    fakeProfile('job A cookies');
    act('park', JOB_A, [JOB_A]);
    act('restore', JOB_A, [JOB_A], (script) => KILL_AFTER_MOVE(script.replace('    unmark || { say "0 reason=mark"; exit 1; }\n    # The move is noted BEFORE', '    # The move is noted BEFORE')));
    expect(existsSync(dirtyMark())).toBe(true);
  });

  it('I4: a retry of a restore whose result Orbit never wrote keeps the live browser; the commit lets the note go; the next restore then makes the browser empty again', () => {
    fakeProfile('job A cookies');
    act('park', JOB_A, [JOB_A]);
    expect(act('restore', JOB_A, [JOB_A]).out).toMatch(/restored=1/);
    expect(existsSync(join(places.parkRoot, `${JOB_A}.restored`))).toBe(true);
    // Orbit asks again (the ready write did not land): nothing is parked now, and the live browser is still A's own
    const again = act('restore', JOB_A, [JOB_A]);
    expect(again.out).toMatch(/restored=1/);
    expect(spawnSync('cat', [join(profile(), 'Default', 'Cookies')], { encoding: 'utf8' }).stdout).toBe('job A cookies');
    // The ready write landed
    const committed = act('commit', JOB_A, [JOB_A]);
    expect(committed.out).toMatch(/committed=1/);
    expect(existsSync(join(places.parkRoot, `${JOB_A}.restored`))).toBe(false);
    // With nothing noted, a restore with nothing parked is the empty browser it always was
    const empty = act('restore', JOB_A, [JOB_A]);
    expect(empty.out).toMatch(/restored=0 reason=none/);
    expect(existsSync(profile())).toBe(false);
  });

  it('N29: a commit belongs to the restore it was made for: one delayed past a newer pause and restore of the same job leaves the newer note, and a retry of the newer restore still keeps the browser', () => {
    fakeProfile('job A cookies');
    act('park', JOB_A, [JOB_A], undefined, 24, 1);
    expect(act('restore', JOB_A, [JOB_A], undefined, 24, 1).out).toMatch(/restored=1/);
    const note = join(places.parkRoot, `${JOB_A}.restored`);
    expect(readFileSync(note, 'utf8')).toBe('1');
    // The job is paused and restored again (pause 2); the first restore's commit, delayed, only now arrives
    act('park', JOB_A, [JOB_A], undefined, 24, 2);
    expect(existsSync(note)).toBe(false);
    expect(act('restore', JOB_A, [JOB_A], undefined, 24, 2).out).toMatch(/restored=1/);
    expect(readFileSync(note, 'utf8')).toBe('2');
    expect(act('commit', JOB_A, [JOB_A], undefined, 24, 1).out).toMatch(/committed=1/);
    expect(existsSync(note)).toBe(true);
    // The newer ready write failed: its retry finds the note and the live browser is the job's own, not emptied
    expect(act('restore', JOB_A, [JOB_A], undefined, 24, 2).out).toMatch(/restored=1/);
    expect(readFileSync(join(profile(), 'Default', 'Cookies'), 'utf8')).toBe('job A cookies');
    // The newer commit lets it go
    expect(act('commit', JOB_A, [JOB_A], undefined, 24, 2).out).toMatch(/committed=1/);
    expect(existsSync(note)).toBe(false);
  });

  it('planted bug: a commit that does not read the note\'s number removes the newer restore\'s note', () => {
    fakeProfile('job A cookies');
    act('park', JOB_A, [JOB_A], undefined, 24, 2);
    act('restore', JOB_A, [JOB_A], undefined, 24, 2);
    act('commit', JOB_A, [JOB_A], (script) => script.replace('&& [ "$(cat "$NOTE" 2>/dev/null)" = "$GEN" ]', ''), 24, 1);
    expect(existsSync(join(places.parkRoot, `${JOB_A}.restored`))).toBe(false);
  });

  it('I4: a note never makes another job’s restore keep A’s browser, and any command that replaces the live browser lets the note go', () => {
    fakeProfile('job A cookies');
    act('park', JOB_A, [JOB_A]);
    act('restore', JOB_A, [JOB_A]);
    expect(act('restore', JOB_B, [JOB_A, JOB_B]).out).toMatch(/restored=0 reason=none/);
    expect(existsSync(profile())).toBe(false);
    expect(existsSync(join(places.parkRoot, `${JOB_A}.restored`))).toBe(false);
    expect(readdirSync(places.parkRoot).filter((name) => name.endsWith('.restored'))).toEqual([]);
  });

  it('planted bug: a retry that does not know the note empties the browser the earlier try restored', () => {
    fakeProfile('job A cookies');
    act('park', JOB_A, [JOB_A]);
    act('restore', JOB_A, [JOB_A]);
    act('restore', JOB_A, [JOB_A], (script) => script.replace('[ -f "$NOTE" ] && [ ! -L "$NOTE" ]', '[ -f "$JOBDIR/never" ]'));
    expect(existsSync(join(profile(), 'Default', 'Cookies'))).toBe(false);
  });

  it('I4: a restored note is kept through the housekeeping for the keep time, then let go (it is Orbit’s to commit)', () => {
    fakeProfile('job A cookies');
    act('park', JOB_A, [JOB_A]);
    writeFileSync(join(parked(JOB_A), 'session.json'), JSON.stringify(sessionFile));
    act('restore', JOB_A, [JOB_A]);
    // No browser answers in these tests, so the replay failed: no note yet. Put one as a finished restore leaves it
    const note = join(places.parkRoot, `${JOB_A}.restored`);
    writeFileSync(note, '');
    act('prune', JOB_B, [JOB_A]);
    expect(existsSync(note)).toBe(true);
    const old = new Date(Date.now() - 48 * 3600_000);
    utimesSync(note, old, old);
    act('prune', JOB_B, [JOB_A]);
    expect(existsSync(note)).toBe(false);
  });
  it('N4: on a machine whose start-up does not read the marks folder, park, restore and clear refuse before they touch anything; drop, prune and commit still run', () => {
    // An image from before the marks folder: its start-up has not the word that says it reads it
    writeFileSync(places.up, '#!/bin/sh\n# an image from before the marks folder\n');
    fakeProfile('job A cookies');
    for (const action of ['park', 'restore', 'clear'] as const) {
      const answer = act(action, JOB_A, [JOB_A]);
      expect(answer.code).toBe(1);
      expect(answer.out).toMatch(/reason=old_image/);
    }
    // Nothing was marked, moved, stopped or removed: the profile is where it was, no mark exists in either place, nothing is parked
    expect(spawnSync('cat', [join(profile(), 'Default', 'Cookies')], { encoding: 'utf8' }).stdout).toBe('job A cookies');
    expect(existsSync(dirtyMark())).toBe(false);
    expect(existsSync(join(home, '.universe', 'profile.dirty'))).toBe(false);
    expect(existsSync(parked(JOB_A))).toBe(false);
    expect(act('drop', JOB_A).out).toMatch(/dropped=1/);
    expect(act('prune', JOB_A).out).toMatch(/pruned=1/);
    expect(act('commit', JOB_A).out).toMatch(/committed=1/);
    // A start-up that is not there at all is the same refusal; the one that has the word is not
    rmSync(places.up);
    expect(act('clear', JOB_A, [JOB_A]).out).toMatch(/reason=old_image/);
    writeFileSync(places.up, '#!/bin/sh\n# universe-marks-v1\n');
    expect(act('clear', JOB_A, [JOB_A]).out).toMatch(/cleared=1/);
    expect(existsSync(profile())).toBe(false);
  });

  it('planted bug: without the check, a park on a machine whose start-up never reads the marks folder moves the profile away behind a mark that start-up would not see', () => {
    writeFileSync(places.up, '#!/bin/sh\n# an image from before the marks folder\n');
    fakeProfile('job A cookies');
    const planted = act('park', JOB_A, [JOB_A], (script) => script.replace('reads_marks() {', 'reads_marks() { return 0; }\nreads_marks_unused() {'));
    expect(planted.out).not.toMatch(/old_image/);
    expect(existsSync(profile())).toBe(false);
  });

  /** A stop that cannot finish: what the command sees when a browser will not go away. */
  const stopFails = (script: string) => script.replace('stop_browser() {', 'stop_browser() { return 1; }\nstop_browser_unused() {');
  const restoredNote = () => join(places.parkRoot, `${JOB_A}.restored`);
  function aRestoredNote(): void {
    fakeProfile('job A cookies');
    act('park', JOB_A, [JOB_A]);
    expect(act('restore', JOB_A, [JOB_A]).out).toMatch(/restored=1/);
    expect(existsSync(restoredNote())).toBe(true);
  }

  it('N15: a park, a restore or a clear whose browser could not be stopped keeps the restore note, and the live browser is still the job’s own', () => {
    for (const action of ['park', 'restore', 'clear'] as const) {
      aRestoredNote();
      const failed = act(action, JOB_B, [JOB_A, JOB_B], stopFails);
      expect(failed.code).toBe(1);
      expect(failed.out).toMatch(/reason=browser_running/);
      expect(existsSync(restoredNote())).toBe(true);
      // The retry of A's own restore is still answered as restored, and the sign-ins it brought are not emptied
      const again = act('restore', JOB_A, [JOB_A]);
      expect(again.out).toMatch(/restored=1/);
      expect(spawnSync('cat', [join(profile(), 'Default', 'Cookies')], { encoding: 'utf8' }).stdout).toBe('job A cookies');
      act('commit', JOB_A, [JOB_A]);
      act('clear', JOB_A, [JOB_A]);
    }
  });

  it('planted bug: the note let go before the stop is proved (the old order) is gone when the stop fails', () => {
    aRestoredNote();
    act('clear', JOB_B, [JOB_A, JOB_B], (script) => stopFails(script.replaceAll('  stop_browser || { say "0 reason=browser_running"; exit 1; }\n  forget_restored\n', '  forget_restored\n  stop_browser || { say "0 reason=browser_running"; exit 1; }\n')));
    expect(existsSync(restoredNote())).toBe(false);
  });

  it('N16: a drop whose restore receipt cannot be removed is not a drop; with the receipt gone it is', () => {
    const note = restoredNote();
    // `rm -f` cannot remove a folder: the receipt stays where it was
    mkdirSync(note, { recursive: true });
    writeFileSync(join(note, 'stays'), '');
    const failed = act('drop', JOB_A);
    expect(failed.code).toBe(1);
    expect(failed.out).toMatch(/dropped=0 reason=not_removed/);
    rmSync(note, { recursive: true, force: true });
    expect(act('drop', JOB_A).out).toMatch(/dropped=1/);
    // A dangling link in its place is removed by `rm -f`, and counts as gone
    symlinkSync(join(root, 'nowhere'), note);
    expect(act('drop', JOB_A).out).toMatch(/dropped=1/);
  });

  it('planted bug: a drop that looks only at the parked folder says dropped while the receipt is still there', () => {
    const note = restoredNote();
    mkdirSync(note, { recursive: true });
    writeFileSync(join(note, 'stays'), '');
    const planted = act('drop', JOB_A, [], (script) => script.replace(' || [ -e "$PARK_ROOT/$JOB.restored" ] || [ -L "$PARK_ROOT/$JOB.restored" ]; then say "0 reason=not_removed"', '; then say "0 reason=not_removed"'));
    expect(planted.out).toMatch(/dropped=1/);
  });

  describe('N26: universe-clean never acts with more rights than the agent has', () => {
    const cleanText = () => imageFiles().find((file) => file.name === 'universe-clean')!.text;
    /** The image's cleanup run as root (what a mistaken caller would do), in this test's own home folder, with the system's pkill and pgrep standing in as the shims. */
    function cleanAsRoot(plant?: (text: string) => string): { code: number; out: string } {
      let text = cleanText();
      if (plant) {
        const planted = plant(text);
        if (planted === text) throw new Error('The planted bug did not change the cleanup');
        text = planted;
      }
      const first = 'export PATH\n';
      text = text.replace(first, `PATH="${shim}:$PATH"\nexport PATH\n`);
      const file = join(root, 'clean');
      writeFileSync(file, text, { mode: 0o755 });
      const done = spawnSync('sh', [file], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, HOME: home } });
      return { code: done.status ?? -1, out: done.stdout };
    }
    /** A folder of root's, with something in it the agent must never be able to make root remove, reached from the agent's own `.config` (which the agent owns: it can make it a link). */
    function configLinkedToDecoy(): string {
      const decoy = join(root, 'decoy');
      mkdirSync(join(decoy, 'universe-chromium'), { recursive: true });
      writeFileSync(join(decoy, 'universe-chromium', 'secret'), 'root-owned');
      rmSync(join(home, '.config'), { recursive: true, force: true });
      symlinkSync(decoy, join(home, '.config'));
      return join(decoy, 'universe-chromium', 'secret');
    }

    it('run as root with no agent user to hand over to, it refuses before it touches anything: what the agent linked its folders to is never removed', () => {
      const secret = configLinkedToDecoy();
      // An agent name that exists nowhere: with the image's own `node` a host that has that account (and `runuser`) would re-run the cleanup as it, in its REAL home (CodeRabbit on #1025, d522f4b3 pass, N1)
      const done = cleanAsRoot((text) => text.replace('AGENT=node', 'AGENT=universe-no-such-agent'));
      expect(done.code).toBe(1);
      expect(done.out).toMatch(/cleaned=0 reason=root/);
      expect(existsSync(secret)).toBe(true);
      expect(existsSync(join(home, '.universe', 'profile.dirty'))).toBe(false);
    });

    it('planted bug: the cleanup that stays root removes what the agent’s link in `.config` points at', () => {
      const secret = configLinkedToDecoy();
      cleanAsRoot((text) => text.replace('if [ "$(id -u)" = "0" ]; then', 'if false; then'));
      expect(existsSync(secret)).toBe(false);
    });

    it('run as root where the agent user exists, it runs again AS that user: its own profile is removed, and the process that did it was the agent’s', () => {
      fakeProfile('job A cookies');
      const done = cleanAsRoot((text) =>
        text
          .replace('AGENT=node', `AGENT=${AGENT}`)
          .replace('AGENT_HOME="$(getent passwd "$AGENT" | cut -d: -f6)"', `AGENT_HOME="${home}"`)
          .replace('STATE="$HOME_DIR/.universe"\n', 'STATE="$HOME_DIR/.universe"\nid -u > "$HOME_DIR/ran-as"\n'),
      );
      expect(done.out).toMatch(/cleaned=1/);
      expect(existsSync(profile())).toBe(false);
      expect(readFileSync(join(home, 'ran-as'), 'utf8').trim()).toBe(String(agentUid));
      expect(statSync(join(home, 'ran-as')).uid).toBe(agentUid);
    });

    it('run as the agent itself, a link in `.config` still gets nothing of root’s removed', () => {
      const secret = configLinkedToDecoy();
      const text = cleanText().replace('export PATH\n', `PATH="${shim}:$PATH"\nexport PATH\n`);
      const file = join(root, 'clean-agent');
      writeFileSync(file, text, { mode: 0o755 });
      const done = spawnSync('setpriv', [`--reuid=${agentUid}`, `--regid=${agentUid}`, '--clear-groups', '--', 'sh', file], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, HOME: home } });
      expect(done.stdout).not.toMatch(/cleaned=1/);
      expect(existsSync(secret)).toBe(true);
    });
  });

  describe('N27: the start-up runs between an interrupted restore and its retry', () => {
    /** The image's own start-up step that removes a marked profile (lib/agent37/image-files.ts, universe-up), taken from the image's text and run as the agent user, with the marks folder where this test keeps it. */
    function startUp(plant?: (text: string) => string, lock?: { child: boolean; plantLock?: (text: string) => string }): { code: number; out: string } {
      const from = UNIVERSE_UP.indexOf("# A cleanup that could not remove the browser's profile left a mark");
      const to = UNIVERSE_UP.indexOf('# Starts a part unless it is running.');
      if (from < 0 || to < from) throw new Error('The start-up step was not found in the image');
      let step = UNIVERSE_UP.slice(from, to).replace('MARKS="/var/lib/universe/marks"', `MARKS="${marksFolder()}"`);
      if (plant) step = plant(step);
      // With `lock`, the image's own lock step runs first, exactly as the real start-up does it (the child yields to a fresh lock, an old one is taken over), so the ordering "lock, then cleanup" is the image's, not the test's
      // (CodeRabbit on #1025, d522f4b3 pass, N19)
      let locking = '';
      if (lock) {
        const lockFrom = UNIVERSE_UP.indexOf('LOCK="$STATE/up.lock"');
        const lockTo = UNIVERSE_UP.indexOf("trap 'rmdir \"$LOCK\" 2>/dev/null' EXIT");
        if (lockFrom < 0 || lockTo < lockFrom) throw new Error('The lock step was not found in the image');
        locking = UNIVERSE_UP.slice(lockFrom, lockTo + "trap 'rmdir \"$LOCK\" 2>/dev/null' EXIT".length);
        if (lock.plantLock) {
          const planted = lock.plantLock(locking);
          if (planted === locking) throw new Error('The planted bug did not change the lock step');
          locking = planted;
        }
        locking = `CHILD=${lock.child ? 1 : 0}\n${locking}\n`;
      }
      const script = `PATH="${shim}:$PATH"\nexport PATH\nHOME_DIR="${home}"\nSTATE="$HOME_DIR/.universe"\n${locking}${step}\necho start-up-ok\n`;
      const done = spawnSync('setpriv', [`--reuid=${agentUid}`, `--regid=${agentUid}`, '--clear-groups', '--', 'sh', '-c', script], { encoding: 'utf8', timeout: 60_000 });
      return { code: done.status ?? -1, out: done.stdout };
    }

    it('the image\'s own start-up has the WHOLE lock block before the cleanup block (the test assembles them in that order, so the order itself is checked on the image\'s text)', () => {
      const lockStart = UNIVERSE_UP.indexOf('LOCK="$STATE/up.lock"');
      const lockEnd = UNIVERSE_UP.indexOf("trap 'rmdir \"$LOCK\" 2>/dev/null' EXIT");
      const cleanup = UNIVERSE_UP.indexOf("# A cleanup that could not remove the browser's profile left a mark");
      expect(lockStart).toBeGreaterThanOrEqual(0);
      expect(lockEnd).toBeGreaterThan(lockStart);
      expect(cleanup).toBeGreaterThan(lockEnd);
    });

    it('after a restore killed right after the move, the start-up that runs before the retry finds no mark and leaves the profile alone; the profile is closed to the agent; the retry then hands it over', () => {
      fakeProfile('job A cookies');
      act('park', JOB_A, [JOB_A]);
      expect(act('restore', JOB_A, [JOB_A], KILL_AFTER_MOVE).out).not.toMatch(/restored=/);
      const seen = startUp();
      expect(seen.out).toMatch(/start-up-ok/);
      expect(seen.out).not.toMatch(/reason=/);
      // The profile that moved in survived the start-up, is root's, and the agent cannot read it
      expect(spawnSync('cat', [join(profile(), 'Default', 'Cookies')], { encoding: 'utf8' }).stdout).toBe('job A cookies');
      expect(statSync(profile()).uid).toBe(0);
      expect(agentCanRead(profile())).toBe(false);
      // The retry (after the killed try's lock is taken over) hands it over to the agent
      const lock = join(home, '.universe', 'up.lock');
      const old = new Date(Date.now() - 5 * 60_000);
      utimesSync(lock, old, old);
      expect(act('restore', JOB_A, [JOB_A]).out).toMatch(/restored=1/);
      expect(statSync(join(profile(), 'Default', 'Cookies')).uid).toBe(agentUid);
      expect(agentCanRead(profile())).toBe(true);
    });

    it('N19 (d522f4b3 pass): the start-up CHILD yields to the fresh lock of the interrupted restore and cleans nothing; once that lock is old, the start-up takes it over and only then runs its dirty-mark step', () => {
      fakeProfile('job A cookies');
      act('park', JOB_A, [JOB_A]);
      expect(act('restore', JOB_A, [JOB_A], KILL_AFTER_MOVE).out).not.toMatch(/restored=/);
      const lock = join(home, '.universe', 'up.lock');
      expect(existsSync(lock)).toBe(true);
      // The supervisor's child run meets the fresh lock: it leaves at once, before any cleanup (no "start-up-ok", no mark read), and the lock is not its to remove
      const yielded = startUp(undefined, { child: true });
      expect(yielded.code).toBe(0);
      expect(yielded.out).not.toMatch(/start-up-ok/);
      expect(existsSync(lock)).toBe(true);
      expect(statSync(profile()).uid).toBe(0);
      expect(agentCanRead(profile())).toBe(false);
      // The killed try's lock is old now: the start-up takes it over, and only then runs its step (no mark, so the profile stays), and lets the lock go when it ends
      const old = new Date(Date.now() - 5 * 60_000);
      utimesSync(lock, old, old);
      const took = startUp(undefined, { child: true });
      expect(took.out).toMatch(/start-up-ok/);
      expect(took.out).not.toMatch(/reason=/);
      expect(existsSync(lock)).toBe(false);
      expect(spawnSync('cat', [join(profile(), 'Default', 'Cookies')], { encoding: 'utf8' }).stdout).toBe('job A cookies');
      expect(agentCanRead(profile())).toBe(false);
      expect(act('restore', JOB_A, [JOB_A]).out).toMatch(/restored=1/);
      expect(agentCanRead(profile())).toBe(true);
    });

    it('planted bug: a start-up that skips the lock goes straight to its cleanup beside the restore that holds it', () => {
      fakeProfile('job A cookies');
      act('park', JOB_A, [JOB_A]);
      act('restore', JOB_A, [JOB_A], KILL_AFTER_MOVE);
      const planted = startUp(undefined, { child: true, plantLock: (text) => text.replace('until mkdir "$LOCK" 2>/dev/null; do', 'until true; do') });
      expect(planted.out).toMatch(/start-up-ok/);
    });

    it('planted bug: with the mark kept (the old order) the same start-up finds it and refuses to run on that profile', () => {
      fakeProfile('job A cookies');
      act('park', JOB_A, [JOB_A]);
      act('restore', JOB_A, [JOB_A], (script) => KILL_AFTER_MOVE(script.replace('    unmark || { say "0 reason=mark"; exit 1; }\n    # The move is noted BEFORE', '    # The move is noted BEFORE')));
      const seen = startUp();
      expect(seen.out).toMatch(/ready=0 reason=profile_not_cleared/);
      expect(seen.out).not.toMatch(/start-up-ok/);
    });
  });
});
