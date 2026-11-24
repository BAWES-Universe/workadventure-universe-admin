/** @jest-environment node */
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { imageFiles } from '@/lib/agent37/image-files';

/**
 * `universe-cold prepack` and `finish`, run for real (Opus on #1025, the root escalation through the folder the agent owns): prepack refuses links where its folders belong and prints a list of
 * what it copied; finish takes that list from Orbit (never from the home folder) and puts back only what matches it. The computer's file system is put under a folder of the test's own
 * (`UNIVERSE_COLD_FS`, honoured only together with `UNIVERSE_COLD_HOME`); `apt-mark` and `apt-get` are stand-ins on the path. Under that seam the scripts also run as an ordinary user (CI is not root):
 * everything that does not depend on root runs everywhere; the checks of owners, and the two races (a second user swaps folders while root runs), run only as root.
 */

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const run = describe;
const canDropRoot = isRoot && spawnSync('setpriv', ['--version']).status === 0;
const raceTest = canDropRoot ? it : it.skip;
const rootTest = isRoot ? it : it.skip;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'universe-cold-outside-'));
const script = path.join(dir, 'universe-cold');
const bin = path.join(dir, 'bin');
const aptLog = path.join(dir, 'apt.log');
let counter = 0;

beforeAll(() => {
  fs.writeFileSync(script, imageFiles().find((file) => file.name === 'universe-cold')!.text, { mode: 0o755 });
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'apt-mark'), '#!/bin/sh\nprintf "baseline1\\nffmpeg\\n"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'apt-get'), `#!/bin/sh\necho "$@" >> "${aptLog}"\nexit 0\n`, { mode: 0o755 });
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

interface World {
  home: string;
  fsA: string;
  fsB: string;
  state: string;
  outside: string;
}

/** A computer (file system A, with the file the image's marker is older than) and the home folder that goes with it; B is the new computer a restore puts things back on. */
function world(): World {
  const root = path.join(dir, `w${++counter}`);
  const home = path.join(root, 'home', 'node');
  const fsA = path.join(root, 'A');
  const fsB = path.join(root, 'B');
  for (const fs_ of [fsA, fsB]) {
    for (const folder of ['etc', 'opt', 'srv', 'root', 'var/www', 'var/spool/cron', 'usr/local/share/universe']) fs.mkdirSync(path.join(fs_, folder), { recursive: true });
    fs.writeFileSync(path.join(fs_, 'usr/local/share/universe/manual-packages.txt'), 'baseline1\n');
    fs.writeFileSync(path.join(fs_, 'usr/local/share/universe/built'), 'built');
    const old = new Date('2020-01-01T00:00:00Z');
    fs.utimesSync(path.join(fs_, 'usr/local/share/universe/built'), old, old);
  }
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(aptLog, '');
  // What the agent (or a package) changed after the image was built
  fs.writeFileSync(path.join(fsA, 'etc/app.conf'), 'conf');
  fs.chmodSync(path.join(fsA, 'etc/app.conf'), 0o640);
  fs.mkdirSync(path.join(fsA, 'opt/tool'), { recursive: true });
  fs.writeFileSync(path.join(fsA, 'opt/tool/run.sh'), '#!/bin/sh\necho hi\n');
  fs.chmodSync(path.join(fsA, 'opt/tool/run.sh'), 0o755);
  fs.symlinkSync('run.sh', path.join(fsA, 'opt/tool/latest'));
  return { home, fsA, fsB, state: path.join(home, '.universe'), outside: path.join(home, '.universe', 'outside') };
}

function cold(w: World, command: 'prepack' | 'finish', fsRoot: string, input = ''): { stdout: string; status: number | null } {
  const done = spawnSync('python3', [script, command], {
    input,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, UNIVERSE_COLD_HOME: w.home, UNIVERSE_COLD_FS: fsRoot },
  });
  return { stdout: done.stdout, status: done.status };
}

const printed = (stdout: string): Record<string, unknown> => JSON.parse(/(^|\n)prepack=(\{[^\n]*\})/.exec(stdout)![2]);
const finishWith = (w: World, manifest: unknown) => cold(w, 'finish', w.fsB, JSON.stringify({ outside: manifest }));
const aptCalls = () => fs.readFileSync(aptLog, 'utf8').trim().split('\n').filter(Boolean);
const writtenOnB = (w: World) => fs.readdirSync(w.fsB, { recursive: true, withFileTypes: true }).filter((entry) => !entry.isDirectory()).map((entry) => path.relative(w.fsB, path.join(entry.parentPath, entry.name))).filter((name) => !name.startsWith('usr/local/share/universe'));

