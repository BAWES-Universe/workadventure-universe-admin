import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { LONGEST_ACCOUNT_CALL_MS } from '@/lib/agent37/client';

/**
 * Serial power operations per machine (post-0.5.0 patch 2, B; GPT's eighth note). A stop or sleep that was sent to the provider cannot be withdrawn, and Agent37 gives no
 * operation id, generation or idempotency key that a later wake could fence against (lib/agent37/client.ts). So the fence is Orbit's own:
 *  - every stop or sleep Orbit sends to a Brick's machine is written here BEFORE the call (in the very commit that claims it, where it has a claim), with the Brick computer's row locked;
 *  - its sender beats the row while the call (with the client's own retries) and the look after it run, and marks it done when both returned, whatever they answered;
 *  - a wake of the same machine takes its ticket only under the same row lock and only when no operation of the machine is open (lib/computer.ts `takeWakeTicket`).
 * An operation whose sender died (open, no beat) can still land for as long as the last request it sent can live: it counts as open until its beat is older than that life.
 */

export type PowerKind = 'stop' | 'rest';

/**
 * The provider's own time to act on a request it already received, on top of the client's longest call. Not measured yet: Agent37's stop latency on dev is owed (the design asks for it),
 * and until then this is a deliberately wide margin. A wider margin only keeps a replacement in line longer after a sender died; it never lets one wake early.
 */
export const PROVIDER_MARGIN_MS = 60_000;

const DEFAULT_TIMING = {
  /** How often a live sender beats its operation. */
  beatMs: 5_000,
  /** A beat older than this: the sender is gone (several beats were missed). */
  staleMs: 20_000,
  /** How long after its last beat a dead sender's operation can still land: the beat that was missed, the client's longest asked-again call, and the provider's margin. */
  deadLifeMs: 20_000 + LONGEST_ACCOUNT_CALL_MS + PROVIDER_MARGIN_MS,
  /** How long a start waits for a LIVE operation before it goes back in line with nothing held. */
  waitMs: 60_000,
  pollMs: 250,
};

let timing = { ...DEFAULT_TIMING };

export function powerTiming(): Readonly<typeof DEFAULT_TIMING> {
  return timing;
}

/** Test seam: shorter beats and lives (null restores the real ones). */
export function setPowerTimingForTests(next: Partial<typeof DEFAULT_TIMING> | null): void {
  timing = next ? { ...DEFAULT_TIMING, ...next } : { ...DEFAULT_TIMING };
}

/**
 * How long a transaction that takes the Brick computer's row lock may wait for it, and run. A leader's stop holds that lock across the provider's stop (up to `leaderStop.transactionMs`), and a start, a rest or another stop arriving meanwhile
 * has to be able to wait for it: with Prisma's own defaults (about 2 s to begin, 5 s to finish) it would give up with P2028, which is not a stop in flight, and the start would be taken for a failure. A little longer than the longest hold.
 */
let rowLockWaitMs = 150_000;
export function rowLockWait(): { timeout: number; maxWait: number } {
  return { timeout: rowLockWaitMs, maxWait: rowLockWaitMs };
}
/** Test seam: the leader's hold, which the wait is kept longer than (null restores the real one). */
export function setRowLockWaitForTests(holdMs: number | null): void {
  rowLockWaitMs = holdMs === null ? 150_000 : holdMs + 30_000;
}

type Db = Pick<Prisma.TransactionClient, '$executeRaw' | '$queryRaw'>;

/** Writes the operation inside the caller's transaction, which already holds the Brick computer's row (its claim wrote it, or it locked it). */
export async function recordPowerOpIn(tx: Db, botId: string, ref: string, kind: PowerKind): Promise<string> {
  const id = randomUUID();
  await tx.$executeRaw`INSERT INTO "computer_power_ops" ("id", "bot_id", "provider_ref", "kind", "sent_at", "beat_at") VALUES (${id}, ${botId}, ${ref}, ${kind}, (NOW() AT TIME ZONE 'UTC'), (NOW() AT TIME ZONE 'UTC'))`;
  return id;
}

