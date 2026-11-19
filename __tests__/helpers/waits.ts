import { prisma } from '@/lib/db';

/** Waits, at most `ms`, until `check` says yes; false when it never did (a test fails on that, it does not guess with a fixed sleep). */
export async function waitUntil(check: () => boolean | Promise<boolean>, ms = 8_000, every = 25): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, every));
  }
  return check();
}

/**
 * Waits, at most `ms`, until another session of this database reports being blocked on a lock in a query that contains `fragment`
 * (what PostgreSQL itself says in pg_stat_activity). That is the proof that a contender reached a row that is held, which a sleep never is.
 */
export function waitUntilBlocked(fragment: string, ms = 8_000): Promise<boolean> {
  return waitUntil(async () => {
    const blocked = await prisma.$queryRaw<{ pid: number }[]>`SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock' AND query LIKE ${`%${fragment}%`}`;
    return blocked.length > 0;
  }, ms);
}
