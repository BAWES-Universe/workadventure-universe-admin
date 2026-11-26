/**
 * Orbit refuses to start when its database migrations do not all apply (outside audit finding O4).
 *
 * Production runs `scripts/start.sh` (the Dockerfile's CMD): it applies pending migrations with `prisma migrate deploy` and starts the app only when that
 * succeeded. The dev image runs `docker-entrypoint.sh`, which does the same before the dev server. Neither may "continue anyway".
 *
 * Each script runs for real (`sh`), from a scratch copy of the app folder, with `npm` (and for the entrypoint `npx`) replaced on PATH by a stand-in that only
 * records that the app was started. So "the app did not start" is read from that record, not from the script's exit code alone.
 *
 *   - Always (CI too): the scripts' own decisions, with a stand-in migration tool that succeeds or fails on demand.
 *   - With ROLES_DB_TEST=yes and a DATABASE_URL whose user may create databases: the REAL `prisma migrate deploy` against a throwaway, populated database,
 *     with a failing migration fixture (__tests__/fixtures/start-script-migrations), and the recovery after it.
 *
 *   ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest __tests__/scripts/start-script.test.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createThrowaway, dropThrowaway, history, migrationsDir, type Throwaway } from '../helpers/migration-upgrade';

const root = path.join(__dirname, '../..');
const fixtures = path.join(__dirname, '../fixtures/start-script-migrations');
const GOOD = '29991231000000_fixture_good';
const FAILING = '29991231000001_fixture_required_column';
const FIXED = '29991231000001_fixture_required_column_fixed';

const scratchDirs: string[] = [];
afterAll(() => {
  for (const dir of scratchDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function scratch(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

/** A folder of stand-in commands. Each records its arguments in `<marker>.<name>` and exits with the code named in its environment variable (default 0). */
function standIns(names: string[]): { bin: string; marker: string; ran: (name: string) => string | null } {
  const bin = scratch('orbit-start-bin-');
  const marker = path.join(bin, 'ran');
  for (const name of names) {
    const code = `STANDIN_${name.toUpperCase()}_EXIT`;
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\necho "$*" >> "${marker}.${name}"\nexit "\${${code}:-0}"\n`, { mode: 0o755 });
  }
  return {
    bin,
    marker,
    ran: (name: string) => (fs.existsSync(`${marker}.${name}`) ? fs.readFileSync(`${marker}.${name}`, 'utf8').trim() : null),
  };
}

function run(script: string, args: string[], cwd: string, env: Record<string, string | undefined>) {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (value !== undefined) clean[key] = value;
  const result = spawnSync('sh', [script, ...args], { cwd, env: clean, encoding: 'utf8', timeout: 600_000 });
  return { status: result.status, out: `${result.stdout}\n${result.stderr}`, stderr: result.stderr };
}

const baseEnv = (bin: string) => ({ PATH: `${bin}:${process.env.PATH ?? ''}`, HOME: process.env.HOME, NODE_ENV: 'production' });

describe('the production Dockerfile', () => {
  const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');

  it('starts through scripts/start.sh, and only through it', () => {
    const cmds = dockerfile.split('\n').filter((line) => /^\s*(CMD|ENTRYPOINT)\b/.test(line));
    expect(cmds).toEqual(['CMD ["sh", "scripts/start.sh"]']);
    expect(dockerfile).toContain('COPY scripts/start.sh ./scripts/start.sh');
  });

  it('ships the migration tool the start script runs', () => {
    expect(dockerfile).toContain('COPY --from=builder /app/node_modules/prisma ./node_modules/prisma');
    expect(dockerfile).toContain('COPY --from=builder /app/prisma ./prisma');
    expect(dockerfile).toContain('COPY --from=builder /app/prisma.config.ts ./prisma.config.ts');
  });
});

describe('scripts/start.sh decides (stand-in migration tool)', () => {
  /** A scratch app folder with the real start script and a stand-in `node_modules/prisma/build/index.js` that exits with PRISMA_STANDIN_EXIT. */
  function app(withCli = true): string {
    const dir = scratch('orbit-start-app-');
    fs.mkdirSync(path.join(dir, 'scripts'));
    fs.copyFileSync(path.join(root, 'scripts/start.sh'), path.join(dir, 'scripts/start.sh'));
    if (withCli) {
      fs.mkdirSync(path.join(dir, 'node_modules/prisma/build'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'node_modules/prisma/build/index.js'),
        `require('fs').appendFileSync(${JSON.stringify(path.join(dir, 'migrated'))}, process.argv.slice(2).join(' ') + '\\n');\nprocess.exit(Number(process.env.PRISMA_STANDIN_EXIT || 0));\n`,
      );
    }
    return dir;
  }

  it('applies the migrations and then starts the app', () => {
    const dir = app();
    const s = standIns(['npm']);
    const { status, out } = run('scripts/start.sh', [], dir, { ...baseEnv(s.bin), DATABASE_URL: 'postgresql://u:p@localhost:1/x' });
    expect(status).toBe(0);
    expect(fs.readFileSync(path.join(dir, 'migrated'), 'utf8').trim()).toBe('migrate deploy');
    expect(s.ran('npm')).toBe('start');
    expect(out).toContain('Database is up to date. Starting Orbit');
  });

  it('runs from any folder: it finds the app folder from its own path', () => {
    const dir = app();
    const s = standIns(['npm']);
    const { status } = run(path.join(dir, 'scripts/start.sh'), [], os.tmpdir(), { ...baseEnv(s.bin), DATABASE_URL: 'postgresql://u:p@localhost:1/x' });
    expect(status).toBe(0);
    expect(fs.existsSync(path.join(dir, 'migrated'))).toBe(true);
    expect(s.ran('npm')).toBe('start');
  });

  it.each([1, 2, 130])('does not start the app when the migration tool exits %i', (code) => {
    const dir = app();
    const s = standIns(['npm']);
    const { status, stderr } = run('scripts/start.sh', [], dir, { ...baseEnv(s.bin), DATABASE_URL: 'postgresql://u:p@localhost:1/x', PRISMA_STANDIN_EXIT: String(code) });
    expect(status).not.toBe(0);
    expect(s.ran('npm')).toBeNull();
    expect(stderr).toContain('Database migrations did not apply');
    expect(stderr).toContain('Orbit is NOT starting');
  });

  it.each([
    ['unset', undefined],
    ['empty', ''],
  ])('does not start, and touches nothing, when DATABASE_URL is %s', (_label, url) => {
    const dir = app();
    const s = standIns(['npm']);
    const { status, stderr } = run('scripts/start.sh', [], dir, { ...baseEnv(s.bin), DATABASE_URL: url });
    expect(status).not.toBe(0);
    expect(fs.existsSync(path.join(dir, 'migrated'))).toBe(false);
    expect(s.ran('npm')).toBeNull();
    expect(stderr).toContain('DATABASE_URL is not set');
  });

  it('does not start when the image has no migration tool, and never fetches one (no npx)', () => {
    const dir = app(false);
    const s = standIns(['npm', 'npx']);
    const { status, stderr } = run('scripts/start.sh', [], dir, { ...baseEnv(s.bin), DATABASE_URL: 'postgresql://u:p@localhost:1/x' });
    expect(status).not.toBe(0);
    expect(s.ran('npm')).toBeNull();
    expect(s.ran('npx')).toBeNull();
    expect(stderr).toContain('The migration tool is missing');
  });

  it('has no way to continue after a failed migration', () => {
    const script = fs.readFileSync(path.join(root, 'scripts/start.sh'), 'utf8');
    const code = script.split('\n').filter((line) => !line.trim().startsWith('#')).join('\n');
    expect(code).not.toMatch(/continu/i);
    expect(code).not.toMatch(/migrate deploy[^\n]*\|\|/);
    expect(code).not.toMatch(/\bnpx\b/);
    expect(code).toMatch(/^set -eu$/m);
  });
});

describe('docker-entrypoint.sh (the dev image) decides (stand-in npx)', () => {
  /** A scratch app folder the entrypoint sees as fully installed, so it goes straight to generate, migrate, seed and the command. */
  function devApp(): string {
    const dir = scratch('orbit-entry-app-');
    for (const pkg of ['@radix-ui/react-dropdown-menu', '@sentry/nextjs', 'next', 'react', 'recharts']) fs.mkdirSync(path.join(dir, 'node_modules', pkg), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules/.package-lock.json'), '{}');
    fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}');
    fs.writeFileSync(path.join(dir, 'prisma.config.ts'), '// stand-in\n');
    return dir;
  }

  /** `npx` stand-in that fails only the named prisma subcommand (generate, migrate or db). */
  function entry(failing?: 'generate' | 'migrate' | 'db') {
    const dir = devApp();
    const bin = scratch('orbit-entry-bin-');
    const marker = path.join(bin, 'ran');
    fs.writeFileSync(path.join(bin, 'npx'), `#!/bin/sh\necho "npx $*" >> "${marker}"\n[ "$2" = "${failing ?? 'none'}" ] && exit 1\nexit 0\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'npm'), `#!/bin/sh\necho "npm $*" >> "${marker}"\nexit 0\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'the-dev-server'), `#!/bin/sh\necho "the-dev-server" >> "${marker}"\nexit 0\n`, { mode: 0o755 });
    const result = run(path.join(root, 'docker-entrypoint.sh'), ['the-dev-server'], dir, { PATH: `${bin}:${process.env.PATH ?? ''}`, HOME: process.env.HOME, APP_DIR: dir });
    const ran = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim().split('\n') : [];
    return { ...result, ran, dir };
  }

  it('generates, migrates, seeds, then runs the command', () => {
    const { status, ran, dir } = entry();
    expect(status).toBe(0);
    expect(ran).toEqual(['npx prisma generate --schema=prisma/schema.prisma', 'npx prisma migrate deploy', 'npx prisma db seed', 'the-dev-server']);
    expect(fs.existsSync(path.join(dir, 'prisma.config.ts'))).toBe(true);
  });

  it('does not start the dev server when the migrations do not apply, and says what to do', () => {
    const { status, ran, stderr } = entry('migrate');
    expect(status).not.toBe(0);
    expect(ran).toEqual(['npx prisma generate --schema=prisma/schema.prisma', 'npx prisma migrate deploy']);
    expect(stderr).toContain('The dev server is NOT starting');
    expect(stderr).toContain('migrate resolve --rolled-back');
  });

  it('does not start when the Prisma client cannot be generated, and puts the config file back', () => {
    const { status, ran, stderr, dir } = entry('generate');
    expect(status).not.toBe(0);
    expect(ran).toEqual(['npx prisma generate --schema=prisma/schema.prisma']);
    expect(stderr).toContain('Prisma client generation failed');
    expect(fs.existsSync(path.join(dir, 'prisma.config.ts'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'prisma.config.ts.bak'))).toBe(false);
  });

  it('still starts when only the seed fails: the schema is up to date, and the failure is shown', () => {
    const { status, ran, stderr } = entry('db');
    expect(status).toBe(0);
    expect(ran).toEqual(['npx prisma generate --schema=prisma/schema.prisma', 'npx prisma migrate deploy', 'npx prisma db seed', 'the-dev-server']);
    expect(stderr).toContain('Seed failed');
  });
});

