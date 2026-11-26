/**
 * Git from a Brick's computer (game #2041, the computer's half), with real git on the computer and a real database. The computer is a
 * temporary home folder; what Orbit tells it to run when it readies a job (`prepareJob`) is run there with `sh`; `git clone`,
 * `commit` and `push` are then plain git, through Orbit's own route on a port of this machine, to a "GitHub" that is git's own server
 * (git http-backend) over bare repositories. Runs only with ROLES_DB_TEST=yes and a DATABASE_URL to a migrated THROWAWAY database:
 *
 *   ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest __tests__/api/computer-git-db.test.ts --runInBand
 */
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';

jest.mock('@/lib/service-tokens', () => ({ requireServiceToken: jest.fn() }));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn(async () => null) }));

import { prisma } from '@/lib/db';
import { encryptApiKey } from '@/lib/encryption';
import { createBrick } from '@/lib/brick-create';
import { saveMeterSettings } from '@/lib/meter';
import { grantToBrick, removeGrant } from '@/lib/app-connections';
import { readServerTools, setToolSetting } from '@/lib/mcp-tool-policy';
import { FakeComputerProvider, setComputerProviderForTests } from '@/lib/computer-provider';
import { giveComputer, handBack, startJob, stopJobFor, takeOver, turnOffComputer } from '@/lib/computer';
import { deleteBrick } from '@/lib/brick-delete';
import { prepareJob } from '@/lib/computer-broker';
import { mintJobToken, verifyJobToken } from '@/lib/computer-token';
import { jobGitAccess } from '@/lib/github/git-login';
import { checkGitKey, recheckGitKey, UPLOAD_GRACE_SECONDS } from '@/lib/github/git-relay';
import { GET as gitGet, POST as gitPost } from '@/app/api/git/[...path]/route';
import { POST as openPull } from '@/app/api/computer/github/pull/route';

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;
const hasHttpBackend = (() => {
  try {
    return existsSync(join(execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim(), 'git-http-backend'));
  } catch {
    return false;
  }
})();

const tag = randomUUID().slice(0, 8);
const NOW = new Date();
const RELAY = 'https://bot-server.example.test';
const ORBIT = 'https://orbit.example.com';
const envBefore = { url: process.env.ADMIN_API_URL, key: process.env.ENCRYPTION_KEY, provider: process.env.COMPUTER_PROVIDER };
const fetchBefore = global.fetch;
const people: string[] = [];
let made = 0;
let fake: FakeComputerProvider;
let work = '';
let port = 0;
let server: http.Server;
/** What "GitHub" was asked: the address and the sign-in it was given. */
let seen: { url: string; authorization: string | undefined }[] = [];
/** The pull requests "GitHub" was asked to open. */
let pulls: Record<string, unknown>[] = [];

async function person(name: string) {
  const unique = `${name}-${tag}-${++made}`;
  const user = await prisma.user.create({ data: { uuid: unique, email: `${unique}@example.test`, name } });
  people.push(user.id);
  const brick = await createBrick({ ownerId: user.id, name: `${name}'s Brick` });
  return { id: user.id, brickId: brick.id };
}

/** Sara has GitHub connected (signed in as sara-gh) and her Brick may use it, with a computer. */
async function saraWithGitHub() {
  const sara = await person('sara');
  const auth = { provider: 'github', accessToken: 'ghu_owner_token', refreshToken: 'ghr_x', expiresAt: Math.floor(Date.now() / 1000) + 8 * 3600, login: 'sara-gh', githubId: 501 };
  const connection = await prisma.appConnection.create({
    data: { ownerId: sara.id, name: 'GitHub', serverUrl: '', source: 'github', catalogKey: '@github', authType: 'oauth', authConfig: encryptApiKey(JSON.stringify(auth)) },
  });
  await grantToBrick(sara.id, connection.id, sara.brickId);
  await giveComputer(sara.brickId, sara.id);
  return { ...sara, connectionId: connection.id };
}

async function running(sara: { brickId: string; id: string }, writes = true) {
  const started = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Job', writes }, NOW);
  if (!started.ok) throw new Error(`the job did not start: ${started.reason}`);
  return started.job.id;
}

/** "GitHub": git http-backend over bare repositories; and its API's compare, answered from the same repositories. */
function pretendGitHub(root: string) {
  return (async (url: string, init: RequestInit = {}) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    seen.push({ url, authorization: headers.Authorization });
    const parsed = new URL(url);
    const compare = /^\/repos\/([^/]+\/[^/]+)\/compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})$/.exec(parsed.pathname);
    if (parsed.host === 'api.github.com' && compare) {
      const repo = join(root, `${compare[1]}.git`);
      const isAncestor = (a: string, b: string) => spawnSync('git', ['merge-base', '--is-ancestor', a, b], { cwd: repo }).status === 0;
      const status = compare[2] === compare[3] ? 'identical' : isAncestor(compare[2], compare[3]) ? 'ahead' : 'diverged';
      return new Response(JSON.stringify({ status }), { status: 200 });
    }
    if (parsed.host === 'api.github.com' && parsed.pathname === '/repos/acme/tools' && (init.method ?? 'GET') === 'GET') return new Response(JSON.stringify({ default_branch: 'main' }), { status: 200 });
    if (parsed.host === 'api.github.com' && parsed.pathname === '/repos/acme/tools/pulls' && init.method === 'POST') {
      pulls.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ number: 3, html_url: 'https://github.com/acme/tools/pull/3' }), { status: 201 });
    }
    if (parsed.host !== 'github.com') return new Response('{}', { status: 404 });
    const env = {
      ...process.env,
      GIT_PROJECT_ROOT: root,
      GIT_HTTP_EXPORT_ALL: '1',
      PATH_INFO: parsed.pathname,
      QUERY_STRING: parsed.search.slice(1),
      REQUEST_METHOD: init.method ?? 'GET',
      CONTENT_TYPE: headers['Content-Type'] ?? '',
      HTTP_CONTENT_ENCODING: headers['Content-Encoding'] ?? '',
      HTTP_GIT_PROTOCOL: headers['Git-Protocol'] ?? '',
      REMOTE_USER: 'sara',
      REMOTE_ADDR: '127.0.0.1',
    };
    const child = spawn('git', ['http-backend'], { env });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    if (init.body) child.stdin.end(Buffer.from(init.body as Uint8Array));
    else child.stdin.end();
    await new Promise((resolve) => child.on('close', resolve));
    const output = Buffer.concat(chunks);
    const split = output.indexOf('\r\n\r\n');
    const responseHeaders = new Headers();
    let status = 200;
    for (const line of output.subarray(0, split).toString().split('\r\n')) {
      const [name, ...rest] = line.split(':');
      const value = rest.join(':').trim();
      if (name.toLowerCase() === 'status') status = parseInt(value, 10);
      else responseHeaders.set(name, value);
    }
    return new Response(new Uint8Array(output.subarray(split + 4)), { status, headers: responseHeaders });
  }) as unknown as typeof fetch;
}

