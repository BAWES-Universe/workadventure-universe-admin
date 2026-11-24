/**
 * The owner's hold on a computer job (`computer_jobs.owner_lease_until`), kept apart so every place that writes it (the owner's beat, a renewal of room, an admitted model call on either kind of key) follows one rule
 * (CodeRabbit on #1025, items 7, 25, 41, 42):
 *
 *   - a write only EXTENDS a hold that exists: it never moves the deadline back (a beat that was read before a renewal and lands after it), and it never makes a hold out of nothing (a hold that was let go, by `release`, a pause
 *     or a take-over, stays let go: a late beat or a call admitted on a key made before cannot bring it back and make a replacement wait it out);
 *   - a hold that LAPSED (it is in the past, nobody claimed the job) is brought back by the owner's next beat or call: the owner was only late;
 *   - the claim is the one write that makes a hold (it starts a new epoch).
 */
import type { Prisma } from '@prisma/client';

/**
 * How long one beat from the owner holds the job for. A runner beats every 30 s, so two beats may be lost before anyone else may take it; a worker that died is taken over within this, plus the sweep.
 * Short enough that a crash does not strand a job for long, long enough that a slow turn, a garbage collection or a rolling deploy never makes two workers run one job.
 */
export const OWNER_LEASE_MS = 90_000;

/** When the owner's hold stands until, from a beat (or a claim) at `now`. */
export const leaseUntil = (now: Date): Date => new Date(now.getTime() + OWNER_LEASE_MS);

/** Extends the hold on the job to `until`, only while there is one and it ends sooner. Returns how many rows changed (0 or 1). Call it in the transaction of the write that makes it a beat. */
export async function extendHoldIn(tx: Pick<Prisma.TransactionClient, '$executeRaw'>, jobId: string, until: Date): Promise<number> {
  return tx.$executeRaw`UPDATE "computer_jobs" SET "owner_lease_until" = ${until} WHERE "id" = ${jobId} AND "owner_lease_until" IS NOT NULL AND "owner_lease_until" < ${until}`;
}
