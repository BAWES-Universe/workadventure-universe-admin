import { prisma } from '@/lib/db';

/**
 * Hide bot conversations (#435). A universe can hide what its bots write down: Orbit then shows nobody (super admins
 * included) a transcript or what a bot remembers, and the bot server sends none of it to PostHog or Sentry. The bot
 * still remembers people exactly as before; this only decides who can read it.
 *
 * Each bot follows its universe unless its managers pick Private or Normal. A universe that hides them wins: a
 * manager cannot loosen it. Everything starts off, so nothing changes until an owner switches it on.
 */
export type BotPrivacyChoice = 'follow' | 'private' | 'normal';

export const BOT_PRIVACY_CHOICES: readonly BotPrivacyChoice[] = ['follow', 'private', 'normal'];

export interface BotPrivacy {
  /** The universe the bot lives in hides bot conversations. */
  universeHides: boolean;
  /** What this bot's managers picked. */
  choice: BotPrivacyChoice;
  /** The answer: hide this bot's conversations and memory. */
  hidden: boolean;
}

/** The stored per-bot value (null follows the universe) as the name the pages use. */
export function choiceOf(stored: boolean | null | undefined): BotPrivacyChoice {
  if (stored === true) return 'private';
  if (stored === false) return 'normal';
  return 'follow';
}

/** The stored value for a choice. */
export function storedFor(choice: BotPrivacyChoice): boolean | null {
  if (choice === 'private') return true;
  if (choice === 'normal') return false;
  return null;
}

export function resolveBotPrivacy(universeHides: boolean, stored: boolean | null | undefined): BotPrivacy {
  return { universeHides, choice: choiceOf(stored), hidden: universeHides || stored === true };
}

/**
 * Does this bot hide its conversations? null when the bot no longer exists: its leftovers are shown as they always
 * were, since there is no universe to ask.
 */
export async function loadBotPrivacy(botId: string): Promise<BotPrivacy | null> {
  const bot = await prisma.bot.findUnique({
    where: { id: botId },
    select: { hideConversations: true, room: { select: { world: { select: { universe: { select: { hideBotConversations: true } } } } } } },
  });
  if (!bot) return null;
  return resolveBotPrivacy(bot.room.world.universe.hideBotConversations, bot.hideConversations);
}

/** Is this bot hidden? A bot that is gone is not. */
export async function isBotHidden(botId: string): Promise<boolean> {
  return (await loadBotPrivacy(botId))?.hidden === true;
}

/** Every bot that hides its conversations, for the pages that list across bots. */
export async function hiddenBotIds(): Promise<string[]> {
  const bots = await prisma.bot.findMany({
    where: { OR: [{ hideConversations: true }, { room: { world: { universe: { hideBotConversations: true } } } }] },
    select: { id: true },
  });
  return bots.map((bot) => bot.id);
}

/** What a hidden bot may still tell a human: how many people it remembers and when that last changed. No text, no names. */
export async function memoryTally(botId: string): Promise<{ people: number; lastUpdated: number | null }> {
  const tally = await prisma.botsMemory.aggregate({ where: { botId }, _count: { _all: true }, _max: { updatedAt: true } });
  return { people: tally._count._all, lastUpdated: tally._max.updatedAt?.getTime() ?? null };
}

/** How long a forget stays after the bot server was told, in case the answer was lost on the way. */
export const FORGET_GRACE_MS = 60_000;

/**
 * The people this bot has been asked to forget (#435), and marks them as told to the bot server. The bot server asks
 * every 30 seconds (the privacy answer) and hears it again with its next memory save. A row stays a minute after the
 * bot server was first told, so an answer that got lost is told again and a save in that minute still skips them;
 * after that it is removed, and what the bot learns about the person from then on is saved as usual.
 */
export async function takeForgets(botId: string): Promise<{ everyone: boolean; userUuids: Set<string> }> {
  const now = new Date();
  const rows = await prisma.botMemoryForget.findMany({ where: { botId }, select: { id: true, userUuid: true, reportedAt: true } });
  const expired = rows.filter((row) => row.reportedAt && now.getTime() - row.reportedAt.getTime() > FORGET_GRACE_MS);
  const live = rows.filter((row) => !expired.includes(row));
  if (expired.length > 0) {
    await prisma.botMemoryForget.deleteMany({ where: { id: { in: expired.map((row) => row.id) } } });
  }
  const fresh = live.filter((row) => !row.reportedAt);
  if (fresh.length > 0) {
    await prisma.botMemoryForget.updateMany({ where: { id: { in: fresh.map((row) => row.id) } }, data: { reportedAt: now } });
  }
  return {
    everyone: live.some((row) => row.userUuid === null),
    userUuids: new Set(live.flatMap((row) => (row.userUuid === null ? [] : [row.userUuid]))),
  };
}
