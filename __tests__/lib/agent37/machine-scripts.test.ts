/** @jest-environment node */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { imageFiles } from '@/lib/agent37/image-files';
import { createGateway, type Gateway } from '@/lib/egress/gateway';
import { defaultPolicy, mintEgressKey } from '@/lib/egress/policy';

/**
 * The scripts that run ON a computer, run for real: the forwarder in front of the egress gateway, and the restore that fetches a copy through it.
 * "The internet" is one local server that serves a copy; the gateway is the real one (its lookups and connections are pointed at that server).
 * Needs python3 and tar, as the computer's image has.
 */

const SECRET = 'a-test-secret-of-the-gateway';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'machine-scripts-'));
const scripts = path.join(dir, 'bin');
const text = (name: string) => imageFiles().find((file) => file.name === name)!.text;

let gateway: Gateway;
let gatewayPort = 0;
let server: http.Server;
let serverPort = 0;
let forwarder: ChildProcess | null = null;
let forwarderPort = 0;
let archive = Buffer.alloc(0);
let token = 'download-token';
let served = 0;

const freePort = () =>
  new Promise<number>((resolvePort) => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
      const port = (probe.address() as net.AddressInfo).port;
      probe.close(() => resolvePort(port));
    });
  });

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
function runCold(home: string, command: string, input: object | null, extra: Record<string, string> = {}): Promise<{ stdout: string; status: number | null }> {
  return new Promise((resolveRun, reject) => {
    const child = spawn('python3', [path.join(scripts, 'universe-cold'), command], { env: { ...process.env, UNIVERSE_COLD_HOME: home, UNIVERSE_COLD_PROXY: `http://127.0.0.1:${forwarderPort}`, ...extra } });
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

const startForwarder = async (conf: string) => {
  forwarderPort = await freePort();
  forwarder = spawn('python3', [path.join(scripts, 'universe-egress-forward')], { env: { ...process.env, UNIVERSE_EGRESS_CONF: conf, UNIVERSE_EGRESS_PORT: String(forwarderPort) }, stdio: 'ignore' });
  for (let tries = 0; tries < 50; tries++) {
    if (await new Promise<boolean>((done) => net.connect(forwarderPort, '127.0.0.1').once('connect', function (this: net.Socket) { this.destroy(); done(true); }).once('error', () => done(false)))) return;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error('The forwarder did not start');
};

beforeAll(async () => {
  fs.mkdirSync(scripts, { recursive: true });
  for (const name of ['universe-cold', 'universe-egress-forward', 'universe-egress']) fs.writeFileSync(path.join(scripts, name), text(name), { mode: 0o755 });
  server = http.createServer((req, res) => {
    if (req.url === '/health') return res.end('ok');
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401);
      return res.end();
    }
    served++;
    res.writeHead(200, { 'content-length': archive.length, 'content-type': 'application/gzip' });
    res.end(archive);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  serverPort = (server.address() as net.AddressInfo).port;
  gateway = createGateway({
    secret: SECRET,
    policy: () => ({ ...defaultPolicy(), allowedPorts: [8080, 80, 443] }),
    resolve: async (host) => {
      if (host === 'orbit.test') return ['93.184.216.34'];
      throw new Error('ENOTFOUND');
    },
    connect: () => net.connect({ host: '127.0.0.1', port: serverPort }),
    helloWaitMs: 500,
  });
  await new Promise<void>((done) => gateway.server.listen(0, '127.0.0.1', done));
  gatewayPort = (gateway.server.address() as net.AddressInfo).port;
  const key = mintEgressKey(SECRET, 'machine-1');
  const conf = path.join(dir, 'egress.json');
  fs.writeFileSync(conf, JSON.stringify({ gateways: [`127.0.0.1:${gatewayPort}`], user: key.user, pass: key.pass }));
  await startForwarder(conf);
});

afterAll(async () => {
  forwarder?.kill();
  gateway.server.closeAllConnections();
  await new Promise<void>((done) => gateway.server.close(() => done()));
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
  fs.rmSync(dir, { recursive: true, force: true });
});

const url = () => 'http://orbit.test:8080/archive';

describe('the forwarder in front of the gateway', () => {
  it('adds the computer\'s key, so the gateway names the computer', async () => {
    const answer = await new Promise<{ status: number; body: string }>((resolveAnswer, reject) => {
      http.get({ host: '127.0.0.1', port: forwarderPort, path: '/__egress/whoami' }, (response) => {
        let body = '';
        response.on('data', (data) => (body += data));
        response.on('end', () => resolveAnswer({ status: response.statusCode ?? 0, body }));
      }).on('error', reject);
    });
    expect(answer.status).toBe(200);
    expect(JSON.parse(answer.body)).toEqual({ ok: true, machine: 'machine-1' });
  });

  it('says 503 and sends nothing out when it has no settings', async () => {
    const empty = path.join(dir, 'empty.json');
    fs.writeFileSync(empty, '{}');
    const port = await freePort();
    const lonely = spawn('python3', [path.join(scripts, 'universe-egress-forward')], { env: { ...process.env, UNIVERSE_EGRESS_CONF: empty, UNIVERSE_EGRESS_PORT: String(port) }, stdio: 'ignore' });
    try {
      await new Promise((done) => setTimeout(done, 600));
      const status = await new Promise<number>((resolveStatus, reject) => {
        http.get({ host: '127.0.0.1', port, path: '/__egress/whoami' }, (response) => resolveStatus(response.statusCode ?? 0)).on('error', reject);
      });
      expect(status).toBe(503);
    } finally {
      lonely.kill();
    }
  });
});

describe('restoring a copy on a computer', () => {
  /** 'relative': names start with ./ (the home folder's contents). 'home': names start with the home folder's own path, as `home/node/...` does on a computer. */
  const makeArchive = (root: string, layout: 'relative' | 'home', homePath: string) =>
    layout === 'relative' ? spawnSync('tar', ['-czf', '-', '-C', root, '.']).stdout : spawnSync('tar', ['-czf', '-', '-C', root, '--transform', `s,^\\./,${homePath.replace(/^\//, '')}/,`, '.']).stdout;

  it.each([['relative'], ['home']] as const)('fetches the copy through the gateway, checks it, unpacks it and compares every file (%s names)', async (layout) => {
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
  it('universe-egress has no syntax error and refuses an unknown command', () => {
    expect(spawnSync('sh', ['-n', path.join(scripts, 'universe-egress')]).status).toBe(0);
    const unknown = spawnSync('sh', [path.join(scripts, 'universe-egress'), 'nothing'], { encoding: 'utf8' });
    expect(unknown.stdout).toContain('egress=0 reason=usage');
  });

  it('universe-egress apply refuses to run as anyone but root and writes nothing', () => {
    if (process.getuid && process.getuid() === 0) return;
    const done = spawnSync('sh', [path.join(scripts, 'universe-egress'), 'apply'], { encoding: 'utf8', input: '{}' });
    expect(done.stdout).toContain('egress=0 reason=not_root');
  });

  it('universe-cold prepack and finish refuse to run as anyone but root', async () => {
    if (process.getuid && process.getuid() === 0) return;
    expect((await runCold(path.join(dir, 'x'), 'prepack', null)).stdout).toContain('not_root');
    expect((await runCold(path.join(dir, 'x'), 'finish', null)).stdout).toContain('finished=0 reason=not_root');
  });
});
