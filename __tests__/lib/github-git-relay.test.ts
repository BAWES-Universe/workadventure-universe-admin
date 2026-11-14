/**
 * The git relay with real git (game #2041): a real `git clone` and `git push` go through the relay, and "GitHub" is a real git
 * server on this machine (git http-backend), so what is checked is what git really sends and reads.
 */
import { execFile, execFileSync, spawn } from 'child_process';
import { promisify } from 'util';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import http from 'http';
import { tmpdir } from 'os';
import path from 'path';

jest.mock('@/lib/github/connection', () => ({
  GITHUB_SOURCE: 'github',
  readGitHubAuth: jest.fn(),
  gitHubTokenRefused: jest.fn(async () => undefined),
  gitHubToken: jest.fn(async () => ({ status: 'ok', token: 'ghu_owner', login: 'sara' })),
}));

import { gzipSync } from 'zlib';
import { gitHubTokenRefused } from '@/lib/github/connection';
import { MAX_PUSH_BYTES, readCapped, readPushCommands, readRelayPath, refusedPush, relayGit } from '@/lib/github/git-relay';

const PASS = { kind: 'git-pass' as const, botId: 'b', connectionId: 'c', ownerId: 'o', exp: Math.floor(Date.now() / 1000) + 900 };

/** "github.com", played by git http-backend over a bare repository: answers what the relay sends it, and keeps what it was sent. */
function pretendGitHub(root: string) {
  const seen: { url: string; authorization: string | undefined }[] = [];
  const impl = (async (url: string, init: RequestInit = {}) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    seen.push({ url, authorization: headers.Authorization });
    const parsed = new URL(url);
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
    const head = output.subarray(0, split).toString();
    const responseHeaders = new Headers();
    let status = 200;
    for (const line of head.split('\r\n')) {
      const [name, ...rest] = line.split(':');
      const value = rest.join(':').trim();
      if (name.toLowerCase() === 'status') status = parseInt(value, 10);
      else responseHeaders.set(name, value);
    }
    return new Response(new Uint8Array(output.subarray(split + 4)), { status, headers: responseHeaders });
  }) as unknown as typeof fetch;
  return { impl, seen };
}

/** The real-git part needs git's own HTTP server program, which every full git install has */
const hasHttpBackend = (() => {
  try {
    return existsSync(path.join(execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim(), 'git-http-backend'));
  } catch {
    return false;
  }
})();

