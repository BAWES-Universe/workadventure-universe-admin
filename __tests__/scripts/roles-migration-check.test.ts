/**
 * The roles migration check changes the database it runs on, so it must refuse any database that isn't on this
 * machine, whatever ROLES_CHECK_ON_A_COPY says. Exit 2 is its refusal; it exits before connecting to anything.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = path.join(__dirname, '../..');

function run(env: Record<string, string>) {
  const result = spawnSync('npx', ['tsx', 'scripts/roles-migration-check.ts'], {
    cwd: root,
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ROLES_CHECK_ON_A_COPY: 'yes', ...env },
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { status: result.status, stderr: result.stderr };
}

describe('roles migration check: local databases only', () => {
  it.each([
    'postgres://user:pass@db.example.com:5432/orbit',
    'postgresql://user:pass@10.0.0.5/orbit',
    'postgres://user:pass@localhost.example.com/orbit',
    'postgres:///orbit?host=db.example.com',
  ])('refuses %s', (url) => {
    const { status, stderr } = run({ DATABASE_URL: url });
    expect(status).toBe(2);
    expect(stderr).toContain('not a database on this machine');
  }, 60_000);

  it('refuses a URL with no host when PGHOST points elsewhere', () => {
    const { status, stderr } = run({ DATABASE_URL: 'postgres:///orbit', PGHOST: 'db.example.com' });
    expect(status).toBe(2);
    expect(stderr).toContain('not a database on this machine');
  }, 60_000);

  it('still needs the copy flag for a local database', () => {
    const { status, stderr } = run({ DATABASE_URL: 'postgres://user:pass@localhost:1/orbit', ROLES_CHECK_ON_A_COPY: '' });
    expect(status).toBe(2);
    expect(stderr).toContain('ROLES_CHECK_ON_A_COPY=yes');
  }, 60_000);
});
