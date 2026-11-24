import type { PrismaClient } from '@prisma/client';

/**
 * Waits until a statement of the database whose text matches `like` (an ILIKE pattern) is waiting for a lock held by another session: the proof that a
 * test is really standing at the wait it means to test, instead of a delay that may be too short. Fails after `timeoutMs`, so a lock that is never waited
 * for ends the test with a plain reason.
 */
export async function waitForLockWait(db: Pick<PrismaClient, '$queryRaw'>, like: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await db.$queryRaw<Array<{ n: bigint }>>`SELECT count(*)::bigint AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE ${like}`;
    if (Number(rows[0]?.n ?? 0) > 0) return;
    if (Date.now() > deadline) throw new Error(`No statement like ${like} was waiting for a lock after ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