const realDb = process.env.ROLES_DB_TEST === 'yes' && process.env.DATABASE_URL ? describe : describe.skip;

realDb('scripts/start.sh with the real migration tool and a populated database', () => {
  jest.setTimeout(900_000);

  let db: Throwaway | undefined;
  let dir: string;
  const folder = () => path.join(dir, 'prisma/migrations');
  const addFixture = (from: string, as: string) => fs.cpSync(path.join(fixtures, from), path.join(folder(), as), { recursive: true });

  beforeAll(async () => {
    // The app folder as the image lays it out: scripts/start.sh, prisma.config.ts, prisma/schema.prisma, prisma/migrations, node_modules (the real one)
    dir = scratch('orbit-start-real-');
    fs.mkdirSync(path.join(dir, 'scripts'));
    fs.copyFileSync(path.join(root, 'scripts/start.sh'), path.join(dir, 'scripts/start.sh'));
    fs.copyFileSync(path.join(root, 'prisma.config.ts'), path.join(dir, 'prisma.config.ts'));
    fs.mkdirSync(path.join(dir, 'prisma'));
    fs.copyFileSync(path.join(root, 'prisma/schema.prisma'), path.join(dir, 'prisma/schema.prisma'));
    fs.cpSync(migrationsDir, folder(), { recursive: true });
    fs.symlinkSync(path.join(root, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
    db = await createThrowaway('start');
  });
  afterAll(async () => {
    await dropThrowaway(db);
  });

  const start = () => {
    const s = standIns(['npm', 'npx']);
    const result = run('scripts/start.sh', [], dir, { ...baseEnv(s.bin), DATABASE_URL: db!.url });
    return { ...result, started: s.ran('npm') === 'start', npx: s.ran('npx') };
  };

  const real = () => fs.readdirSync(migrationsDir).filter((name) => fs.statSync(path.join(migrationsDir, name)).isDirectory()).sort();

  it('a fresh database: applies every migration, then starts', async () => {
    const first = start();
    expect(first.status).toBe(0);
    expect(first.started).toBe(true);
    expect(first.npx).toBeNull();
    const h = await history(db!.client);
    expect(h.applied).toEqual(real());
    expect(h.unfinished).toBe(0);
  });

  it('nothing pending: starts again without changing anything', async () => {
    const again = start();
    expect(again.status).toBe(0);
    expect(again.started).toBe(true);
    expect(again.out).toMatch(/No pending migrations to apply/i);
  });

  describe('a release whose second new migration fails on the populated database', () => {
    let rowsBefore: number;
    let failed: ReturnType<typeof start>;

    beforeAll(async () => {
      // Production-like rows: people (the table the failing migration changes), a universe, a world, a room and a Brick
      await db!.client.query(`
        INSERT INTO users (id, uuid, updated_at) SELECT 'u-' || g, 'uuid-' || g, now() FROM generate_series(1, 200) g;
        INSERT INTO universes (id, slug, name, owner_id, updated_at) VALUES ('uni1', 'acme', 'Acme', 'u-1', now());
        INSERT INTO worlds (id, universe_id, slug, name, updated_at) VALUES ('w1', 'uni1', 'hq', 'HQ', now());
        INSERT INTO rooms (id, world_id, slug, name, updated_at) VALUES ('room1', 'w1', 'lobby', 'Lobby', now());
        INSERT INTO bots (id, room_id, name, updated_at) VALUES ('bot1', 'room1', 'Nora', now());
      `);
      rowsBefore = Number((await db!.client.query('SELECT count(*)::int AS n FROM users')).rows[0].n);
      addFixture(GOOD, GOOD);
      addFixture(FAILING, FAILING);
      failed = start();
    });

    it('does not start the app, and says why', () => {
      expect(failed.status).not.toBe(0);
      expect(failed.started).toBe(false);
      expect(failed.npx).toBeNull();
      expect(failed.stderr).toContain('Database migrations did not apply');
      expect(failed.stderr).toContain('Orbit is NOT starting');
      expect(failed.out).toContain(FAILING);
    });

    it('keeps every row, and the migration before it stays applied', async () => {
      expect(Number((await db!.client.query('SELECT count(*)::int AS n FROM users')).rows[0].n)).toBe(rowsBefore);
      expect(Number((await db!.client.query('SELECT count(*)::int AS n FROM bots')).rows[0].n)).toBe(1);
      const h = await history(db!.client);
      expect(h.applied).toContain(GOOD);
      expect((await db!.client.query(`SELECT to_regclass('public.fixture_good') IS NOT NULL AS here`)).rows[0].here).toBe(true);
    });

    it('records the failing migration as failed, and none of its changes stay (Postgres runs it as one transaction)', async () => {
      const row = (await db!.client.query(`SELECT finished_at, rolled_back_at FROM _prisma_migrations WHERE migration_name = $1`, [FAILING])).rows[0];
      expect(row).toBeDefined();
      expect(row.finished_at).toBeNull();
      expect(row.rolled_back_at).toBeNull();
      const column = await db!.client.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'fixture_required'`);
      expect(column.rowCount).toBe(0);
      expect((await db!.client.query(`SELECT to_regclass('public.fixture_partial') IS NOT NULL AS here`)).rows[0].here).toBe(false);
    });

    it('a restart (or another deploy of the same image) still refuses: the failed migration blocks until someone resolves it', () => {
      const restart = start();
      expect(restart.status).not.toBe(0);
      expect(restart.started).toBe(false);
      expect(restart.out).toMatch(/P3009|failed migrations/i);
    });

    it('recovery: mark it rolled back, ship the fixed migration, and Orbit starts on the up-to-date database', async () => {
      const resolve = spawnSync('node', ['node_modules/prisma/build/index.js', 'migrate', 'resolve', '--rolled-back', FAILING], {
        cwd: dir,
        env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', DATABASE_URL: db!.url },
        encoding: 'utf8',
        timeout: 240_000,
      });
      expect(resolve.status).toBe(0);
      fs.rmSync(path.join(folder(), FAILING), { recursive: true });
      addFixture(FIXED, FAILING);
      const fixed = start();
      expect(fixed.status).toBe(0);
      expect(fixed.started).toBe(true);
      const filled = await db!.client.query(`SELECT count(*)::int AS n FROM users WHERE fixture_required = 'filled'`);
      expect(Number(filled.rows[0].n)).toBe(rowsBefore);
    });
  });

  it('a database it cannot reach: does not start', () => {
    const s = standIns(['npm']);
    const unreachable = new URL(db!.url);
    unreachable.port = '1';
    const result = run('scripts/start.sh', [], dir, { ...baseEnv(s.bin), DATABASE_URL: unreachable.toString() });
    expect(result.status).not.toBe(0);
    expect(s.ran('npm')).toBeNull();
    expect(result.stderr).toContain('Orbit is NOT starting');
  });
});
