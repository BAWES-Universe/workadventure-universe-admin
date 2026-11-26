import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Client, type Pool, type PoolConfig } from 'pg';

/**
 * Helpers for the upgrade tests: a throwaway database per scenario, the REAL `prisma migrate deploy` run against it with only some of the migrations in its
 * directory (the state an environment was in), rows written the way that state's code wrote them, and then the real deploy with the whole directory.
 * Needs ROLES_DB_TEST=yes and a DATABASE_URL whose user may create databases.
 */
export const root = path.join(__dirname, '../..');
export const migrationsDir = path.join(root, 'prisma/migrations');
export const manifest = JSON.parse(fs.readFileSync(path.join(root, 'prisma/migration-manifest.json'), 'utf8')) as {
  baseline: { tag: string; migrations: string[] };
  shipping: { lastMigration: string; count: number; migrations: string[] };
};

const urlOf = (database: string): string => {
  const url = new URL(process.env.DATABASE_URL as string);
  url.pathname = `/${database}`;
  return url.toString();
};

export type Throwaway = { name: string; url: string; client: Client };

const admin = async <T>(callback: (client: Client) => Promise<T>): Promise<T> => {
  const client = new Client({ connectionString: urlOf('postgres') });
  await client.connect();
  try {
    return await callback(client);
  } finally {
    await client.end();
  }
};

/** A new empty database, and a connection to it. */
export async function createThrowaway(label: string): Promise<Throwaway> {
  const name = `orbit_up_${label}_${process.pid}_${Date.now().toString(36)}`.slice(0, 60);
  await admin((client) => client.query(`CREATE DATABASE "${name}"`));
  const client = new Client({ connectionString: urlOf(name) });
  // Dropping the database (WITH FORCE) cuts every connection to it: that is not an error for a test that is finished with it
  client.on('error', () => undefined);
  await client.connect();
  return { name, url: urlOf(name), client };
}

export async function dropThrowaway(db: Throwaway | undefined): Promise<void> {
  if (!db) return;
  await db.client.end().catch(() => undefined);
  await admin((client) => client.query(`DROP DATABASE IF EXISTS "${db.name}" WITH (FORCE)`));
}

/**
 * A migrations folder holding only these migrations (copied from the real directory) and extra ones given as SQL, with a config that points the real CLI at it.
 * Returns the config's path.
 */
export function stage(names: string[], extras: Array<{ name: string; from: string }> = []): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-upgrade-'));
  const folder = path.join(dir, 'migrations');
  fs.mkdirSync(folder);
  fs.copyFileSync(path.join(migrationsDir, 'migration_lock.toml'), path.join(folder, 'migration_lock.toml'));
  for (const name of names) fs.cpSync(path.join(migrationsDir, name), path.join(folder, name), { recursive: true });
  for (const extra of extras) fs.cpSync(extra.from, path.join(folder, extra.name), { recursive: true });
  const config = path.join(dir, 'prisma.config.mjs');
  fs.writeFileSync(
    config,
    `export default { schema: ${JSON.stringify(path.join(root, 'prisma/schema.prisma'))}, migrations: { path: ${JSON.stringify(folder)} }, datasource: { url: process.env.DATABASE_URL } };\n`,
  );
  return config;
}

/** The real `prisma migrate deploy` (with the repository's own config when none is given). */
export function deploy(db: Throwaway, config?: string): { status: number | null; out: string } {
  const result = spawnSync('npx', ['prisma', 'migrate', 'deploy', ...(config ? ['--config', config] : [])], {
    cwd: root,
    env: { ...process.env, DATABASE_URL: db.url },
    encoding: 'utf8',
    timeout: 240_000,
  });
  return { status: result.status, out: `${result.stdout}\n${result.stderr}` };
}

/**
 * A deploy worked when the CLI exited 0. The migration history and the drift check (asserted by the callers) prove what was applied; the output text is NOT
 * judged, because a harmless npm warning can push Prisma's last line out of any fixed tail. The tail is shown only when the exit status is not 0.
 */
export function expectDeployed(result: { status: number | null; out: string }): void {
  expect({ status: result.status, tail: result.status === 0 ? '' : result.out.slice(-1500) }).toEqual({ status: 0, tail: '' });
}

/** What `prisma migrate diff` says the database lacks or has beyond schema.prisma, as the SQL that would fix it ('' when none). */
export function drift(db: Throwaway): string {
  const result = spawnSync('npx', ['prisma', 'migrate', 'diff', '--from-config-datasource', '--to-schema', 'prisma/schema.prisma', '--script'], {
    cwd: root,
    env: { ...process.env, DATABASE_URL: db.url },
    encoding: 'utf8',
    timeout: 240_000,
  });
  if (result.status !== 0) throw new Error(`migrate diff failed: ${result.stderr}`);
  return result.stdout
    .split('\n')
    .filter((line) => line.trim() !== '' && line.trim() !== '-- This is an empty migration.')
    .join('\n');
}

/** How many rows each table holds (by name), for comparing before and after an upgrade. */
export async function counts(client: Client, exclude: string[] = []): Promise<Record<string, number>> {
  const tables = (await client.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> '_prisma_migrations' ORDER BY 1`)).rows as Array<{ table_name: string }>;
  const out: Record<string, number> = {};
  for (const { table_name: table } of tables) {
    if (exclude.includes(table)) continue;
    out[table] = Number((await client.query(`SELECT count(*)::int AS n FROM "${table}"`)).rows[0].n);
  }
  return out;
}

/** The migration history the database holds. */
export async function history(client: Client): Promise<{ applied: string[]; unfinished: number; rolledBack: number }> {
  const rows = (await client.query(`SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations ORDER BY migration_name`)).rows as Array<{ migration_name: string; finished_at: Date | null; rolled_back_at: Date | null }>;
  return { applied: rows.map((row) => row.migration_name), unfinished: rows.filter((row) => !row.finished_at).length, rolledBack: rows.filter((row) => row.rolled_back_at).length };
}

/**
 * Runs `callback` with the application's own database module (lib/db) pointed at this database, so the real code reads what the upgrade left. Modules are loaded
 * fresh for it and the connection is closed after.
 */
export async function withApplication<T>(db: Throwaway, callback: () => Promise<T>): Promise<T> {
  const holder = globalThis as unknown as { prisma?: { $disconnect(): Promise<void> } };
  const closeShared = async () => {
    await holder.prisma?.$disconnect().catch(() => undefined);
    delete holder.prisma;
  };
  const before = process.env.DATABASE_URL;
  await closeShared();
  process.env.DATABASE_URL = db.url;
  jest.resetModules();
  // The application's pool is made inside lib/db and never handed out: this one is remembered so it is closed here (an idle connection cut by the drop would be an unhandled error)
  const pools: Pool[] = [];
  jest.doMock('pg', () => {
    const actual = jest.requireActual('pg') as typeof import('pg');
    class Tracked extends actual.Pool {
      constructor(config?: PoolConfig) {
        super(config);
        this.on('error', () => undefined);
        pools.push(this);
      }
    }
    return { ...actual, Pool: Tracked };
  });
  try {
    return await callback();
  } finally {
    await closeShared();
    await Promise.all(pools.map((pool) => pool.end().catch(() => undefined)));
    jest.dontMock('pg');
    process.env.DATABASE_URL = before;
    jest.resetModules();
  }
}