type Manifest = { files: Array<[string, string, number, number, string]>; packages: string[] };

function packed(w: World): Manifest {
  const done = cold(w, 'prepack', w.fsA);
  const out = printed(done.stdout);
  expect(out.blocked).toBeNull();
  expect(done.status).toBe(0);
  return out.manifest as Manifest;
}

run('universe-cold: prepack prints what it copied, finish puts back only that (Opus on #1025)', () => {
  it('a clean round trip: files with their mode, the link and the software, from the list Orbit holds', () => {
    const w = world();
    fs.writeFileSync(path.join(w.fsA, 'opt/tool/suid'), 'x');
    fs.chmodSync(path.join(w.fsA, 'opt/tool/suid'), 0o4755);
    const manifest = packed(w);
    expect(manifest.packages).toEqual(['ffmpeg']);
    const byPath = new Map(manifest.files.map((entry) => [entry[1], entry]));
    expect(byPath.get('/etc/app.conf')).toEqual(['f', '/etc/app.conf', 4, 0o640, sha('conf')]);
    expect(byPath.get('/opt/tool/latest')).toEqual(['l', '/opt/tool/latest', 0, 0, 'run.sh']);
    expect(manifest.files.map((entry) => entry[1]).sort()).toEqual(['/etc/app.conf', '/opt/tool/latest', '/opt/tool/run.sh', '/opt/tool/suid']);
    const done = finishWith(w, manifest);
    expect(done.stdout).toMatch(/finished=1 files=4 packages=1\n/);
    expect(done.stdout).not.toMatch(/unverified/);
    expect(fs.readFileSync(path.join(w.fsB, 'etc/app.conf'), 'utf8')).toBe('conf');
    expect(fs.statSync(path.join(w.fsB, 'etc/app.conf')).mode & 0o7777).toBe(0o640);
    expect(fs.statSync(path.join(w.fsB, 'opt/tool/run.sh')).mode & 0o7777).toBe(0o755);
    expect(fs.readlinkSync(path.join(w.fsB, 'opt/tool/latest'))).toBe('run.sh');
    if (isRoot) expect(fs.statSync(path.join(w.fsB, 'etc/app.conf')).uid).toBe(0);
    // The set-user-id bit is never put back
    expect(fs.statSync(path.join(w.fsB, 'opt/tool/suid')).mode & 0o7777).toBe(0o755);
    expect(aptCalls()).toEqual(['update -qq', 'install -y --no-install-recommends -qq ffmpeg']);
  });

  it('a list and a copy that both carry the set-user-id bit are installed WITHOUT it (Opus: finish never puts the bit back)', () => {
    const w = world();
    const manifest = packed(w);
    const entry = manifest.files.find((one) => one[1] === '/opt/tool/run.sh')!;
    // The copy in the home folder and the list both say 4755, as a list made before the owner change would
    fs.chmodSync(path.join(w.outside, 'opt/tool/run.sh'), 0o4755);
    entry[3] = 0o4755;
    expect(fs.statSync(path.join(w.outside, 'opt/tool/run.sh')).mode & 0o7777).toBe(0o4755);
    const done = finishWith(w, manifest);
    expect(done.stdout).toMatch(/finished=1/);
    expect(fs.statSync(path.join(w.fsB, 'opt/tool/run.sh')).mode & 0o7777).toBe(0o755);
    // The same for the set-group-id bit
    fs.chmodSync(path.join(w.outside, 'opt/tool/run.sh'), 0o2755);
    entry[3] = 0o2755;
    expect(finishWith(w, manifest).stdout).toMatch(/finished=1/);
    expect(fs.statSync(path.join(w.fsB, 'opt/tool/run.sh')).mode & 0o7777).toBe(0o755);
  });

  it('a link where the folder belongs is refused, and nothing is removed or written through it', () => {
    const w = world();
    const evil = path.join(path.dirname(w.home), 'evil');
    fs.mkdirSync(path.join(evil, 'etc/sudoers.d'), { recursive: true });
    fs.writeFileSync(path.join(evil, 'etc/sudoers.d/x'), 'node ALL=(ALL) NOPASSWD:ALL\n');
    fs.mkdirSync(w.state, { recursive: true });
    fs.symlinkSync(evil, w.outside);
    const done = cold(w, 'prepack', w.fsA);
    expect(done.status).toBe(1);
    expect(printed(done.stdout)).toMatchObject({ blocked: 'outside_link', manifest: null });
    // The link and everything behind it are as they were (rmtree did not follow it, nothing was copied into it)
    expect(fs.lstatSync(w.outside).isSymbolicLink()).toBe(true);
    expect(fs.readdirSync(evil, { recursive: true }).sort()).toEqual(['etc', 'etc/sudoers.d', 'etc/sudoers.d/x']);
  });

  it('a link at the state folder, or a folder where the packages file belongs, is refused too', () => {
    const w = world();
    const elsewhere = path.join(path.dirname(w.home), 'elsewhere');
    fs.mkdirSync(elsewhere, { recursive: true });
    fs.symlinkSync(elsewhere, w.state);
    expect(printed(cold(w, 'prepack', w.fsA).stdout)).toMatchObject({ blocked: 'outside_link' });
    expect(fs.readdirSync(elsewhere)).toEqual([]);
    fs.rmSync(w.state);
    fs.mkdirSync(path.join(w.state, 'outside-packages.txt'), { recursive: true });
    expect(printed(cold(w, 'prepack', w.fsA).stdout)).toMatchObject({ blocked: 'outside_link' });
  });

  it('a link at the packages file is not written through (the file it points at keeps what it held)', () => {
    const w = world();
    const victim = path.join(path.dirname(w.home), 'victim.txt');
    fs.writeFileSync(victim, 'keep me');
    fs.mkdirSync(w.state, { recursive: true });
    fs.symlinkSync(victim, path.join(w.state, 'outside-packages.txt'));
    const done = cold(w, 'prepack', w.fsA);
    expect(printed(done.stdout)).toMatchObject({ blocked: 'outside_link' });
    expect(fs.readFileSync(victim, 'utf8')).toBe('keep me');
  });

  it('a file planted in the folder after prepack is refused: nothing at all is put back', () => {
    const w = world();
    const manifest = packed(w);
    fs.mkdirSync(path.join(w.outside, 'etc/sudoers.d'), { recursive: true });
    fs.writeFileSync(path.join(w.outside, 'etc/sudoers.d/x'), 'node ALL=(ALL) NOPASSWD:ALL\n');
    const done = finishWith(w, manifest);
    expect(done.status).toBe(1);
    expect(done.stdout).toContain('finished=0 reason=outside_tampered');
    expect(writtenOnB(w)).toEqual([]);
    expect(aptCalls()).toEqual([]);
  });

  it('a changed file is refused, and the files that were not changed are not put back either', () => {
    const w = world();
    const manifest = packed(w);
    fs.writeFileSync(path.join(w.outside, 'etc/app.conf'), 'cone');
    const done = finishWith(w, manifest);
    expect(done.stdout).toContain('finished=0 reason=outside_tampered');
    expect(writtenOnB(w)).toEqual([]);
    // The same size and mode with other bytes is a change too (the hash is read, not only the size)
    fs.writeFileSync(path.join(w.outside, 'etc/app.conf'), 'conf');
    fs.writeFileSync(path.join(w.outside, 'opt/tool/run.sh'), '#!/bin/sh\necho ho\n');
    fs.chmodSync(path.join(w.outside, 'opt/tool/run.sh'), 0o755);
    expect(finishWith(w, manifest).stdout).toContain('outside_tampered');
    expect(writtenOnB(w)).toEqual([]);
  });

  it('a missing file is refused', () => {
    const w = world();
    const manifest = packed(w);
    fs.rmSync(path.join(w.outside, 'etc/app.conf'));
    expect(finishWith(w, manifest).stdout).toContain('outside_tampered');
    expect(writtenOnB(w)).toEqual([]);
  });

  it('the folder swapped for a link to a folder of planted files after prepack is refused, and so is a link inside it', () => {
    const w = world();
    const manifest = packed(w);
    const evil = path.join(path.dirname(w.home), 'evil');
    fs.mkdirSync(path.join(evil, 'etc/sudoers.d'), { recursive: true });
    fs.writeFileSync(path.join(evil, 'etc/sudoers.d/x'), 'node ALL=(ALL) NOPASSWD:ALL\n');
    // A link inside the folder (a file's folder swapped for a link to the same content, or to another folder)
    const held = path.join(w.state, 'outside-held');
    fs.renameSync(path.join(w.outside, 'etc'), held);
    fs.symlinkSync(held, path.join(w.outside, 'etc'));
    expect(finishWith(w, manifest).stdout).toContain('outside_tampered');
    expect(writtenOnB(w)).toEqual([]);
    fs.rmSync(path.join(w.outside, 'etc'));
    fs.renameSync(held, path.join(w.outside, 'etc'));
    // The folder itself a link
    fs.renameSync(w.outside, path.join(w.state, 'outside-real'));
    fs.symlinkSync(evil, w.outside);
    expect(finishWith(w, manifest).stdout).toContain('outside_tampered');
    expect(writtenOnB(w)).toEqual([]);
    expect(fs.existsSync(path.join(w.fsB, 'etc/sudoers.d/x'))).toBe(false);
  });

  it('a packages file planted in the home folder installs nothing: only the packages in the list Orbit holds are installed', () => {
    const w = world();
    const manifest = packed(w);
    fs.writeFileSync(path.join(w.state, 'outside-packages.txt'), 'evilpkg\n');
    expect(finishWith(w, manifest).stdout).toMatch(/finished=1 files=\d+ packages=1/);
    expect(aptCalls()).toEqual(['update -qq', 'install -y --no-install-recommends -qq ffmpeg']);
  });

  it('a copy with no list (made before the list was kept) puts nothing back outside the home folder, installs nothing, and says so', () => {
    const w = world();
    packed(w);
    for (const input of [JSON.stringify({ outside: null }), JSON.stringify({}), '']) {
      const done = cold(w, 'finish', w.fsB, input);
      expect(done.stdout).toMatch(/finished=1 files=0 packages=0 outside=unverified\n/);
    }
    // Even with files in the folder (and a planted one): they are not trusted
    fs.mkdirSync(path.join(w.outside, 'etc/cron.d'), { recursive: true });
    fs.writeFileSync(path.join(w.outside, 'etc/cron.d/x'), '* * * * * root id\n');
    expect(cold(w, 'finish', w.fsB, JSON.stringify({ outside: null })).stdout).toContain('outside=unverified');
    expect(writtenOnB(w)).toEqual([]);
    expect(aptCalls()).toEqual([]);
  });

  it('a list that is not a list, or names a path outside the folders a copy may put back, is refused as a bad list', () => {
    const w = world();
    const manifest = packed(w);
    const bad: unknown[] = [
      'x',
      { files: 'x', packages: [] },
      { files: [['f', '/etc/../etc/shadow', 1, 0o600, sha('x')]], packages: [] },
      { files: [['f', '/home/node/x', 1, 0o600, sha('x')]], packages: [] },
      { files: [['f', '/etc/universe/x', 1, 0o600, sha('x')]], packages: [] },
      { files: [['f', '/etc/a', 1, 0o600, 'nothex']], packages: [] },
      { files: [manifest.files[0], manifest.files[0]], packages: [] },
      { files: [], packages: ['Bad Name!'] },
    ];
    for (const one of bad) expect(finishWith(w, one).stdout).toContain('finished=0 reason=outside_manifest');
    expect(cold(w, 'finish', w.fsB, '{not json').stdout).toContain('finished=0 reason=outside_manifest');
    expect(writtenOnB(w)).toEqual([]);
  });

  it('an existing link at a target is replaced, never written through', () => {
    const w = world();
    const manifest = packed(w);
    const victim = path.join(path.dirname(w.home), 'victim2.txt');
    fs.writeFileSync(victim, 'keep me');
    fs.symlinkSync(victim, path.join(w.fsB, 'etc/app.conf'));
    expect(finishWith(w, manifest).stdout).toMatch(/finished=1/);
    expect(fs.readFileSync(victim, 'utf8')).toBe('keep me');
    expect(fs.lstatSync(path.join(w.fsB, 'etc/app.conf')).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(w.fsB, 'etc/app.conf'), 'utf8')).toBe('conf');
  });

  it('a link in the home folder is never rewritten as root by the old-proxy clean-up', () => {
    const w = world();
    const victim = path.join(path.dirname(w.home), 'victim3.txt');
    fs.writeFileSync(victim, 'keep\nHTTP_PROXY=http://127.0.0.1:3128\n');
    fs.symlinkSync(victim, path.join(w.home, '.bashrc'));
    finishWith(w, null);
    expect(fs.readFileSync(victim, 'utf8')).toBe('keep\nHTTP_PROXY=http://127.0.0.1:3128\n');
  });

  it('a link in a folder above a target (one the agent can write) is refused: nothing is written through it (Opus: finish follows no link on the way)', () => {
    const w = world();
    fs.mkdirSync(path.join(w.fsA, 'var/www/sub'), { recursive: true });
    fs.writeFileSync(path.join(w.fsA, 'var/www/sub/evil'), '* * * * * root id\n');
    const manifest = packed(w);
    expect(manifest.files.map((entry) => entry[1])).toContain('/var/www/sub/evil');
    // On the new computer, before finish, the agent links the folder to one it must not reach
    fs.mkdirSync(path.join(w.fsB, 'etc/cron.d'), { recursive: true });
    fs.symlinkSync(path.join(w.fsB, 'etc/cron.d'), path.join(w.fsB, 'var/www/sub'));
    const done = finishWith(w, manifest);
    expect(done.status).toBe(1);
    expect(done.stdout).toContain('finished=0 reason=outside_tampered');
    expect(fs.readdirSync(path.join(w.fsB, 'etc/cron.d'))).toEqual([]);
    expect(aptCalls()).toEqual([]);
    // The same list with no link on the way is put back
    fs.rmSync(path.join(w.fsB, 'var/www/sub'));
    expect(finishWith(w, manifest).stdout).toMatch(/finished=1/);
    expect(fs.readFileSync(path.join(w.fsB, 'var/www/sub/evil'), 'utf8')).toBe('* * * * * root id\n');
  });

  it('a folder that is a link on the old computer is not walked or copied through: nothing behind it reaches the copy', () => {
    const w = world();
    const secret = path.join(path.dirname(w.home), 'secret');
    fs.mkdirSync(secret, { recursive: true });
    fs.writeFileSync(path.join(secret, 'key'), 'not for the agent');
    fs.mkdirSync(path.join(w.fsA, 'var/www/sub'), { recursive: true });
    fs.writeFileSync(path.join(w.fsA, 'var/www/sub/file'), 'x');
    fs.rmSync(path.join(w.fsA, 'var/www/sub'), { recursive: true });
    fs.symlinkSync(secret, path.join(w.fsA, 'var/www/sub'));
    const out = printed(cold(w, 'prepack', w.fsA).stdout);
    expect(out.blocked).toBeNull();
    expect(JSON.stringify(out.manifest)).not.toContain('not for the agent');
    expect(fs.existsSync(path.join(w.outside, 'var/www/sub/key'))).toBe(false);
  });

  it('the old-proxy clean-up works inside the test file system (never on the real /etc): a listed file is rewritten there, the settings files and the old files are removed there', () => {
    const w = world();
    const manifest = packed(w);
    fs.mkdirSync(path.join(w.fsB, 'etc/apt/apt.conf.d'), { recursive: true });
    fs.writeFileSync(path.join(w.fsB, 'etc/apt/apt.conf.d/99universe-egress'), 'x');
    fs.writeFileSync(path.join(w.fsB, 'etc/environment'), 'KEEP=1\nHTTP_PROXY=http://127.0.0.1:3128\n');
    expect(finishWith(w, manifest).stdout).toMatch(/finished=1/);
    expect(fs.existsSync(path.join(w.fsB, 'etc/apt/apt.conf.d/99universe-egress'))).toBe(false);
    expect(fs.readFileSync(path.join(w.fsB, 'etc/environment'), 'utf8')).toBe('KEEP=1\n');
  });

  it('a link to a folder above a file in the home folder is not rewritten by the old-proxy clean-up either', () => {
    const w = world();
    const elsewhere = path.join(path.dirname(w.home), 'elsewhere4');
    fs.mkdirSync(elsewhere, { recursive: true });
    fs.writeFileSync(path.join(elsewhere, 'pip.conf'), 'HTTP_PROXY=http://127.0.0.1:3128\n');
    fs.symlinkSync(elsewhere, path.join(w.home, '.pip'));
    finishWith(w, null);
    expect(fs.readFileSync(path.join(elsewhere, 'pip.conf'), 'utf8')).toBe('HTTP_PROXY=http://127.0.0.1:3128\n');
  });

  raceTest('the agent swaps the folder for a link while prepack runs: root writes only into the folder it holds open, never through the link (Opus fix 1, a second user does the swap)', () => {
    const w = world();
    const root = path.dirname(path.dirname(w.home));
    // Many files from the image, so the walk takes a moment; then the marker is made newer, so none of them counts as new
    for (let d = 0; d < 100; d++) {
      fs.mkdirSync(path.join(w.fsA, 'opt/bulk', String(d)), { recursive: true });
      for (let f = 0; f < 200; f++) fs.writeFileSync(path.join(w.fsA, 'opt/bulk', String(d), String(f)), '');
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1100);
    const now = new Date();
    fs.utimesSync(path.join(w.fsA, 'usr/local/share/universe/built'), now, now);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1100);
    // The one file that is new, in a folder the agent owns; and the places the swapped link would lead to
    fs.writeFileSync(path.join(w.fsA, 'var/www/evil'), '* * * * * root id\n');
    const victim = path.join(root, `victim-${counter}`);
    const trap = path.join(w.home, 'trap');
    fs.mkdirSync(victim, { recursive: true });
    fs.mkdirSync(path.join(trap, 'var'), { recursive: true });
    fs.mkdirSync(w.state, { recursive: true });
    fs.symlinkSync(victim, path.join(trap, 'var/www'));
    for (const folder of [dir, root, path.dirname(w.home), w.home]) fs.chmodSync(folder, 0o755);
    spawnSync('chown', ['-R', '1000:1000', w.home]);
    const actor = spawn('setpriv', ['--reuid=1000', '--regid=1000', '--clear-groups', 'bash', '-c', `cd "${w.state}" && while :; do if [ -d outside ] && [ ! -L outside ]; then mv outside outside.x && ln -s "${trap}" outside; break; fi; done`], { stdio: 'ignore' });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
    const done = cold(w, 'prepack', w.fsA);
    actor.kill();
    // The swap happened (the test is not empty), and the root-owned folder the link led to was never written into
    expect(fs.lstatSync(w.outside).isSymbolicLink()).toBe(true);
    expect(fs.readdirSync(victim)).toEqual([]);
    expect(printed(done.stdout).blocked).toBeNull();
    expect(fs.readFileSync(path.join(w.state, 'outside.x/var/www/evil'), 'utf8')).toBe('* * * * * root id\n');
  }, 120_000);

  rootTest('the state folder prepack makes is handed over through its descriptor: a link swapped in right after it was made is not followed (a root file is not given to the agent) (Opus 2nd look, 1)', () => {
    const w = world();
    const victim = path.join(path.dirname(w.home), `shadow-${counter}`);
    fs.writeFileSync(victim, 'root:x:');
    fs.chmodSync(victim, 0o600);
    // The agent wins the race for certain here: right after the script makes the state folder, the name becomes a link to a root file
    const harness = path.join(dir, 'state-race.py');
    fs.writeFileSync(harness, [
      'import importlib.machinery, importlib.util, os, sys',
      'loader = importlib.machinery.SourceFileLoader("cold", sys.argv[1])',
      'spec = importlib.util.spec_from_loader("cold", loader)',
      'mod = importlib.util.module_from_spec(spec)',
      'loader.exec_module(mod)',
      'real_mkdir = os.mkdir',
      'def swapped(target, *args, **kwargs):',
      '    real_mkdir(target, *args, **kwargs)',
      '    if target == mod.STATE and "dir_fd" not in kwargs:',
      '        os.rmdir(target)',
      '        os.symlink(sys.argv[2], target)',
      'os.mkdir = swapped',
      'sys.exit(mod.prepack())',
    ].join('\n'));
    const done = spawnSync('python3', [harness, script, victim], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, UNIVERSE_COLD_HOME: w.home, UNIVERSE_COLD_FS: w.fsA } });
    expect(fs.lstatSync(w.state).isSymbolicLink()).toBe(true);
    expect(printed(done.stdout)).toMatchObject({ blocked: 'outside_link' });
    expect(fs.statSync(victim).uid).toBe(0);
    expect(fs.readFileSync(victim, 'utf8')).toBe('root:x:');
  });

  it('a hard link planted at the packages file is unlinked, never written through: the file it pointed at keeps its bytes and its owner (Opus 2nd look, 3)', () => {
    const w = world();
    const victim = path.join(path.dirname(w.home), `passwd-${counter}`);
    fs.writeFileSync(victim, 'root:x:0:0\n');
    fs.mkdirSync(w.state, { recursive: true });
    fs.linkSync(victim, path.join(w.state, 'outside-packages.txt'));
    const before = fs.statSync(victim);
    const done = cold(w, 'prepack', w.fsA);
    expect(done.status).toBe(0);
    expect(printed(done.stdout)).toMatchObject({ blocked: null });
    expect(fs.readFileSync(victim, 'utf8')).toBe('root:x:0:0\n');
    expect(fs.statSync(victim).uid).toBe(before.uid);
    expect(fs.statSync(victim).nlink).toBe(1);
    const made = path.join(w.state, 'outside-packages.txt');
    expect(fs.statSync(made).nlink).toBe(1);
    expect(fs.readFileSync(made, 'utf8')).toBe('ffmpeg\n');
  });

  rootTest('the links prepack copies are not handed to the agent by name (they stay the root-owned links they were made as); the files and folders are, through descriptors (Opus 2nd look, 3)', () => {
    const w = world();
    packed(w);
    expect(fs.lstatSync(path.join(w.outside, 'opt/tool/latest')).uid).toBe(0);
    expect(fs.statSync(path.join(w.outside, 'etc/app.conf')).uid).not.toBe(0);
    expect(fs.statSync(path.join(w.outside, 'opt/tool')).uid).not.toBe(0);
    expect(fs.statSync(w.outside).uid).not.toBe(0);
  });

  it('finish never reads or rewrites a settings file in the home folder (it runs as root and those are the agent\'s): restore, which runs as the computer\'s own user, cleans them (Opus 2nd look, 2)', async () => {
    const w = world();
    const manifest = packed(w);
    const legacy = 'KEEP=1\nHTTP_PROXY=http://127.0.0.1:3128\n';
    fs.writeFileSync(path.join(w.home, '.bashrc'), legacy);
    fs.writeFileSync(path.join(w.fsB, 'etc/environment'), legacy);
    expect(finishWith(w, manifest).stdout).toMatch(/finished=1/);
    // The computer's own file is cleaned by finish; the agent's is not touched by it
    expect(fs.readFileSync(path.join(w.fsB, 'etc/environment'), 'utf8')).toBe('KEEP=1\n');
    expect(fs.readFileSync(path.join(w.home, '.bashrc'), 'utf8')).toBe(legacy);
    // restore, with a copy served from here
    const source = path.join(dir, `copy-${counter}`);
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, '.bashrc'), legacy);
    fs.writeFileSync(path.join(source, '.profile'), 'export A=1\n');
    const archive = spawnSync('tar', ['-czf', '-', '-C', source, '.'], { maxBuffer: 1 << 26 }).stdout;
    const server = http.createServer((_request, response) => response.end(archive));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/copy`;
      fs.rmSync(path.join(w.home, '.bashrc'));
      const out = await new Promise<string>((resolve) => {
        const child = spawn('python3', [script, 'restore'], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, UNIVERSE_COLD_HOME: w.home, UNIVERSE_COLD_FS: w.fsB } });
        let text = '';
        child.stdout.on('data', (chunk) => (text += chunk));
        child.on('close', () => resolve(text));
        child.stdin.end(JSON.stringify({ url, token: 't', sha256: createHash('sha256').update(archive).digest('hex') }));
      });
      expect(out).toMatch(/restored=1/);
      expect(fs.readFileSync(path.join(w.home, '.bashrc'), 'utf8')).toBe('KEEP=1\n');
      expect(fs.readFileSync(path.join(w.home, '.profile'), 'utf8')).toBe('export A=1\n');
    } finally {
      server.close();
    }
  });
});
