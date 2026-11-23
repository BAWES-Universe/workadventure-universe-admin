/**
 * The command that puts a paused job's browser sign-ins away, brings them back, and throws them away (lib/computer-browser-profile-script.ts),
 * run for real: as root, in a folder of its own, against a real Chromium (the one Playwright brings) and a real unprivileged user standing in
 * for the agent. What it must prove, above all: one job's sign-ins can never be read by, or restored into, another job.
 *
 * Needs root, python3, setpriv and Chromium; skipped where any is missing. Some tests run the command with a bug planted on purpose
 * ("planted-bug checks"): each shows the check above it would catch that bug, so a check that passes for the wrong reason is seen.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, chownSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { MACHINE_PLACES, isSafeJobId, readSignInsAnswer, signInsCommand, type SignInsAction, type SignInsPlaces } from '@/lib/computer-browser-profile-script';
import { CLEAN_CLAIM_STALE_MS, MACHINE_COMMAND_MS } from '@/lib/computer-values';

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

const profile = () => join(home, '.config', 'universe-chromium');
const parked = (job: string) => join(places.parkRoot, job);

function freePort(): number {
  const found = spawnSync('python3', ['-c', 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])'], { encoding: 'utf8' });
  return Number(found.stdout.trim());
}

/** Runs the command as root (what Orbit does through the provider), with an optional bug planted in it. */
function act(action: SignInsAction, job: string, keep: string[] = [], plant?: (script: string) => string, keepHours = 24): { code: number; out: string } {
  let script = signInsCommand(action, job, keep, keepHours, places);
  if (plant) {
    const planted = plant(script);
    if (planted === script) throw new Error('The planted bug did not change the command');
    script = planted;
  }
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
  if (!root) return;
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
  places = {
    parkRoot: join(root, 'var', 'lib', 'universe', 'signins'),
    user: AGENT,
    home,
    devtools: `127.0.0.1:${port}`,
    // Only the real-browser tests start one (below); the file tests have none to start
    start: 'true',
    answerWait: 1,
  };
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
    expect(existsSync(join(home, '.universe', 'profile.dirty'))).toBe(false);
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
    expect(existsSync(join(home, '.universe', 'profile.dirty'))).toBe(false);
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
    expect(existsSync(join(home, '.universe', 'profile.dirty'))).toBe(true);
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
    expect(existsSync(join(home, '.universe', 'profile.dirty'))).toBe(false);
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
    // The agent owns its own state folder, so it can put a link where the mark goes. Every action that marks is tried
    for (const action of ['park', 'restore', 'clear'] as const) {
      rmSync(join(home, '.universe', 'profile.dirty'), { recursive: true, force: true });
      symlinkSync(rootFile, join(home, '.universe', 'profile.dirty'));
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
    symlinkSync(rootFile, join(home, '.universe', 'profile.dirty'));
    act('park', JOB_A, [JOB_A], (script) =>
      script.replace('  rm -rf "$STATE/profile.dirty" 2>/dev/null\n  mkdir "$STATE/profile.dirty" 2>/dev/null || return 1', '  : > "$STATE/profile.dirty" || return 1'),
    );
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
    act('restore', JOB_A, [JOB_A], (script) => script.replace('  replay || { say "0 reason=no_answer"; exit 1; }\n  rm -rf "$JOBDIR" "$JOBDIR.new"\n  if [ "$had" = "1" ]', '  replay\n  rm -rf "$JOBDIR" "$JOBDIR.new"\n  if [ "$had" = "1" ]'));
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
    places.start = `if [ -e "$STATE/profile.dirty" ]; then echo set > "${seen}"; rm -rf "$PROFILE"; else echo clear > "${seen}"; fi`;
    return seen;
  }
  const markPath = () => join(home, '.universe', 'profile.dirty');
  /** A command that was killed after the move: the mark is still there and the lock is left behind (the command lock is taken over after a minute). */
  function leaveKilledTryBehind(): void {
    mkdirSync(markPath());
    const lock = join(home, '.universe', 'up.lock');
    mkdirSync(lock);
    const old = new Date(Date.now() - 5 * 60_000);
    utimesSync(lock, old, old);
  }

  it('CodeRabbit A3: once the profile is moved in, a failed hand-back clears the dirty mark under the lock before the lock is let go, and the next try finishes', () => {
    fakeProfile('job A cookies');
    act('park', JOB_A, [JOB_A]);
    const failed = act('restore', JOB_A, [JOB_A], (script) => script.replace('    chown -R -h "$NODE_USER": "$PROFILE" || { say "0 reason=move"; exit 1; }\n    had=1', '    false || { say "0 reason=move"; exit 1; }\n    had=1'));
    expect(failed.code).toBe(1);
    expect(failed.out).toMatch(/restored=0 reason=move/);
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
    act('restore', JOB_A, [JOB_A], (script) =>
      script.replace('    unmark || { say "0 reason=mark"; exit 1; }\n    chown -R -h "$NODE_USER": "$PROFILE" || { say "0 reason=move"; exit 1; }\n    had=1', '    false || { say "0 reason=move"; exit 1; }\n    had=1'),
    );
    expect(existsSync(markPath())).toBe(true);
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
    act('restore', JOB_A, [JOB_A], (script) => script.replace(MOVED_NOTE, '  if [ -d "$JOBDIR" ]; then printf \'\' > "$JOBDIR/moved" 2>/dev/null; fi\n'));
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

  /** The pages the browser has open at one address, once the browser has had a moment to show what was opened (at least one is waited for only when `wait` is set). */
  async function pagesAt(live: CdpBrowser, url: string, wait = true): Promise<CdpPage[]> {
    const context = live.contexts()[0];
    for (let i = 0; wait && i < 50 && !context.pages().some((one) => one.url() === url); i++) await new Promise((resolve) => setTimeout(resolve, 100));
    return context.pages().filter((one) => one.url() === url);
  }

  function startBrowser() {
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
    expect(await pagesAt(again, `${site}/visa-form`)).toHaveLength(1);
    await again.close().catch(() => undefined);
    // The retry (the move is already noted, so only the replay is done again): the page that already came back is not opened a second time
    const second = act('restore', JOB_A, [JOB_A]);
    expect(second.out).toMatch(/restored=0 reason=no_answer/);
    again = await browser();
    expect(await pagesAt(again, `${site}/visa-form`)).toHaveLength(1);
    await again.close().catch(() => undefined);
    // Once the session is whole the replay finishes and the saved session goes
    writeFileSync(join(parked(JOB_A), 'session.json'), JSON.stringify({ cookies: [good], pages: [`${site}/visa-form`] }));
    expect(act('restore', JOB_A, [JOB_A]).out).toMatch(/restored=1/);
    expect(existsSync(parked(JOB_A))).toBe(false);
    again = await browser();
    expect(await pagesAt(again, `${site}/visa-form`)).toHaveLength(1);
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
    expect(await pagesAt(live, `${site}/page-a`)).toHaveLength(1);
    expect(await pagesAt(live, `${site}/page-b`, false)).toHaveLength(0);
    await live.close().catch(() => undefined);
    // The retry cannot list the tabs: nothing is opened (page A is not opened a second time), the session is kept and the answer says incomplete
    const blind = act('restore', JOB_A, [JOB_A], (script) => script.replace('def open_tabs():\n', 'def open_tabs():\n    raise IOError("planted")\n'));
    expect(blind.out).toMatch(/restored=0 reason=no_answer/);
    expect(existsSync(join(parked(JOB_A), 'session.json'))).toBe(true);
    live = await browser();
    expect(await pagesAt(live, `${site}/page-a`)).toHaveLength(1);
    expect(await pagesAt(live, `${site}/page-b`, false)).toHaveLength(0);
    await live.close().catch(() => undefined);
    // The list works again: only the missing page is opened, and the replay finishes
    expect(act('restore', JOB_A, [JOB_A]).out).toMatch(/restored=1 cookies=1 pages=2/);
    expect(existsSync(parked(JOB_A))).toBe(false);
    live = await browser();
    expect(await pagesAt(live, `${site}/page-a`)).toHaveLength(1);
    expect(await pagesAt(live, `${site}/page-b`)).toHaveLength(1);
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
    expect(await pagesAt(live, `${site}/same`)).toHaveLength(2);
    expect(await pagesAt(live, `${site}/other`)).toHaveLength(1);
    await live.close().catch(() => undefined);
    // The retry finds all three there and opens none
    expect(act('restore', JOB_A, [JOB_A]).out).toMatch(/restored=0 reason=no_answer/);
    live = await browser();
    expect(await pagesAt(live, `${site}/same`)).toHaveLength(2);
    expect(await pagesAt(live, `${site}/other`)).toHaveLength(1);
    await live.close().catch(() => undefined);
    // With one of the two already open, a whole session opens only the missing one
    writeFileSync(join(parked(JOB_A), 'session.json'), JSON.stringify({ cookies: [good], pages: [`${site}/same`, `${site}/same`, `${site}/same`] }));
    expect(act('restore', JOB_A, [JOB_A]).out).toMatch(/restored=1 cookies=1 pages=3/);
    live = await browser();
    expect(await pagesAt(live, `${site}/same`)).toHaveLength(3);
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
