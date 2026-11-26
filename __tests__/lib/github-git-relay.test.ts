/**
 * The git relay with real git (game #2041): a real `git clone` and `git push` go through the relay, and "GitHub" is a real git
 * server on this machine (git http-backend), so what is checked is what git really sends and reads.
 */
import crypto from 'node:crypto';
import { execFile, execFileSync, spawn, spawnSync } from 'child_process';
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
import { MAX_PUSH_BYTES, readCapped, readEncoding, readPushCommands, readRelayPath, refusedPush, relayGit } from '@/lib/github/git-relay';

const PASS = { jobId: 'j', generation: 0, botId: 'b', connectionId: 'c', ownerId: 'o', readOnly: false, stops: { read: null, push: null, branch: null, pullRequest: null } };

/** "github.com", played by git http-backend over a bare repository: answers what the relay sends it, and keeps what it was sent. */
function pretendGitHub(root: string) {
  const seen: { url: string; authorization: string | undefined }[] = [];
  const impl = (async (url: string, init: RequestInit = {}) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    seen.push({ url, authorization: headers.Authorization });
    const parsed = new URL(url);
    // GitHub's compare of two commits, played by git itself
    const compare = /^\/repos\/([^/]+\/[^/]+)\/compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})$/.exec(parsed.pathname);
    if (parsed.host === 'api.github.com' && compare) {
      const dir = path.join(root, `${compare[1]}.git`);
      const isAncestor = (a: string, b: string) => spawnSync('git', ['merge-base', '--is-ancestor', a, b], { cwd: dir }).status === 0;
      const status = compare[2] === compare[3] ? 'identical' : isAncestor(compare[2], compare[3]) ? 'ahead' : isAncestor(compare[3], compare[2]) ? 'behind' : 'diverged';
      return new Response(JSON.stringify({ status }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
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
    expect(upstream.seen.every((call) => call.url.startsWith('https://github.com/acme/tools.git/') || call.url.startsWith('https://api.github.com/repos/acme/tools/compare/'))).toBe(true);
    expect(upstream.seen.filter((call) => call.url.startsWith('https://github.com/')).every((call) => call.authorization === `Basic ${Buffer.from('x-access-token:ghu_owner').toString('base64')}`)).toBe(true);
    expect(upstream.seen.filter((call) => call.url.startsWith('https://api.github.com/')).every((call) => call.authorization === 'Bearer ghu_owner')).toBe(true);
    expect(git(path.join(work, 'github', 'acme', 'tools.git'), 'branch', '--list')).toContain('feature');
  });

  it('passes on a push bigger than git sends in one go (git first sends a bare flush to probe, then the push in pieces)', async () => {
    const clone = path.join(work, 'clone-big');
    expect(await tryGit(work, 'clone', '-q', `http://127.0.0.1:${port}/api/git/acme/tools.git`, clone)).toMatchObject({ ok: true });
    writeFileSync(path.join(clone, 'big.bin'), crypto.randomBytes(64 * 1024));
    git(clone, 'add', '.');
    git(clone, '-c', 'user.name=sara', '-c', 'user.email=1+sara@users.noreply.github.com', 'commit', '-qm', 'big');
    const pushed = await tryGit(clone, '-c', 'http.postBuffer=4096', 'push', '-q', 'origin', 'HEAD:refs/heads/big');
    expect(pushed).toMatchObject({ ok: true });
    expect(git(path.join(work, 'github', 'acme', 'tools.git'), 'branch', '--list')).toContain('big');
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

  it('lets a branch grow but never be overwritten: a forced push, an amended commit and a move back are turned down, and git says why', async () => {
    const repo = path.join(work, 'github', 'acme', 'tools.git');
    const clone = path.join(work, 'clone-overwrite');
    const as = ['-c', 'user.name=sara', '-c', 'user.email=1+sara@users.noreply.github.com'];
    expect(await tryGit(work, 'clone', '-q', `http://127.0.0.1:${port}/api/git/acme/tools.git`, clone)).toMatchObject({ ok: true });
    // A branch of its own, then two commits added to it one after the other: both are additions
    writeFileSync(path.join(clone, 'o1.txt'), '1\n');
    git(clone, 'add', '.');
    git(clone, ...as, 'commit', '-qm', 'one');
    expect(await tryGit(clone, 'push', '-q', 'origin', 'HEAD:refs/heads/work')).toMatchObject({ ok: true });
    writeFileSync(path.join(clone, 'o2.txt'), '2\n');
    git(clone, 'add', '.');
    git(clone, ...as, 'commit', '-qm', 'two');
    expect(await tryGit(clone, 'push', '-q', 'origin', 'HEAD:work')).toMatchObject({ ok: true });
    const tip = git(repo, 'rev-parse', 'work').trim();
    // An amended commit pushed with force: the same ref update as an addition, but not built on the branch
    git(clone, ...as, 'commit', '-q', '--amend', '-m', 'two, again');
    const forced = await tryGit(clone, 'push', '-f', 'origin', 'HEAD:work');
    expect(forced.ok).toBe(false);
    expect(forced.out).toContain('Bricks add to a branch, they never overwrite one');
    // A branch moved back to an older commit: the pack carries nothing, so nothing proves it builds on the tip
    const back = await tryGit(clone, 'push', '-f', 'origin', 'HEAD~2:work');
    expect(back.ok).toBe(false);
    // The default branch cannot be reset to a history of its own either (a commit with no parent)
    const orphan = git(clone, ...as, 'commit-tree', 'HEAD^{tree}', '-m', 'orphan').trim();
    const reset = await tryGit(clone, 'push', '-f', 'origin', `${orphan}:refs/heads/main`);
    expect(reset.ok).toBe(false);
    expect(git(repo, 'rev-parse', 'work').trim()).toBe(tip);
    // A merge that brings another line of history in still builds on the branch
    git(clone, 'reset', '-q', '--hard', tip);
    git(clone, ...as, 'checkout', '-q', '-b', 'side', 'HEAD~1');
    writeFileSync(path.join(clone, 'side.txt'), 's\n');
    git(clone, 'add', '.');
    git(clone, ...as, 'commit', '-qm', 'side');
    git(clone, ...as, 'merge', '-q', '--no-ff', '-m', 'merge', tip);
    expect(await tryGit(clone, 'push', '-q', 'origin', 'HEAD:work')).toMatchObject({ ok: true });
    expect(git(repo, 'rev-parse', 'work').trim()).not.toBe(tip);
  });

  it('lets a branch move up onto commits that stand on a commit GitHub already has elsewhere, and still turns down a line that does not (the thin pack leaves that commit out)', async () => {
    const repo = path.join(work, 'github', 'acme', 'tools.git');
    const clone = path.join(work, 'clone-stacked');
    const as = ['-c', 'user.name=sara', '-c', 'user.email=1+sara@users.noreply.github.com'];
    expect(await tryGit(work, 'clone', '-q', `http://127.0.0.1:${port}/api/git/acme/tools.git`, clone)).toMatchObject({ ok: true });
    const stale = git(clone, 'rev-parse', 'HEAD').trim();
    // F goes to a branch of its own; G is built on F and pushed to main, which is still where it was: the pack carries G alone
    writeFileSync(path.join(clone, 'f.txt'), 'F\n');
    git(clone, 'add', '.');
    git(clone, ...as, 'commit', '-qm', 'F');
    expect(await tryGit(clone, 'push', '-q', 'origin', 'HEAD:refs/heads/stack')).toMatchObject({ ok: true });
    writeFileSync(path.join(clone, 'g.txt'), 'G\n');
    git(clone, 'add', '.');
    git(clone, ...as, 'commit', '-qm', 'G');
    expect(await tryGit(clone, 'push', '-q', 'origin', 'HEAD:main')).toMatchObject({ ok: true });
    const tip = git(repo, 'rev-parse', 'main').trim();
    // A commit built on where main used to be is not on top of main now: turned down, main stays
    git(clone, ...as, 'checkout', '-q', '-b', 'old-line', stale);
    writeFileSync(path.join(clone, 'x.txt'), 'X\n');
    git(clone, 'add', '.');
    git(clone, ...as, 'commit', '-qm', 'X');
    const diverged = await tryGit(clone, 'push', '-f', 'origin', 'HEAD:main');
    expect(diverged.ok).toBe(false);
    expect(diverged.out).toContain('never overwrite');
    expect(git(repo, 'rev-parse', 'main').trim()).toBe(tip);
  });

  it('judges every ref of a push that names several: new branches and one that grows go together, and one overwrite, delete or tag among them turns the whole push down', async () => {
    const repo = path.join(work, 'github', 'acme', 'tools.git');
    const clone = path.join(work, 'clone-multi');
    const as = ['-c', 'user.name=sara', '-c', 'user.email=1+sara@users.noreply.github.com'];
    expect(await tryGit(work, 'clone', '-q', `http://127.0.0.1:${port}/api/git/acme/tools.git`, clone)).toMatchObject({ ok: true });
    writeFileSync(path.join(clone, 'm1.txt'), '1\n');
    git(clone, 'add', '.');
    git(clone, ...as, 'commit', '-qm', 'm1');
    expect(await tryGit(clone, 'push', '-q', 'origin', 'HEAD:refs/heads/grow')).toMatchObject({ ok: true });
    const grown = git(repo, 'rev-parse', 'grow').trim();
    writeFileSync(path.join(clone, 'm2.txt'), '2\n');
    git(clone, 'add', '.');
    git(clone, ...as, 'commit', '-qm', 'm2');
    // Two new branches and one that grows, in one push: all are additions
    expect(await tryGit(clone, 'push', '-q', 'origin', 'HEAD:refs/heads/new-a', 'HEAD:refs/heads/new-b', 'HEAD:refs/heads/grow')).toMatchObject({ ok: true });
    const branches = git(repo, 'branch', '--list');
    expect(branches).toContain('new-a');
    expect(branches).toContain('new-b');
    expect(git(repo, 'rev-parse', 'grow').trim()).not.toBe(grown);
    // An overwrite hidden among additions turns the whole push down: the additions do not go either
    const tip = git(repo, 'rev-parse', 'grow').trim();
    git(clone, ...as, 'commit', '-q', '--amend', '-m', 'm2 again');
    const mixed = await tryGit(clone, 'push', '-f', 'origin', 'HEAD:refs/heads/new-c', 'HEAD:refs/heads/grow');
    expect(mixed.ok).toBe(false);
    expect(mixed.out).toContain('never overwrite');
    expect(git(repo, 'branch', '--list')).not.toContain('new-c');
    expect(git(repo, 'rev-parse', 'grow').trim()).toBe(tip);
    // A delete, and a tag, hidden among additions, the same
    const deleted = await tryGit(clone, 'push', 'origin', 'HEAD:refs/heads/new-d', ':new-a');
    expect(deleted.ok).toBe(false);
    expect(git(repo, 'branch', '--list')).toContain('new-a');
    expect(git(repo, 'branch', '--list')).not.toContain('new-d');
  });

  /**
   * Git itself never compresses a push (only a fetch), but the protocol allows a gzipped body and the relay reads it, so these are sent
   * by hand: the commands and a real pack made by git, gzipped, to the relay as a client that compresses would.
   */
  const pkt = (text: string) => `${(text.length + 4).toString(16).padStart(4, '0')}${text}`;
  async function handPush(clone: string, updates: { old: string | null; id: string; ref: string }[], base: string | null, encoding: string | null = 'gzip') {
    const zero = '0'.repeat(40);
    const commands = updates.map((update, at) => pkt(`${update.old ?? zero} ${update.id} ${update.ref}${at === 0 ? '\0report-status\n' : '\n'}`)).join('');
    const wanted = updates.filter((update) => update.id !== zero).map((update) => update.id);
    const pack = wanted.length ? execFileSync('git', ['pack-objects', '--revs', '--stdout', '-q'], { cwd: clone, input: `${wanted.join('\n')}\n${base ? `^${base}\n` : ''}`, maxBuffer: 64 * 1024 * 1024 }) : Buffer.alloc(0);
    const body = Buffer.concat([Buffer.from(`${commands}0000`), pack]);
    const sent = encoding === 'gzip' ? gzipSync(body) : body;
    const response = await fetch(`http://127.0.0.1:${port}/api/git/acme/tools.git/git-receive-pack`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-git-receive-pack-request', ...(encoding ? { 'content-encoding': encoding } : {}) },
      body: new Uint8Array(sent),
    });
    return { status: response.status, text: Buffer.from(await response.arrayBuffer()).toString('latin1') };
  }

  it('reads a gzipped push as GitHub will: a gzipped addition goes through, a gzipped overwrite, delete or tag is turned down, and nothing else is taken as a way of packing', async () => {
    const repo = path.join(work, 'github', 'acme', 'tools.git');
    const clone = path.join(work, 'clone-gzip');
    const as = ['-c', 'user.name=sara', '-c', 'user.email=1+sara@users.noreply.github.com'];
    expect(await tryGit(work, 'clone', '-q', `http://127.0.0.1:${port}/api/git/acme/tools.git`, clone)).toMatchObject({ ok: true });
    const main = git(clone, 'rev-parse', 'HEAD').trim();
    const commit = (name: string) => {
      writeFileSync(path.join(clone, `${name}.txt`), `${name}\n`.repeat(50));
      git(clone, 'add', '.');
      git(clone, ...as, 'commit', '-qm', name);
      return git(clone, 'rev-parse', 'HEAD').trim();
    };
    const one = commit('z1');
    // A gzipped new branch goes through
    const made = await handPush(clone, [{ old: null, id: one, ref: 'refs/heads/zip' }], main);
    expect(made.text).toContain('ok refs/heads/zip');
    expect(git(repo, 'rev-parse', 'zip').trim()).toBe(one);
    // ...and a gzipped addition to it, which is proved against the unpacked pack
    const two = commit('z2');
    expect((await handPush(clone, [{ old: one, id: two, ref: 'refs/heads/zip' }], one)).text).toContain('ok refs/heads/zip');
    expect(git(repo, 'rev-parse', 'zip').trim()).toBe(two);
    // An amended commit (built on the old parent, not on the tip): turned down, the branch stays
    git(clone, 'reset', '-q', '--hard', one);
    const amended = commit('z2-again');
    const forced = await handPush(clone, [{ old: two, id: amended, ref: 'refs/heads/zip' }], one);
    expect(forced.text).toContain('never overwrite');
    expect(forced.text).toContain('ng refs/heads/zip');
    expect(git(repo, 'rev-parse', 'zip').trim()).toBe(two);
    // Several refs, one of them that overwrite: none goes
    const mixed = await handPush(clone, [{ old: null, id: amended, ref: 'refs/heads/zip-new' }, { old: two, id: amended, ref: 'refs/heads/zip' }], one);
    expect(mixed.text).toContain('never overwrite');
    expect(git(repo, 'branch', '--list')).not.toContain('zip-new');
    // A gzipped delete, and a gzipped tag
    expect((await handPush(clone, [{ old: two, id: '0'.repeat(40), ref: 'refs/heads/zip' }], null)).text).toContain('Deleting is not allowed');
    expect((await handPush(clone, [{ old: null, id: amended, ref: 'refs/tags/zv1' }], main)).text).toContain('Pushing tags is not allowed');
    expect(git(repo, 'rev-parse', 'zip').trim()).toBe(two);
    expect(git(repo, 'tag', '--list')).toBe('');
    // The same overwrite sent in a packing the relay does not read is turned down before anything is read
    expect(await handPush(clone, [{ old: two, id: amended, ref: 'refs/heads/zip' }], one, 'deflate')).toMatchObject({ status: 400, text: 'bad_request' });
    // ...and sent plain it is judged just the same
    expect((await handPush(clone, [{ old: two, id: amended, ref: 'refs/heads/zip' }], one, null)).text).toContain('never overwrite');
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
    expect(readPushCommands(body)).toEqual({ updates: [{ oldId: 'a'.repeat(40), newId: 'b'.repeat(40), ref: 'refs/heads/main' }], capabilities: ['report-status', 'side-band-64k'], packAt: body.length - 4 });
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
    expect([...((await readCapped(short, 10)) as Buffer)]).toEqual([1, 2, 3]);
    // An upload that stalls is given up after its time, never waited on for ever
    let stopped = false;
    const stalled = new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => undefined),
      cancel() {
        stopped = true;
      },
    });
    expect(await readCapped(stalled, 10, 50)).toBe('late');
    expect(stopped).toBe(true);
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

describe('looking at the sign-in again before a push goes to GitHub', () => {
  const line = (text: string) => `${(text.length + 4).toString(16).padStart(4, '0')}${text}`;
  const newBranch = Buffer.from(`${line(`${'0'.repeat(40)} ${'b'.repeat(40)} refs/heads/feature\0report-status\n`)}0000PACK`);
  const noGitHub = (() => {
    throw new Error('nothing may reach GitHub here');
  }) as unknown as typeof fetch;
  const push = (recheck: (() => Promise<typeof PASS | null>) | undefined, pass: typeof PASS = PASS, fetchImpl: typeof fetch = noGitHub, body: Buffer = newBranch, contentEncoding: string | null = null) =>
    relayGit(pass, { repo: 'acme/tools', step: 'git-receive-pack' }, { method: 'POST', search: '', contentType: 'application/x-git-receive-pack-request', contentEncoding, gitProtocol: null, body, recheck }, fetchImpl);

  it('does not send a push on when the job ended, was taken over or lost GitHub while it was being read and checked', async () => {
    const calls: string[] = [];
    expect(await push(async () => {
      calls.push('recheck');
      return null;
    })).toEqual({ status: 'revoked' });
    expect(calls).toEqual(['recheck']);
  });

  it('turns the push down when the job may only read by now, as it would have at the start', async () => {
    const outcome = await push(async () => ({ ...PASS, readOnly: true }));
    expect(outcome).toMatchObject({ status: 'refused', message: expect.stringContaining('may only read from GitHub') });
    expect((outcome as { response: Response }).response.status).toBe(403);
  });

  it('looks last: after the owner’s token was fetched and the push read, right before GitHub is asked, and only for a push', async () => {
    const order: string[] = [];
    const { gitHubToken } = jest.requireMock('@/lib/github/connection') as { gitHubToken: jest.Mock };
    gitHubToken.mockImplementationOnce(async () => {
      order.push('token');
      return { status: 'ok', token: 'ghu_owner', login: 'sara' };
    });
    const github = (async (url: string) => {
      order.push(`github ${String(url).split('/').pop()}`);
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;
    expect(await push(async () => {
      order.push('recheck');
      return PASS;
    }, PASS, github)).toMatchObject({ status: 'pass' });
    expect(order).toEqual(['token', 'recheck', 'github git-receive-pack']);
    // Reading (a clone) is not looked at again: the sign-in at its start is all it needs
    const reads: string[] = [];
    await relayGit(PASS, { repo: 'acme/tools', step: 'info/refs' }, { method: 'GET', search: '?service=git-upload-pack', contentType: null, contentEncoding: null, gitProtocol: null, body: null, recheck: async () => {
      reads.push('recheck');
      return PASS;
    } }, (async () => new Response('', { status: 200 })) as unknown as typeof fetch);
    expect(reads).toEqual([]);
  });

  it('turns down a job that may only read before git sends anything (the advertisement) and for a push sent without it', async () => {
    const readOnly = { ...PASS, readOnly: true };
    const advert = await relayGit(readOnly, { repo: 'acme/tools', step: 'info/refs' }, { method: 'GET', search: '?service=git-receive-pack', contentType: null, contentEncoding: null, gitProtocol: null, body: null }, noGitHub);
    expect(advert).toMatchObject({ status: 'refused' });
    expect(await (advert as { response: Response }).response.text()).toContain('ERR This computer may only read');
    expect(await push(undefined, readOnly)).toMatchObject({ status: 'refused' });
  });

  it('takes only gzip or no compression: any other way of packing a body, which GitHub might unpack differently, is turned down unread', async () => {
    for (const encoding of ['deflate', 'br', 'compress', 'gzip, gzip', 'identity, gzip', 'zstd']) {
      expect(await push(undefined, PASS, noGitHub, newBranch, encoding)).toEqual({ status: 'bad_request' });
    }
    expect(readEncoding(null)).toBeNull();
    expect(readEncoding('')).toBeNull();
    expect(readEncoding(' Identity ')).toBeNull();
    expect(readEncoding(' GZIP ')).toBe('gzip');
    // gzip, and no header at all, still go on (to GitHub's answer; the pack here is only a stub)
    const github = (async () => new Response('', { status: 200 })) as unknown as typeof fetch;
    expect(await push(undefined, PASS, github, newBranch, 'identity')).toMatchObject({ status: 'pass' });
    expect(await push(undefined, PASS, github, gzipSync(newBranch), ' GZIP ')).toMatchObject({ status: 'pass' });
  });

  it('sends GitHub the encoding it checked, not the words it was given', async () => {
    const seenHeaders: Record<string, string>[] = [];
    const github = (async (_url: string, init: RequestInit = {}) => {
      seenHeaders.push(init.headers as Record<string, string>);
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;
    await push(undefined, PASS, github, gzipSync(newBranch), ' GZIP ');
    await push(undefined, PASS, github, newBranch, 'identity');
    expect(seenHeaders[0]['Content-Encoding']).toBe('gzip');
    expect(seenHeaders[1]['Content-Encoding']).toBeUndefined();
  });
});
