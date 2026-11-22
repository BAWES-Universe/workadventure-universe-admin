/**
 * Runs a suite with the DATABASE's time zone set to `zone` and puts it back exactly as it was (an explicit override, or none at all), never "reset to the server's default".
 *
 * The pool's connections keep the zone they opened with and close when idle, so readiness is OBSERVED, not waited for with a fixed delay: it is watched from a connection of its own (which the pool never uses) until the pool has no
 * session left open, and a batch of overlapping statements then each says the zone it runs in. Use inside a describe: `const zone = databaseTimezone(prisma, 'Asia/Kuwait'); beforeAll(zone.set, 120_000); afterAll(zone.restore, 120_000);`
 */
import { Client } from 'pg';
import type { PrismaClient } from '@prisma/client';

const inZone = (name: string, shown: string) => (name === 'UTC' ? /UTC$/.test(shown) : shown === name);

export function databaseTimezone(prisma: PrismaClient, zone: string) {
  let original: string | null | undefined;
  const override = async (): Promise<string | null> => {
    const rows = await prisma.$queryRaw<Array<{ setconfig: string[] | null }>>`SELECT s.setconfig FROM pg_db_role_setting s JOIN pg_database d ON d.oid = s.setdatabase WHERE d.datname = current_database() AND s.setrole = 0`;
    const entry = (rows[0]?.setconfig ?? []).find((line) => line.toLowerCase().startsWith('timezone='));
    return entry ? entry.slice('timezone='.length) : null;
  };
  /** Every session the pool can hand out says the zone it runs in: statements that overlap never share a connection. */
  const zonesOfSessions = async (): Promise<string[]> => {
    const seen = await Promise.all(Array.from({ length: 6 }, () => prisma.$queryRaw<Array<{ z: string }>>`SELECT current_setting('TimeZone') AS z, pg_sleep(0.3)::text AS s`));
    return seen.map((rows) => rows[0].z);
  };
  /** Waits (bounded) until the pool has no open session: whatever it opens next has the database's current setting. */
  const poolIsEmpty = async (): Promise<boolean> => {
    const watcher = new Client({ connectionString: process.env.DATABASE_URL });
    await watcher.connect();
    try {
      for (let tries = 0; tries < 200; tries += 1) {
        const open = await watcher.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND backend_type = 'client backend'`);
        if (open.rows[0].n === 0) return true;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      return false;
    } finally {
      await watcher.end();
    }
  };
  const apply = (value: string | null) =>
    prisma.$executeRawUnsafe(
      value === null
        ? `DO $$ BEGIN EXECUTE format('ALTER DATABASE %I RESET timezone', current_database()); END $$`
        : `DO $$ BEGIN EXECUTE format('ALTER DATABASE %I SET timezone TO %L', current_database(), '${value.replace(/'/g, "''")}'); END $$`,
    );
  return {
    async set(): Promise<void> {
      original = await override();
      await apply(zone);
      if (!(await poolIsEmpty())) throw new Error('the pool never emptied after the time zone was set');
      const shown = await zonesOfSessions();
      if (!shown.every((one) => inZone(zone, one))) throw new Error(`the database sessions did not come up in ${zone}: ${shown.join(', ')}`);
    },
    async restore(): Promise<void> {
      if (original === undefined) return;
      await apply(original);
      await poolIsEmpty();
      if ((await override()) !== original) throw new Error('the database time zone was not put back as it was');
    },
  };
}
