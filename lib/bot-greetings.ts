import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getGreetingCooldownMinutes } from '@/lib/bot-limits';
import { ReplyAllowanceError } from '@/lib/reply-limits';
import { resolveUsagePerson } from '@/lib/usage-person';

/**
 * Greetings cooldown, approved by Khalid 10 Nov 2026. When someone walks up, a bot greets them on its own. That greeting:
 *   - costs the person nothing: it is paid for by whoever's key the bot runs on, reported as that key's usage, and never counted
 *     in the person's Universe AI window, a bot's own limit per person or the guests' pool (the usage row is marked `greeting`);
 *   - is made at most once per cooldown for each bot and person. The cooldown is a super admin setting ("Greet the same person
 *     again after", in minutes; lib/bot-limit-values.ts), the same for every bot. Stepping out of a bubble and back in, a reconnect
 *     or another device inside it gives no new greeting. The person can still talk to the bot at any time.
 * Only time and who the person is are used: nothing about where anyone stands.
 *
 * The bot server asks just before it would make a greeting (`claimGreeting`), so a greeting is remembered before anything is paid
 * for, and two asked at the same moment can't both be made. A greeting that then isn't made after all (the AI said nothing or
 * failed) is handed back (`releaseGreeting`), so the person is greeted next time.
 */
export type GreetingAnswer =
  /** `greetedAt`: when this greeting was remembered, to hand it back with. Missing for a person nobody could name (nothing remembered). */
  | { greet: true; greetedAt?: string }
  /** `nextAt`: when this bot will greet them again. */
  | { greet: false; nextAt: string };

const MINUTE = 60 * 1000;

/** The words a person is remembered by, the same as for the reply limits: their account when signed in, else their own id. */
async function personKeyOf(input: { userId?: unknown; isGuest?: unknown }): Promise<string | null> {
  const userId = typeof input.userId === 'string' && input.userId ? input.userId.slice(0, 255) : null;
  if (!userId) return null;
  const person = await resolveUsagePerson(userId, input.isGuest);
  return person.personId ? `person:${person.personId}` : `guest:${userId}`;
}

async function findBot(botId: string): Promise<void> {
  const bot = await prisma.bot.findUnique({ where: { id: botId }, select: { id: true } });
  if (!bot) throw new ReplyAllowanceError('Bot not found', 404);
}

/**
 * May this bot greet this person now? Yes when it never has, or its last greeting is at least the cooldown ago; the greeting is
 * then remembered as made now. One statement, so two asked at the same moment don't both get a yes.
 */
export async function claimGreeting(
  botId: string,
  input: { userId?: unknown; isGuest?: unknown },
  now: Date = new Date(),
): Promise<GreetingAnswer> {
  await findBot(botId);
  const personKey = await personKeyOf(input);
  // Nobody to remember: greeted, as any reply to someone the bot can't name is answered
  if (!personKey) return { greet: true };
  const cooldown = await getGreetingCooldownMinutes();
  const lastBefore = new Date(now.getTime() - cooldown * MINUTE);
  const rows = await prisma.$queryRaw<{ greeted_at: Date }[]>(Prisma.sql`
    INSERT INTO "bot_greetings" ("bot_id", "person_key", "greeted_at") VALUES (${botId}, ${personKey}, ${now})
    ON CONFLICT ("bot_id", "person_key") DO UPDATE SET "greeted_at" = EXCLUDED."greeted_at"
      WHERE "bot_greetings"."greeted_at" <= ${lastBefore}
    RETURNING "greeted_at"`);
  if (rows.length > 0) return { greet: true, greetedAt: now.toISOString() };
  const last = await prisma.botGreeting.findUnique({ where: { botId_personKey: { botId, personKey } }, select: { greetedAt: true } });
  const nextAt = new Date((last?.greetedAt ?? now).getTime() + cooldown * MINUTE);
  return { greet: false, nextAt: nextAt.toISOString() };
}

/**
 * A greeting that was claimed and then not made after all: it is forgotten, so this bot greets the person next time. Only the
 * greeting claimed at `greetedAt` is forgotten, never a newer one. `released` says whether there was one to forget.
 */
export async function releaseGreeting(
  botId: string,
  input: { userId?: unknown; isGuest?: unknown; greetedAt?: unknown },
): Promise<{ released: boolean }> {
  const greetedAt = typeof input.greetedAt === 'string' ? new Date(input.greetedAt) : null;
  if (!greetedAt || Number.isNaN(greetedAt.getTime())) throw new ReplyAllowanceError('greetedAt is required (the time the greeting was claimed at)', 400);
  await findBot(botId);
  const personKey = await personKeyOf(input);
  if (!personKey) return { released: false };
  const { count } = await prisma.botGreeting.deleteMany({ where: { botId, personKey, greetedAt } });
  return { released: count > 0 };
}
