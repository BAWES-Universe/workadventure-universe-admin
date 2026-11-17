import { prisma } from '@/lib/db';
import { getBrickLimits } from '@/lib/bot-limits';
import { ownsBrick } from '@/lib/brick';
import { placeOfRoomId, type Place } from '@/lib/brick-visit';

/**
 * People who met a Brick (game #2005; audit F05).
 *
 * Khalid, 5 Nov: "regarding a bot without a room, if i met them and i have dmd them and permissions allow dms then i should be
 * able to keep dming until a person changes permission or whatever?" Agreed as C22: whether someone can message a Brick depends on
 * what they are allowed, never on where the Brick or the person is right now. So a visit ending, a home that goes, the Brick
 * walking on to another universe or the person doing so changes nothing.
 *
 * What is kept. One row per Brick and person (`brick_met`), written when the Brick answers them nearby or in a direct message
 * while it is somewhere other people can reach it (lib/brick-visit.ts `whereIsBrick`). It holds the place they met it last, so the
 * roles and bans of that place still decide, and when. Nothing of the owner's rides on it: it lets a person write to the Brick, and
 * what the Brick may use for them is decided as for any visitor (lib/bot-ai-credentials.ts; the bot server's F4.1 rule).
 *
 * What ends it, and only this:
 *  - its owner takes the person off (`revokeMet`, one person or everyone). That is a decision about direct messages, so it also
 *    holds while the Brick is standing somewhere they can reach it, and meeting it again never undoes it; the owner can let
 *    them back (`allowMet`);
 *  - the Brick is switched off or deleted (it is not there to answer anyone, as for any visitor);
 *  - the person's access is withdrawn where they met it: a ban there, losing the roles that allow messaging bots, or no longer
 *    being able to see the room (lib/bot-access.ts reads these on every message, as it does for a visitor);
 *  - for someone who only met it and never wrote: the days Limits give ("Bricks", People who met). Once they have written to it,
 *    time never ends it.
 */

