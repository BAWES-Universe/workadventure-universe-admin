/**
 * A real database for the funding books' scenarios (paying spec v3, O1). It builds a throwaway Postgres from every migration and hands
 * back the Prisma client the libraries use (put on globalThis before they load, so lib/db.ts finds it).
 *
 * Two kinds:
 *  - PGlite (the default, runs anywhere): one connection, so overlapping calls take turns. It proves the rules, the constraints and
 *    that asking twice is the same as asking once; it cannot show a true race.
 *  - A real Postgres (CREDIT_BOOKS_PG=postgres://user:pass@host:5432/postgres): a fresh database is made on it and many connections run
 *    at once, so the locks and unique keys are tested for real.
 *
 * It runs in its own process (PGlite loads itself with dynamic imports, which Jest does not allow): see run-credit-books.ts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Pool, Client } from 'pg';

const MIGRATIONS = path.join(__dirname, '../../prisma/migrations');

const migrationFiles = () =>
  fs
    .readdirSync(MIGRATIONS)
    .filter((name) => /^\d/.test(name))
    .sort()
    .map((name) => ({ name, sql: fs.readFileSync(path.join(MIGRATIONS, name, 'migration.sql'), 'utf8') }));

export interface TestDatabase {
  kind: 'pglite' | 'postgres';
  url: string;
  stop(): Promise<void>;
}

export async function startTestDatabase(): Promise<TestDatabase> {
  const real = process.env.CREDIT_BOOKS_PG;
  if (real) {
    const admin = new Client({ connectionString: real });
    await admin.connect();
    const name = `credit_books_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const url = new URL(real);
    url.pathname = `/${name}`;
    let created = false;
    const client = new Client({ connectionString: url.toString() });
    let connected = false;
    const cleanUp = async () => {
      if (connected) await client.end().catch(() => undefined);
      if (created) await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => undefined);
      await admin.end().catch(() => undefined);
    };
    try {
      await admin.query(`CREATE DATABASE ${name}`);
      created = true;
      await client.connect();
      connected = true;
      for (const migration of migrationFiles()) await client.query(migration.sql);
      connected = false;
      await client.end();
    } catch (error) {
      // A setup that fails leaves nothing behind: the database made so far is dropped and every connection closed, then the real error goes on
      await cleanUp();
      throw error;
    }
    return {
      kind: 'postgres',
      url: url.toString(),
      async stop() {
        await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
        await admin.end();
      },
    };
  }
  const { PGlite } = await import('@electric-sql/pglite');
  const { PGLiteSocketServer } = await import('@electric-sql/pglite-socket');
  const db = await PGlite.create();
  try {
    for (const migration of migrationFiles()) await db.exec(migration.sql);
  } catch (error) {
    await db.close().catch(() => undefined);
    throw error;
  }
  const port = 20000 + Math.floor(Math.random() * 20000);
  const server = new PGLiteSocketServer({ db, port, host: '127.0.0.1' });
  await server.start();
  return {
    kind: 'pglite',
    url: `postgres://postgres:postgres@127.0.0.1:${port}/postgres`,
    async stop() {
      await server.stop();
      await db.close();
    },
  };
}

/** The Prisma client over the test database, as lib/db.ts would make it. PGlite takes one connection; a real server takes many. */
export async function connect(database: TestDatabase) {
  const { PrismaClient } = await import('@prisma/client');
  const { PrismaPg } = await import('@prisma/adapter-pg');
  const pool = new Pool({ connectionString: database.url, max: database.kind === 'pglite' ? 1 : 10, ssl: false });
  // A server that drops the database at the end closes idle connections; that is the end of the run, not an error
  pool.on('error', () => undefined);
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool), log: ['error'] });
  return {
    prisma,
    async close() {
      await prisma.$disconnect().catch(() => undefined);
      await pool.end().catch(() => undefined);
    },
  };
}
