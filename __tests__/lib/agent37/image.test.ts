/**
 * The image every Brick computer is made from: what is in it, that its scripts work (the model address and the take-over fence are run
 * for real here), and how Orbit builds it on Agent37 a step at a time. What cannot be run here (the screen, the browser, Hermes) is
 * proven on the first real machine.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { AddressInfo } from 'node:net';

jest.mock('@/lib/db', () => ({ prisma: {} }));

import { IMAGE_NAME, IMAGE_PORT, ensureImage, imageContext, tarOf, type ImageState, type ImageStore } from '@/lib/agent37/image';
import { DOCKERFILE, IMAGE_SETUP_VERSION, imageFiles, LOCAL_MODEL_PORT } from '@/lib/agent37/image-files';
import type { Agent37Client, TemplateBuild } from '@/lib/agent37/client';

const folder = mkdtempSync(join(tmpdir(), 'universe-image-'));
afterAll(() => rmSync(folder, { recursive: true, force: true }));
const have = (command: string) => spawnSync('sh', ['-c', `command -v ${command}`]).status === 0;
const hasPython = have('python3');
const python = hasPython ? it : it.skip;

const write = () => {
  const dir = join(folder, 'image');
  mkdirSync(dir, { recursive: true });
  for (const file of imageFiles()) writeFileSync(join(dir, file.name), file.text, { mode: file.mode });
  return dir;
};

describe('what is in the image', () => {
  it('builds on the base image, keeps its entrypoint, writes nothing into the masked home folder, and copies every file it has', () => {
    expect(DOCKERFILE.split('\n')[0]).toMatch(/^FROM ghcr\.io\/agent37-platform\/hermes-base:/);
    expect(DOCKERFILE).not.toMatch(/^\s*(ENTRYPOINT|CMD)\b/m);
    expect(DOCKERFILE).not.toContain('/home/node');
    expect(DOCKERFILE.trim().split('\n').at(-1)).toBe('USER node');
    expect(DOCKERFILE).toContain('BROWSER_CDP_URL=http://127.0.0.1:9222');
    for (const file of imageFiles().filter((entry) => entry.name !== 'Dockerfile')) {
      expect(DOCKERFILE).toContain(`/usr/local/bin/${file.name}`);
      expect(DOCKERFILE).toMatch(new RegExp(`COPY [^\\n]*\\b${file.name}\\b`));
    }
  });

  it('holds no key and no address of ours: the computer’s only credential is the job’s own, written when it runs', () => {
    for (const file of imageFiles()) expect(file.text).not.toMatch(/sk-[A-Za-z0-9]{10,}|Bearer [A-Za-z0-9_-]{20,}|AGENT37_API_KEY/);
  });

  it('packs into a gzipped folder with the Dockerfile at its root, and the same files always give the same bytes', () => {
    const a = imageContext();
    const b = imageContext();
    expect(a.hash).toBe(b.hash);
    expect(a.gzipped.equals(b.gzipped)).toBe(true);
    const dir = join(folder, 'unpacked');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(folder, 'context.tgz'), a.gzipped);
    const unpacked = spawnSync('tar', ['-xzf', join(folder, 'context.tgz'), '-C', dir]);
    expect(unpacked.status).toBe(0);
    for (const file of imageFiles()) expect(readFileSync(join(dir, file.name), 'utf8')).toBe(file.text);
    expect(gunzipSync(a.gzipped).length % 512).toBe(0);
  });

  it('changes its hash when a file changes, so a new build starts by itself', () => {
    const files = imageFiles();
    const same = tarOf(files);
    const changed = tarOf(files.map((file) => (file.name === 'universe-up' ? { ...file, text: file.text + '\n# change' } : file)));
    expect(same.equals(changed)).toBe(false);
    expect(IMAGE_SETUP_VERSION).toBeTruthy();
  });

  python('has scripts that are well formed', () => {
    const dir = write();
    for (const name of ['universe-up', 'universe-supervise', 'universe-clean']) expect(spawnSync('sh', ['-n', join(dir, name)]).status).toBe(0);
    for (const name of ['universe-proxy', 'universe-fence']) {
      const compiled = spawnSync('python3', ['-c', `import ast,sys;ast.parse(open(sys.argv[1]).read())`, join(dir, name)]);
      expect(compiled.status).toBe(0);
    }
  });

  it('writes Hermes’ config once, pointing only at the local model address, and says when Hermes must be restarted', () => {
    const up = imageFiles().find((file) => file.name === 'universe-up')!.text;
    expect(up).toContain(`base_url: http://127.0.0.1:${LOCAL_MODEL_PORT}/v1`);
    expect(up).toContain('api_mode: chat_completions');
    expect(up).toContain('restart=1');
    expect(up).toContain('ready=1');
    expect(up).toMatch(/ready=0 reason=(browser|model_address|screen)/);
  });
});

describe('the local model address', () => {
  let relay: Server;
  let relayBase: string;
  const seen: Array<{ method?: string; url?: string; auth?: string; body: string }> = [];
  let handler: (req: IncomingMessage, res: ServerResponse) => void;

  beforeAll(async () => {
    relay = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
        handler(req, res);
      });
    });
    await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve));
    relayBase = `http://127.0.0.1:${(relay.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => relay.close(() => resolve())));
  beforeEach(() => {
    seen.length = 0;
    handler = (_req, res) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true }));
  });

  async function withProxy(run: (base: string, home: string) => Promise<void>) {
    const dir = write();
    const home = mkdtempSync(join(folder, 'home-'));
    const port = 20_000 + Math.floor(Math.random() * 20_000);
    const child = spawn('python3', [join(dir, 'universe-proxy')], { env: { ...process.env, HOME: home, UNIVERSE_PROXY_PORT: String(port) }, stdio: 'ignore' });
    try {
      for (let tries = 0; tries < 50; tries++) {
        const up = await fetch(`http://127.0.0.1:${port}/v1/models`).then(() => true).catch(() => false);
        if (up) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      await run(`http://127.0.0.1:${port}`, home);
    } finally {
      child.kill('SIGKILL');
    }
  }
  const setRelay = (home: string, token: string, path = '') => {
    mkdirSync(join(home, '.universe'), { recursive: true });
    writeFileSync(join(home, '.universe', 'relay.json'), JSON.stringify({ url: `${relayBase}${path}`, token }));
  };

  python('says there is no key yet, in the shape a client reads, until the job’s key is written', async () => {
    await withProxy(async (base) => {
      const answer = await fetch(`${base}/v1/chat/completions`, { method: 'POST', body: '{}' });
      expect(answer.status).toBe(503);
      expect((await answer.json()).error.code).toBe('no_relay');
      expect(seen).toHaveLength(0);
    });
  });

  python('passes a call on with the job’s key in place of whatever the caller sent, and reads the key again on the next call', async () => {
    await withProxy(async (base, home) => {
      setRelay(home, 'cjt_first', '/prefix');
      const call = () => fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer universe-local' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }) });
      expect((await (await call()).json()).ok).toBe(true);
      expect(seen[0]).toMatchObject({ method: 'POST', url: '/prefix/v1/chat/completions', auth: 'Bearer cjt_first' });
      expect(JSON.parse(seen[0].body).messages[0].content).toBe('hi');
      // a new key is picked up with nothing restarted
      setRelay(home, 'cjt_second', '/prefix');
      await call();
      expect(seen[1].auth).toBe('Bearer cjt_second');
    });
  });

  python('passes the answer back as it comes, and the relay’s refusals as they are', async () => {
    await withProxy(async (base, home) => {
      setRelay(home, 'cjt_x');
      handler = (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: one\n\n');
        setTimeout(() => {
          res.write('data: two\n\n');
          res.end();
        }, 300);
      };
      const answer = await fetch(`${base}/v1/chat/completions`, { method: 'POST', body: '{}' });
      const reader = answer.body!.getReader();
      const first = await reader.read();
      const at = Date.now();
      // the first part arrives before the relay has finished
      expect(new TextDecoder().decode(first.value)).toContain('data: one');
      let rest = '';
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        rest += new TextDecoder().decode(part.value);
      }
      expect(rest).toContain('data: two');
      expect(Date.now() - at).toBeGreaterThanOrEqual(150);

      handler = (_req, res) => res.writeHead(429, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { code: 'insufficient_quota' } }));
      const refused = await fetch(`${base}/v1/chat/completions`, { method: 'POST', body: '{}' });
      expect(refused.status).toBe(429);
      expect((await refused.json()).error.code).toBe('insufficient_quota');
    });
  });

  python('says the address could not be reached, never hangs or shows an address or key', async () => {
    await withProxy(async (base, home) => {
      mkdirSync(join(home, '.universe'), { recursive: true });
      writeFileSync(join(home, '.universe', 'relay.json'), JSON.stringify({ url: 'http://127.0.0.1:9', token: 'cjt_secret' }));
      const answer = await fetch(`${base}/v1/models`);
      expect(answer.status).toBe(502);
      const text = await answer.text();
      expect(text).toContain('upstream_unreachable');
      expect(text).not.toContain('cjt_secret');
      expect(text).not.toContain('127.0.0.1:9');
    });
  });
});

describe('the take-over fence', () => {
  // Run in a process space of its own, so only what the scenario starts can be touched
  const isolated = hasPython && spawnSync('unshare', ['--pid', '--fork', '--mount-proc', 'true']).status === 0;
  (isolated ? it : it.skip)('stops what the agent started, keeps the gateway and the browser, and proves none is left', () => {
    const dir = write();
    mkdirSync(join(dir, 'bin'), { recursive: true });
    const scenario = `
cp /usr/bin/sleep ${dir}/bin/chromium
python3 -c "
import socket, subprocess, time
s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); s.bind(('127.0.0.1', 3737)); s.listen()
subprocess.Popen(['sleep', '300'])
time.sleep(300)" &
GW=$!
${dir}/bin/chromium 300 &
BR=$!
setsid sleep 301 </dev/null >/dev/null 2>&1 &
sh -c 'sleep 302' &
sleep 1
echo "before: $(python3 ${dir}/universe-fence --check)"
python3 ${dir}/universe-fence
echo "after: $(python3 ${dir}/universe-fence --check)"
for p in $GW $BR; do kill -0 $p 2>/dev/null && echo "alive" || echo "dead"; done
`;
    const run = spawnSync('unshare', ['--pid', '--fork', '--mount-proc', 'sh', '-c', scenario], { encoding: 'utf8', timeout: 60_000 });
    expect(run.stdout).toMatch(/before: remaining=[1-9]/);
    expect(run.stdout).toMatch(/killed=[1-9]/);
    expect(run.stdout).toMatch(/after: remaining=0/);
    expect(run.stdout.match(/alive/g)).toHaveLength(2);
    expect(run.stdout).not.toContain('dead');
  });
});

describe('building the image on Agent37', () => {
  const T0 = new Date('2026-11-15T12:00:00Z');
  const minutes = (n: number) => new Date(T0.getTime() + n * 60_000);

  function setup(builds: Array<Partial<TemplateBuild>> = []) {
    let saved: ImageState | null = null;
    const store: ImageStore = { get: async () => saved, set: async (value) => void (saved = value) };
    const calls: string[] = [];
    const uploaded: Uint8Array[] = [];
    let polls = 0;
    const fail: { create?: boolean; upload?: boolean; start?: boolean } = {};
    const client = {
      async createTemplateBuild(input: { name: string; sizeBytes: number; defaultPort?: number }) {
        calls.push(`create:${input.name}:${input.defaultPort}:${input.sizeBytes}`);
        if (fail.create) throw new Error('refused');
        return { id: `build-${calls.length}`, uploadUrl: 'https://upload.example.test/x' };
      },
      async uploadTemplateContext(_url: string, bytes: Uint8Array) {
        calls.push('upload');
        if (fail.upload) throw new Error('upload refused');
        uploaded.push(bytes);
      },
      async startTemplateBuild(id: string) {
        calls.push(`start:${id}`);
        if (fail.start) throw new Error('start refused');
      },
      async templateBuild(id: string): Promise<TemplateBuild> {
        calls.push(`poll:${id}`);
        const next = builds[Math.min(polls++, builds.length - 1)] ?? { status: 'building' };
        return { status: 'building', log: '', error: null, template: null, ...next };
      },
    } as unknown as Agent37Client;
    return { store, client, calls, uploaded, fail, state: () => saved, set: (value: ImageState | null) => (saved = value) };
  }

  it('starts a build of its content when there is none: packs, uploads, starts, and keeps the build’s id', async () => {
    const w = setup();
    const state = await ensureImage(w.client, w.store, T0);
    expect(state).toMatchObject({ state: 'building', hash: imageContext().hash, failures: 0 });
    expect(w.calls[0]).toMatch(new RegExp(`^create:${IMAGE_NAME}:${IMAGE_PORT}:\\d+$`));
    expect(w.calls.slice(1)).toEqual(['upload', `start:${state.buildId}`]);
    expect(w.uploaded[0].length).toBe(imageContext().gzipped.length);
  });

  it('is ready when the build succeeded, with the revision it published, and then does nothing more', async () => {
    const w = setup([{ status: 'building' }, { status: 'succeeded', template: { revision: 3, imageDigest: 'sha256:x' } }]);
    await ensureImage(w.client, w.store, T0);
    expect((await ensureImage(w.client, w.store, minutes(1))).state).toBe('building');
    const ready = await ensureImage(w.client, w.store, minutes(5));
    expect(ready).toMatchObject({ state: 'ready', revision: 3 });
    const before = w.calls.length;
    await ensureImage(w.client, w.store, minutes(10));
    expect(w.calls.length).toBe(before);
  });

  it('starts a new build when the content changed, even though the old one is ready', async () => {
    const w = setup();
    w.set({ hash: 'older', state: 'ready', buildId: 'b0', revision: 1, startedAt: T0.toISOString(), failures: 0, error: null });
    const state = await ensureImage(w.client, w.store, minutes(1));
    expect(state).toMatchObject({ state: 'building', hash: imageContext().hash });
    expect(w.calls[0]).toContain('create:');
  });

  it('records a failed build with its reason, and tries again only after a wait that doubles', async () => {
    const w = setup([{ status: 'failed', error: { code: 'build_failed', message: 'apt could not find chromium' } }]);
    await ensureImage(w.client, w.store, T0);
    const failed = await ensureImage(w.client, w.store, minutes(1));
    expect(failed).toMatchObject({ state: 'failed', failures: 1, error: 'apt could not find chromium' });
    // within the wait: nothing new is started
    const calls = w.calls.length;
    await ensureImage(w.client, w.store, minutes(3));
    expect(w.calls.length).toBe(calls);
    // after it: a new build, and the next wait is longer
    expect((await ensureImage(w.client, w.store, minutes(6))).state).toBe('building');
    await ensureImage(w.client, w.store, minutes(7));
    expect(w.state()).toMatchObject({ state: 'failed', failures: 2 });
    const second = w.calls.length;
    await ensureImage(w.client, w.store, minutes(15));
    expect(w.calls.length).toBe(second);
    await ensureImage(w.client, w.store, minutes(17));
    expect(w.calls.length).toBeGreaterThan(second);
  });

  it('counts a build that was made but could not be uploaded or started as failed, not as building for ever', async () => {
    for (const step of ['upload', 'start'] as const) {
      const w = setup();
      w.fail[step] = true;
      const state = await ensureImage(w.client, w.store, T0);
      expect(state).toMatchObject({ state: 'failed', failures: 1 });
      expect(w.state()?.state).toBe('failed');
    }
    const w = setup();
    w.fail.create = true;
    expect((await ensureImage(w.client, w.store, T0)).state).toBe('failed');
  });

  it('ends a build that has gone on for more than an hour', async () => {
    const w = setup();
    await ensureImage(w.client, w.store, T0);
    expect((await ensureImage(w.client, w.store, minutes(30))).state).toBe('building');
    expect((await ensureImage(w.client, w.store, minutes(61))).state).toBe('failed');
  });
});