/** A person who may still write to a Brick they met, and where they met it (null when that room is gone). */
export interface StandingMeeting {
  place: Omit<Place, 'roomUrl'> | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** A meeting seen again within this long is not written again: a busy room's chat would otherwise rewrite one row per message. */
const REFRESH_MS = 10 * 60 * 1000;

/**
 * The person met the Brick: the Brick answered them nearby or in a direct message in `roomId`. `wrote` says it was a direct message,
 * which makes the relationship last until someone decides otherwise; `onlyWrote` that it was one that continued a conversation
 * with a Brick that is no longer there, so it records the writing and not a new meeting. Never throws into the answer it comes from: a person who was
 * allowed is not refused because this could not be written (the next message writes it).
 */
export async function rememberMet(input: { botId: string; userId: string; roomId: string | null; wrote: boolean; onlyWrote?: boolean; now?: Date }): Promise<void> {
  const now = input.now ?? new Date();
  const { botId, userId, roomId } = input;
  const key = { botId_userId: { botId, userId } };
  const existing = await prisma.brickMet.findUnique({ where: key, select: { roomId: true, metAt: true, lastMetAt: true, dmAt: true, revokedAt: true } });
  if (!existing) {
    // Two messages together can both find nothing: the one that loses the race to add the row lands on the update below
    try {
      await prisma.brickMet.create({ data: { botId, userId, roomId, metAt: now, lastMetAt: now, dmAt: input.wrote ? now : null } });
      return;
    } catch (error) {
      if (!(error instanceof Error) || !/Unique constraint|P2002/.test(`${error.message} ${(error as { code?: string }).code ?? ''}`)) throw error;
    }
  }
  // A message that continues a conversation after the Brick has left is not a meeting: where and when they met it stay as they were
  const stale = !input.onlyWrote && (!existing || !existing.lastMetAt || existing.roomId !== roomId || now.getTime() - existing.lastMetAt.getTime() >= REFRESH_MS);
  const firstWrite = input.wrote && !existing?.dmAt;
  if (!stale && !firstWrite) return;
  await prisma.brickMet.update({
    where: key,
    data: {
      ...(stale ? { roomId, lastMetAt: now, ...(existing?.metAt ? {} : { metAt: now }) } : {}),
      ...(firstWrite ? { dmAt: now } : {}),
    },
  });
}

/**
 * The person's standing with a Brick they are not the owner of, for a direct message that has nowhere to be: they met it, and
 * nothing that ends it has happened yet. Null: they did not, it expired unwritten, or the owner took them off. This is not the
 * whole answer (bans, roles and the person's access to the room still decide in lib/bot-access.ts); it is only that the
 * relationship exists. A Brick that is switched off or waits deleted is nobody's to write to.
 */
export async function standingMeeting(botId: string, userId: string, now: Date = new Date()): Promise<StandingMeeting | null> {
  const [met, bot] = await Promise.all([
    prisma.brickMet.findUnique({ where: { botId_userId: { botId, userId } } }),
    prisma.bot.findUnique({ where: { id: botId }, select: { enabled: true, deletedAt: true, roomId: true } }),
  ]);
  if (!met || met.revokedAt || !bot || !bot.enabled || bot.deletedAt !== null || bot.roomId !== null) return null;
  // Taken off before ever meeting it, then let back: nothing was ever met, so there is nothing to keep
  if (!met.dmAt) {
    if (!met.lastMetAt) return null;
    const days = (await getBrickLimits()).metExpiresDays;
    if (now.getTime() - met.lastMetAt.getTime() > days * DAY_MS) return null;
  }
  if (!met.roomId) return { place: null };
  const place = await placeOfRoomId(met.roomId);
  return { place };
}

/** Everyone who met this Brick and still may write to it, for its owner. Names only; never what was said. */
export async function listMet(brickId: string, ownerId: string, now: Date = new Date()) {
  const brick = await prisma.bot.findUnique({ where: { id: brickId }, select: { id: true, roomId: true, ownerId: true, deletedAt: true } });
  if (!brick || !ownsBrick(brick, ownerId)) return null;
  const days = (await getBrickLimits()).metExpiresDays;
  const since = new Date(now.getTime() - days * DAY_MS);
  const rows = await prisma.brickMet.findMany({
    where: { botId: brickId, revokedAt: null, OR: [{ dmAt: { not: null } }, { lastMetAt: { gte: since } }] },
    orderBy: { lastMetAt: { sort: 'desc', nulls: 'last' } },
    select: { userId: true, metAt: true, lastMetAt: true, dmAt: true, user: { select: { name: true } } },
  });
  return rows.map((row) => ({ userId: row.userId, name: row.user.name, metAt: row.metAt ?? row.dmAt, lastMetAt: row.lastMetAt ?? row.dmAt, wrote: row.dmAt !== null }));
}

/** Whether the Brick's owner took this person off: then no direct message, wherever the Brick is. */
export async function isTakenOff(botId: string, userId: string): Promise<boolean> {
  const met = await prisma.brickMet.findUnique({ where: { botId_userId: { botId, userId } }, select: { revokedAt: true } });
  return !!met?.revokedAt;
}

/**
 * The owner takes a person off, or everyone who met the Brick when no person is named: they can no longer message it, wherever it
 * is, until the owner lets them back. Only its owner may; for a Brick that is not theirs it answers null. A named person who never met
 * it is taken off too (the owner may decide before they meet), and asked twice is the same. Returns how many were taken off.
 */
export async function revokeMet(brickId: string, ownerId: string, personId: string | null, now: Date = new Date()): Promise<number | null> {
  const brick = await prisma.bot.findUnique({ where: { id: brickId }, select: { id: true, roomId: true, ownerId: true, deletedAt: true } });
  if (!brick || !ownsBrick(brick, ownerId) || brick.deletedAt !== null) return null;
  if (personId === ownerId) return 0;
  if (personId) {
    const person = await prisma.user.findUnique({ where: { id: personId }, select: { id: true } });
    if (!person) return null;
    await prisma.brickMet.upsert({
      where: { botId_userId: { botId: brickId, userId: personId } },
      create: { botId: brickId, userId: personId, roomId: null, metAt: null, lastMetAt: null, revokedAt: now },
      update: { revokedAt: now },
    });
    return 1;
  }
  return (await prisma.brickMet.updateMany({ where: { botId: brickId, revokedAt: null }, data: { revokedAt: now } })).count;
}

/** The owner lets a person they took off write to the Brick again. They are as if they had never been taken off: they have to have met it. */
export async function allowMet(brickId: string, ownerId: string, personId: string): Promise<boolean | null> {
  const brick = await prisma.bot.findUnique({ where: { id: brickId }, select: { id: true, roomId: true, ownerId: true, deletedAt: true } });
  if (!brick || !ownsBrick(brick, ownerId) || brick.deletedAt !== null) return null;
  const cleared = await prisma.brickMet.updateMany({ where: { botId: brickId, userId: personId, revokedAt: { not: null } }, data: { revokedAt: null } });
  return cleared.count > 0;
}
