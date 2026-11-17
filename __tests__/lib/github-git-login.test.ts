import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

jest.mock('@/lib/db', () => ({ prisma: {} }));
jest.mock('@/lib/github/connection', () => ({ GITHUB_SOURCE: 'github', readGitHubAuth: jest.fn() }));

import { committerOf, gitLoginCommand, NO_GIT_COMMAND } from '@/lib/github/git-login';

const TOKEN = `cjt_${'a'.repeat(43)}`;
const BASE = 'https://orbit.example.com/api/git';
const WHO = { name: 'sara-gh', email: '501+sara-gh@users.noreply.github.com' };

describe('the git login a computer is given', () => {
  it('names a commit by the owner’s GitHub login and the no-reply address GitHub gives', () => {
    expect(committerOf({ login: 'sara-gh', githubId: 501 })).toEqual(WHO);
    expect(committerOf({ login: 'sara-gh' })).toEqual({ name: 'sara-gh', email: 'sara-gh@users.noreply.github.com' });
    expect(committerOf({})).toBeNull();
  });

  it('is made only from plain pieces: anything else gives no command at all', () => {
    expect(gitLoginCommand(TOKEN, BASE, WHO)).not.toBeNull();
    expect(gitLoginCommand(TOKEN, 'https://orbit.example.com:8443/api/git', WHO)).not.toBeNull();
    for (const base of ["https://orbit.example.com/api/git'; rm -rf ~; '", 'http://orbit.example.com/api/git', 'https://u:p@orbit.example.com/api/git', 'https://orbit.example.com/api/git?x=1', 'https://orbit.example.com/a b']) {
      expect(gitLoginCommand(TOKEN, base, WHO)).toBeNull();
    }
    for (const name of ["sara'; touch x; '", 'sara gh', '', 'a'.repeat(40), 'sara$(id)']) expect(gitLoginCommand(TOKEN, BASE, { ...WHO, name })).toBeNull();
    for (const email of ["x@users.noreply.github.com'; id", 'sara@example.com', '501+sara-gh@users.noreply.github.com\nx']) expect(gitLoginCommand(TOKEN, BASE, { ...WHO, email })).toBeNull();
    for (const token of ["cjt_x'; id; '", 'ghu_owner', `cjt_${'a'.repeat(300)}`, 'cjt_short']) expect(gitLoginCommand(token, BASE, WHO)).toBeNull();
  });

  it('writes four files only the machine’s own user can read, includes them from ~/.gitconfig, and runs twice without piling up', () => {
    const home = mkdtempSync(join(tmpdir(), 'git-login-'));
    try {
      const command = gitLoginCommand(TOKEN, BASE, WHO) as string;
      const run = (text: string) => spawnSync('sh', ['-c', `umask 077 && d="$HOME/.universe" && mkdir -p "$d" && { ${text}; }`], { env: { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1' }, encoding: 'utf8' });
      expect(run(command).status).toBe(0);
      expect(run(command).status).toBe(0);
      const folder = join(home, '.universe');
      expect(readFileSync(join(folder, 'git-token'), 'utf8')).toBe(TOKEN);
      for (const file of ['git-token', 'git-credential', 'gitconfig', 'open-pr']) expect(statSync(join(folder, file)).mode & 0o077).toBe(0);
      const config = readFileSync(join(folder, 'gitconfig'), 'utf8');
      expect(config).toContain('name = sara-gh');
      expect(config).toContain(`[url "${BASE}/"]`);
      expect(config).toContain('insteadOf = https://github.com/');
      expect(config).toContain('[credential "https://orbit.example.com"]');
      // The key is only in its own file: never in the settings git shows
      expect(config).not.toContain(TOKEN);
      expect(readFileSync(join(home, '.gitconfig'), 'utf8').match(/path = /g)).toHaveLength(1);
      // Git's own question and the helper's answer
      const asked = spawnSync('sh', [join(folder, 'git-credential'), 'get'], { env: { ...process.env, HOME: home }, input: 'protocol=https\nhost=orbit.example.com\n\n', encoding: 'utf8' });
      expect(asked.stdout).toBe(`username=x-universe-job\npassword=${TOKEN}\n`);
      expect(spawnSync('sh', [join(folder, 'git-credential'), 'store'], { env: { ...process.env, HOME: home }, input: 'x\n', encoding: 'utf8' }).stdout).toBe('');
      // Taking the login away leaves nothing of it
      expect(run(NO_GIT_COMMAND).status).toBe(0);
      expect(() => statSync(join(folder, 'git-token'))).toThrow();
      expect(() => statSync(join(folder, 'open-pr'))).toThrow();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
  it('opens a pull request with `open-pr`: asks Orbit with the job key, says the address on success, and the reason when Orbit says no', async () => {
    const home = mkdtempSync(join(tmpdir(), 'git-login-pr-'));
    const asked: { authorization?: string; body: string }[] = [];
    let answer: { status: number; body: unknown } = { status: 200, body: { ok: true, number: 7, url: 'https://github.com/acme/tools/pull/7' } };
    const orbit = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      asked.push({ authorization: req.headers.authorization, body: Buffer.concat(chunks).toString() });
      res.writeHead(answer.status, { 'Content-Type': 'application/json' }).end(JSON.stringify(answer.body));
    });
    await new Promise<void>((resolve) => orbit.listen(0, '127.0.0.1', resolve));
    try {
      const command = gitLoginCommand(TOKEN, BASE, WHO) as string;
      expect(spawnSync('sh', ['-c', `umask 077 && d="$HOME/.universe" && mkdir -p "$d" && { ${command}; }`], { env: { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: join(home, '.gitconfig') } }).status).toBe(0);
      // Orbit's https address is this machine's port for the test
      const script = join(home, '.universe', 'open-pr');
      writeFileSync(script, readFileSync(script, 'utf8').replace('https://orbit.example.com', `http://127.0.0.1:${(orbit.address() as AddressInfo).port}`));
      const run = (...args: string[]) =>
        new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
          const child = spawn('python3', [script, ...args], { env: { ...process.env, HOME: home } });
          let stdout = '';
          let stderr = '';
          child.stdout.on('data', (c) => (stdout += c));
          child.stderr.on('data', (c) => (stderr += c));
          child.on('close', (status) => resolve({ status, stdout, stderr }));
        });
      const done = await run('acme/tools', 'feature', 'Add a', 'Body "quoted" text');
      expect(done).toMatchObject({ status: 0, stdout: 'https://github.com/acme/tools/pull/7\n' });
      expect(asked[0].authorization).toBe(`Basic ${Buffer.from(`x-universe-job:${TOKEN}`).toString('base64')}`);
      expect(JSON.parse(asked[0].body)).toEqual({ repo: 'acme/tools', head: 'feature', title: 'Add a', body: 'Body "quoted" text' });
      answer = { status: 403, body: { ok: false, error: 'This computer may only read' } };
      const refused = await run('acme/tools', 'feature', 'Add a', '', 'develop');
      expect(refused.status).not.toBe(0);
      expect(refused.stderr).toContain('Pull request not opened: This computer may only read');
      expect(JSON.parse(asked[1].body)).toEqual({ repo: 'acme/tools', head: 'feature', title: 'Add a', base: 'develop' });
      expect((await run('acme/tools')).stderr).toContain('Usage');
    } finally {
      await new Promise((resolve) => orbit.close(resolve));
      rmSync(home, { recursive: true, force: true });
    }
  });
});
