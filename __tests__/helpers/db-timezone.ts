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
  /** The backend ids of the sessions the pool holds right now: overlapping statements never share a connection, so each one shows a different session. */
  const poolSessions = async (): Promise<number[]> => {
    const seen = await Promise.all(Array.from({ length: 12 }, () => prisma.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid, pg_sleep(0.3)::text AS s`));
    return [...new Set(seen.map((rows) => rows[0].pid))];
  };
  /**
   * Waits (bounded) until none of the pool's sessions (named by `pids`, read before the setting changed) is open: whatever it opens next has the database's current setting.
   * Only the pool's own sessions are counted, never another client's that happens to be open on the same database (a psql left idle would have made this wait for
   * nothing and fail: CodeRabbit on #1025).
   */
  const poolIsEmpty = async (pids: number[]): Promise<boolean> => {
    if (pids.length === 0) return true;
    const watcher = new Client({ connectionString: process.env.DATABASE_URL });
    await watcher.connect();
    try {
      for (let tries = 0; tries < 200; tries += 1) {
        const open = await watcher.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND backend_type = 'client backend' AND pid = ANY($1::int[])`, [pids]);
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
      const pids = await poolSessions();
      await apply(zone);
      if (!(await poolIsEmpty(pids))) throw new Error('the pool never emptied after the time zone was set');
      const shown = await zonesOfSessions();
      if (!shown.every((one) => inZone(zone, one))) throw new Error(`the database sessions did not come up in ${zone}: ${shown.join(', ')}`);
    },
    async restore(): Promise<void> {
      if (original === undefined) return;
      const pids = await poolSessions();
      await apply(original);
      // As in `set()`: a pooled session that stays open past the wait still has the test's zone (the override reaches new sessions only), and that is a failure to report (CodeRabbit on #1025, 54)
      const drained = await poolIsEmpty(pids);
      if ((await override()) !== original) throw new Error('the database time zone was not put back as it was');
      if (!drained) throw new Error('the pool never emptied after the time zone was put back');
    },
  };
}