/** Orbit's git route, as Next runs it, on a port of this machine. */
function startOrbit(): Promise<http.Server> {
  const orbit = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    const request = new NextRequest(url, {
      method: req.method,
      headers: Object.fromEntries(Object.entries(req.headers).filter(([, v]) => typeof v === 'string') as [string, string][]),
      ...(req.method === 'POST' ? { body: Buffer.concat(chunks), duplex: 'half' } : {}),
    } as ConstructorParameters<typeof NextRequest>[1]);
    const path = url.pathname.replace(/^\/api\/git\//, '').split('/');
    const answer = url.pathname === '/api/computer/github/pull' ? await openPull(request) : await (req.method === 'POST' ? gitPost : gitGet)(request, { params: Promise.resolve({ path }) });
    res.writeHead(answer.status, Object.fromEntries(answer.headers));
    res.end(Buffer.from(await answer.arrayBuffer()));
  });
  return new Promise((resolve) => orbit.listen(0, '127.0.0.1', () => resolve(orbit)));
}

/** Run without blocking: Orbit's route runs in this same process and must answer while git waits for it. */
function runAsync(program: string, args: string[], options: { cwd?: string; env: NodeJS.ProcessEnv }): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(program, args, { cwd: options.cwd, env: options.env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}
const git = (cwd: string, home: string, ...args: string[]) =>
  runAsync('git', args, { cwd, env: { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_GLOBAL: join(home, '.gitconfig') } });
const sh = (home: string, command: string) => runAsync('sh', ['-c', command], { env: { ...process.env, HOME: home } });

/** Readies the job as Orbit does, runs what it sends on the "computer", and points the relay's https address at this machine's port. */
async function readyComputer(jobId: string, home: string) {
  const done = await prepareJob(jobId, RELAY, NOW);
  expect(done).toMatchObject({ ok: true });
  const command = fake.commands.at(-1)?.command ?? '';
  expect((await sh(home, command)).status).toBe(0);
  const config = join(home, '.universe', 'gitconfig');
  if (existsSync(config)) writeFileSync(config, readFileSync(config, 'utf8').split(ORBIT).join(`http://127.0.0.1:${port}`));
  const script = join(home, '.universe', 'open-pr');
  if (existsSync(script)) writeFileSync(script, readFileSync(script, 'utf8').split(ORBIT).join(`http://127.0.0.1:${port}`));
  return { done, command };
}

const all = (dir: string): string[] => readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? all(join(dir, name)) : [join(dir, name)]));
const openPr = (home: string, ...args: string[]) => runAsync('python3', [join(home, '.universe', 'open-pr'), ...args], { env: { ...process.env, HOME: home } });
const bare = () => join(work, 'github', 'acme', 'tools.git');
const branches = () => execFileSync('git', ['branch', '--list'], { cwd: bare(), encoding: 'utf8' });

const basic = (key: string) => `Basic ${Buffer.from(`x-universe-job:${key}`).toString('base64')}`;
const refsPath = ['acme', 'tools.git', 'info', 'refs'];
/** Orbit's git route asked directly, as a computer holding `key` (or the sign-in `header`) would. */
const askRefs = (header: string | null, service: 'git-upload-pack' | 'git-receive-pack') =>
  gitGet(new NextRequest(`${ORBIT}/api/git/acme/tools.git/info/refs?service=${service}`, { headers: header ? { authorization: header } : {} }), { params: Promise.resolve({ path: refsPath }) });
const pkt = (text: string) => `${(text.length + 4).toString(16).padStart(4, '0')}${text}`;
/** A push that makes one new branch at a commit GitHub already has: the commands, and a pack with nothing in it (what git sends). */
function newBranchPush(ref: string, id: string): Buffer {
  const header = Buffer.concat([Buffer.from('PACK'), Buffer.from([0, 0, 0, 2, 0, 0, 0, 0])]);
  return Buffer.concat([Buffer.from(`${pkt(`${'0'.repeat(40)} ${id} ${ref}\0report-status\n`)}0000`), header, createHash('sha1').update(header).digest()]);
}
const receivePost = (header: string | null, body: Buffer | ReadableStream<Uint8Array>, extra: Record<string, string> = {}) =>
  gitPost(
    new NextRequest(`${ORBIT}/api/git/acme/tools.git/git-receive-pack`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-git-receive-pack-request', ...(header ? { authorization: header } : {}), ...extra },
      body: body instanceof ReadableStream ? body : new Uint8Array(body),
      duplex: 'half',
    } as ConstructorParameters<typeof NextRequest>[1] & { duplex: 'half' }),
    { params: Promise.resolve({ path: ['acme', 'tools.git', 'git-receive-pack'] }) },
  );
