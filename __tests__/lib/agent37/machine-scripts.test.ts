/** @jest-environment node */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { imageFiles } from '@/lib/agent37/image-files';

/**
 * The scripts that run ON a computer, run for real: the restore that fetches a copy straight from Orbit, and the clean-up of old proxy settings.
 * "Orbit" is one local server that serves a copy. Needs python3 and tar, as the computer's image has.
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'machine-scripts-'));
const scripts = path.join(dir, 'bin');
const text = (name: string) => imageFiles().find((file) => file.name === name)!.text;

let server: http.Server;
let serverPort = 0;
let archive = Buffer.alloc(0);
const token = 'download-token';
let served = 0;
let liveCounter = 0;
let altered: { from: number; body: Buffer } | null = null;

function writeTree(root: string) {
  const put = (name: string, content: string | Buffer) => {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  put('notes/plan.md', '# the plan\n'.repeat(500));
  put('projects/app/index.js', 'console.log("hi")\n');
  put('projects/app/data.bin', Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 7) % 256)));
  put('.hermes/memory/memories.json', JSON.stringify({ likes: ['tea'] }));
  put('.hermes/sessions/one.jsonl', '{"turn":1}\n{"turn":2}\n');
  put('.config/universe-chromium/Default/Preferences', '{"a":1}');
  put('.universe/setup', '1');
  put('.universe/logs/up.log', 'a log that keeps changing');
  fs.symlinkSync('notes/plan.md', path.join(root, 'plan-link'));
}

const tree = (root: string): string[] =>
  fs
    .readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => !entry.isDirectory())
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)))
    .filter((name) => !name.startsWith('.universe/logs'))
    .sort();

const sha = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex');

/** Asynchronous on purpose: the gateway runs in this process, so a blocked process would never answer the script that waits for it. */
function runCold(home: string, command: string, input: object | null, extra: Record<string, string> = {}, asUser = false): Promise<{ stdout: string; status: number | null }> {
  return new Promise((resolveRun, reject) => {
    // `asUser`: as the computer's own user (not root, as `restore` runs there), with the usual umask: tar then applies the umask to what it extracts unless it is told to keep the modes
    const child = asUser
      ? spawn('sh', ['-c', 'umask 022 && exec setpriv --reuid=1000 --regid=1000 --clear-groups python3 "$0" "$1"', path.join(scripts, 'universe-cold'), command], { env: { ...process.env, UNIVERSE_COLD_HOME: home, ...extra } })
      : spawn('python3', [path.join(scripts, 'universe-cold'), command], { env: { ...process.env, UNIVERSE_COLD_HOME: home, ...extra } });
    let stdout = '';
    child.stdout.on('data', (data) => (stdout += data));
    child.stderr.on('data', (d) => { if (process.env.DEBUG_COLD) console.error(String(d)); });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('universe-cold took too long'));
    }, 60_000);
    child.on('close', (status) => {
      clearTimeout(timer);
      resolveRun({ stdout, status });
    });
    if (input) child.stdin.write(JSON.stringify(input));
    child.stdin.end();
  });
}

beforeAll(async () => {
  fs.mkdirSync(scripts, { recursive: true });
  for (const name of ['universe-cold']) fs.writeFileSync(path.join(scripts, name), text(name), { mode: 0o755 });
  server = http.createServer((req, res) => {
    if (req.url === '/health') return res.end('ok');
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401);
      return res.end();
    }
    served++;
    // `altered`: from that request on, another copy is served (the restore reads the copy three times: its first names, the unpack, the comparison)
    const body = altered && served >= altered.from ? altered.body : archive;
    res.writeHead(200, { 'content-length': body.length, 'content-type': 'application/gzip' });
    res.end(body);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  serverPort = (server.address() as net.AddressInfo).port;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
  fs.rmSync(dir, { recursive: true, force: true });
});

const url = () => `http://127.0.0.1:${serverPort}/archive`;

