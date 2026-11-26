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
  /** How long after its last beat a dead sender's operation can still land: the beat that was missed, TWO of the client's longest asked-again calls (a stop or a sleep first looks the machine up, then sends: a sender whose beats fail but who stays alive can POST its stop after both), and the provider's margin. */
  deadLifeMs: 20_000 + 2 * LONGEST_ACCOUNT_CALL_MS + PROVIDER_MARGIN_MS,
  /** How long a start waits for a LIVE operation before it goes back in line with nothing held. */
  waitMs: 60_000,
  pollMs: 250,
  /** How long an operation whose call threw stays open (and beating) after the call returned: the provider may still act on a request it received (the same margin a dead sender's life carries). */
  marginMs: PROVIDER_MARGIN_MS,
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

/**
 * Waits, holding nothing else, until the Brick computer's row is free: a transaction that only locks the row and lets it go at once. A pause writes that row (the park mark, the turn hold) inside a 15 s transaction that already holds the
 * job's locks (and, for "do this first", the Brick's line), and a take-over leader's stop holds the row for up to 120 s: waited for INSIDE that transaction the pause would time out (P2028) and not happen. Waiting here instead takes no other
 * lock, so it can join no wait cycle, whatever order the pause then takes its locks in.
 */
export async function untilRowFree(botId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 AS one FROM "brick_computers" WHERE "bot_id" = ${botId} FOR UPDATE`;
  }, rowLockWait());
}

/** A transaction that gave up waiting (Prisma's P2028: it never began in time, or ran out of time while a lock held it up). It wrote nothing: the database rolled it back. */
export function isTransactionTimeout(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2028';
}

/** The computer's row was taken by someone else when a pause asked for it without waiting (`takeRowOrYield`: Postgres 55P03, lock not available). It wrote nothing: the transaction is rolled back and the pause is tried again. */
export function isRowBusy(error: unknown): boolean {
  const text = error instanceof Error ? `${error.message} ${JSON.stringify((error as { meta?: unknown }).meta ?? '')} ${String((error as { cause?: unknown }).cause ?? '')}` : '';
  return /55P03|could not obtain lock on row/i.test(text);
}

/**
 * The first thing a pause that will write the Brick computer's row does with it, before it settles the room (which takes the one lock every meter step of every person shares) and before it writes anything: take the row, WITHOUT
 * waiting. A take-over leader's stop holds that row for up to 120 s, and a statement that waits for it while the transaction holds the meter lock or a job lock stalls everyone behind those locks (Prisma's own timeout does not
 * interrupt a blocked statement). A pause that does not get the row yields at once (`isRowBusy`): its transaction is rolled back, and `pauseWhenRowFree` waits for the row holding nothing and tries again. A pause that never
 * writes the row (the person holds the screen, a kept ending, a job in line) never reaches this, so it never waits. It also cannot wait in a cycle with a Restart first, which takes the row and then the jobs.
 */
export async function takeRowOrYield(tx: Db, botId: string): Promise<void> {
  await tx.$queryRaw`SELECT 1 AS one FROM "brick_computers" WHERE "bot_id" = ${botId} FOR UPDATE NOWAIT`;
}

/**
 * How long a pause keeps trying when the row is taken again between the wait and its transaction (a second leader's stop right behind the first, wake beats): longer than the longest hold of the row (a leader's stop holds it up to 120 s) and
 * the wait that follows it, so a pause that meets one busy row after another is not given up on after three tries (Sentry on #1040: it would end in an error where the person only had to wait). Every try waits for the row first, holding nothing, so
 * trying again never spins. A count also bounds it.
 */
let rowRetryBudgetMs = 330_000;
const ROW_TRIES_MAX = 25;
/** Test seam: the time a pause keeps trying (null restores the real one). */
export function setRowRetryBudgetForTests(ms: number | null): void {
  rowRetryBudgetMs = ms === null ? 330_000 : ms;
}

/**
 * Runs the transaction of a pause (`run`: one `prisma.$transaction`, nothing after it, nothing sent to a provider) so that a take-over leader's stop on the Brick computer's row never makes the pause fail with a timeout
 * (post-0.5.0: pause during take-over). The first try goes straight in: the pause takes the row without waiting (`takeRowOrYield`) the moment it knows it will write it. One that did not get the row (or timed out) wrote nothing:
 * the row is waited for here, outside any transaction, holding nothing, and the same pause is tried again, for as long as the budget lasts (`rowRetryBudgetMs`) and at most `ROW_TRIES_MAX` times. Any other error is the caller's, and so is the last failure of a pause that used its budget up.
 *
 * The job kept running while the pause waited, so the pause is dated when it is WRITTEN, not when it was asked: `run` receives a `clock`: the caller's `now` moved on by the real time spent since the ask, for the pause to read once it holds its locks (Sentry and CodeRabbit on #1040: a stretch ended at
 * the moment of the ask would leave the seconds of the wait unpriced). The caller's `now` itself, simulated or not, is never replaced: only the pause's own moment moves with the wait.
 */
export async function pauseWhenRowFree<T>(botId: string, now: Date, run: (clock: () => Date) => Promise<T>): Promise<T> {
  const began = Date.now();
  // Read by the pause once it holds every lock it needs (`decidePauseIn`), so a wait for the job's lock counts too, not only the wait for the row
  // Moved on in whole seconds only (the books count whole seconds, and the few milliseconds of an ordinary pause that waited for nothing are not a wait: a pause that did not wait keeps the caller's time exactly)
  const clock = () => new Date(now.getTime() + Math.floor((Date.now() - began) / 1000) * 1000);
  for (let attempt = 1; ; attempt++) {
    try {
      return await run(clock);
    } catch (error) {
      if (!(isTransactionTimeout(error) || isRowBusy(error)) || attempt >= ROW_TRIES_MAX || Date.now() - began >= rowRetryBudgetMs) throw error;
      await untilRowFree(botId);
    }
  }
}

type Db = Pick<Prisma.TransactionClient, '$executeRaw' | '$queryRaw'>;

/** Writes the operation inside the caller's transaction, which already holds the Brick computer's row (its claim wrote it, or it locked it). */
export async function recordPowerOpIn(tx: Db, botId: string, ref: string, kind: PowerKind): Promise<string> {
  const id = randomUUID();
  // The clock of the statement, not of the transaction: `NOW()` is when the transaction began, and one that waited minutes for the computer's row would write an operation that was born stale (its sender seemingly gone, its life cut short).
  // One reading for both columns (`beat_at >= sent_at` is checked)
  await tx.$executeRaw`INSERT INTO "computer_power_ops" ("id", "bot_id", "provider_ref", "kind", "sent_at", "beat_at") SELECT ${id}, ${botId}, ${ref}, ${kind}, t.at, t.at FROM (SELECT (clock_timestamp() AT TIME ZONE 'UTC') AS at) t`;
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
  await prisma.$executeRaw`UPDATE "computer_power_ops" SET "done_at" = (clock_timestamp() AT TIME ZONE 'UTC') WHERE "id" = ${id} AND "done_at" IS NULL`;
}

/**
 * Runs a recorded operation's call and the look after it, beating while they run, and marks it done when they returned, however. A done mark that could not be written leaves the operation open until its last beat is older
 * than a dead sender's life: a replacement waits longer, never less.
 */
export async function underPowerOp<T>(id: string, work: (late: { mayLand: () => void }) => Promise<T>): Promise<T> {
  const beat = setInterval(() => {
    void prisma.$executeRaw`UPDATE "computer_power_ops" SET "beat_at" = (clock_timestamp() AT TIME ZONE 'UTC') WHERE "id" = ${id} AND "done_at" IS NULL`.catch(() => undefined);
  }, timing.beatMs);
  beat.unref?.();
  // A call that threw (a timeout, a gateway that answered badly) did not prove it was not received: the provider can still act on it. The operation then stays open, and beating, for the provider's margin after the call returned,
  // and is marked done only then (a replacement that asks meanwhile waits, as for any live operation). A sender that dies in that time leaves it to age out by a dead sender's life, which is longer than the margin
  let late = false;
  try {
    return await work({ mayLand: () => (late = true) });
  } catch (error) {
    late = true;
    throw error;
  } finally {
    if (late) {
      const closing = setTimeout(() => {
        clearInterval(beat);
        void endPowerOp(id).catch((error) => console.error('[Computer] Could not mark a power operation done:', error instanceof Error ? error.message : 'unknown'));
      }, timing.marginMs);
      closing.unref?.();
    } else {
      clearInterval(beat);
      await endPowerOp(id).catch((error) => console.error('[Computer] Could not mark a power operation done:', error instanceof Error ? error.message : 'unknown'));
    }
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
    SELECT "id", "kind", ("beat_at" > ((clock_timestamp() AT TIME ZONE 'UTC') - make_interval(secs => ${timing.staleMs / 1000}))) AS "live"
    FROM "computer_power_ops"
    WHERE "provider_ref" = ${ref} AND "done_at" IS NULL AND "beat_at" > ((clock_timestamp() AT TIME ZONE 'UTC') - make_interval(secs => ${timing.deadLifeMs / 1000}))
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