const openPullWith = (header: string | null) =>
  openPull(new NextRequest(`${ORBIT}/api/computer/github/pull`, { method: 'POST', headers: { 'content-type': 'application/json', ...(header ? { authorization: header } : {}) }, body: JSON.stringify({ repo: 'acme/tools', head: 'for-pr', title: 'A change' }) }));
const mainTip = () => execFileSync('git', ['rev-parse', 'main'], { cwd: bare(), encoding: 'utf8' }).trim();
const hasBranch = (name: string) => branches().split('\n').some((line) => line.replace('*', '').trim() === name);

(hasHttpBackend ? run : describe.skip)('a Brick’s computer uses git as its owner, through Orbit', () => {
  beforeAll(async () => {
    process.env.COMPUTER_PROVIDER = 'fake';
    process.env.ADMIN_API_URL = ORBIT;
    process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
    work = mkdtempSync(join(tmpdir(), 'brick-git-'));
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare()]);
    execFileSync('git', ['config', 'http.receivepack', 'true'], { cwd: bare() });
    const seed = join(work, 'seed');
    execFileSync('git', ['init', '-q', '-b', 'main', seed]);
    writeFileSync(join(seed, 'README.md'), 'hello\n');
    execFileSync('git', ['add', '.'], { cwd: seed });
    execFileSync('git', ['-c', 'user.name=s', '-c', 'user.email=s@e', 'commit', '-qm', 'first'], { cwd: seed });
    execFileSync('git', ['push', '-q', bare(), 'main'], { cwd: seed });
    server = await startOrbit();
    port = (server.address() as AddressInfo).port;
  });
  beforeEach(async () => {
    fake = new FakeComputerProvider();
    setComputerProviderForTests(fake);
    global.fetch = pretendGitHub(join(work, 'github'));
    seen = [];
    pulls = [];
    await saveMeterSettings({ memberAllowanceMicros: 1_000_000, poolCeilingMicros: 100_000_000, reserveMicros: 0, storageMicrosPerGbMonth: 0, atOnceMember: 100, atOnceAll: 100, renewMinutes: 10 }, 'admin');
  });
  afterEach(async () => {
    global.fetch = fetchBefore;
    await prisma.computerJob.deleteMany({ where: { personId: { in: people } } });
    await prisma.brickComputer.deleteMany({ where: { bot: { ownerId: { in: people } } } });
    await prisma.appConnection.deleteMany({ where: { ownerId: { in: people } } });
  });
  afterAll(async () => {
    setComputerProviderForTests(null);
    await new Promise((resolve) => server.close(resolve));
    rmSync(work, { recursive: true, force: true });
    await prisma.meterEvent.deleteMany({});
    await prisma.meterReservation.deleteMany({});
    await prisma.appSetting.deleteMany({ where: { key: { in: ['meter', 'bot-limits'] } } });
    await prisma.user.deleteMany({ where: { id: { in: people } } });
    for (const [name, value] of [['ADMIN_API_URL', envBefore.url], ['ENCRYPTION_KEY', envBefore.key], ['COMPUTER_PROVIDER', envBefore.provider]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await prisma.$disconnect();
  });

  it('clones with plain `git clone https://github.com/…`, commits as the owner, and pushes branches; the owner’s token never reaches the computer', async () => {
    const sara = await saraWithGitHub();
    const jobId = await running(sara);
    const home = mkdtempSync(join(tmpdir(), 'brick-home-'));
    try {
      const { done } = await readyComputer(jobId, home);
      expect(done).toMatchObject({ git: true });
      const clone = join(home, 'tools');
      const cloned = await git(home, home, 'clone', '-q', 'https://github.com/acme/tools', clone);
      expect(cloned.stderr).toBe('');
      expect(cloned.status).toBe(0);
      // GitHub was asked with the owner's token, put on by Orbit
      expect(seen.some((call) => call.authorization === `Basic ${Buffer.from('x-access-token:ghu_owner_token').toString('base64')}`)).toBe(true);

      writeFileSync(join(clone, 'a.txt'), 'a\n');
      expect((await git(clone, home, 'add', '.')).status).toBe(0);
      // No identity given on the command line: it is the owner's, from the computer's git settings
      expect((await git(clone, home, 'commit', '-qm', 'add a')).status).toBe(0);
      expect((await git(clone, home, 'log', '-1', '--format=%an <%ae>')).stdout.trim()).toBe('sara-gh <501+sara-gh@users.noreply.github.com>');
      expect((await git(clone, home, 'push', '-q', 'origin', 'HEAD:refs/heads/feature')).status).toBe(0);
      expect(branches()).toContain('feature');
      // and adds to a branch that is there
      writeFileSync(join(clone, 'b.txt'), 'b\n');
      await git(clone, home, 'add', '.');
      await git(clone, home, 'commit', '-qm', 'add b');
      expect((await git(clone, home, 'push', '-q', 'origin', 'HEAD:refs/heads/feature')).status).toBe(0);
      expect(execFileSync('git', ['log', '--format=%s', 'feature'], { cwd: bare(), encoding: 'utf8' }).trim().split('\n')).toEqual(['add b', 'add a', 'first']);

      // Nothing the computer holds is the owner's token, GitHub's own or anyone's key to it
      for (const file of all(home).filter((f) => !f.includes('/.git/'))) expect(readFileSync(file, 'utf8')).not.toContain('ghu_owner_token');
      expect(readFileSync(join(clone, '.git', 'config'), 'utf8')).not.toMatch(/cjt_|ghu_/);
      // the key sits in one file only the machine's own user reads
      expect(statSync(join(home, '.universe', 'git-token')).mode & 0o077).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('turns down overwriting a branch, deleting one and pushing a tag, and git says why', async () => {
    const sara = await saraWithGitHub();
    const jobId = await running(sara);
    const home = mkdtempSync(join(tmpdir(), 'brick-home-'));
    try {
      await readyComputer(jobId, home);
      const clone = join(home, 'tools');
      expect((await git(home, home, 'clone', '-q', 'https://github.com/acme/tools', clone)).status).toBe(0);
      writeFileSync(join(clone, 'c.txt'), 'c\n');
      await git(clone, home, 'add', '.');
      await git(clone, home, 'commit', '-qm', 'add c');
      expect((await git(clone, home, 'push', '-q', 'origin', 'HEAD:refs/heads/work')).status).toBe(0);
      const before = execFileSync('git', ['rev-parse', 'work'], { cwd: bare(), encoding: 'utf8' });
      // history rewritten: the branch would lose a commit
      await git(clone, home, 'commit', '-q', '--amend', '-m', 'rewritten c');
      const forced = await git(clone, home, 'push', '--force', 'origin', 'HEAD:refs/heads/work');
      expect(forced.status).not.toBe(0);
      expect(forced.stderr).toMatch(/never overwrite/);
      expect((await git(clone, home, 'push', 'origin', '--delete', 'work')).stderr).toMatch(/Deleting is not allowed/);
      await git(clone, home, 'tag', 'v1');
      expect((await git(clone, home, 'push', 'origin', 'v1')).stderr).toMatch(/tags is not allowed/);
      expect(execFileSync('git', ['rev-parse', 'work'], { cwd: bare(), encoding: 'utf8' })).toBe(before);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('a job that is only to look clones and fetches, and its pushes are turned down before git packs anything', async () => {
    const sara = await saraWithGitHub();
    const jobId = await running(sara, false);
    const home = mkdtempSync(join(tmpdir(), 'brick-home-'));
    try {
      expect(await readyComputer(jobId, home)).toMatchObject({ done: { git: true } });
      const clone = join(home, 'tools');
      expect((await git(home, home, 'clone', '-q', 'https://github.com/acme/tools', clone)).status).toBe(0);
      writeFileSync(join(clone, 'd.txt'), 'd\n');
      await git(clone, home, 'add', '.');
      await git(clone, home, 'commit', '-qm', 'add d');
      const pushed = await git(clone, home, 'push', 'origin', 'HEAD:refs/heads/looked');
      expect(pushed.status).not.toBe(0);
      expect(pushed.stderr).toMatch(/may only read from GitHub for this job/);
      expect(branches()).not.toContain('looked');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('a job gets no git login when GitHub is not the owner’s to give: no GitHub for the Brick, or not the owner’s own job', async () => {
    const sara = await saraWithGitHub();
    const jobId = await running(sara);
    // Not the owner's own job (a job someone else gave the owner's Brick): no key and no files, and the old ones are removed
    await prisma.computerJob.update({ where: { id: jobId }, data: { personId: (await person('lee')).id } });
    expect(await jobGitAccess(jobId)).toBeNull();
    const home = mkdtempSync(join(tmpdir(), 'brick-home-'));
    try {
      writeFileSync(join(home, 'leftover'), 'x');
      await prisma.computerJob.update({ where: { id: jobId }, data: { personId: sara.id } });
      await readyComputer(jobId, home);
      expect(existsSync(join(home, '.universe', 'git-token'))).toBe(true);
      await prisma.computerJob.update({ where: { id: jobId }, data: { personId: (await person('lee2')).id } });
      const again = await prepareJob(jobId, RELAY, new Date(NOW.getTime() + 60_000));
      expect(again).toMatchObject({ ok: true, git: false });
      expect((await sh(home, fake.commands.at(-1)?.command ?? '')).status).toBe(0);
      expect(existsSync(join(home, '.universe', 'git-token'))).toBe(false);
      expect(existsSync(join(home, '.universe', 'gitconfig'))).toBe(false);
      // and the Brick with GitHub taken away
      await prisma.computerJob.update({ where: { id: jobId }, data: { personId: sara.id } });
      await removeGrant(sara.id, sara.connectionId, sara.brickId);
      expect(await jobGitAccess(jobId)).toBeNull();
      expect(await prepareJob(jobId, RELAY, new Date(NOW.getTime() + 120_000))).toMatchObject({ ok: true, git: false });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('stops the moment the person takes the computer, GitHub is taken from the Brick, or the job ends; a model key is no git key', async () => {
    const sara = await saraWithGitHub();
    const jobId = await running(sara);
    const home = mkdtempSync(join(tmpdir(), 'brick-home-'));
    try {
      await readyComputer(jobId, home);
      const command = fake.commands.at(-1)?.command ?? '';
      const modelKey = /"token":"(cjt_[A-Za-z0-9_-]+)"/.exec(command)?.[1] ?? '';
      const gitKey = readFileSync(join(home, '.universe', 'git-token'), 'utf8');
      expect(gitKey).toMatch(/^cjt_/);
      expect(gitKey).not.toBe(modelKey);
      expect(await verifyJobToken(gitKey, 'model', NOW)).toMatchObject({ ok: false });
      expect(await verifyJobToken(modelKey, 'git', NOW)).toMatchObject({ ok: false });
      expect(await verifyJobToken(gitKey, 'git', NOW)).toMatchObject({ ok: true, jobId });

      const clone = join(home, 'tools');
      expect((await git(home, home, 'clone', '-q', 'https://github.com/acme/tools', clone)).status).toBe(0);
      // The person takes over: the key goes with the control number, and git gets a refusal
      await takeOver(sara.brickId, sara.id, NOW);
      const fetched = await git(clone, home, 'fetch', '-q');
      expect(fetched.status).not.toBe(0);
      expect(fetched.stderr).toMatch(/401|Authentication failed|could not read/);
      expect(await verifyJobToken(gitKey, 'git', NOW)).toMatchObject({ ok: false });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('keeps the git key as long as the model key (the job’s lease renews both) and ends both when a new one is made', async () => {
    const sara = await saraWithGitHub();
    const jobId = await running(sara);
    const home = mkdtempSync(join(tmpdir(), 'brick-home-'));
    try {
      await readyComputer(jobId, home);
      const first = readFileSync(join(home, '.universe', 'git-token'), 'utf8');
      await prepareJob(jobId, RELAY, new Date(NOW.getTime() + 60_000));
      expect((await sh(home, fake.commands.at(-1)?.command ?? '')).status).toBe(0);
      const second = readFileSync(join(home, '.universe', 'git-token'), 'utf8');
      expect(second).not.toBe(first);
      expect((await verifyJobToken(first, 'git', new Date(NOW.getTime() + 60_000))).ok).toBe(false);
      expect((await verifyJobToken(second, 'git', new Date(NOW.getTime() + 60_000))).ok).toBe(true);
      // never in an https address that is not plain: no git login is made for it
      expect(JSON.stringify(fake.commands)).not.toMatch(/ghu_owner_token/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
  it('after pushing a branch, the computer opens the pull request as the owner; a job that only looks, and a job the person took over, cannot', async () => {
    const sara = await saraWithGitHub();
    const jobId = await running(sara);
    const home = mkdtempSync(join(tmpdir(), 'brick-home-'));
    try {
      await readyComputer(jobId, home);
      const clone = join(home, 'tools');
      expect((await git(home, home, 'clone', '-q', 'https://github.com/acme/tools', clone)).status).toBe(0);
      writeFileSync(join(clone, 'e.txt'), 'e\n');
      await git(clone, home, 'add', '.');
      await git(clone, home, 'commit', '-qm', 'add e');
      expect((await git(clone, home, 'push', '-q', 'origin', 'HEAD:refs/heads/for-pr')).status).toBe(0);
      const opened = await openPr(home, 'acme/tools', 'for-pr', 'Add e', 'Because e.');
      expect(opened).toMatchObject({ status: 0, stdout: 'https://github.com/acme/tools/pull/3\n' });
      // as the owner (her token, put on by Orbit), from the branch, onto the repository's own default branch
      expect(pulls).toEqual([{ head: 'for-pr', base: 'main', title: 'Add e', body: 'Because e.', draft: false }]);
      expect(seen.some((call) => call.url.endsWith('/repos/acme/tools/pulls') && call.authorization === 'Bearer ghu_owner_token')).toBe(true);
      // Only a pull request, and only with a good key
      const bad = await openPr(home, 'not a repo', 'for-pr', 'x');
      expect(bad.status).not.toBe(0);
      expect(pulls).toHaveLength(1);
      await takeOver(sara.brickId, sara.id, NOW);
      const afterTakeOver = await openPr(home, 'acme/tools', 'for-pr', 'Again');
      expect(afterTakeOver.status).not.toBe(0);
      expect(afterTakeOver.stderr).toMatch(/job key from Universe is needed/);
      expect(pulls).toHaveLength(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }

    const looker = await saraWithGitHub();
    const lookJob = await running(looker, false);
    const lookHome = mkdtempSync(join(tmpdir(), 'brick-home-'));
    try {
      await readyComputer(lookJob, lookHome);
      const refused = await openPr(lookHome, 'acme/tools', 'for-pr', 'Nope');
      expect(refused.status).not.toBe(0);
      expect(refused.stderr).toMatch(/may only read from GitHub/);
      expect(pulls).toHaveLength(1);
    } finally {
      rmSync(lookHome, { recursive: true, force: true });
    }
  });

  it('takes no sign-in but the running job’s git key: the old encrypted pass, a model key and made-up secrets get nowhere, and nothing goes to GitHub', async () => {
    const sara = await saraWithGitHub();
    const jobId = await running(sara);
    // A pass of the old kind, made with Orbit's own key for this very Brick, grant and owner, good for another 15 minutes
    const legacy = basic(encryptApiKey(JSON.stringify({ kind: 'git-pass', botId: sara.brickId, connectionId: sara.connectionId, ownerId: sara.id, exp: Math.floor(Date.now() / 1000) + 900 })));
    const model = await mintJobToken(jobId, 'model', NOW);
    if (!model.ok) throw new Error('no model key');
    const before = seen.length;
    for (const header of [null, legacy, basic(model.token), basic('made-up'), 'Bearer cjt_nope']) {
      expect((await askRefs(header, 'git-upload-pack')).status).toBe(401);
      expect((await askRefs(header, 'git-receive-pack')).status).toBe(401);
      expect((await receivePost(header, newBranchPush('refs/heads/nope', mainTip()))).status).toBe(401);
      expect((await openPullWith(header)).status).toBe(401);
      expect(await checkGitKey(header)).toBeNull();
    }
    expect(seen.length).toBe(before);
    expect(hasBranch('nope')).toBe(false);
    expect(pulls).toHaveLength(0);
    // and the route that used to give such a pass is gone
    expect(existsSync(join(process.cwd(), 'app', 'api', 'bots', '[id]', 'git-pass', 'route.ts'))).toBe(false);
  });

  /** Every way a job's git key can end, each with the key in the computer's hand: nothing it asks for after goes to GitHub. */
  const ways: [string, (sara: { id: string; brickId: string; connectionId: string }, jobId: string) => Promise<unknown>][] = [
    ['the job is stopped', (sara) => stopJobFor(sara.brickId, sara.id, NOW)],
    ['the person takes the computer', (sara) => takeOver(sara.brickId, sara.id, NOW)],
    ['GitHub is taken from the Brick', (sara) => removeGrant(sara.id, sara.connectionId, sara.brickId)],
    ['the owner’s GitHub connection is deleted', (sara) => prisma.appConnection.delete({ where: { id: sara.connectionId } })],
    ['the Brick is deleted', (sara) => deleteBrick(sara.brickId, sara.id, NOW)],
    ['the job is removed', (_sara, jobId) => prisma.computerJob.delete({ where: { id: jobId } })],
    ['the computer is turned off', (sara) => turnOffComputer(sara.brickId, sara.id, NOW)],
    ['the job turns out to be someone else’s', async (_sara, jobId) => prisma.computerJob.update({ where: { id: jobId }, data: { personId: (await person('other')).id } })],
    ['the key is revoked', (_sara, jobId) => prisma.computerJobToken.updateMany({ where: { jobId }, data: { revokedAt: new Date() } })],
    ['the key runs out', (_sara, jobId) => prisma.computerJobToken.updateMany({ where: { jobId }, data: { expiresAt: new Date(Date.now() - 60_000) } })],
  ];
  /** A key that only ran out still counts for an upload that began before (the grace); every other ending is final. */
  const onlyRanOut = 'the key runs out';
  it.each(ways)('the key stops for reading, pushing and opening a pull request, the moment %s', async (name, end) => {
    const sara = await saraWithGitHub();
    const jobId = await running(sara);
    const minted = await mintJobToken(jobId, 'git', NOW);
    if (!minted.ok) throw new Error('no key');
    const header = basic(minted.token);
    const tip = mainTip();
    // First, that it works: the same three things go through
    expect((await askRefs(header, 'git-upload-pack')).status).toBe(200);
    expect((await receivePost(header, newBranchPush('refs/heads/control', tip))).status).toBe(200);
    expect(hasBranch('control')).toBe(true);
    expect((await openPullWith(header)).status).toBe(200);
    expect(pulls).toHaveLength(1);
    const asked = seen.length;

    await end(sara, jobId);

    expect(await checkGitKey(header)).toBeNull();
    expect((await askRefs(header, 'git-upload-pack')).status).toBe(401);
    expect((await askRefs(header, 'git-receive-pack')).status).toBe(401);
    expect((await receivePost(header, newBranchPush('refs/heads/after', tip))).status).toBe(401);
    expect((await openPullWith(header)).status).toBe(401);
    // An upload already on its way when it ended gets nowhere either, whatever grace it has
    if (name === onlyRanOut) expect(await checkGitKey(header, UPLOAD_GRACE_SECONDS)).toMatchObject({ jobId });
    else expect(await checkGitKey(header, UPLOAD_GRACE_SECONDS)).toBeNull();
    expect(seen.length).toBe(asked);
    expect(hasBranch('after')).toBe(false);
    expect(pulls).toHaveLength(1);
  });

  it('a key made before a hand-back is dead after it, and the one made for the job after is good: nothing from the earlier control works', async () => {
    const sara = await saraWithGitHub();
    const jobId = await running(sara);
    const first = await mintJobToken(jobId, 'git', NOW);
    if (!first.ok) throw new Error('no key');
    expect((await askRefs(basic(first.token), 'git-upload-pack')).status).toBe(200);
    expect(await takeOver(sara.brickId, sara.id, NOW)).toMatchObject({ ok: true });
    expect(await handBack(sara.brickId, sara.id)).toMatchObject({ ok: true });
    // The job runs again, under a later control number: the old key is not brought back by that
    expect((await askRefs(basic(first.token), 'git-upload-pack')).status).toBe(401);
    expect(await checkGitKey(basic(first.token), UPLOAD_GRACE_SECONDS)).toBeNull();
    const second = await mintJobToken(jobId, 'git', NOW);
    if (!second.ok) throw new Error('no second key');
    expect((await askRefs(basic(second.token), 'git-upload-pack')).status).toBe(200);
  });

  it('a job that may only read cannot push by any road: not git’s own, and not a push sent by hand without asking first', async () => {
    const sara = await saraWithGitHub();
    const jobId = await running(sara, false);
    const minted = await mintJobToken(jobId, 'git', NOW);
    if (!minted.ok) throw new Error('no key');
    const header = basic(minted.token);
    expect((await askRefs(header, 'git-upload-pack')).status).toBe(200);
    const asked = seen.length;
    const advert = await askRefs(header, 'git-receive-pack');
    expect(await advert.text()).toContain('may only read from GitHub');
    const sent = await receivePost(header, newBranchPush('refs/heads/by-hand', mainTip()));
    expect(sent.status).toBe(403);
    expect(await sent.text()).toContain('may only read from GitHub');
    expect((await openPullWith(header)).status).toBe(403);
    expect(seen.length).toBe(asked);
    expect(hasBranch('by-hand')).toBe(false);
    expect(pulls).toHaveLength(0);
  });

  it('a job that may write loses that when the owner turns GitHub’s Changes things off: reading stays, pushing and pull requests go, and git says why', async () => {
    const sara = await saraWithGitHub();
    const jobId = await running(sara);
    const minted = await mintJobToken(jobId, 'git', NOW);
    if (!minted.ok) throw new Error('no key');
    const header = basic(minted.token);
    expect((await receivePost(header, newBranchPush('refs/heads/before-off', mainTip()))).status).toBe(200);
    await prisma.botMcpServer.updateMany({ where: { botId: sara.brickId }, data: { changeSetting: 'off' } });
    expect((await askRefs(header, 'git-upload-pack')).status).toBe(200);
    expect(await (await askRefs(header, 'git-receive-pack')).text()).toContain('ERR Commit files is off for sara\'s Brick in GitHub, so nothing was pushed.');
    const refused = await receivePost(header, newBranchPush('refs/heads/after-off', mainTip()));
    expect(refused.status).toBe(403);
    expect(await refused.text()).toContain('Commit files is off for sara\'s Brick in GitHub');
    const pull = await openPullWith(header);
    expect(pull.status).toBe(403);
    expect(await pull.json()).toMatchObject({ ok: false, error: 'Open a pull request is off for sara\'s Brick in GitHub, so no pull request was opened.' });
    expect(hasBranch('before-off')).toBe(true);
    expect(hasBranch('after-off')).toBe(false);
  });

  it('follows each GitHub action’s own choice once the grant is brought over: only Right away runs on a computer, and Asks first says to ask in chat', async () => {
    const sara = await saraWithGitHub();
    const grant = await prisma.botMcpServer.findFirstOrThrow({ where: { botId: sara.brickId, connectionId: sara.connectionId }, select: { id: true } });
    const brought = await readServerTools(sara.brickId, grant.id, { appActions: true });
    expect(brought.kind).toBe('appActions');
    const idOf = (name: string) => brought.tools.find((tool) => tool.name === name)!.id;
    const jobId = await running(sara);
    const minted = await mintJobToken(jobId, 'git', NOW);
    if (!minted.ok) throw new Error('no key');
    const header = basic(minted.token);
    // Everything on Right away: a new branch, and a pull request from it
    expect((await receivePost(header, newBranchPush('refs/heads/per-action', mainTip()))).status).toBe(200);
    expect(hasBranch('per-action')).toBe(true);
    expect((await openPullWith(header)).status).toBe(200);
    expect(pulls).toHaveLength(1);

    // Make a branch off: a push that makes one is turned down by git's own report; Commit files alone still runs
    await setToolSetting(sara.brickId, grant.id, idOf('github_create_branch'), 'off');
    const noBranch = await receivePost(header, newBranchPush('refs/heads/no-branch', mainTip()));
    const report = await noBranch.text();
    expect(report).toContain('ng refs/heads/no-branch');
    expect(report).toContain('Make a branch is off for sara\'s Brick in GitHub, so nothing was pushed.');
    expect(hasBranch('no-branch')).toBe(false);
    await setToolSetting(sara.brickId, grant.id, idOf('github_create_branch'), null);

    // Commit files asks first: a computer can't ask, so no push at all, and the words say where to ask
    await setToolSetting(sara.brickId, grant.id, idOf('github_write_files'), 'asksFirst');
    const advert = await (await askRefs(header, 'git-receive-pack')).text();
    expect(advert).toContain('ERR Commit files asks first for sara\'s Brick in GitHub, and a computer can\'t ask, so nothing was pushed. Ask your owner in chat: Commit files there shows them a card.');
    expect((await receivePost(header, newBranchPush('refs/heads/asks', mainTip()))).status).toBe(403);
    expect(hasBranch('asks')).toBe(false);
    await setToolSetting(sara.brickId, grant.id, idOf('github_write_files'), null);

    // Open a pull request asks first: none is opened
    await setToolSetting(sara.brickId, grant.id, idOf('github_create_pull_request'), 'asksFirst');
    const pull = await openPullWith(header);
    expect(pull.status).toBe(403);
    expect((await pull.json()).error).toMatch(/^Open a pull request asks first for sara's Brick in GitHub/);
    expect(pulls).toHaveLength(1);

    // Read a file off: no clone or fetch either
    await setToolSetting(sara.brickId, grant.id, idOf('github_read_file'), 'off');
    const asked = seen.length;
    expect(await (await askRefs(header, 'git-upload-pack')).text()).toContain('ERR Read a file is off for sara\'s Brick in GitHub, so this computer can\'t read from GitHub.');
    expect(seen.length).toBe(asked);
  });

  it('looks at the key again once a push is read: a push that was let in and then loses its job, its grant or its GitHub is not passed on', async () => {
    const sara = await saraWithGitHub();
    const tip = mainTip();
    // The upload is slow on purpose: `during` runs once the route has started reading, which is after it let the push in
    const slow = (body: Buffer, during: () => Promise<unknown>) => {
      let started = false;
      return new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            if (started) return controller.close();
            started = true;
            await during();
            controller.enqueue(new Uint8Array(body));
          },
        },
        { highWaterMark: 0 },
      );
    };
    const cases: [string, (jobId: string) => Promise<unknown>][] = [
      ['the person takes the computer', () => takeOver(sara.brickId, sara.id, NOW)],
      ['GitHub is taken from the Brick', () => removeGrant(sara.id, sara.connectionId, sara.brickId)],
      ['the key is revoked', (jobId) => prisma.computerJobToken.updateMany({ where: { jobId }, data: { revokedAt: new Date() } })],
      ['the job is stopped', () => stopJobFor(sara.brickId, sara.id, NOW)],
    ];
    for (const [index, [name, during]] of cases.entries()) {
      if (index > 0) {
        // A fresh job each time, and the grant back
        await prisma.computerJob.deleteMany({ where: { personId: sara.id } });
        await prisma.brickComputer.updateMany({ where: { botId: sara.brickId }, data: {} });
        await grantToBrick(sara.id, sara.connectionId, sara.brickId).catch(() => undefined);
      }
      const jobId = await running(sara);
      const minted = await mintJobToken(jobId, 'git', NOW);
      if (!minted.ok) throw new Error('no key');
      const asked = seen.length;
      const answer = await receivePost(basic(minted.token), slow(newBranchPush(`refs/heads/slow-${index}`, tip), () => during(jobId)), { 'transfer-encoding': 'chunked' });
      expect([name, answer.status]).toEqual([name, 401]);
      expect(seen.length).toBe(asked);
      expect(hasBranch(`slow-${index}`)).toBe(false);
    }
  });

  it('an upload whose key ran out while it was on its way still counts for a while, but not for ever', async () => {
    const sara = await saraWithGitHub();
    const jobId = await running(sara);
    const minted = await mintJobToken(jobId, 'git', NOW);
    if (!minted.ok) throw new Error('no key');
    const tip = mainTip();
    const upload = (ref: string, ranOutAgoMs: number) => {
      let started = false;
      return new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            if (started) return controller.close();
            started = true;
            await prisma.computerJobToken.updateMany({ where: { jobId }, data: { expiresAt: new Date(Date.now() - ranOutAgoMs) } });
            controller.enqueue(new Uint8Array(newBranchPush(ref, tip)));
          },
        },
        { highWaterMark: 0 },
      );
    };
    expect((await receivePost(basic(minted.token), upload('refs/heads/grace-one', 60_000), { 'transfer-encoding': 'chunked' })).status).toBe(200);
    expect(hasBranch('grace-one')).toBe(true);
    await prisma.computerJobToken.updateMany({ where: { jobId }, data: { expiresAt: new Date(Date.now() + 600_000) } });
    expect((await receivePost(basic(minted.token), upload('refs/heads/grace-two', (UPLOAD_GRACE_SECONDS + 60) * 1000), { 'transfer-encoding': 'chunked' })).status).toBe(401);
    expect(hasBranch('grace-two')).toBe(false);
  });

  it('a push is judged against the same job, owner, Brick and GitHub connection that let it in: a connection swapped while it uploaded is not the one that was let in', async () => {
    const sara = await saraWithGitHub();
    const jobId = await running(sara);
    const minted = await mintJobToken(jobId, 'git', NOW);
    if (!minted.ok) throw new Error('no key');
    const header = basic(minted.token);
    const before = await checkGitKey(header);
    expect(before).toMatchObject({ jobId, botId: sara.brickId, ownerId: sara.id, connectionId: sara.connectionId, readOnly: false });
    if (!before) throw new Error('no pass');
    expect(await recheckGitKey(header, before)).toMatchObject({ jobId });
    // Sara connects a second GitHub login and gives the Brick that one instead
    const auth = { provider: 'github', accessToken: 'ghu_other', refreshToken: 'ghr_y', expiresAt: Math.floor(Date.now() / 1000) + 8 * 3600, login: 'sara-other', githubId: 777 };
    const other = await prisma.appConnection.create({
      data: { ownerId: sara.id, name: 'GitHub 2', serverUrl: '', source: 'github', catalogKey: '@github-second', authType: 'oauth', authConfig: encryptApiKey(JSON.stringify(auth)) },
    });
    await removeGrant(sara.id, sara.connectionId, sara.brickId);
    await grantToBrick(sara.id, other.id, sara.brickId);
    // Still a good key (the Brick has GitHub), but not for the connection the push was let in under
    expect(await checkGitKey(header)).toMatchObject({ connectionId: other.id });
    expect(await recheckGitKey(header, before)).toBeNull();
    // a take-over moves the control number: a pass from before it is not the job as it stands
    const again = await checkGitKey(header);
    if (!again) throw new Error('no pass');
    await takeOver(sara.brickId, sara.id, NOW);
    expect(await recheckGitKey(header, again)).toBeNull();
  });

  it('never gives the computer the owner’s GitHub token, in what it is told to run, in what the relay answers, or in what a refusal says', async () => {
    const sara = await saraWithGitHub();
    const jobId = await running(sara);
    const home = mkdtempSync(join(tmpdir(), 'brick-home-'));
    try {
      const { command } = await readyComputer(jobId, home);
      for (const secret of ['ghu_owner_token', 'ghr_x']) {
        expect(command).not.toContain(secret);
        expect(JSON.stringify(fake.commands)).not.toContain(secret);
      }
      const header = basic(readFileSync(join(home, '.universe', 'git-token'), 'utf8'));
      const answers = [
        await askRefs(header, 'git-upload-pack'),
        await receivePost(header, newBranchPush('refs/heads/tokens', mainTip())),
        await openPullWith(header),
        await askRefs(basic('cjt_made-up-key-0000000000000000'), 'git-upload-pack'),
      ];
      for (const answer of answers) {
        const text = Buffer.from(await answer.arrayBuffer()).toString('latin1');
        expect(text).not.toContain('ghu_owner_token');
        expect(text).not.toContain('ghr_x');
        expect([...answer.headers.values()].join('\n')).not.toMatch(/ghu_|ghr_|x-access-token/);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
