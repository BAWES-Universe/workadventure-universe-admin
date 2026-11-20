import * as Sentry from '@sentry/nextjs';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { refundHold } from '@/lib/credit-spend';
import { retryWaitMs } from '@/lib/computer-retry';

/**
 * The refund of what a failed computer job drew from credit is an OBLIGATION until the funding books acknowledge it (table computer_refund_obligations).
 *
 * It is written once per hold BEFORE the refund is asked, with the amount fixed at that moment and the refund key of the hold (`giveback:<holdKey>`), so every
 * retry asks the books for exactly the same refund and gets the same answer back, and a refund the books made but that was never heard about is found again by
 * its key. A failed try is kept (attempts, last try, last error) and tried again with a growing wait (one minute to an hour); one that stays unacknowledged
 * past an hour is told to Sentry once and shows as overdue in the operations view, with what support needs: the original job, the person, the amount owed,
 * the last try and why it failed. The row keeps the minimum references to finish the reimbursement without the job, so a Brick's deletion is never held
 * for ever by a refund that cannot be made, and the refund is still made, or still seen, afterwards.
 */

/** How long an obligation may stay unacknowledged before it is told to Sentry and shows as overdue. */
export const REFUND_OVERDUE_MS = 60 * 60 * 1000;

export const refundKeyOf = (holdKey: string): string => `giveback:${holdKey}`;

/**
 * Writes what is owed for a job's settled credit holds that have not gone back in full: once per hold, the amount as it is now. Safe to say twice (a hold that
 * has an obligation keeps its own). Returns how many were new.
 */
export async function recordRefundObligations(jobId: string): Promise<number> {
  const holds = await prisma.creditHold.findMany({ where: { jobKey: jobId, category: 'computers', state: 'settled' }, select: { holdKey: true, personId: true, customerMicros: true, refundedMicros: true } });
  const data = holds
    .map((hold) => ({ hold, left: Number(hold.customerMicros ?? 0) - Number(hold.refundedMicros) }))
    .filter(({ left }) => left > 0)
    .map(({ hold, left }) => ({ jobId, personId: hold.personId, holdKey: hold.holdKey, refundKey: refundKeyOf(hold.holdKey), amountMicros: BigInt(left) }));
  if (data.length === 0) return 0;
  const created = await prisma.computerRefundObligation.createMany({ data, skipDuplicates: true });
  return created.count;
}

/**
 * The obligations of a Brick's failed jobs that have none yet, so a purge may go on without the jobs (the obligations carry what is needed). EVERY job that qualifies,
 * a page at a time in the order of their ids: a Brick with more of them than one page is never left blocked on the ones a first page never reached.
 */
export async function recordRefundObligationsForBrick(botId: string, page = 500): Promise<void> {
  let after: string | undefined;
  for (;;) {
    const jobs = await prisma.computerJob.findMany({
      where: { botId, status: { in: ['failed', 'stopped'] }, endedBy: 'error' },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: page,
      ...(after ? { cursor: { id: after }, skip: 1 } : {}),
    });
    for (const job of jobs) await recordRefundObligations(job.id);
    if (jobs.length < page) return;
    after = jobs[jobs.length - 1].id;
  }
}

export type AttemptResult = 'acknowledged' | 'owed' | 'none';

/**
 * Asks the books for one obligation's refund, with its own amount and key. Only when it is due (or `force`). An answer of the books, replayed or new, is the
 * acknowledgement (it keeps what they gave back); anything else is kept as the last error and tried again later. Never throws.
 */
