import { prisma } from '@/lib/db';

/**
 * Uses of a lent app, or of a universe's own app, by a bot of that universe (game #2001 step 7). One row for each call id, so a
 * retried call counts once. These are what "today 12 of 200" and "this month's uses" read. A person's own app used by their own
 * Brick is not written here: that is the meter's alone.
 */

/** The universe a room bot stands in, or null (a Brick, a bot that is gone). */
export async function botUniverseId(botId: string): Promise<string | null> {
  const bot = await prisma.bot.findUnique({ where: { id: botId }, select: { room: { select: { world: { select: { universeId: true } } } } } });
  return bot?.room?.world.universeId ?? null;
}

/** A day starts at 00:00 UTC, the same for everyone, so "uses a day" means one thing everywhere. */
export function startOfDay(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export function startOfMonth(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export const usesToday = (connectionId: string, universeId: string, now: Date = new Date()) =>
  prisma.appUse.count({ where: { connectionId, universeId, usedAt: { gte: startOfDay(now) } } });

export type UseOutcome = 'recorded' | 'again' | 'limit_reached';

/**
 * Writes one use under its call id. With a limit, the day's count and this write happen together under one lock, so two calls at
 * once can never both take the last use. The same call id again is `again` and adds nothing, even at the limit: a retry is the
 * same use. Never throws on a duplicate.
 */
export async function recordUse(input: { connectionId: string; universeId: string; botId: string; callId: string; limit: number | null }): Promise<UseOutcome> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`app-use:${input.connectionId}:${input.universeId}`}))`;
    const seen = await tx.appUse.findUnique({ where: { connectionId_callId: { connectionId: input.connectionId, callId: input.callId } }, select: { id: true } });
    if (seen) return 'again';
    if (input.limit !== null) {
      const today = await tx.appUse.count({ where: { connectionId: input.connectionId, universeId: input.universeId, usedAt: { gte: startOfDay() } } });
      if (today >= input.limit) return 'limit_reached';
    }
    await tx.appUse.create({ data: { connectionId: input.connectionId, universeId: input.universeId, botId: input.botId, callId: input.callId } });
    return 'recorded';
  });
}
