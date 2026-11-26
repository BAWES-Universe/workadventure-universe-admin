/** @jest-environment node */
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { imageFiles } from '@/lib/agent37/image-files';
import { checkOutsideManifest } from '@/lib/computer-outside';

/**
 * `universe-cold prepack` and `finish`, run for real (Opus on #1025, the root escalation through the folder the agent owns): prepack refuses links where its folders belong and prints a list of
 * what it copied; finish takes that list from Orbit (never from the home folder) and puts back only what matches it. The computer's file system is put under a folder of the test's own
 * (`UNIVERSE_COLD_FS`, honoured only together with `UNIVERSE_COLD_HOME`); `apt-mark` and `apt-get` are stand-ins on the path. Under that seam the scripts also run as an ordinary user (CI is not root):
 * everything that does not depend on root runs everywhere; the checks of owners run only as root. The races are made at the exact moment (a patched call swaps the name), not by timing.
 */

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const run = describe;
const rootTest = isRoot ? it : it.skip;
const canDropRoot = isRoot && spawnSync('setpriv', ['--version']).status === 0;
const raceTest = canDropRoot ? it : it.skip;

// The test computers are made a moment before a finish runs: a finish does not wait for the margin after the unpack here (the one test of the wait turns it back on)
process.env.UNIVERSE_COLD_NO_WAIT = '1';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'universe-cold-outside-'));
const script = path.join(dir, 'universe-cold');
const bin = path.join(dir, 'bin');
const aptLog = path.join(dir, 'apt.log');
let counter = 0;