export async function attemptRefundObligation(holdKey: string, now: Date = new Date(), options: { force?: boolean } = {}): Promise<AttemptResult> {
  try {
    const one = await prisma.computerRefundObligation.findUnique({ where: { holdKey } });
    if (!one) return 'none';
    if (one.state === 'acknowledged') return 'none';
    if (!options.force && one.nextAttemptAt && one.nextAttemptAt.getTime() > now.getTime()) return 'owed';
    let error: string | null = null;
    let given = 0;
    try {
      const result = await refundHold({ holdKey: one.holdKey, refundKey: one.refundKey, amountMicros: Number(one.amountMicros), reason: 'platform_failure' }, now);
      if (result.ok) given = result.refundedMicros;
      else error = result.reason;
    } catch (thrown) {
      error = (thrown instanceof Error ? thrown.message : 'unknown').slice(0, 190);
    }
    if (error === null) {
      await prisma.computerRefundObligation.updateMany({
        where: { id: one.id, state: 'owed' },
        data: { state: 'acknowledged', acknowledgedAt: now, acknowledgedMicros: BigInt(given), attempts: { increment: 1 }, lastAttemptAt: now, lastError: null, nextAttemptAt: null },
      });
      return 'acknowledged';
    }
    // The wait is worked out from the count that THIS write advances: the row is locked while it is read and written, so two tries that fail together (the sweep and a
    // support retry) record two attempts one after the other and the second waits the longer time, never the same one from the same old count
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "computer_refund_obligations" WHERE "id" = ${one.id} FOR UPDATE`);
      const current = await tx.computerRefundObligation.findUnique({ where: { id: one.id }, select: { attempts: true, state: true } });
      if (!current || current.state !== 'owed') return;
      await tx.computerRefundObligation.update({
        where: { id: one.id },
        data: { attempts: current.attempts + 1, lastAttemptAt: now, lastError: error, nextAttemptAt: new Date(now.getTime() + retryWaitMs(current.attempts + 1)) },
      });
    });
    return 'owed';
  } catch (caught) {
    console.error('[Computer] Could not keep a refund obligation:', caught instanceof Error ? caught.message : 'unknown');
    return 'owed';
  }
}

/** The refunds owed for one job: written if they were not, and every one that is due is asked for. Never throws. */
export async function settleRefundObligations(jobId: string, now: Date = new Date()): Promise<void> {
  try {
    await recordRefundObligations(jobId);
    const owed = await prisma.computerRefundObligation.findMany({ where: { jobId, state: 'owed' }, select: { holdKey: true } });
    for (const one of owed) await attemptRefundObligation(one.holdKey, now);
  } catch (error) {
    console.error('[Computer] Could not give back the credit a job drew:', error instanceof Error ? error.message : 'unknown');
  }
}

/**
 * The sweep's part: asks again for every obligation that is due, and tells Sentry once about each that has gone unacknowledged for longer than an hour. Never
 * throws.
 */
export async function sweepRefundObligations(now: Date = new Date(), batch = 50): Promise<{ looked: number; acknowledged: number; alerted: number }> {
  const result = { looked: 0, acknowledged: 0, alerted: 0 };
  try {
    const due = await prisma.computerRefundObligation.findMany({ where: { state: 'owed', OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] }, orderBy: { createdAt: 'asc' }, take: batch, select: { holdKey: true } });
    for (const one of due) {
      result.looked++;
      if ((await attemptRefundObligation(one.holdKey, now)) === 'acknowledged') result.acknowledged++;
    }
    const old = await prisma.computerRefundObligation.findMany({ where: { state: 'owed', alertedAt: null, createdAt: { lte: new Date(now.getTime() - REFUND_OVERDUE_MS) } }, take: 20 });
    for (const one of old) {
      // Claimed first, by a write that only one of two sweeps running together can win: the one that wins tells Sentry, so an obligation is told once, never twice
      const claimed = await prisma.computerRefundObligation.updateMany({ where: { id: one.id, state: 'owed', alertedAt: null }, data: { alertedAt: now } });
      if (claimed.count !== 1) continue;
      try {
        Sentry.captureMessage('A refund of credit a failed computer job drew has not been acknowledged by the books for over an hour', {
          level: 'error',
          tags: { area: 'computer', step: 'refund_obligation_age' },
          extra: { jobId: one.jobId, holdKey: one.holdKey, amountMicros: Number(one.amountMicros), attempts: one.attempts, lastError: one.lastError, since: one.createdAt.toISOString() },
        });
        result.alerted++;
      } catch (error) {
        // The alert did not go: the claim is given back so the next sweep tells it (never an overdue refund nobody was told about)
        console.error('[Computer] Could not tell Sentry about an overdue refund:', error instanceof Error ? error.message : 'unknown');
        await prisma.computerRefundObligation.updateMany({ where: { id: one.id, alertedAt: now }, data: { alertedAt: null } }).catch(() => undefined);
      }
    }
  } catch (error) {
    console.error('[Computer] The refund sweep failed:', error instanceof Error ? error.message : 'unknown');
  }
  return result;
}

export interface RefundObligationRow {
  jobId: string;
  personId: string;
  holdKey: string;
  amountMicros: number;
  attempts: number;
  lastAttemptAt: string | null;
  lastError: string | null;
  nextAttemptAt: string | null;
  ageMinutes: number;
  overdue: boolean;
}

export interface RefundOverview {
  owed: { count: number; amountMicros: number; oldestAt: string | null; oldestMinutes: number | null; overdue: number };
  /** Support's list: the oldest first, up to 100. */
  rows: RefundObligationRow[];
}

/** What is owed and not yet acknowledged, for operations and support. Reads only. */
export async function refundOverview(now: Date = new Date()): Promise<RefundOverview> {
  // The rows, the totals and the overdue count are read in ONE snapshot: a refund acknowledged between three separate reads would be listed as overdue and counted as none owed
  const { owed, totals, overdueCount } = await prisma.$transaction(
    async (tx) => ({
      owed: await tx.computerRefundObligation.findMany({ where: { state: 'owed' }, orderBy: { createdAt: 'asc' }, take: 100 }),
      totals: await tx.computerRefundObligation.aggregate({ where: { state: 'owed' }, _count: { _all: true }, _sum: { amountMicros: true }, _min: { createdAt: true } }),
      overdueCount: await tx.computerRefundObligation.count({ where: { state: 'owed', createdAt: { lte: new Date(now.getTime() - REFUND_OVERDUE_MS) } } }),
    }),
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
  const oldest = totals._min.createdAt;
  return {
    owed: {
      count: totals._count._all,
      amountMicros: Number(totals._sum.amountMicros ?? 0),
      oldestAt: oldest?.toISOString() ?? null,
      oldestMinutes: oldest ? Math.floor((now.getTime() - oldest.getTime()) / 60_000) : null,
      overdue: overdueCount,
    },
    rows: owed.map((one) => ({
      jobId: one.jobId,
      personId: one.personId,
      holdKey: one.holdKey,
      amountMicros: Number(one.amountMicros),
      attempts: one.attempts,
      lastAttemptAt: one.lastAttemptAt?.toISOString() ?? null,
      lastError: one.lastError,
      nextAttemptAt: one.nextAttemptAt?.toISOString() ?? null,
      ageMinutes: Math.floor((now.getTime() - one.createdAt.getTime()) / 60_000),
      overdue: now.getTime() - one.createdAt.getTime() >= REFUND_OVERDUE_MS,
    })),
  };
}

/** Support asks again now (not waiting for the next try): the books answer with the same refund, never a second one. */
export async function retryRefundObligation(holdKey: string, now: Date = new Date()): Promise<{ found: boolean; result: AttemptResult }> {
  const one = await prisma.computerRefundObligation.findUnique({ where: { holdKey }, select: { id: true } });
  if (!one) return { found: false, result: 'none' };
  return { found: true, result: await attemptRefundObligation(holdKey, now, { force: true }) };
}