/**
 * Writes the operation with the Brick computer's row locked: the lock a wake's ticket takes. A wake either took its ticket before this record (and the stop, claimed against the state it saw, is not sent under it where it has
 * a claim) or comes after it and sees it open.
 */
export async function recordPowerOp(botId: string, ref: string, kind: PowerKind): Promise<string> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 AS one FROM "brick_computers" WHERE "bot_id" = ${botId} FOR UPDATE`;
    return recordPowerOpIn(tx, botId, ref, kind);
  }, rowLockWait());
}

/** The operation is over: its call and the look after it returned (or it was never sent). Written once. */
export async function endPowerOp(id: string): Promise<void> {
  await prisma.$executeRaw`UPDATE "computer_power_ops" SET "done_at" = (NOW() AT TIME ZONE 'UTC') WHERE "id" = ${id} AND "done_at" IS NULL`;
}

/**
 * Runs a recorded operation's call and the look after it, beating while they run, and marks it done when they returned, however. A done mark that could not be written leaves the operation open until its last beat is older
 * than a dead sender's life: a replacement waits longer, never less.
 */
export async function underPowerOp<T>(id: string, work: () => Promise<T>): Promise<T> {
  const beat = setInterval(() => {
    void prisma.$executeRaw`UPDATE "computer_power_ops" SET "beat_at" = (NOW() AT TIME ZONE 'UTC') WHERE "id" = ${id} AND "done_at" IS NULL`.catch(() => undefined);
  }, timing.beatMs);
  beat.unref?.();
  try {
    return await work();
  } finally {
    clearInterval(beat);
    await endPowerOp(id).catch((error) => console.error('[Computer] Could not mark a power operation done:', error instanceof Error ? error.message : 'unknown'));
  }
}

export interface OpenPowerOp {
  id: string;
  kind: PowerKind;
  /** Its sender still beats (it waits for the call to return); false: the sender is gone and only the bounded life keeps it open. */
  live: boolean;
}

/** The operation of this machine that can still land, if any (a live one first). Read through the caller's transaction when it holds the row lock. Judged by the database's clock. */
export async function openPowerOpOf(db: Db, ref: string): Promise<OpenPowerOp | null> {
  const rows = await db.$queryRaw<Array<{ id: string; kind: string; live: boolean }>>(Prisma.sql`
    SELECT "id", "kind", ("beat_at" > ((NOW() AT TIME ZONE 'UTC') - make_interval(secs => ${timing.staleMs / 1000}))) AS "live"
    FROM "computer_power_ops"
    WHERE "provider_ref" = ${ref} AND "done_at" IS NULL AND "beat_at" > ((NOW() AT TIME ZONE 'UTC') - make_interval(secs => ${timing.deadLifeMs / 1000}))
    ORDER BY "live" DESC, "beat_at" DESC
    LIMIT 1`);
  const row = rows[0];
  return row ? { id: row.id, kind: row.kind === 'rest' ? 'rest' : 'stop', live: row.live } : null;
}

/**
 * Waits while an operation of this machine is open, up to `until` (epoch ms): a live one always, one whose sender died only when `dead` is asked. 'clear': nothing of ours can still land on it now; 'open': something can.
 */
export async function waitForPowerOps(ref: string, until: number, dead = false): Promise<'clear' | 'open'> {
  for (;;) {
    const open = await openPowerOpOf(prisma, ref);
    if (!open) return 'clear';
    if ((!open.live && !dead) || Date.now() >= until) return 'open';
    await new Promise((resolve) => setTimeout(resolve, timing.pollMs));
  }
}

/** Forgets operations older than a day: done ones say nothing more, and an open one that old is far past any life it could have. Returns how many went. */
export async function prunePowerOps(now: Date = new Date(), olderThanMs: number = 24 * 60 * 60_000): Promise<number> {
  return prisma.$executeRaw`DELETE FROM "computer_power_ops" WHERE "sent_at" < ${new Date(now.getTime() - olderThanMs)}`;
}
