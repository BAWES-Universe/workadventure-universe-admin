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

const CHROME = ['/opt/pw-browsers/chromium-1243/chrome-linux64/chrome', process.env.CHROME_PATH ?? ''].find((path) => path && existsSync(path)) ?? '';
const have = (command: string) => spawnSync('sh', ['-c', `command -v ${command}`]).status === 0;
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const AGENT = 'nobody';
const agentUid = Number(spawnSync('id', ['-u', AGENT], { encoding: 'utf8' }).stdout.trim());
const usable = isRoot && have('python3') && have('setpriv') && Number.isFinite(agentUid) && !!CHROME;
const run = usable ? describe : describe.skip;
const runWithBrowser = usable ? describe : describe.skip;

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

function killBrowsers(): void {
  spawnSync('pkill', ['-x', 'chrome']);
  for (let i = 0; i < 50 && spawnSync('pgrep', ['-x', 'chrome']).status === 0; i++) spawnSync('sleep', ['0.1']);
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
  rmSync(root, { recursive: true, force: true });
});

describe('the command, as text', () => {
  it('names only job ids it can trust, and refuses anything else before a command is made', () => {
    expect(isSafeJobId('6f1c2a7e-8a43-4c4b-9a55-0d2c4f1d2e3f')).toBe(true);
    for (const bad of ['', '../x', 'a b', 'a;rm -rf /', '$(id)', 'a/b', '-rf', 'x'.repeat(65)]) expect(isSafeJobId(bad)).toBe(false);
    expect(() => signInsCommand('park', '../../etc', [], 24)).toThrow();
    // A job in the keep list that is not an id is left out, never written into the command
    expect(signInsCommand('drop', JOB_A, [JOB_B, '$(reboot)', JOB_A], 24)).toContain(`KEEP="${JOB_B}"`);
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
    expect(act('park', JOB_A, [JOB_A]).out).toMatch(/parked=1/);
    expect(existsSync(join(target, 'keep.txt'))).toBe(true);
    expect(existsSync(profile())).toBe(false);
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

  it('hands the profile back without following a link inside it to a file the agent does not own', () => {
    const rootFile = join(root, 'root-only');
    writeFileSync(rootFile, 'root');
    fakeProfile('job A cookies');
    symlinkSync(rootFile, join(profile(), 'Default', 'trap'));
    act('park', JOB_A, [JOB_A]);
    act('restore', JOB_A, [JOB_A]);
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
    places.start = `nohup setsid "${CHROME}" --headless=new --no-sandbox --disable-gpu --no-first-run --user-data-dir="$PROFILE" --remote-debugging-port=${port} --remote-debugging-address=127.0.0.1 about:blank >/dev/null 2>&1 &`;
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

  function startBrowser() {
    mkdirSync(join(home, '.config'), { recursive: true });
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
