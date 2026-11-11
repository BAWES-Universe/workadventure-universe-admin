import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';

/**
 * Shadow checks for the meter (game #1998, Brick 7). The meter records first and enforces nothing new, so what it has to prove
 * is that it agrees with what is counted today, and later with the provider's own figures, before anything is switched over.
 * These only read. They never change a count, a limit or a reply.
 */

export interface Comparison {
  /** Our figure; null when we have none. */
  ours: number | null;
  /** The other side's figure; null when it was not given. */
  theirs: number | null;
  /** ours minus theirs; null when either is missing. */
  difference: number | null;
  /** "same", "differs", or "unknown" when either figure is missing: a missing figure is never taken for zero. */
  state: 'same' | 'differs' | 'unknown';
}

/** Our figure beside someone else's. No tolerance is guessed here: how close is close enough is for whoever reads the difference. */
export function compareFigures(ours: number | null, theirs: number | null): Comparison {
  if (ours === null || theirs === null) return { ours, theirs, difference: null, state: 'unknown' };
  return { ours, theirs, difference: ours - theirs, state: ours === theirs ? 'same' : 'differs' };
}

export interface ModelCallComparison {
  /** Model calls reported to the usage rows in the period. */
  usageRows: number;
  /** Model calls in the books that were copied from a usage row in the period. */
  ledgerEvents: number;
  /** Usage rows with no event in the books: the books missed them. */
  usageRowsWithoutEvent: number;
  /** Usage rows and events compared by what they add up to (calls). */
  calls: Comparison;
}

/**
 * Does the books' count of model calls agree with the usage rows they are copied from? A report the bot server sent twice under one
 * event id is two usage rows today and one event in the books: that shows up here as a row without an event, which is the point.
 */
export async function compareModelCalls(from: Date, to: Date): Promise<ModelCallComparison> {
  const [rows, missing, events] = await Promise.all([
    prisma.botsAiUsage.aggregate({ where: { timestamp: { gte: from, lt: to } }, _count: { _all: true }, _sum: { apiCalls: true } }),
    prisma.$queryRaw<{ count: bigint }[]>(Prisma.sql`
      SELECT count(*)::bigint AS count FROM bots_ai_usage u
      WHERE u."timestamp" >= ${from} AND u."timestamp" < ${to}
        AND NOT EXISTS (SELECT 1 FROM meter_events e WHERE e.source_ref = 'bots_ai_usage:' || u.id::text)`),
    prisma.meterEvent.aggregate({ where: { kind: 'model_call', sourceRef: { startsWith: 'bots_ai_usage:' }, occurredAt: { gte: from, lt: to } }, _count: { _all: true }, _sum: { quantity: true } }),
  ]);
  return {
    usageRows: rows._count._all,
    ledgerEvents: events._count._all,
    usageRowsWithoutEvent: Number(missing[0]?.count ?? 0),
    calls: compareFigures(events._sum.quantity === null ? 0 : Number(events._sum.quantity), rows._sum.apiCalls ?? 0),
  };
}

export interface WindowComparison {
  /** When the person's Universe AI window began; null when none is running. */
  since: Date | null;
  /** Replies counted as today's 5 hour allowance counts them. */
  today: number;
  /** The same replies counted from the books. */
  books: number;
  replies: Comparison;
}

/**
 * One signed-in person's Universe AI replies in their running window, counted the way today's allowance counts them (lib/reply-limits.ts)
 * and counted from the books. They should agree: this is the shared 5 hour allowance, which stays enforced exactly as it is.
 */
export async function compareReplyWindow(personId: string): Promise<WindowComparison> {
  const window = await prisma.replyWindow.findUnique({ where: { key: `ua:person:${personId}` }, select: { startedAt: true } });
  if (!window) return { since: null, today: 0, books: 0, replies: compareFigures(0, 0) };
  const since = window.startedAt;
  const [today, books] = await Promise.all([
    prisma.botsAiUsage.count({ where: { talkedPersonId: personId, keyOwnerId: null, error: false, greeting: false, timestamp: { gte: since } } }),
    prisma.meterEvent.count({
      where: {
        personKey: `person:${personId}`,
        kind: 'model_call',
        payerKind: 'universe',
        AND: [{ detail: { path: ['error'], equals: false } }, { detail: { path: ['greeting'], equals: false } }],
        occurredAt: { gte: since },
      },
    }),
  ]);
  return { since, today, books, replies: compareFigures(books, today) };
}