beforeAll(() => {
  fs.writeFileSync(script, imageFiles().find((file) => file.name === 'universe-cold')!.text, { mode: 0o755 });
  fs.mkdirSync(bin, { recursive: true });
  // EXTRA_PACKAGES makes the stand-in report that many more software names (for a computer with a very long list)
  fs.writeFileSync(path.join(bin, 'apt-mark'), '#!/bin/sh\nprintf "baseline1\\nffmpeg\\n"\ni=0\nwhile [ "$i" -lt "${EXTRA_PACKAGES:-0}" ]; do echo "extra$i"; i=$((i+1)); done\n', { mode: 0o755 });
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

function cold(w: World, command: string, fsRoot: string, input = '', extra: Record<string, string> = {}): { stdout: string; status: number | null } {
  const done = spawnSync('python3', [script, ...command.split(' ')], {
    input,
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 1 << 28,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, UNIVERSE_COLD_HOME: w.home, UNIVERSE_COLD_FS: fsRoot, ...extra },
  });
  return { stdout: done.stdout, status: done.status };
}

const printed = (stdout: string): Record<string, unknown> => JSON.parse(/(^|\n)prepack=(\{[^\n]*\})/.exec(stdout)![2]);
/** One finish. The copy folder is removed when a finish ends, and a retry restores the copy again from the archive: so each call here gets the copy as it was (and it is put back after, for a test that looks at the next step). */
const finishWith = (w: World, manifest: unknown) => {
  const keep = `${w.outside}.kept`;
  const there = fs.existsSync(w.outside) || fs.lstatSync(w.outside, { throwIfNoEntry: false }) !== undefined;
  if (there) fs.cpSync(w.outside, keep, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
  const done = cold(w, 'finish', w.fsB, JSON.stringify({ outside: manifest }));
  if (there) {
    fs.rmSync(w.outside, { recursive: true, force: true });
    fs.renameSync(keep, w.outside);
  }
  return done;
};
const aptCalls = () => fs.readFileSync(aptLog, 'utf8').trim().split('\n').filter(Boolean);
const writtenOnB = (w: World) => fs.readdirSync(w.fsB, { recursive: true, withFileTypes: true }).filter((entry) => !entry.isDirectory()).map((entry) => path.relative(w.fsB, path.join(entry.parentPath, entry.name))).filter((name) => !name.startsWith('usr/local/share/universe'));

type Manifest = { files: Array<[string, string, number, number, string]>; packages: string[]; dirs?: Array<[string, number]> };

/** What Orbit does with a prepack answer: the list is not in it, it is read back from the computer in slices (as the provider does) and checked against the length and SHA-256 the line gave. */
function listOf(w: World, out: Record<string, unknown>, piece = 200_000): Manifest {
  const bytes = out.manifest_bytes as number;
  let text = '';
  while (text.length < bytes) {
    const want = Math.min(piece, bytes - text.length);
    const got = cold(w, `list-piece ${text.length} ${want}`, w.fsA);
    const data = /(^|\n)listpiece=([^\n]*)\|end\|(\n|$)/.exec(got.stdout)?.[2];
    expect(data).toHaveLength(want);
    text += data;
  }
  expect(sha(text)).toBe(out.manifest_sha256);
  return JSON.parse(text) as Manifest;
}

function packed(w: World): Manifest {
  const done = cold(w, 'prepack', w.fsA);
  const out = printed(done.stdout);
  expect(out.blocked).toBeNull();
  expect(done.status).toBe(0);
  return listOf(w, out);
}

run('universe-cold: prepack prints what it copied, finish puts back only that (Opus on #1025)', () => {
  rootTest('puts the files back under folders that pass the set-group-id bit on to what is made in them (a Debian /usr/local and its folders are mode 2775): the private staging folder is made 0700 whatever its parent gives it (Seer on #1035)', () => {
    const w = world();
    fs.mkdirSync(path.join(w.fsA, 'srv/a/b'), { recursive: true });
    fs.writeFileSync(path.join(w.fsA, 'srv/a/b/file.txt'), 'deep');
    const manifest = packed(w);
    // The folders of the new computer the files go to (and the one folder finish makes below one of them) pass the bit on
    fs.mkdirSync(path.join(w.fsB, 'opt/tool'), { recursive: true });
    for (const folder of ['etc', 'opt', 'opt/tool', 'srv']) fs.chmodSync(path.join(w.fsB, folder), 0o2775);
    // The test's own file system must pass it on, or this test shows nothing
    const probe = path.join(w.fsB, 'etc/probe-folder');
    fs.mkdirSync(probe);
    expect(fs.statSync(probe).mode & 0o2000).toBe(0o2000);
    fs.rmdirSync(probe);
    const done = finishWith(w, manifest);
    expect(done.stdout).toMatch(/finished=1 files=\d+ packages=1 outside=applied\n/);
    expect(fs.readFileSync(path.join(w.fsB, 'etc/app.conf'), 'utf8')).toBe('conf');
    expect(fs.readFileSync(path.join(w.fsB, 'opt/tool/run.sh'), 'utf8')).toBe('#!/bin/sh\necho hi\n');
    expect(fs.readFileSync(path.join(w.fsB, 'srv/a/b/file.txt'), 'utf8')).toBe('deep');
    for (const folder of ['opt/tool', 'etc', 'srv']) expect(fs.readdirSync(path.join(w.fsB, folder)).filter((name) => name.startsWith('.uc-'))).toEqual([]);
  });

  it('folders ABOVE the roots (/var, /var/spool, /usr) are never listed, whatever their mode: only folders inside a root are, so the list always passes Orbit\'s check and the computer is packed, not refused (Seer on #1035)', () => {
    const w = world();
    // Files whose folders reach up through /var, /var/spool and /usr, with modes that are not the usual 0755
    fs.mkdirSync(path.join(w.fsA, 'var/www/site/private'), { recursive: true });
    fs.writeFileSync(path.join(w.fsA, 'var/www/site/private/index.html'), 'page');
    fs.writeFileSync(path.join(w.fsA, 'var/spool/cron/crontabs-root'), '* * * * * true\n');
    fs.mkdirSync(path.join(w.fsA, 'usr/local/lib/own'), { recursive: true });
    fs.writeFileSync(path.join(w.fsA, 'usr/local/lib/own/tool.so'), 'lib');
    // A folder inside a root that is odd still is listed (it is made again as it was)
    fs.chmodSync(path.join(w.fsA, 'var/www/site/private'), 0o700);
    fs.chmodSync(path.join(w.fsA, 'usr/local/lib/own'), 0o750);
    for (const folder of ['var/spool', 'var', 'usr']) fs.chmodSync(path.join(w.fsA, folder), 0o750);
    const manifest = packed(w);
    expect(manifest.files.map((entry) => entry[1]).sort()).toEqual(expect.arrayContaining(['/var/www/site/private/index.html', '/var/spool/cron/crontabs-root', '/usr/local/lib/own/tool.so']));
    const roots = ['/etc', '/opt', '/srv', '/usr/local', '/root', '/var/www', '/var/spool/cron'];
    const listed = (manifest.dirs ?? []).map((entry) => entry[0]);
    expect(listed).toEqual(expect.arrayContaining(['/var/www/site/private', '/usr/local/lib/own']));
    for (const folder of listed) expect(roots.some((root) => folder.startsWith(`${root}/`))).toBe(true);
    for (const above of ['/var', '/var/spool', '/usr', '/var/www', '/usr/local']) expect(listed).not.toContain(above);
    // What Orbit does with the list: it is accepted
    expect(checkOutsideManifest(manifest)).toMatchObject({ ok: true });
  });

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
    expect(done.stdout).toMatch(/finished=1 files=4 packages=1 outside=applied\n/);
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
    expect(printed(done.stdout)).toMatchObject({ blocked: 'outside_link', manifest_bytes: null, manifest_sha256: null });
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
    const list = listOf(w, out);
    expect(JSON.stringify(list)).not.toContain('not for the agent');
    // The link itself is one of the computer's files (a changed link is put back as a link); what it points at is never walked, so nothing behind it is in the copy or the list
    expect(list.files.find((entry) => entry[1] === '/var/www/sub')).toEqual(['l', '/var/www/sub', 0, 0, secret]);
    expect(list.files.some((entry) => entry[1].startsWith('/var/www/sub/'))).toBe(false);
    expect(fs.lstatSync(path.join(w.outside, 'var/www/sub')).isSymbolicLink()).toBe(true);
    expect(fs.readdirSync(path.join(w.outside, 'var/www'))).toEqual(['sub']);
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

run('universe-cold: a long list travels in pieces (Sentry on #1035: one command line and one answer are both capped)', () => {
  /** Many files with long names, so the list is far over what one command (about 128 KiB) or one printed line can carry. */
  function crowded(w: World, count: number) {
    const folder = path.join(w.fsA, 'opt/many');
    fs.mkdirSync(folder, { recursive: true });
    for (let i = 0; i < count; i++) fs.writeFileSync(path.join(folder, `file-${String(i).padStart(5, '0')}-${'x'.repeat(120)}.dat`), `data ${i}`);
  }

  /** What Orbit does to send a list: slices of at most `piece` characters, each its own command, the way the provider sends them. */
  function sendInPieces(w: World, text: string, piece = 48 * 1024) {
    for (let at = 0; at < text.length; at += piece) {
      const part = text.slice(at, at + piece);
      const put = cold(w, `list-put ${at}`, w.fsB, `${part}\n`);
      expect(put.stdout).toBe(`listput=1 size=${at + part.length}\n`);
    }
  }

  const ascii = (value: unknown) => JSON.stringify(value);

  it('prepack prints a short line, never the list: the list is a root-only file the caller reads back in slices and checks', () => {
    const w = world();
    crowded(w, 1200);
    const done = cold(w, 'prepack', w.fsA);
    expect(done.status).toBe(0);
    // However many files there are, the line stays small (Agent37 cuts what is printed over 512 KB)
    expect(done.stdout.length).toBeLessThan(2000);
    const out = printed(done.stdout);
    expect(out).not.toHaveProperty('manifest');
    expect(out.manifest_bytes as number).toBeGreaterThan(160_000);
    const file = path.join(w.fsA, 'usr/local/share/universe/cold/list.json');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    // Read back in slices smaller than the list, every one exactly as long as asked
    const list = listOf(w, out, 50_000);
    expect(list.files).toHaveLength(1200 + 3);
    // The list file is never part of what a later prepack copies
    expect(list.files.map((entry) => entry[1]).some((name) => name.includes('/usr/local/share/universe/'))).toBe(false);
  });

  it('a list too long for one command is sent in pieces and put back whole, and the file it travelled in is gone afterwards', () => {
    const w = world();
    crowded(w, 1200);
    const list = packed(w);
    const text = ascii(list);
    expect(text.length).toBeGreaterThan(160_000);
    sendInPieces(w, text);
    const done = cold(w, 'finish', w.fsB, JSON.stringify({ outside_file: { bytes: text.length, sha256: sha(text) } }));
    expect(done.stdout).toMatch(/finished=1 files=1203 packages=1 outside=applied\n/);
    expect(fs.readFileSync(path.join(w.fsB, `opt/many/file-01199-${'x'.repeat(120)}.dat`), 'utf8')).toBe('data 1199');
    expect(fs.existsSync(path.join(w.fsB, 'usr/local/share/universe/cold/list.json'))).toBe(false);
  });

  it('a piece that arrives twice, out of order or skipping ahead is refused, and the transfer starts again from the first piece', () => {
    const w = world();
    const text = ascii({ files: [], packages: [] });
    expect(cold(w, 'list-put 0', w.fsB, `${text.slice(0, 5)}\n`).stdout).toBe('listput=1 size=5\n');
    expect(cold(w, 'list-put 0', w.fsB, `${text.slice(0, 5)}\n`).stdout).toBe('listput=1 size=5\n');
    expect(cold(w, 'list-put 3', w.fsB, `${text.slice(3)}\n`).stdout).toMatch(/listput=0 reason=out_of_order/);
    expect(cold(w, 'list-put 9', w.fsB, 'x\n').stdout).toMatch(/listput=0 reason=out_of_order/);
    expect(cold(w, 'list-put 5', w.fsB, `${text.slice(5)}\n`).stdout).toBe(`listput=1 size=${text.length}\n`);
    expect(finishFrom(w, text).stdout).toMatch(/finished=1/);
    // A line break inside a piece, or a character that is not plain ASCII, is not a piece
    expect(cold(w, 'list-put 0', w.fsB, 'a\nb\n').stdout).toMatch(/listput=0 reason=usage/);
    expect(cold(w, 'list-put 0', w.fsB, 'caf\u00e9\n').stdout).toMatch(/listput=0 reason=usage/);
  });

  it('slices that arrive together at the same offset: exactly one is taken, the others are refused, and the file holds only the one that was taken', async () => {
    const w = world();
    const file = path.join(w.fsB, 'usr/local/share/universe/cold/list.json');
    for (let round = 0; round < 6; round++) {
      expect(cold(w, 'list-put 0', w.fsB, 'aaaa\n').stdout).toBe('listput=1 size=4\n');
      const answers = await Promise.all(Array.from({ length: 10 }, (_, i) => new Promise<string>((resolve) => {
        const child = spawn('python3', [script, 'list-put', '4'], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, UNIVERSE_COLD_HOME: w.home, UNIVERSE_COLD_FS: w.fsB } });
        let out = '';
        child.stdout.on('data', (chunk) => (out += chunk));
        child.on('close', () => resolve(out));
        child.stdin.end(`${String(i).repeat(50)}\n`);
      })));
      const taken = answers.filter((answer) => answer === 'listput=1 size=54\n');
      expect(taken).toHaveLength(1);
      expect(answers.filter((answer) => /listput=0 reason=out_of_order/.test(answer))).toHaveLength(9);
      const held = fs.readFileSync(file, 'utf8');
      expect(held).toHaveLength(54);
      expect(/^aaaa(\d)\1{49}$/.test(held)).toBe(true);
    }
  });

  it('a slice waits while another holds the file (the lock is taken before the length is read, which is what closes the gap between the check and the write)', async () => {
    const w = world();
    const file = path.join(w.fsB, 'usr/local/share/universe/cold/list.json');
    expect(cold(w, 'list-put 0', w.fsB, 'aaaa\n').stdout).toBe('listput=1 size=4\n');
    // Another writer holds the file for 1.5 seconds
    const holder = spawn('python3', ['-c', 'import fcntl,sys,time\nf=open(sys.argv[1],"ab")\nfcntl.flock(f,fcntl.LOCK_EX)\nprint("held",flush=True)\ntime.sleep(1.5)', file]);
    await new Promise<void>((resolve) => holder.stdout.once('data', () => resolve()));
    const began = Date.now();
    const answer = await new Promise<string>((resolve) => {
      const child = spawn('python3', [script, 'list-put', '4'], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, UNIVERSE_COLD_HOME: w.home, UNIVERSE_COLD_FS: w.fsB } });
      let out = '';
      child.stdout.on('data', (chunk) => (out += chunk));
      child.on('close', () => resolve(out));
      child.stdin.end('bbbb\n');
    });
    expect(Date.now() - began).toBeGreaterThan(1000);
    expect(answer).toBe('listput=1 size=8\n');
    holder.kill();
  });

  const finishFrom = (w: World, text: string) => cold(w, 'finish', w.fsB, JSON.stringify({ outside_file: { bytes: text.length, sha256: sha(text) } }));

  it('finish refuses a list that is not the length and SHA-256 it was told, puts nothing back, and removes the file', () => {
    const w = world();
    const list = packed(w);
    const text = ascii(list);
    const file = path.join(w.fsB, 'usr/local/share/universe/cold/list.json');
    sendInPieces(w, text);
    const wrong = [
      { bytes: text.length, sha256: sha('something else') },
      { bytes: text.length - 1, sha256: sha(text) },
      { bytes: text.length + 1, sha256: sha(text) },
      { bytes: text.length, sha256: 'nothex' },
      { bytes: 'many', sha256: sha(text) },
      null,
    ];
    for (const spec of wrong) {
      sendInPieces(w, text);
      expect(cold(w, 'finish', w.fsB, JSON.stringify({ outside_file: spec })).stdout).toContain('finished=0 reason=outside_manifest');
      expect(fs.existsSync(file)).toBe(false);
    }
    // No list was ever sent
    expect(cold(w, 'finish', w.fsB, JSON.stringify({ outside_file: { bytes: text.length, sha256: sha(text) } })).stdout).toContain('finished=0 reason=outside_manifest');
    expect(writtenOnB(w)).toEqual([]);
    expect(aptCalls()).toEqual([]);
    // A list that arrived whole is not trusted for its contents either: the same checks as for one sent as it is
    const bad = ascii({ files: [['f', '/home/node/x', 1, 0o600, sha('x')]], packages: [] });
    sendInPieces(w, bad);
    expect(finishFrom(w, bad).stdout).toContain('finished=0 reason=outside_manifest');
    expect(writtenOnB(w)).toEqual([]);
  });

  it('the script Orbit puts on a computer for a pack-away (in the folder the list travels in) is never part of what is listed, whatever its age', () => {
    const w = world();
    const installed = path.join(w.fsA, 'usr/local/share/universe/cold');
    fs.mkdirSync(installed, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(installed, 'universe-cold'), '#!/usr/bin/env python3\n');
    fs.writeFileSync(path.join(installed, 'universe-cold.new'), 'half');
    const list = packed(w);
    expect(list.files.map((entry) => entry[1]).sort()).toEqual(['/etc/app.conf', '/opt/tool/latest', '/opt/tool/run.sh']);
    expect(fs.readFileSync(path.join(installed, 'universe-cold'), 'utf8')).toBe('#!/usr/bin/env python3\n');
  });

  it('the list is in path order, whatever order the file system reads its folders in', () => {
    const w = world();
    for (const name of ['z-last', 'b-middle', 'a-first', 'Capital']) fs.writeFileSync(path.join(w.fsA, 'opt/tool', name), name);
    for (const name of ['y.conf', 'c.conf']) fs.writeFileSync(path.join(w.fsA, 'etc', name), name);
    const names = packed(w).files.map((entry) => entry[1]);
    expect(names).toEqual([...names].sort());
    expect(names).toHaveLength(9);
    // The same on the next run
    expect(packed(w).files.map((entry) => entry[1])).toEqual(names);
  });

  it('every slice ends with a marker on its line, so a slice that ends in a space is whole after the end of the answer is trimmed', () => {
    const w = world();
    fs.writeFileSync(path.join(w.fsA, 'opt/tool/ends with a space '), 'x');
    const out = printed(cold(w, 'prepack', w.fsA).stdout);
    const bytes = out.manifest_bytes as number;
    const text = JSON.stringify(packed(w));
    expect(text).toContain('ends with a space "');
    // Ask for a slice that ends exactly at that space
    const cut = text.indexOf('ends with a space ') + 'ends with a space '.length;
    const got = cold(w, `list-piece 0 ${cut}`, w.fsA).stdout;
    expect(got).toBe(`listpiece=${text.slice(0, cut)}|end|\n`);
    expect(got.trimEnd().endsWith('|end|')).toBe(true);
    expect(bytes).toBeGreaterThan(cut);
  });

  it('a file name that is not valid UTF-8 (a path or a link target) makes the computer blocked, not a list a database would refuse', () => {
    const w = world();
    fs.writeFileSync(Buffer.concat([Buffer.from(path.join(w.fsA, 'opt/tool/')), Buffer.from([0x66, 0xff, 0xfe, 0x2e, 0x74])]), 'x');
    const done = cold(w, 'prepack', w.fsA);
    expect(done.status).toBe(1);
    expect(printed(done.stdout)).toMatchObject({ blocked: 'outside_name_not_utf8', manifest_bytes: null, manifest_sha256: null });
    // The same for a link that points at such a name
    const v = world();
    fs.symlinkSync(Buffer.from([0x74, 0xff, 0x6f]) as unknown as string, path.join(v.fsA, 'opt/tool/odd'));
    const again = cold(v, 'prepack', v.fsA);
    expect(printed(again.stdout)).toMatchObject({ blocked: 'outside_name_not_utf8', manifest_bytes: null });
  });

  it('more than 2000 added software names makes the computer blocked (a list finish would refuse is never made)', () => {
    const w = world();
    const done = cold(w, 'prepack', w.fsA, '', { EXTRA_PACKAGES: '2000' });
    expect(printed(done.stdout)).toMatchObject({ blocked: 'packages_too_many', manifest_bytes: null });
    // 1999 more and ffmpeg is exactly 2000: still fine
    const ok = world();
    const fine = cold(ok, 'prepack', ok.fsA, '', { EXTRA_PACKAGES: '1999' });
    expect(printed(fine.stdout).blocked).toBeNull();
  });

  /** Runs the script's own functions under a patch: `patch` is Python source run after the module loaded (it may wrap `os` calls), then the command's function runs. */
  function patched(w: World, fsRoot: string, command: 'prepack' | 'finish', patch: string, input = ''): { stdout: string; status: number | null } {
    const harness = path.join(dir, `patched-${++counter}.py`);
    fs.writeFileSync(harness, [
      'import importlib.machinery, importlib.util, os, sys',
      'loader = importlib.machinery.SourceFileLoader("cold", sys.argv[1])',
      'spec = importlib.util.spec_from_loader("cold", loader)',
      'mod = importlib.util.module_from_spec(spec)',
      'loader.exec_module(mod)',
      patch,
      `sys.exit(mod.${command}())`,
    ].join('\n'));
    const done = spawnSync('python3', [harness, script], { input, encoding: 'utf8', timeout: 60_000, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, UNIVERSE_COLD_HOME: w.home, UNIVERSE_COLD_FS: fsRoot } });
    return { stdout: done.stdout, status: done.status };
  }
  const stagedNames = (folder: string) => fs.readdirSync(folder).filter((name) => name.startsWith('.uc-') || name.startsWith('.universe-'));

  it('a file that grows past what is left of the size limit while it is copied stops the copy (outside_too_big) and no part of it stays in the copy folder', () => {
    const w = world();
    const harness = path.join(dir, `copy-budget-${counter}.py`);
    const outside = path.join(w.home, 'o');
    fs.mkdirSync(path.join(w.fsA, 'opt/grow'), { recursive: true });
    fs.writeFileSync(path.join(w.fsA, 'opt/grow/big'), 'x'.repeat(100));
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(harness, [
      'import importlib.machinery, importlib.util, os, sys',
      'loader = importlib.machinery.SourceFileLoader("cold", sys.argv[1])',
      'spec = importlib.util.spec_from_loader("cold", loader)',
      'mod = importlib.util.module_from_spec(spec)',
      'loader.exec_module(mod)',
      'out_fd = os.open(sys.argv[2], os.O_RDONLY | os.O_DIRECTORY)',
      'root_fd = os.open(sys.argv[3], os.O_RDONLY | os.O_DIRECTORY)',
      'try:',
      '    mod.copy_into(out_fd, root_fd, "/opt/grow/big", 40)',
      '    print("copied")',
      'except mod.TooBig:',
      '    print("toobig")',
      'print(sorted(os.listdir(os.path.join(sys.argv[2], "opt/grow"))))',
      'print(mod.copy_into(out_fd, root_fd, "/opt/grow/big", 100)[1])',
    ].join('\n'));
    const done = spawnSync('python3', [harness, script, outside, w.fsA], { encoding: 'utf8', env: { ...process.env, UNIVERSE_COLD_HOME: w.home, UNIVERSE_COLD_FS: w.fsA } });
    // Over the limit: stopped, and the half-written file is gone; at exactly the limit it is copied whole
    expect(done.stdout.split('\n').slice(0, 3)).toEqual(['toobig', '[]', '100']);
    expect(fs.readFileSync(path.join(outside, 'opt/grow/big'), 'utf8')).toBe('x'.repeat(100));
  });

  it('a name at the longest a folder allows (255 bytes) is copied and put back, and a file of the new computer that happens to be named like the old staging name is never touched', () => {
    const w = world();
    const long = 'n'.repeat(255);
    fs.writeFileSync(path.join(w.fsA, 'opt/tool', long), 'long');
    const manifest = packed(w);
    expect(manifest.files.some((entry) => entry[1] === `/opt/tool/${long}`)).toBe(true);
    fs.mkdirSync(path.join(w.fsB, 'opt/tool'), { recursive: true });
    fs.writeFileSync(path.join(w.fsB, 'opt/tool/run.sh.universe-new'), 'not ours');
    const done = finishWith(w, manifest);
    expect(done.stdout).toMatch(/finished=1 files=\d+ packages=1 outside=applied\n/);
    expect(fs.readFileSync(path.join(w.fsB, 'opt/tool', long), 'utf8')).toBe('long');
    expect(fs.readFileSync(path.join(w.fsB, 'opt/tool/run.sh.universe-new'), 'utf8')).toBe('not ours');
    // Nothing of the staging is left behind
    expect(stagedNames(path.join(w.fsB, 'opt/tool'))).toEqual([]);
  });

  /** A computer made from the image the way a real one is: the image's files keep the image's old modification times, but every one of them has the time of the unpack as its change time (measured on a real Agent37 computer). */
  function unpacked(w: World, count: number) {
    const old = new Date('2019-06-01T00:00:00Z');
    for (let i = 0; i < count; i++) {
      const folder = ['etc', 'opt', 'usr/local/lib', 'root'][i % 4];
      fs.mkdirSync(path.join(w.fsA, folder, 'image'), { recursive: true });
      const file = path.join(w.fsA, folder, 'image', `file-${i}`);
      fs.writeFileSync(file, `image ${i}`);
      fs.utimesSync(file, old, old);
      if (i % 5 === 0) {
        const link = path.join(w.fsA, folder, 'image', `link-${i}`);
        fs.symlinkSync(`file-${i}`, link);
        fs.lutimesSync(link, old, old);
      }
    }
    // The marker files are the last of the unpack (the same change time as the files, a moment later)
    for (const name of ['built', 'manual-packages.txt']) {
      const marker = path.join(w.fsA, 'usr/local/share/universe', name);
      fs.writeFileSync(marker, name === 'built' ? 'built' : 'baseline1\n');
      const date = new Date('2020-01-01T00:00:00Z');
      fs.utimesSync(marker, date, date);
    }
  }

  it('a real computer: every file of the image has the unpack time as its change time and the image\'s old modification time, and none of them is taken for something the agent added (found on a real Agent37 computer: 88,000 files counted as new)', () => {
    const w = world();
    unpacked(w, 400);
    const done = cold(w, 'prepack', w.fsA);
    const out = printed(done.stdout);
    expect(out.blocked).toBeNull();
    // Only what was written here: the three files of the test (their modification time is later than the image's)
    expect(listOf(w, out).files.map((entry) => entry[1]).sort()).toEqual(['/etc/app.conf', '/opt/tool/latest', '/opt/tool/run.sh']);
    expect(out.outside_files).toBe(3);
  });

  describe('outside-check: whether an image update would wipe anything (found on a real computer: a computer behind the image lost its files outside the home folder when ready() updated it)', () => {
    const said = (w: World, extra: Record<string, string> = {}) => {
      const done = cold(w, 'outside-check', w.fsA, '', extra);
      return { line: /(^|\n)(outside_check=[^\n]*)/.exec(done.stdout)?.[2] ?? null, status: done.status };
    };
    /** The test's own three files (made after the image) taken away: a computer that holds only what its image had. */
    const untouched = (w: World) => {
      unpacked(w, 60);
      for (const name of ['etc/app.conf', 'opt/tool']) fs.rmSync(path.join(w.fsA, name), { recursive: true, force: true });
    };

    it('says any=0 for a computer that holds only what its image had (the unpack time as every file\'s change time, the image\'s old modification time), and copies and writes nothing', () => {
      const w = world();
      untouched(w);
      // The stand-in lists the baseline software only
      fs.writeFileSync(path.join(w.fsA, 'usr/local/share/universe/manual-packages.txt'), 'baseline1\nffmpeg\n');
      expect(said(w)).toEqual({ line: 'outside_check=1 any=0', status: 0 });
      expect(fs.existsSync(w.state)).toBe(false);
    });

    it('says any=1 for a file written after the image was built (a tool in /opt, a changed /etc file)', () => {
      const w = world();
      untouched(w);
      fs.writeFileSync(path.join(w.fsA, 'usr/local/share/universe/manual-packages.txt'), 'baseline1\nffmpeg\n');
      fs.mkdirSync(path.join(w.fsA, 'opt/tool'), { recursive: true });
      fs.writeFileSync(path.join(w.fsA, 'opt/tool/run.sh'), 'x');
      expect(said(w)).toEqual({ line: 'outside_check=1 any=1', status: 0 });
      expect(fs.existsSync(w.state)).toBe(false);
    });

    it('says any=1 for software added after the image (a package) when no file is new', () => {
      const w = world();
      untouched(w);
      // The stand-in apt-mark reports ffmpeg as installed by hand, and the baseline does not have it
      expect(said(w)).toEqual({ line: 'outside_check=1 any=1', status: 0 });
    });

    it('says any=1 for a file whose name is not valid UTF-8 (it is something the update would wipe all the same)', () => {
      const w = world();
      untouched(w);
      fs.writeFileSync(path.join(w.fsA, 'usr/local/share/universe/manual-packages.txt'), 'baseline1\nffmpeg\n');
      fs.writeFileSync(Buffer.concat([Buffer.from(path.join(w.fsA, 'opt/')), Buffer.from([0xff, 0xfe])]), 'x');
      expect(said(w)).toEqual({ line: 'outside_check=1 any=1', status: 0 });
    });

    it('says why it cannot tell, never any=0: the image marker is missing, or the software list cannot be read', () => {
      const w = world();
      untouched(w);
      fs.writeFileSync(path.join(w.fsA, 'usr/local/share/universe/manual-packages.txt'), 'baseline1\nffmpeg\n');
      const broken = path.join(dir, `broken-apt-${counter}`);
      fs.mkdirSync(broken, { recursive: true });
      fs.writeFileSync(path.join(broken, 'apt-mark'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
      expect(said(w, { PATH: `${broken}:${process.env.PATH}` })).toEqual({ line: 'outside_check=0 reason=packages_unknown', status: 1 });
      fs.rmSync(path.join(w.fsA, 'usr/local/share/universe/built'));
      expect(said(w)).toEqual({ line: 'outside_check=0 reason=image_marker_missing', status: 1 });
    });

    it('looks at the same files prepack would copy: whatever prepack lists, the check says any=1, and when prepack lists nothing, any=0 (one scan for both)', () => {
      const w = world();
      untouched(w);
      fs.writeFileSync(path.join(w.fsA, 'usr/local/share/universe/manual-packages.txt'), 'baseline1\nffmpeg\n');
      expect(printed(cold(w, 'prepack', w.fsA).stdout).outside_files).toBe(0);
      expect(said(w).line).toBe('outside_check=1 any=0');
      fs.writeFileSync(path.join(w.fsA, 'root/new-file'), 'x');
      expect(printed(cold(w, 'prepack', w.fsA).stdout).outside_files).toBe(1);
      expect(said(w).line).toBe('outside_check=1 any=1');
    });
  });

  it('a file copied here with its old modification time kept (cp -p, tar x) is still found, by its change time: it is later than the end of the unpack by more than the margin', () => {
    const w = world();
    unpacked(w, 40);
    // The margin is set to nothing here (a real computer waits 120 s, which a test cannot): what changes after the unpack ended is new, what was unpacked with it is not
    const seen = (patch: string) => patched(w, w.fsA, 'prepack', patch);
    fs.mkdirSync(path.join(w.fsA, 'opt/copied'), { recursive: true });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1300);
    const probe = path.join(w.fsA, 'opt/copied/probe');
    fs.writeFileSync(probe, 'copied with cp -p');
    const old = new Date('2018-01-01T00:00:00Z');
    fs.utimesSync(probe, old, old);
    const withMargin = printed(seen('').stdout);
    // With the real margin it is not seen yet (only the three files written with a new modification time)
    expect(withMargin.outside_files).toBe(3);
    const done = seen('mod.CTIME_MARGIN = 0');
    const list = printed(done.stdout);
    expect(list.blocked).toBeNull();
    const names = listOf(w, list).files.map((entry) => entry[1]);
    expect(names).toContain('/opt/copied/probe');
    expect(names.filter((name) => name.includes('/image/'))).toEqual([]);
  });

  it('a private folder stays private: prepack lists the mode of every folder above a file that is not 0755, and a folder made again on the new computer gets that mode (found on a real computer: a 0700 folder came back 0755)', () => {
    const w = world();
    fs.mkdirSync(path.join(w.fsA, 'opt/zz/private/deeper'), { recursive: true });
    fs.mkdirSync(path.join(w.fsA, 'opt/zz/open'), { recursive: true });
    fs.writeFileSync(path.join(w.fsA, 'opt/zz/private/deeper/secret.txt'), 'secret');
    fs.writeFileSync(path.join(w.fsA, 'opt/zz/open/plain.txt'), 'plain');
    fs.chmodSync(path.join(w.fsA, 'opt/zz/private'), 0o700);
    fs.chmodSync(path.join(w.fsA, 'opt/zz/private/deeper'), 0o750);
    const list = packed(w);
    // Only the folders that are not the usual 0755, by path, in path order
    expect(list.dirs).toEqual([['/opt/zz/private', 0o700], ['/opt/zz/private/deeper', 0o750]]);
    // A folder that already exists on the new computer is left as it is
    fs.mkdirSync(path.join(w.fsB, 'opt/zz/open'), { recursive: true });
    expect(finishWith(w, list).stdout).toMatch(/finished=1/);
    expect(fs.statSync(path.join(w.fsB, 'opt/zz/private')).mode & 0o7777).toBe(0o700);
    expect(fs.statSync(path.join(w.fsB, 'opt/zz/private/deeper')).mode & 0o7777).toBe(0o750);
    expect(fs.statSync(path.join(w.fsB, 'opt/zz/open')).mode & 0o7777).toBe(0o755);
    expect(fs.readFileSync(path.join(w.fsB, 'opt/zz/private/deeper/secret.txt'), 'utf8')).toBe('secret');
    // A copy made before the modes were kept (no dirs) is made as it always was
    const old = packed(w);
    delete old.dirs;
    fs.rmSync(path.join(w.fsB, 'opt'), { recursive: true });
    expect(finishWith(w, old).stdout).toMatch(/finished=1/);
    expect(fs.statSync(path.join(w.fsB, 'opt/zz/private')).mode & 0o7777).toBe(0o755);
  });

  it('more folder modes than a list may hold (four for each file the list may hold) is a computer that holds too much to carry, said by prepack (outside_too_big), never a list the caller then cannot read', () => {
    const w = world();
    // The limits made small: 5 files, so 20 folder modes. Two files under 11 private folders each (22 modes) are over it; one such file (11 modes) is not
    const chain = (name: string) => {
      const folder = path.join(w.fsA, 'opt', name, ...Array.from({ length: 11 }, (_, i) => `d${i}`));
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(path.join(folder, 'f.txt'), name);
      for (let depth = 1; depth <= 11; depth++) fs.chmodSync(path.join(w.fsA, 'opt', name, ...Array.from({ length: depth }, (_, i) => `d${i}`)), 0o700);
      fs.chmodSync(path.join(w.fsA, 'opt', name), 0o700);
    };
    chain('one');
    const fine = patched(w, w.fsA, 'prepack', 'mod.MAX_FILES = 5');
    expect(printed(fine.stdout).blocked).toBeNull();
    chain('two');
    const over = patched(w, w.fsA, 'prepack', 'mod.MAX_FILES = 5');
    // 3 files of the test + 2 = 5 files, 24 folder modes with the two top folders: over the 20
    expect(printed(over.stdout)).toMatchObject({ blocked: 'outside_too_big', manifest_bytes: null });
  });

  it('a folder mode is applied only to a folder that finish makes (one the new computer already has is left as it is), and never carries the set-user-id or set-group-id bits (the sticky bit stays)', () => {
    const w = world();
    for (const folder of ['etc/existing', 'opt/p1', 'opt/p2', 'opt/p3']) {
      fs.mkdirSync(path.join(w.fsA, folder), { recursive: true });
      fs.writeFileSync(path.join(w.fsA, folder, 'x.conf'), folder);
    }
    const list = packed(w);
    list.dirs = [['/etc/existing', 0o777], ['/opt/p1', 0o2770], ['/opt/p2', 0o4700], ['/opt/p3', 0o1777]];
    fs.mkdirSync(path.join(w.fsB, 'etc/existing'), { recursive: true });
    fs.chmodSync(path.join(w.fsB, 'etc/existing'), 0o755);
    expect(finishWith(w, list).stdout).toMatch(/finished=1/);
    const mode = (name: string) => fs.statSync(path.join(w.fsB, name)).mode & 0o7777;
    expect(mode('etc/existing')).toBe(0o755);
    expect(mode('opt/p1')).toBe(0o770);
    expect(mode('opt/p2')).toBe(0o700);
    expect(mode('opt/p3')).toBe(0o1777);
  });

  it('a list with folder modes that are not what prepack prints is a bad list: a path outside the folders a copy may put back, a path that is not clean, a mode out of range, the same folder twice', () => {
    const w = world();
    const list = packed(w);
    for (const dirs of [[['/etc2/x', 0o700]], [['/opt/../etc', 0o700]], [['/opt/a', 0o10000]], [['/opt/a', 0o700], ['/opt/a', 0o700]], [['/opt/a']], 'no', [['opt/a', 0o700]]]) {
      const done = cold(w, 'finish', w.fsB, JSON.stringify({ outside: { ...list, dirs } }));
      expect(done.stdout).toContain('finished=0 reason=outside_manifest');
    }
    expect(writtenOnB(w)).toEqual([]);
  });

  it('nothing is put back until the margin after the end of the unpack has passed: a file restored with its old modification time must not look like one of the image the next time (Opus read of the ctime fix)', () => {
    const w = world();
    const list = packed(w);
    // The new computer was unpacked a moment ago; the margin is 2 s here (a real one is 120 s), so a finish has to wait about 3 s
    for (const name of ['built', 'manual-packages.txt']) fs.utimesSync(path.join(w.fsB, 'usr/local/share/universe', name), new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'));
    const unpackEnd = Math.min(...['built', 'manual-packages.txt'].map((name) => fs.statSync(path.join(w.fsB, 'usr/local/share/universe', name)).ctimeMs));
    const harness = path.join(dir, `wait-${++counter}.py`);
    fs.writeFileSync(harness, [
      'import importlib.machinery, importlib.util, sys',
      'loader = importlib.machinery.SourceFileLoader("cold", sys.argv[1])',
      'spec = importlib.util.spec_from_loader("cold", loader)',
      'mod = importlib.util.module_from_spec(spec)',
      'loader.exec_module(mod)',
      'mod.CTIME_MARGIN = 2',
      'sys.exit(mod.finish())',
    ].join('\n'));
    const done = spawnSync('python3', [harness, script], { input: JSON.stringify({ outside: list }), encoding: 'utf8', timeout: 60_000, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, UNIVERSE_COLD_HOME: w.home, UNIVERSE_COLD_FS: w.fsB, UNIVERSE_COLD_NO_WAIT: '' } });
    expect(done.stdout).toMatch(/finished=1/);
    for (const name of ['etc/app.conf', 'opt/tool/run.sh']) expect(fs.statSync(path.join(w.fsB, name)).ctimeMs).toBeGreaterThan(unpackEnd + 2000);
  });

  it('a staging folder name that is already taken is never used or removed: another is tried', () => {
    const w = world();
    const manifest = packed(w);
    // The first name the script would pick is a folder of someone else (with a file in it)
    const done = patched(w, w.fsB, 'finish', [
      'real_urandom = os.urandom',
      'taken = [b"\\x01" * 4]',
      'def fixed(n):',
      '    return taken.pop(0) if n == 4 and taken else real_urandom(n)',
      'os.urandom = fixed',
      'os.makedirs(os.path.join(mod.FSROOT, "opt/tool/.uc-01010101"), exist_ok=True)',
      'open(os.path.join(mod.FSROOT, "opt/tool/.uc-01010101/mine"), "w").write("someone else")',
    ].join('\n'), JSON.stringify({ outside: manifest }));
    expect(done.stdout).toMatch(/finished=1 .* outside=applied\n/);
    expect(fs.readFileSync(path.join(w.fsB, 'opt/tool/.uc-01010101/mine'), 'utf8')).toBe('someone else');
    expect(fs.readFileSync(path.join(w.fsB, 'opt/tool/run.sh'), 'utf8')).toBe('#!/bin/sh\necho hi\n');
  });

  it('the staged file swapped for another before it is moved into place is refused, and what was swapped in is not left at the target', () => {
    const w = world();
    const manifest = packed(w);
    const done = patched(w, w.fsB, 'finish', [
      'real_lstat = os.lstat',
      'swapped = []',
      'def look(target, *args, **kwargs):',
      '    if target == "f" and "dir_fd" in kwargs and not swapped:',
      '        swapped.append(1)',
      '        fd = os.open(".attacker", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=kwargs["dir_fd"])',
      '        os.write(fd, b"attacker")',
      '        os.close(fd)',
      '        os.rename(".attacker", target, src_dir_fd=kwargs["dir_fd"], dst_dir_fd=kwargs["dir_fd"])',
      '    return real_lstat(target, *args, **kwargs)',
      'os.lstat = look',
    ].join('\n'), JSON.stringify({ outside: manifest }));
    expect(done.stdout).toMatch(/finished=0 reason=outside_tampered\n/);
    expect(done.status).toBe(1);
    for (const folder of ['etc', 'opt/tool']) {
      if (!fs.existsSync(path.join(w.fsB, folder))) continue;
      for (const name of fs.readdirSync(path.join(w.fsB, folder))) {
        if (fs.statSync(path.join(w.fsB, folder, name)).isFile()) expect(fs.readFileSync(path.join(w.fsB, folder, name), 'utf8')).not.toBe('attacker');
      }
      expect(stagedNames(path.join(w.fsB, folder))).toEqual([]);
    }
  });

  it('the copy folder is gone when a finish ends, whatever it said once the list was read (so a file only root could read is not left in the home folder), and the rest of the state folder stays', () => {
    const w = world();
    const manifest = packed(w);
    const keepPackages = fs.existsSync(path.join(w.state, 'outside-packages.txt'));
    expect(fs.readFileSync(path.join(w.outside, 'etc/app.conf'), 'utf8')).toBe('conf');
    expect(cold(w, 'finish', w.fsB, JSON.stringify({ outside: manifest })).stdout).toMatch(/finished=1 .* outside=applied\n/);
    expect(fs.existsSync(w.outside)).toBe(false);
    expect(fs.existsSync(path.join(w.state, 'outside-packages.txt'))).toBe(keepPackages);
    // A refused one too
    const v = world();
    const list = packed(v);
    fs.writeFileSync(path.join(v.outside, 'etc/app.conf'), 'cone');
    expect(cold(v, 'finish', v.fsB, JSON.stringify({ outside: list })).stdout).toContain('outside_tampered');
    expect(fs.existsSync(v.outside)).toBe(false);
    // And a copy with no list (unverified)
    const u = world();
    packed(u);
    expect(cold(u, 'finish', u.fsB, JSON.stringify({ outside: null })).stdout).toMatch(/outside=unverified\n/);
    expect(fs.existsSync(u.outside)).toBe(false);
    // A list that is not a list says so and leaves the folder alone
    const x = world();
    packed(x);
    expect(cold(x, 'finish', x.fsB, JSON.stringify({ outside: { files: 'no', packages: [] } })).stdout).toContain('outside_manifest');
    expect(fs.existsSync(x.outside)).toBe(true);
  });

  it('a link where the copy folder belongs is removed as a link when a finish ends: what it points at keeps its files', () => {
    const w = world();
    const manifest = packed(w);
    const elsewhere = path.join(path.dirname(w.home), `elsewhere-drop-${counter}`);
    fs.mkdirSync(elsewhere, { recursive: true });
    fs.writeFileSync(path.join(elsewhere, 'keep'), 'mine');
    fs.rmSync(w.outside, { recursive: true });
    fs.symlinkSync(elsewhere, w.outside);
    expect(cold(w, 'finish', w.fsB, JSON.stringify({ outside: manifest })).stdout).toContain('outside_tampered');
    expect(fs.readFileSync(path.join(elsewhere, 'keep'), 'utf8')).toBe('mine');
    expect(fs.lstatSync(w.outside, { throwIfNoEntry: false })).toBeUndefined();
  });

  it('a copy that changes after the list was checked puts nothing in place: every file is checked and staged first, so the files before it are not put back either', () => {
    const w = world();
    const manifest = packed(w);
    const done = patched(w, w.fsB, 'finish', [
      'real_verify = mod.verify_outside',
      'def verify(entries):',
      '    real_verify(entries)',
      // The last file of the list (by path) changes after the check: same size, same mode, other bytes
      '    last = os.path.join(mod.OUTSIDE, "opt/tool/run.sh")',
      '    data = open(last, "rb").read()',
      '    open(last, "wb").write(data.replace(b"hi", b"ho"))',
      'mod.verify_outside = verify',
    ].join('\n'), JSON.stringify({ outside: manifest }));
    expect(done.stdout).toMatch(/finished=0 reason=outside_tampered\n/);
    expect(writtenOnB(w)).toEqual([]);
    for (const folder of ['etc', 'opt/tool']) if (fs.existsSync(path.join(w.fsB, folder))) expect(stagedNames(path.join(w.fsB, folder))).toEqual([]);
  });

  it('the staged file given a second name before it is moved (a hard link the agent can keep writing through) is refused, and nothing is put at the target', () => {
    const w = world();
    const manifest = packed(w);
    const done = patched(w, w.fsB, 'finish', [
      'real_lstat = os.lstat',
      'linked = []',
      'def look(target, *args, **kwargs):',
      '    got = real_lstat(target, *args, **kwargs)',
      '    if target == "f" and "dir_fd" in kwargs and not linked and os.path.stat.S_ISREG(got.st_mode):',
      '        linked.append(1)',
      '        os.link(target, os.path.join(mod.FSROOT, "etc/.kept"), src_dir_fd=kwargs["dir_fd"], follow_symlinks=False)',
      '        got = real_lstat(target, *args, **kwargs)',
      '    return got',
      'os.lstat = look',
    ].join('\n'), JSON.stringify({ outside: manifest }));
    expect(done.stdout).toMatch(/finished=0 reason=outside_tampered\n/);
    expect(fs.existsSync(path.join(w.fsB, 'etc/app.conf'))).toBe(false);
    expect(stagedNames(path.join(w.fsB, 'etc'))).toEqual([]);
  });

  it('every file is put in place by a rename from its private folder to the target\'s folder, both held as descriptors (the name looked up again is the target\'s, never a staging name)', () => {
    const w = world();
    const manifest = packed(w);
    const done = patched(w, w.fsB, 'finish', [
      'real_rename = os.rename',
      'def rename(src, dst, *args, **kwargs):',
      '    print("rename:%s:%s:%s" % (src, os.path.basename(str(dst)), kwargs.get("src_dir_fd") is not None and kwargs.get("dst_dir_fd") is not None and kwargs["src_dir_fd"] != kwargs["dst_dir_fd"]))',
      '    return real_rename(src, dst, *args, **kwargs)',
      'os.rename = rename',
    ].join('\n'), JSON.stringify({ outside: manifest }));
    expect(done.stdout).toMatch(/finished=1/);
    const moves = done.stdout.split('\n').filter((line) => line.startsWith('rename:f:'));
    expect(moves.map((line) => line.split(':')[2]).sort()).toEqual(['app.conf', 'latest', 'run.sh']);
    for (const move of moves) expect(move.endsWith(':True')).toBe(true);
  });

  const left = (w: World) => fs.readdirSync(w.fsB, { recursive: true }).map(String).filter((name) => path.basename(name).startsWith('.uc-') || name.endsWith('.universe-new'));

  it('no staging folder is left behind after a good finish or after a refused one, and a link replaces a file at the target in one step', () => {
    const w = world();
    const list = packed(w);
    fs.mkdirSync(path.join(w.fsB, 'opt/tool'), { recursive: true });
    fs.writeFileSync(path.join(w.fsB, 'opt/tool/latest'), 'a file where the link goes');
    expect(finishWith(w, list).stdout).toMatch(/finished=1/);
    expect(fs.readlinkSync(path.join(w.fsB, 'opt/tool/latest'))).toBe('run.sh');
    expect(left(w)).toEqual([]);
    // A file that changed in the copy after prepack: refused, and nothing is left
    const v = world();
    const again = packed(v);
    fs.appendFileSync(path.join(v.outside, 'etc/app.conf'), 'x');
    expect(finishWith(v, again).stdout).toContain('finished=0 reason=outside_tampered');
    expect(left(v)).toEqual([]);
  });

  raceTest('between the checks and the rename the agent can change nothing inside the staging folder, and a staging folder it swapped in meanwhile publishes nothing', () => {
    // The hook runs just before the rename that publishes: the agent tries to rename the staged file (must be refused), then renames the staging folder away and puts its own with a different file
    const w = world();
    const list = packed(w);
    const parent = path.join(w.fsB, 'opt/tool');
    fs.mkdirSync(parent, { recursive: true });
    for (const folder of [dir, path.dirname(w.fsB), w.fsB, path.join(w.fsB, 'opt')]) fs.chmodSync(folder, 0o755);
    spawnSync('chown', ['-R', '1000:1000', parent]);
    const agentCode = path.join(dir, `agent-${++counter}.py`);
    fs.writeFileSync(agentCode, [
      'import os, sys',
      'parent, stage = sys.argv[1], sys.argv[2]',
      'try:',
      '    os.rename(os.path.join(parent, stage, "f"), os.path.join(parent, stage, "g"))',
      '    print("renamed-inside")',
      'except PermissionError:',
      '    print("refused-inside")',
      'os.rename(os.path.join(parent, stage), os.path.join(parent, ".moved"))',
      'os.mkdir(os.path.join(parent, stage), 0o700)',
      'open(os.path.join(parent, stage, "f"), "w").write("EVIL")',
    ].join('\n'));
    const harness = path.join(dir, `publish-race-${counter}.py`);
    fs.writeFileSync(harness, [
      'import importlib.machinery, importlib.util, os, subprocess, sys',
      'loader = importlib.machinery.SourceFileLoader("cold", sys.argv[1])',
      'spec = importlib.util.spec_from_loader("cold", loader)',
      'mod = importlib.util.module_from_spec(spec)',
      'loader.exec_module(mod)',
      'real_rename = os.rename',
      'stages = {}',
      'def stage_of(held, parent_fd):',
      '    mine = os.fstat(held).st_ino',
      '    return [n for n in os.listdir(parent_fd) if n.startswith(".uc-") and os.stat(n, dir_fd=parent_fd).st_ino == mine][0]',
      'real_mkdir = os.mkdir',
      'def seen_mkdir(target, *args, **kwargs):',
      '    real_mkdir(target, *args, **kwargs)',
      '    if str(target).startswith(".uc-"):',
      '        stages["name"] = str(target)',
      'os.mkdir = seen_mkdir',
      'done = {"n": 0}',
      'def racing(src, dst, *args, **kwargs):',
      '    if src == "f" and "src_dir_fd" in kwargs and dst == "run.sh" and not done["n"]:',
      '        done["n"] = 1',
      '        ran = subprocess.run(["setpriv", "--reuid=1000", "--regid=1000", "--clear-groups", "python3", sys.argv[2], sys.argv[3], stage_of(kwargs["src_dir_fd"], kwargs["dst_dir_fd"])], capture_output=True, text=True)',
      '        print("agent:" + ran.stdout.strip().replace("\\n", ",") + ran.stderr.strip())',
      '    return real_rename(src, dst, *args, **kwargs)',
      'os.rename = racing',
      'sys.exit(mod.finish())',
    ].join('\n'));
    const done = spawnSync('python3', [harness, script, agentCode, parent], { input: JSON.stringify({ outside: list }), encoding: 'utf8', timeout: 60_000, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, UNIVERSE_COLD_HOME: w.home, UNIVERSE_COLD_FS: w.fsB } });
    expect(done.stdout).toContain('agent:refused-inside');
    expect(done.stdout).toMatch(/finished=1/);
    // What was published is what was hashed, owned by root, not what the agent put in a folder of its own name
    expect(fs.readFileSync(path.join(parent, 'run.sh'), 'utf8')).toBe('#!/bin/sh\necho hi\n');
    expect(fs.statSync(path.join(parent, 'run.sh')).uid).toBe(0);
  });

  raceTest('a staging folder the agent swapped in between the mkdir and the open is refused, and the target is untouched', () => {
    const w = world();
    const list = packed(w);
    const parent = path.join(w.fsB, 'opt/tool');
    fs.mkdirSync(parent, { recursive: true });
    for (const folder of [dir, path.dirname(w.fsB), w.fsB, path.join(w.fsB, 'opt')]) fs.chmodSync(folder, 0o755);
    fs.writeFileSync(path.join(parent, 'run.sh'), 'what was there');
    spawnSync('chown', ['-R', '1000:1000', parent]);
    const agentCode = path.join(dir, `agent-${++counter}.py`);
    fs.writeFileSync(agentCode, [
      'import os, sys',
      'parent, stage = sys.argv[1], sys.argv[2]',
      'os.rename(os.path.join(parent, stage), os.path.join(parent, ".gone"))',
      'os.mkdir(os.path.join(parent, stage), 0o700)',
    ].join('\n'));
    const harness = path.join(dir, `stage-swap-${counter}.py`);
    fs.writeFileSync(harness, [
      'import importlib.machinery, importlib.util, os, subprocess, sys',
      'loader = importlib.machinery.SourceFileLoader("cold", sys.argv[1])',
      'spec = importlib.util.spec_from_loader("cold", loader)',
      'mod = importlib.util.module_from_spec(spec)',
      'loader.exec_module(mod)',
      'real_mkdir = os.mkdir',
      'def swapping(target, *args, **kwargs):',
      '    real_mkdir(target, *args, **kwargs)',
      '    if str(target).startswith(".uc-") and "dir_fd" in kwargs and "run.sh" in os.listdir(kwargs["dir_fd"]):',
      '        subprocess.run(["setpriv", "--reuid=1000", "--regid=1000", "--clear-groups", "python3", sys.argv[2], sys.argv[3], str(target)], check=True)',
      'os.mkdir = swapping',
      'sys.exit(mod.finish())',
    ].join('\n'));
    const done = spawnSync('python3', [harness, script, agentCode, parent], { input: JSON.stringify({ outside: list }), encoding: 'utf8', timeout: 60_000, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, UNIVERSE_COLD_HOME: w.home, UNIVERSE_COLD_FS: w.fsB } });
    expect(done.stdout).toContain('finished=0 reason=outside_tampered');
    expect(fs.readFileSync(path.join(parent, 'run.sh'), 'utf8')).toBe('what was there');
  });
  raceTest('a folder of the agent\'s that was swapped in for the staging folder is never given another mode: it is refused as it is (still 0755, still the agent\'s)', () => {
    const w = world();
    const list = packed(w);
    const parent = path.join(w.fsB, 'opt/tool');
    fs.mkdirSync(parent, { recursive: true });
    for (const folder of [dir, path.dirname(w.fsB), w.fsB, path.join(w.fsB, 'opt')]) fs.chmodSync(folder, 0o755);
    fs.writeFileSync(path.join(parent, 'run.sh'), 'what was there');
    spawnSync('chown', ['-R', '1000:1000', parent]);
    const agentCode = path.join(dir, `agent-${++counter}.py`);
    // The agent's own folder under the staging name, open to everyone (0755): a chmod of it by root would be seen
    fs.writeFileSync(agentCode, [
      'import os, sys',
      'parent, stage = sys.argv[1], sys.argv[2]',
      'os.rename(os.path.join(parent, stage), os.path.join(parent, ".gone"))',
      'os.mkdir(os.path.join(parent, stage), 0o755)',
      'os.chmod(os.path.join(parent, stage), 0o755)',
    ].join('\n'));
    const harness = path.join(dir, `stage-swap-mode-${counter}.py`);
    fs.writeFileSync(harness, [
      'import importlib.machinery, importlib.util, os, subprocess, sys',
      'loader = importlib.machinery.SourceFileLoader("cold", sys.argv[1])',
      'spec = importlib.util.spec_from_loader("cold", loader)',
      'mod = importlib.util.module_from_spec(spec)',
      'loader.exec_module(mod)',
      'real_mkdir = os.mkdir',
      'def swapping(target, *args, **kwargs):',
      '    real_mkdir(target, *args, **kwargs)',
      '    if str(target).startswith(".uc-") and "dir_fd" in kwargs and "run.sh" in os.listdir(kwargs["dir_fd"]):',
      '        subprocess.run(["setpriv", "--reuid=1000", "--regid=1000", "--clear-groups", "python3", sys.argv[2], sys.argv[3], str(target)], check=True)',
      '        print("swapped:" + str(target))',
      'os.mkdir = swapping',
      'sys.exit(mod.finish())',
    ].join('\n'));
    const done = spawnSync('python3', [harness, script, agentCode, parent], { input: JSON.stringify({ outside: list }), encoding: 'utf8', timeout: 60_000, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, UNIVERSE_COLD_HOME: w.home, UNIVERSE_COLD_FS: w.fsB } });
    const swapped = /swapped:(\.uc-[0-9a-f]+)/.exec(done.stdout)?.[1];
    expect(swapped).toBeDefined();
    expect(done.stdout).toContain('finished=0 reason=outside_tampered');
    expect(fs.readFileSync(path.join(parent, 'run.sh'), 'utf8')).toBe('what was there');
    // The agent's folder is still the agent's and still open: nothing of root's touched it (a clean-up that removed it is no reason to doubt this, so it is read only when it is still there)
    const left = fs.lstatSync(path.join(parent, swapped!), { throwIfNoEntry: false });
    if (left) {
      expect(left.uid).toBe(1000);
      expect(left.mode & 0o7777).toBe(0o755);
    }
  });

  raceTest('a staging folder the agent swapped in after the checks, before the move, is refused: nothing is published from it and the target is untouched', () => {
    const w = world();
    const list = packed(w);
    const parent = path.join(w.fsB, 'opt/tool');
    fs.mkdirSync(parent, { recursive: true });
    for (const folder of [dir, path.dirname(w.fsB), w.fsB, path.join(w.fsB, 'opt')]) fs.chmodSync(folder, 0o755);
    fs.writeFileSync(path.join(parent, 'run.sh'), 'what was there');
    spawnSync('chown', ['-R', '1000:1000', parent]);
    const agentCode = path.join(dir, `agent-${++counter}.py`);
    fs.writeFileSync(agentCode, [
      'import os, sys',
      'parent = sys.argv[1]',
      'for name in os.listdir(parent):',
      '    if name.startswith(".uc-"):',
      '        os.rename(os.path.join(parent, name), os.path.join(parent, ".gone-" + name))',
      '        os.mkdir(os.path.join(parent, name), 0o700)',
      '        open(os.path.join(parent, name, "f"), "w").write("EVIL")',
    ].join('\n'));
    const harness = path.join(dir, `reopen-swap-${counter}.py`);
    fs.writeFileSync(harness, [
      'import importlib.machinery, importlib.util, os, subprocess, sys',
      'loader = importlib.machinery.SourceFileLoader("cold", sys.argv[1])',
      'spec = importlib.util.spec_from_loader("cold", loader)',
      'mod = importlib.util.module_from_spec(spec)',
      'loader.exec_module(mod)',
      'real = mod.reopen_stage',
      'done = {"n": 0}',
      'def swapping(parent_fd, item):',
      '    if not done["n"] and item["parts"][-1] == "run.sh":',
      '        done["n"] = 1',
      '        subprocess.run(["setpriv", "--reuid=1000", "--regid=1000", "--clear-groups", "python3", sys.argv[2], sys.argv[3]], check=True)',
      '    return real(parent_fd, item)',
      'mod.reopen_stage = swapping',
      'sys.exit(mod.finish())',
    ].join('\n'));
    const done = spawnSync('python3', [harness, script, agentCode, parent], { input: JSON.stringify({ outside: list }), encoding: 'utf8', timeout: 60_000, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, UNIVERSE_COLD_HOME: w.home, UNIVERSE_COLD_FS: w.fsB } });
    expect(done.stdout).toContain('finished=0 reason=outside_tampered');
    expect(fs.readFileSync(path.join(parent, 'run.sh'), 'utf8')).toBe('what was there');
  });

  raceTest('two staging folders the agent swapped after the checks (so each name holds the other file) publish nothing: neither target gets the other file\'s bytes', () => {
    const w = world();
    fs.writeFileSync(path.join(w.fsA, 'opt/tool/other.sh'), 'other bytes\n');
    const list = packed(w);
    const parent = path.join(w.fsB, 'opt/tool');
    fs.mkdirSync(parent, { recursive: true });
    for (const folder of [dir, path.dirname(w.fsB), w.fsB, path.join(w.fsB, 'opt')]) fs.chmodSync(folder, 0o755);
    fs.writeFileSync(path.join(parent, 'run.sh'), 'what was there');
    fs.writeFileSync(path.join(parent, 'other.sh'), 'what else was there');
    spawnSync('chown', ['-R', '1000:1000', parent]);
    const agentCode = path.join(dir, `agent-${++counter}.py`);
    fs.writeFileSync(agentCode, [
      'import os, sys',
      'parent, a, b = sys.argv[1], sys.argv[2], sys.argv[3]',
      'os.rename(os.path.join(parent, a), os.path.join(parent, ".tmp-swap"))',
      'os.rename(os.path.join(parent, b), os.path.join(parent, a))',
      'os.rename(os.path.join(parent, ".tmp-swap"), os.path.join(parent, b))',
    ].join('\n'));
    const harness = path.join(dir, `names-swap-${counter}.py`);
    fs.writeFileSync(harness, [
      'import importlib.machinery, importlib.util, os, subprocess, sys',
      'loader = importlib.machinery.SourceFileLoader("cold", sys.argv[1])',
      'spec = importlib.util.spec_from_loader("cold", loader)',
      'mod = importlib.util.module_from_spec(spec)',
      'loader.exec_module(mod)',
      'real = mod.reopen_stage',
      'done = {"n": 0}',
      'def swapping(parent_fd, item):',
      '    if not done["n"] and item["parts"][-1] in ("run.sh", "other.sh"):',
      '        done["n"] = 1',
      '        held = {}',
      '        for name in os.listdir(parent_fd):',
      '            if name.startswith(".uc-"):',
      '                fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY, dir_fd=parent_fd)',
      '                try:',
      '                    inside = os.open("f", os.O_RDONLY, dir_fd=fd)',
      '                    held[os.read(inside, 3)] = name',
      '                    os.close(inside)',
      '                except OSError:',
      '                    pass',
      '                finally:',
      '                    os.close(fd)',
      '        subprocess.run(["setpriv", "--reuid=1000", "--regid=1000", "--clear-groups", "python3", sys.argv[2], sys.argv[3], held[b"#!/"], held[b"oth"]], check=True)',
      '    return real(parent_fd, item)',
      'mod.reopen_stage = swapping',
      'sys.exit(mod.finish())',
    ].join('\n'));
    const done = spawnSync('python3', [harness, script, agentCode, parent], { input: JSON.stringify({ outside: list }), encoding: 'utf8', timeout: 60_000, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, UNIVERSE_COLD_HOME: w.home, UNIVERSE_COLD_FS: w.fsB } });
    expect(done.stdout).toContain('finished=0 reason=outside_tampered');
    expect(fs.readFileSync(path.join(parent, 'run.sh'), 'utf8')).toBe('what was there');
    expect(fs.readFileSync(path.join(parent, 'other.sh'), 'utf8')).toBe('what else was there');
  });

  it('the old-proxy clean-up follows no link: a link at a settings file, or a link where a folder of it belongs, is left alone and what it points at is never rewritten; a plain file is cleaned', () => {
    const w = world();
    const manifest = packed(w);
    const elsewhere = path.join(path.dirname(w.home), `elsewhere-${counter}`);
    fs.mkdirSync(elsewhere, { recursive: true });
    const line = 'KEEP=1\nHTTP_PROXY=http://127.0.0.1:3128\n';
    fs.writeFileSync(path.join(elsewhere, 'target'), line);
    fs.writeFileSync(path.join(elsewhere, 'proxy.sh'), line);
    fs.mkdirSync(path.join(w.fsB, 'etc'), { recursive: true });
    fs.symlinkSync(path.join(elsewhere, 'target'), path.join(w.fsB, 'etc/environment'));
    fs.symlinkSync(elsewhere, path.join(w.fsB, 'etc/profile.d'));
    fs.writeFileSync(path.join(w.fsB, 'etc/hosts'), 'KEEP=1\nHTTP_PROXY=http://127.0.0.1:3128\n');
    expect(finishWith(w, manifest).stdout).toMatch(/finished=1/);
    expect(fs.readFileSync(path.join(elsewhere, 'target'), 'utf8')).toBe(line);
    expect(fs.readFileSync(path.join(elsewhere, 'proxy.sh'), 'utf8')).toBe(line);
    expect(fs.lstatSync(path.join(w.fsB, 'etc/environment')).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(w.fsB, 'etc/hosts'), 'utf8')).toBe('KEEP=1\n');
  });

  it('a pipe where a file of the list belongs does not hold the restore: it is refused, not waited on', () => {
    const w = world();
    const manifest = packed(w);
    fs.rmSync(path.join(w.outside, 'etc/app.conf'));
    spawnSync('mkfifo', [path.join(w.outside, 'etc/app.conf')]);
    const done = cold(w, 'finish', w.fsB, JSON.stringify({ outside: manifest }));
    expect(done.stdout).toMatch(/finished=0 reason=outside_tampered\n/);
  });

  it('the agent swaps the copy folder for a link right after the script made it: it is never followed, nothing is written through the link, and the computer is blocked (outside_link)', () => {
    const w = world();
    const victim = path.join(path.dirname(path.dirname(w.home)), `victim-race2-${counter}`);
    fs.mkdirSync(victim, { recursive: true });
    const done = patched(w, w.fsA, 'prepack', [
      'real_mkdir = os.mkdir',
      'def swapped(target, *args, **kwargs):',
      '    real_mkdir(target, *args, **kwargs)',
      '    if target == "outside" and kwargs.get("dir_fd") is not None:',
      '        os.rmdir(target, dir_fd=kwargs["dir_fd"])',
      `        os.symlink(${JSON.stringify(victim)}, target, dir_fd=kwargs["dir_fd"])`,
      'os.mkdir = swapped',
    ].join('\n'));
    expect(printed(done.stdout)).toMatchObject({ blocked: 'outside_link' });
    expect(fs.readdirSync(victim)).toEqual([]);
  });

  it('the agent swaps the copy folder for a link right after the script opened it: root writes only into the folder it holds open, never through the link (the swap is made at that exact moment, every time)', () => {
    const w = world();
    const victim = path.join(path.dirname(path.dirname(w.home)), `victim-race3-${counter}`);
    fs.mkdirSync(victim, { recursive: true });
    fs.writeFileSync(path.join(w.fsA, 'var/www/evil'), '* * * * * root id\n');
    const done = patched(w, w.fsA, 'prepack', [
      'real_open = os.open',
      'swapped = []',
      'def opened(target, *args, **kwargs):',
      '    fd = real_open(target, *args, **kwargs)',
      '    if target == "outside" and kwargs.get("dir_fd") is not None and not swapped:',
      '        swapped.append(1)',
      '        os.rename("outside", "outside.x", src_dir_fd=kwargs["dir_fd"], dst_dir_fd=kwargs["dir_fd"])',
      `        os.symlink(${JSON.stringify(victim)}, "outside", dir_fd=kwargs["dir_fd"])`,
      '    return fd',
      'os.open = opened',
    ].join('\n'));
    expect(fs.lstatSync(w.outside).isSymbolicLink()).toBe(true);
    expect(fs.readdirSync(victim)).toEqual([]);
    expect(printed(done.stdout).blocked).toBeNull();
    expect(fs.readFileSync(path.join(w.state, 'outside.x/var/www/evil'), 'utf8')).toBe('* * * * * root id\n');
  });
});
