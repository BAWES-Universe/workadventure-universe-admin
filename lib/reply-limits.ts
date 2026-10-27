import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { resolveUsagePerson } from '@/lib/usage-person';

/**
 * Reply limits (game #1159), decided by Khalid 19 Oct and 26 Oct 2026:
 *   - Universe AI, per person, across every bot on Universe AI in every universe: 30 replies in a 5-hour window when
 *     signed in, 10 for a guest. Bots on their maker's own AI key never count toward it.
 *   - All guests on one bot share 200 Universe AI replies per 5 hours; signed-in people are not affected by it.
 *   - A bot's own limit per person (`dailyReplyCap`, set by whoever manages the bot): that bot only, whatever it runs
 *     on, in a 24-hour window. No limit when it is empty.
 * A window starts at the first reply asked for once the last one has ended, so the end time a person sees is fixed.
 * Replies are counted from usage rows (one per reply, failed ones left out). The three numbers can be changed without a
 * release through UNIVERSE_AI_REPLIES_SIGNED_IN, UNIVERSE_AI_REPLIES_GUEST and UNIVERSE_AI_GUEST_POOL.
 */
export const UNIVERSE_AI_WINDOW_HOURS = 5;
export const BOT_LIMIT_WINDOW_HOURS = 24;

const HOUR = 60 * 60 * 1000;

function positiveInt(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function universeAiLimits() {
  return {
    signedIn: positiveInt(process.env.UNIVERSE_AI_REPLIES_SIGNED_IN, 30),
    guest: positiveInt(process.env.UNIVERSE_AI_REPLIES_GUEST, 10),
    guestPool: positiveInt(process.env.UNIVERSE_AI_GUEST_POOL, 200),
    windowHours: UNIVERSE_AI_WINDOW_HOURS,
  };
}

/** Which limit stopped a reply: a signed-in person's Universe AI replies, a guest's, the bot's guest pool, or the bot's own. */
export type LimitKind = 'universe-ai' | 'guest' | 'guests' | 'bot';

/** Who is asking, so the bot server can show the card's one button that fits them (Ask the maker, Sign in, Use my AI key). */
export type Asker = 'guest' | 'member' | 'maker';

export type ReplyAllowance =
  | { allowed: true }
  | { allowed: false; limit: LimitKind; resetsAt: string; who: Asker };

/** Where the reply would run, as the bot's AI credentials said: anything but the maker's own key is Universe AI. */
export type ReplySource = 'universe-ai' | 'provider' | 'own-key';

export class ReplyAllowanceError extends Error {
  constructor(message: string, readonly status: 400 | 404) {
    super(message);
  }
}

/**
 * When the window under `key` started, starting a new one now when there is none or the last has ended. One statement,
 * so two replies asked for at the same moment agree on the same start.
 */
async function windowStart(key: string, hours: number, now: Date): Promise<Date> {
  const endedBefore = new Date(now.getTime() - hours * HOUR);
  const rows = await prisma.$queryRaw<{ started_at: Date }[]>(Prisma.sql`
    INSERT INTO "reply_windows" ("key", "started_at") VALUES (${key}, ${now})
    ON CONFLICT ("key") DO UPDATE SET "started_at" =
      CASE WHEN "reply_windows"."started_at" <= ${endedBefore} THEN EXCLUDED."started_at" ELSE "reply_windows"."started_at" END
    RETURNING "started_at"`);
  return rows[0]?.started_at ?? now;
}

type Check = {
  kind: LimitKind;
  key: string;
  hours: number;
  limit: number;
  where: (since: Date) => Prisma.BotsAiUsageWhereInput;
};

/**
 * May this person get one more reply from this bot now? Asked by the bot server before each reply, after it knows what
 * the reply would run on. A person the bot can't name yet (no id) is never stopped: there is nobody to count.
 * When a limit is reached it is remembered once per person and window, for the bot page's "people ran out" count.
 */
export async function checkReplyAllowance(
  botId: string,
  input: { userId?: unknown; isGuest?: unknown; source?: unknown },
  now: Date = new Date(),
): Promise<ReplyAllowance> {
  const source = input.source;
  if (source !== 'universe-ai' && source !== 'provider' && source !== 'own-key') {
    throw new ReplyAllowanceError('source must be universe-ai, provider or own-key', 400);
  }
  const bot = await prisma.bot.findUnique({ where: { id: botId }, select: { id: true, dailyReplyCap: true, createdById: true } });
  if (!bot) throw new ReplyAllowanceError('Bot not found', 404);

  const userId = typeof input.userId === 'string' && input.userId ? input.userId.slice(0, 255) : null;
  if (!userId) return { allowed: true };

  const person = await resolveUsagePerson(userId, input.isGuest);
  const guest = !person.personId;
  const who: Asker = guest ? 'guest' : person.personId === bot.createdById ? 'maker' : 'member';
  // A signed-in person is counted by their account, so it is the same pool on every device; a guest by their id
  const personKey = person.personId ? `person:${person.personId}` : `guest:${userId}`;
  const personRows: Prisma.BotsAiUsageWhereInput = person.personId
    ? { talkedPersonId: person.personId }
    : { talkedUserId: userId, talkedGuest: true };

  const checks: Check[] = [];
  if (source !== 'own-key') {
    const limits = universeAiLimits();
    checks.push({
      kind: guest ? 'guest' : 'universe-ai',
      key: `ua:${personKey}`,
      hours: limits.windowHours,
      limit: guest ? limits.guest : limits.signedIn,
      // Every Universe AI reply this person got, from any bot: a reply no personal key paid for
      where: (since) => ({ ...personRows, keyOwnerId: null, error: false, timestamp: { gte: since } }),
    });
    if (guest) {
      checks.push({
        kind: 'guests',
        key: `ua:guests:${bot.id}`,
        hours: limits.windowHours,
        limit: limits.guestPool,
        where: (since) => ({ botId: bot.id, talkedGuest: true, keyOwnerId: null, error: false, timestamp: { gte: since } }),
      });
    }
  }
  if (bot.dailyReplyCap) {
    checks.push({
      kind: 'bot',
      key: `bot:${bot.id}:${personKey}`,
      hours: BOT_LIMIT_WINDOW_HOURS,
      limit: bot.dailyReplyCap,
      where: (since) => ({ ...personRows, botId: bot.id, error: false, timestamp: { gte: since } }),
    });
  }

  for (const check of checks) {
    const since = await windowStart(check.key, check.hours, now);
    const used = await prisma.botsAiUsage.count({ where: check.where(since) });
    if (used < check.limit) continue;
    const resetsAt = new Date(since.getTime() + check.hours * HOUR);
    await prisma.botReplyLimitHit
      .createMany({ data: [{ botId: bot.id, kind: check.kind, talkedUserId: userId, windowEndsAt: resetsAt }], skipDuplicates: true })
      .catch((error) => console.error('Error remembering a reached reply limit:', error));
    return { allowed: false, limit: check.kind, resetsAt: resetsAt.toISOString(), who };
  }
  return { allowed: true };
}
