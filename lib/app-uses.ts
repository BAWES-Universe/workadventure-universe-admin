import { prisma } from '@/lib/db';

/**
 * Uses of a lent app, or of a universe's own app, by a bot of that universe (game #2001 step 7). One row for each call id of each bot (two bots
 * may use the same id, and neither hides the other's use), so a retried call counts once. These are what "today 12 of 200" and "this month's uses" read. A person's own app used by their own
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

export type UseOutcome = 'recorded' | 'again' | 'limit_reached' | 'gone';

/**
 * Writes one use under its call id. With a limit, the day's count and this write happen together under one lock, so two calls at
 * once can never both take the last use. The same call id again is `again` and adds nothing, even at the limit: a retry is the
 * same use. Never throws on a duplicate.
 *
 * What allowed the use is read again under lock before it is written (`serverId` is the bot's grant; `lend` is the lend of a
 * person's app): taking an app back holds the same rows for update, so a check that was waiting while the app was taken back finds
 * it gone (`gone`) and records nothing, never a use after the take-back.
 */
export async function recordUse(input: { connectionId: string; universeId: string; botId: string; callId: string; limit: number | null; serverId?: string; lend?: boolean }): Promise<UseOutcome> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`app-use:${input.connectionId}:${input.universeId}`}))`;
    if (input.lend) {
      const lend = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "app_lends" WHERE "connection_id" = ${input.connectionId} AND "universe_id" = ${input.universeId} FOR SHARE`;
      if (lend.length === 0) return 'gone';
    }
    if (input.serverId) {
      const grant = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "bot_mcp_servers" WHERE "id" = ${input.serverId} AND "bot_id" = ${input.botId} AND "connection_id" = ${input.connectionId} FOR SHARE`;
      if (grant.length === 0) return 'gone';
    }
    const seen = await tx.appUse.findUnique({ where: { connectionId_botId_callId: { connectionId: input.connectionId, botId: input.botId, callId: input.callId } }, select: { id: true } });
    if (seen) return 'again';
    // One moment for the day's count and the write: a transaction that began before midnight and got the lock after it cannot
    // count the new day and then file the use under the old one
    const now = new Date();
    if (input.limit !== null) {
      const today = await tx.appUse.count({ where: { connectionId: input.connectionId, universeId: input.universeId, usedAt: { gte: startOfDay(now) } } });
      if (today >= input.limit) return 'limit_reached';
    }
    await tx.appUse.create({ data: { connectionId: input.connectionId, universeId: input.universeId, botId: input.botId, callId: input.callId, usedAt: now } });
    return 'recorded';
  });
}