describe('restoring a copy on a computer', () => {
  /** 'relative': names start with ./ (the home folder's contents). 'home': names start with the home folder's own path, as `home/node/...` does on a computer. */
  const makeArchive = (root: string, layout: 'relative' | 'home', homePath: string) =>
    layout === 'relative' ? spawnSync('tar', ['-czf', '-', '-C', root, '.']).stdout : spawnSync('tar', ['-czf', '-', '-C', root, '--transform', `s,^\\./,${homePath.replace(/^\//, '')}/,`, '.']).stdout;

  it.each([['relative'], ['home']] as const)('fetches the copy straight from Orbit, checks it, unpacks it and compares every file (%s names)', async (layout) => {
    const source = path.join(dir, `source-${layout}`, 'home', 'node');
    fs.mkdirSync(source, { recursive: true });
    writeTree(source);
    const target = layout === 'relative' ? path.join(dir, 'target-relative') : path.join(dir, 'target-home', 'home', 'node');
    fs.mkdirSync(target, { recursive: true });
    archive = makeArchive(source, layout, target);
    const done = await runCold(target, 'restore', { url: url(), token, sha256: sha(archive) });
    expect(done.stdout).toMatch(/restored=1 sha=[0-9a-f]{64} bytes=\d+/);
    expect(done.status).toBe(0);
    expect(tree(target)).toEqual(tree(source));
    expect(fs.readFileSync(path.join(target, 'projects/app/data.bin')).equals(fs.readFileSync(path.join(source, 'projects/app/data.bin')))).toBe(true);
    expect(fs.readlinkSync(path.join(target, 'plan-link'))).toBe('notes/plan.md');
  });

  it('compares every file with the copy for real: a file that differs from the copy when it is read again fails the restore', async () => {
    const source = path.join(dir, 'source-compare', 'home', 'node');
    fs.mkdirSync(source, { recursive: true });
    writeTree(source);
    const other = path.join(dir, 'source-compare-other', 'home', 'node');
    fs.mkdirSync(other, { recursive: true });
    writeTree(other);
    fs.writeFileSync(path.join(other, 'projects/app/index.js'), 'console.log("changed")\n');
    const target = path.join(dir, 'target-compare');
    fs.mkdirSync(target, { recursive: true });
    archive = makeArchive(source, 'relative', target);
    altered = { from: served + 3, body: makeArchive(other, 'relative', target) };
    try {
      const done = await runCold(target, 'restore', { url: url(), token, sha256: sha(archive) });
      expect(done.stdout).toMatch(/restored=0 reason=differs_\d+/);
      expect(done.status).toBe(1);
    } finally {
      altered = null;
    }
  });

  describe('the compare leaves out the files a running computer rewrites by itself (found on a real computer: the proof failed by chance on Hermes logs, the gateway heartbeat and the browser profile)', () => {
    const live = ['.hermes/logs/gateway.log', '.hermes/logs/agent.log', '.hermes/gateway.heartbeat', '.config/universe-chromium/Local State'];
    /** A copy served first, and another served to the compare in which `changed` differ (and the files in `live` are rewritten as a running computer would). */
    async function compared(changed: string[]) {
      const base = path.join(dir, `live-${++liveCounter}`);
      const source = path.join(base, 'a', 'home', 'node');
      const other = path.join(base, 'b', 'home', 'node');
      for (const root of [source, other]) {
        fs.mkdirSync(root, { recursive: true });
        writeTree(root);
        for (const name of live) {
          fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
          fs.writeFileSync(path.join(root, name), root === source ? 'before' : 'a later write');
        }
      }
      for (const name of changed) fs.writeFileSync(path.join(other, name), 'a real change');
      const target = path.join(base, 'target');
      fs.mkdirSync(target, { recursive: true });
      archive = makeArchive(source, 'relative', target);
      altered = { from: served + 3, body: makeArchive(other, 'relative', target) };
      try {
        return await runCold(target, 'restore', { url: url(), token, sha256: sha(archive) });
      } finally {
        altered = null;
      }
    }

    it('a copy whose Hermes logs, heartbeat and browser profile files were rewritten while it was compared still passes', async () => {
      const done = await compared([]);
      expect(done.stdout).toMatch(/restored=1 /);
      expect(done.status).toBe(0);
    });

    it('but any other file that differs still fails it, with the number of files that differ', async () => {
      const done = await compared(['.hermes/memory/memories.json']);
      expect(done.stdout).toMatch(/restored=0 reason=differs_1\b/);
      expect(done.status).toBe(1);
    });
  });

  const unprivileged = process.getuid?.() === 0 && spawnSync('setpriv', ['--version']).status === 0 ? it : it.skip;

  unprivileged('keeps the modes of what it restores when it runs as the computer\'s own user (a file of mode 0664, 0666 or 0775 is not cut down by the umask (the set-user-id bits are already gone from a list: the copy is handed over first), so finish finds what prepack listed; Seer on #1035)', async () => {
    const source = path.join(dir, 'source-modes', 'home', 'node');
    fs.mkdirSync(source, { recursive: true });
    writeTree(source);
    const modes: Record<string, number> = { 'shared/group-write.txt': 0o664, 'shared/world-write.txt': 0o666, 'shared/group-run.sh': 0o775, '.universe/outside/opt/tool/run.sh': 0o755, '.universe/outside/var/www/shared.txt': 0o666, '.universe/outside/etc/app.conf': 0o640, 'notes/read-only.md': 0o444 };
    for (const [name, mode] of Object.entries(modes)) {
      const file = path.join(source, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `content of ${name}`);
      fs.chmodSync(file, mode);
    }
    const target = path.join(dir, 'target-modes');
    fs.mkdirSync(target, { recursive: true });
    // The computer's own user owns its home folder, and must be able to reach the script and the folder
    for (const folder of [dir, scripts]) fs.chmodSync(folder, 0o755);
    fs.chownSync(target, 1000, 1000);
    // The copy is of the computer's own user's files, as on a computer (the compare checks the owner too)
    spawnSync('chown', ['-R', '1000:1000', source]);
    archive = makeArchive(source, 'relative', target);
    const done = await runCold(target, 'restore', { url: url(), token, sha256: sha(archive) }, {}, true);
    expect(done.stdout).toMatch(/restored=1 /);
    for (const [name, mode] of Object.entries(modes)) expect([name, fs.lstatSync(path.join(target, name)).mode & 0o7777]).toEqual([name, mode]);
  });

  it('counts a file as outside the image when its change time is later than the end of the unpack (plus the margin), even if it kept an old modification time', () => {
    // cp -p, tar x and rsync -a keep the old modification time; the change time is the day the file arrived
    const file = path.join(dir, 'kept-old-time');
    fs.writeFileSync(file, 'a tool unpacked into /opt');
    fs.utimesSync(file, new Date('2000-01-01'), new Date('2000-01-01'));
    const reference = Date.now() / 1000 - 3600;
    const ran = spawnSync(
      'python3',
      [
        '-c',
        [
          'import importlib.machinery, importlib.util, os, sys',
          'loader = importlib.machinery.SourceFileLoader("universe_cold", sys.argv[1])',
          'spec = importlib.util.spec_from_loader("universe_cold", loader)',
          'module = importlib.util.module_from_spec(spec)',
          'loader.exec_module(module)',
          'info = os.lstat(sys.argv[2])',
          'print(info.st_mtime < float(sys.argv[3]), module.newer_than(info, float(sys.argv[3]), float(sys.argv[3])))',
        ].join('\n'),
        path.join(scripts, 'universe-cold'),
        file,
        String(reference),
      ],
      { encoding: 'utf8' },
    );
    expect(ran.stdout.trim()).toBe('True True');
  });

  it('does not carry a job\'s key over from the copy', async () => {
    const source = path.join(dir, 'source-key');
    fs.mkdirSync(path.join(source, '.universe'), { recursive: true });
    fs.writeFileSync(path.join(source, '.universe', 'relay.json'), '{"token":"cjt_old"}');
    fs.writeFileSync(path.join(source, 'a.txt'), 'a');
    archive = spawnSync('tar', ['-czf', '-', '-C', source, '.']).stdout;
    const target = path.join(dir, 'target-key');
    fs.mkdirSync(target, { recursive: true });
    expect((await runCold(target, 'restore', { url: url(), token, sha256: sha(archive) })).stdout).toMatch(/restored=1/);
    expect(fs.existsSync(path.join(target, '.universe', 'relay.json'))).toBe(false);
    expect(fs.existsSync(path.join(target, 'a.txt'))).toBe(true);
  });

  it('refuses a copy whose bytes are not the stored ones (wrong checksum) and one that comes cut short or damaged', async () => {
    const source = path.join(dir, 'source-bad');
    fs.mkdirSync(source, { recursive: true });
    writeTree(source);
    archive = spawnSync('tar', ['-czf', '-', '-C', source, '.']).stdout;
    const target = path.join(dir, 'target-bad');
    fs.mkdirSync(target, { recursive: true });
    expect((await runCold(target, 'restore', { url: url(), token, sha256: '0'.repeat(64) })).stdout).toContain('restored=0 reason=checksum');
    const damaged = Buffer.from(archive);
    damaged[Math.floor(damaged.length / 2)] ^= 0xff;
    archive = damaged;
    const target2 = path.join(dir, 'target-bad-2');
    fs.mkdirSync(target2, { recursive: true });
    const out = (await runCold(target2, 'restore', { url: url(), token, sha256: sha(damaged) })).stdout;
    expect(out).toMatch(/restored=0 reason=(unreadable|unpack|compare|differs_\d+)/);
  });

  it('says it could not download when the copy is refused', async () => {
    archive = Buffer.from('x');
    const target = path.join(dir, 'target-refused');
    fs.mkdirSync(target, { recursive: true });
    const before = served;
    expect((await runCold(target, 'restore', { url: url(), token: 'wrong', sha256: sha(archive) })).stdout).toMatch(/restored=0 reason=(unreachable|download)/);
    expect(served).toBe(before);
  });
});