(hasHttpBackend ? describe : describe.skip)('the git relay, with real git on both sides', () => {
  let work: string;
  let server: http.Server;
  let port = 0;
  let upstream: ReturnType<typeof pretendGitHub>;
  /** Seeding runs git directly; anything that talks to the relay must not block this process, which is the relay too */
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const run = promisify(execFile);
  const tryGit = async (cwd: string, ...args: string[]) => {
    try {
      const done = await run('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
      return { ok: true, out: `${done.stdout}${done.stderr}` };
    } catch (error) {
      const failed = error as { stderr?: string; stdout?: string };
      return { ok: false, out: `${failed.stdout ?? ''}${failed.stderr ?? ''}` };
    }
  };

  beforeAll(async () => {
    work = mkdtempSync(path.join(tmpdir(), 'relay-'));
    const root = path.join(work, 'github');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', path.join(root, 'acme', 'tools.git')]);
    execFileSync('git', ['config', 'http.receivepack', 'true'], { cwd: path.join(root, 'acme', 'tools.git') });
    // Something to start from: one commit and one tag that exist already
    const seed = path.join(work, 'seed');
    execFileSync('git', ['init', '-q', '-b', 'main', seed]);
    writeFileSync(path.join(seed, 'README.md'), 'hello\n');
    git(seed, '-c', 'user.name=s', '-c', 'user.email=s@e', 'commit', '-qam', 'first', '--allow-empty');
    git(seed, 'add', '.');
    git(seed, '-c', 'user.name=s', '-c', 'user.email=s@e', 'commit', '-qm', 'readme');
    git(seed, 'push', '-q', path.join(root, 'acme', 'tools.git'), 'main', 'main:refs/heads/old');
    upstream = pretendGitHub(root);

    // The relay, as Orbit's route runs it, on a port of this machine
    server = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const url = new URL(req.url ?? '/', 'http://relay');
      const target = readRelayPath(url.pathname.replace(/^\/api\/git\//, '').split('/'));
      if (!target) {
        res.writeHead(404).end();
        return;
      }
      const outcome = await relayGit(PASS, target, {
        method: req.method ?? 'GET',
        search: url.search,
        contentType: req.headers['content-type'] ?? null,
        contentEncoding: (req.headers['content-encoding'] as string | undefined) ?? null,
        gitProtocol: (req.headers['git-protocol'] as string | undefined) ?? null,
        body: req.method === 'POST' ? Buffer.concat(chunks) : null,
      }, upstream.impl);
      if (outcome.status !== 'pass' && outcome.status !== 'refused') {
        res.writeHead(400).end(outcome.status);
        return;
      }
      res.writeHead(outcome.response.status, Object.fromEntries(outcome.response.headers));
      res.end(Buffer.from(await outcome.response.arrayBuffer()));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    port = (server.address() as { port: number }).port;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    rmSync(work, { recursive: true, force: true });
  });

  it('clones, and pushes a new branch and a new commit, with the owner’s token added on the way', async () => {
    const clone = path.join(work, 'clone');
    expect(await tryGit(work, 'clone', '-q', `http://127.0.0.1:${port}/api/git/acme/tools.git`, clone)).toMatchObject({ ok: true });
    writeFileSync(path.join(clone, 'a.txt'), 'A\n');
    git(clone, 'add', '.');
    git(clone, '-c', 'user.name=sara', '-c', 'user.email=1+sara@users.noreply.github.com', 'commit', '-qm', 'a');
    expect(await tryGit(clone, 'push', '-q', 'origin', 'HEAD:refs/heads/feature')).toMatchObject({ ok: true });
    expect(await tryGit(clone, 'push', '-q', 'origin', 'HEAD:main')).toMatchObject({ ok: true });
    expect(upstream.seen.every((call) => call.url.startsWith('https://github.com/acme/tools.git/'))).toBe(true);
    expect(upstream.seen.every((call) => call.authorization === `Basic ${Buffer.from('x-access-token:ghu_owner').toString('base64')}`)).toBe(true);
    expect(git(path.join(work, 'github', 'acme', 'tools.git'), 'branch', '--list')).toContain('feature');
  });

  it('turns down deleting a branch and pushing a tag, and git says why', async () => {
    // Its own clone, so this runs on its own too
    const clone = path.join(work, 'clone-refused');
    expect(await tryGit(work, 'clone', '-q', `http://127.0.0.1:${port}/api/git/acme/tools.git`, clone)).toMatchObject({ ok: true });
    const deleted = await tryGit(clone, 'push', 'origin', '--delete', 'old');
    expect(deleted.ok).toBe(false);
    expect(deleted.out).toContain('[remote rejected] old (Deleting is not allowed for Bricks');
    git(clone, 'tag', 'v1');
    const tagged = await tryGit(clone, 'push', 'origin', 'v1');
    expect(tagged.ok).toBe(false);
    expect(tagged.out).toContain('[remote rejected] v1 -> v1 (Pushing tags is not allowed for Bricks');
    // A tag hidden among branches turns the whole push down
    const mixed = await tryGit(clone, 'push', 'origin', 'HEAD:refs/heads/other', 'v1');
    expect(mixed.ok).toBe(false);
    const branches = git(path.join(work, 'github', 'acme', 'tools.git'), 'branch', '--list');
    expect(branches).toContain('old');
    expect(branches).not.toContain('other');
    expect(git(path.join(work, 'github', 'acme', 'tools.git'), 'tag', '--list')).toBe('');
  });
});

describe('reading a git address and a push', () => {
  it('passes on only the smart protocol for owner/repo', () => {
    expect(readRelayPath(['acme', 'tools.git', 'info', 'refs'])).toEqual({ repo: 'acme/tools', step: 'info/refs' });
    expect(readRelayPath(['acme', 'tools', 'git-receive-pack'])).toEqual({ repo: 'acme/tools', step: 'git-receive-pack' });
    expect(readRelayPath(['acme', 'tools.git', 'info', 'lfs', 'objects'])).toBeNull();
    expect(readRelayPath(['..', 'x', 'info', 'refs'])).toBeNull();
    expect(readRelayPath(['acme', 'tools.git', 'HEAD'])).toBeNull();
  });

  it('reads the ref updates and refuses what cannot be read', () => {
    const line = (text: string) => `${(text.length + 4).toString(16).padStart(4, '0')}${text}`;
    const body = Buffer.from(`${line(`${'a'.repeat(40)} ${'b'.repeat(40)} refs/heads/main\0report-status side-band-64k\n`)}0000PACK`);
    expect(readPushCommands(body)).toEqual({ updates: [{ oldId: 'a'.repeat(40), newId: 'b'.repeat(40), ref: 'refs/heads/main' }], capabilities: ['report-status', 'side-band-64k'] });
    expect(readPushCommands(Buffer.from('zzzz'))).toBeNull();
    expect(readPushCommands(Buffer.from('0000'))).toBeNull();
    expect(refusedPush([{ oldId: 'a', newId: '0'.repeat(64), ref: 'refs/heads/main' }])).toContain('Deleting');
    expect(refusedPush([{ oldId: 'a', newId: 'b', ref: 'refs/notes/x' }])).toContain('Only branches');
    expect(refusedPush([{ oldId: 'a', newId: 'b', ref: 'refs/heads/main' }])).toBeNull();
  });

  const line = (text: string) => `${(text.length + 4).toString(16).padStart(4, '0')}${text}`;
  const push = (body: Buffer, contentEncoding: string | null) =>
    relayGit(PASS, { repo: 'acme/tools', step: 'git-receive-pack' }, { method: 'POST', search: '', contentType: 'application/x-git-receive-pack-request', contentEncoding, gitProtocol: null, body }, (async () => {
      throw new Error('nothing reaches GitHub here');
    }) as unknown as typeof fetch);

  it('unpacks only the start of a gzipped push: a small body that unpacks past the limit is turned down, never unpacked whole', async () => {
    // gzip packs at most about 1000 to 1, so a body that unpacks past the 200 MB limit is about 200 KB; a 4 KB one unpacks to 4 MB.
    // Both are turned down having unpacked no more than 1 MB.
    const bomb = gzipSync(Buffer.alloc(MAX_PUSH_BYTES + 1024 * 1024), { level: 9 });
    expect(bomb.length).toBeLessThan(250 * 1024);
    const small = gzipSync(Buffer.alloc(4 * 1024 * 1024), { level: 9 });
    expect(small.length).toBeLessThan(5 * 1024);
    const before = process.memoryUsage().rss;
    expect(await push(small, 'gzip')).toEqual({ status: 'bad_request' });
    expect(await push(bomb, 'gzip')).toEqual({ status: 'bad_request' });
    expect(process.memoryUsage().rss - before).toBeLessThan(100 * 1024 * 1024);
    expect(await push(Buffer.from('not gzip at all'), 'gzip')).toEqual({ status: 'bad_request' });
    // A real gzipped push is still read, and a tag in it still turned down
    const tag = Buffer.from(`${line(`${'0'.repeat(40)} ${'b'.repeat(40)} refs/tags/v1\0report-status\n`)}0000PACK`);
    expect(await push(gzipSync(tag), 'gzip')).toMatchObject({ status: 'refused', message: expect.stringContaining('Pushing tags') });
  });

  it('reads a streamed body only up to the limit, and stops there without reading the rest', async () => {
    let pulled = 0;
    let cancelled = false;
    const piece = new Uint8Array(1024);
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(piece);
      },
      cancel() {
        cancelled = true;
      },
    });
    expect(await readCapped(endless, 10 * 1024)).toBeNull();
    expect(pulled).toBeLessThan(20);
    expect(cancelled).toBe(true);
    const short = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3]));
        controller.close();
      },
    });
    expect([...((await readCapped(short, 10)) ?? [])]).toEqual([1, 2, 3]);
    expect((await readCapped(null, 10))?.length).toBe(0);
  });

  it('says GitHub could not be reached when the request fails, and asks for a new sign-in when GitHub refuses the token', async () => {
    const refs = (impl: typeof fetch) =>
      relayGit(PASS, { repo: 'acme/tools', step: 'info/refs' }, { method: 'GET', search: '?service=git-upload-pack', contentType: null, contentEncoding: null, gitProtocol: null, body: null }, impl);
    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    expect(await refs(down)).toEqual({ status: 'unavailable' });
    expect(gitHubTokenRefused).not.toHaveBeenCalled();
    const refused = (async () => new Response('Bad credentials', { status: 401 })) as unknown as typeof fetch;
    expect(await refs(refused)).toEqual({ status: 'reconnect' });
    expect(gitHubTokenRefused).toHaveBeenCalledWith('c', 'ghu_owner');
  });
});
