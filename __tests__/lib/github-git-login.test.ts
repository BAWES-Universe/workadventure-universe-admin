import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
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

  it('writes three files only the machine’s own user can read, includes them from ~/.gitconfig, and runs twice without piling up', () => {
    const home = mkdtempSync(join(tmpdir(), 'git-login-'));
    try {
      const command = gitLoginCommand(TOKEN, BASE, WHO) as string;
      const run = (text: string) => spawnSync('sh', ['-c', `umask 077 && d="$HOME/.universe" && mkdir -p "$d" && { ${text}; }`], { env: { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1' }, encoding: 'utf8' });
      expect(run(command).status).toBe(0);
      expect(run(command).status).toBe(0);
      const folder = join(home, '.universe');
      expect(readFileSync(join(folder, 'git-token'), 'utf8')).toBe(TOKEN);
      for (const file of ['git-token', 'git-credential', 'gitconfig']) expect(statSync(join(folder, file)).mode & 0o077).toBe(0);
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
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
