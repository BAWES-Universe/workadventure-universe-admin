import { prisma } from '@/lib/db';

// Race tests hold a row or a lock open on purpose and then claim that a second statement could not get past it. A fixed delay does not prove the second
// statement ever reached the database, so these helpers wait on what the database itself reports (pg_stat_activity), with a ceiling that fails loudly.
const CEILING_MS = 10_000;
const STEP_MS = 25;

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check: () => Promise<boolean>, what: string) {
  const end = Date.now() + CEILING_MS;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await pause(STEP_MS);
  }
}

/** Waits until at least `count` statements of this database are shown waiting on a lock (a row lock, a transaction or an advisory lock). */
export async function waitUntilBlockedOnLock(count = 1) {
  await until(async () => {
    const rows = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*)::bigint AS n FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock'`;
    return Number(rows[0]?.n ?? 0) >= count;
  }, `${count} statement(s) to be blocked on a lock`);
}

/** Waits until no other connection of this database is running a statement (so work started without being awaited has finished its queries). */
export async function waitUntilNoStatementRuns() {
  await until(async () => {
    const rows = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*)::bigint AS n FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND state <> 'idle' AND backend_type = 'client backend'`;
    return Number(rows[0]?.n ?? 0) === 0;
  }, 'every statement to finish');
}