describe('the scripts are well formed', () => {
  it('universe-cold prepack and finish refuse to run as anyone but root', async () => {
    if (process.getuid && process.getuid() === 0) return;
    expect((await runCold(path.join(dir, 'x'), 'prepack', null)).stdout).toContain('not_root');
    expect((await runCold(path.join(dir, 'x'), 'finish', null)).stdout).toContain('finished=0 reason=not_root');
  });
});

describe('old proxy settings from a dropped design', () => {
  /** Runs only the clean-up function restore calls (the agent's own settings files, as the computer's own user), on a home folder in the temp folder (and only ever changes lines that name the old proxy). */
  const scrub = (home: string) =>
    spawnSync('python3', ['-I', '-c', `import os,sys\nsrc=open(sys.argv[1]).read().replace('if __name__ == "__main__":','if False:')\nexec(compile(src,'universe-cold','exec'))\ndrop_legacy_home()`, path.join(scripts, 'universe-cold')], { env: { ...process.env, UNIVERSE_COLD_HOME: home }, encoding: 'utf8' });

  it('removes lines that point software at the old local proxy from a restored home, and keeps every other line', () => {
    const home = path.join(dir, 'legacy-home');
    fs.mkdirSync(path.join(home, '.hermes'), { recursive: true });
    fs.writeFileSync(path.join(home, '.gitconfig'), '[user]\n\tname = Tea\n[http]\n\tproxy = http://127.0.0.1:3128\n');
    fs.writeFileSync(path.join(home, '.bashrc'), 'export PATH=$PATH:~/bin\nexport HTTPS_PROXY=http://127.0.0.1:3128\nalias ll="ls -l"\n');
    fs.writeFileSync(path.join(home, '.hermes', '.env'), 'MODEL=x\nHTTP_PROXY=http://127.0.0.1:3128\n');
    fs.writeFileSync(path.join(home, '.npmrc'), 'registry=https://registry.npmjs.org/\n');
    const done = scrub(home);
    expect(done.status).toBe(0);
    expect(fs.readFileSync(path.join(home, '.gitconfig'), 'utf8')).toBe('[user]\n\tname = Tea\n[http]\n');
    expect(fs.readFileSync(path.join(home, '.bashrc'), 'utf8')).toBe('export PATH=$PATH:~/bin\nalias ll="ls -l"\n');
    expect(fs.readFileSync(path.join(home, '.hermes', '.env'), 'utf8')).toBe('MODEL=x\n');
    // A file with no mention of it is not rewritten
    expect(fs.readFileSync(path.join(home, '.npmrc'), 'utf8')).toBe('registry=https://registry.npmjs.org/\n');
  });

  it('a restore ignores proxy settings in the environment and fetches straight from Orbit', async () => {
    const source = path.join(dir, 'source-env');
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, 'a.txt'), 'a');
    archive = spawnSync('tar', ['-czf', '-', '-C', source, '.']).stdout;
    const target = path.join(dir, 'target-env');
    fs.mkdirSync(target, { recursive: true });
    const dead = 'http://127.0.0.1:9';
    const done = await runCold(target, 'restore', { url: url(), token, sha256: sha(archive) }, { HTTP_PROXY: dead, HTTPS_PROXY: dead, http_proxy: dead, https_proxy: dead });
    expect(done.stdout).toMatch(/restored=1/);
    expect(fs.existsSync(path.join(target, 'a.txt'))).toBe(true);
  });
});
