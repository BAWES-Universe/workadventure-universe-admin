import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';

/**
 * The one lock between a purge and every write a bot server makes for the same Brick (chat, memory, metrics, test results).
 *
 * `purgeBrick` takes it exclusively before it deletes anything, and holds it until it commits. A write takes it shared, then looks for the
 * purge marker and writes only if there is none, all in one transaction. So a write that began first is finished (and then deleted by the
 * purge), and a write that comes while the purge runs waits and then finds the marker. Without it, a save that had checked "not purged" a
 * moment earlier could still insert after the purge had deleted the rows, and nothing would ever remove that row (it has no link to the Brick).
 * Saves do not wait on each other, only on a purge. Under READ COMMITTED the check after the lock sees a marker that committed meanwhile.
 */
const lockName = (botId: string) => `brick_purge:${botId}`;

type Tx = Prisma.TransactionClient;

/** The purge takes the lock for itself, alone. */
export async function lockPurgeAlone(tx: Tx, botId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockName(botId)}))`;
}

/** A write takes the lock together with other writes, then says whether the Brick was purged. True: write nothing. Held until the transaction ends. */
export async function purgedUnderLock(tx: Tx, botId: string): Promise<boolean> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtext(${lockName(botId)}))`;
  return (await tx.brickPurge.count({ where: { botId } })) > 0;
}

/** Runs one write for a Brick in a transaction that is safe against its purge. `gone` when the Brick was purged: the write did not run. */
export async function whileNotPurged<T>(botId: string, write: (tx: Tx) => Promise<T>): Promise<{ gone: true } | { gone: false; value: T }> {
  return prisma.$transaction(
    async (tx) => {
      if (await purgedUnderLock(tx, botId)) return { gone: true } as const;
      return { gone: false, value: await write(tx) } as const;
    },
    // A save may have to wait for a purge that is running (it has up to a minute): wait for it rather than fail the save
    { timeout: 70_000, maxWait: 10_000 },
  );
}
