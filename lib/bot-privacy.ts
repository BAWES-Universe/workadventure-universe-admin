import type { Prisma } from '@prisma/client';
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

/**
 * A bot that hides its conversations is moved to a room whose universe does not hide them: without help it would stop
 * being hidden and show what it wrote before (transcripts and memory belong to the bot, not to the room). True when
 * the move must also set the bot to Private, so the move changes nothing about who can read what it already wrote.
 * A manager can still pick Normal afterwards, on purpose.
 */
export async function mustStayPrivateAfterMove(botId: string, newRoomId: string): Promise<boolean> {
  const [current, target] = await Promise.all([
    loadBotPrivacy(botId),
    prisma.room.findUnique({
      where: { id: newRoomId },
      select: { world: { select: { universe: { select: { hideBotConversations: true } } } } },
    }),
  ]);
  if (!current?.hidden || !target) return false;
  return !target.world.universe.hideBotConversations && current.choice !== 'private';
}

/** Is this bot hidden? A bot that is gone is not. */
export async function isBotHidden(botId: string): Promise<boolean> {
  return (await loadBotPrivacy(botId))?.hidden === true;
}

/** The filter for bots that hide their conversations: their own choice is Private, or their universe hides them. */
const HIDING_BOTS: Prisma.BotWhereInput = {
  OR: [{ hideConversations: true }, { room: { world: { universe: { hideBotConversations: true } } } }],
};

/** Every bot that hides its conversations, for the pages that list across bots. */
export async function hiddenBotIds(): Promise<string[]> {
  const bots = await prisma.bot.findMany({ where: HIDING_BOTS, select: { id: true } });
  return bots.map((bot) => bot.id);
}

/**
 * Delete a bot, or a room, world or universe that holds bots, without leaving the hidden transcripts and memory of
 * its hidden bots behind. Transcripts and memory are kept by bot id, not tied to the bot row, so deleting the bot
 * would leave them with nothing to say they were hidden, and the lists across bots would show them. The hidden bots'
 * data goes in the same transaction as the delete. When no bot in it hides, this is just the delete, as before.
 *
 * `botsWhere` picks the bots that go with it, `remove` is the delete itself.
 */
export async function deleteWithHiddenBotData<T>(botsWhere: Prisma.BotWhereInput, remove: () => Prisma.PrismaPromise<T>): Promise<T> {
  const hidden = await prisma.bot.findMany({ where: { AND: [botsWhere, HIDING_BOTS] }, select: { id: true } });
  if (hidden.length === 0) return remove();
  const botIdIn = { botId: { in: hidden.map((bot) => bot.id) } };
  const results = await prisma.$transaction([
    prisma.botsConversation.deleteMany({ where: botIdIn }),
    prisma.botsMemory.deleteMany({ where: botIdIn }),
    prisma.botMemoryForget.deleteMany({ where: botIdIn }),
    remove(),
  ]);
  return results[results.length - 1] as T;
}

/** What a hidden bot may still tell a human: how many people it remembers and when that last changed. No text, no names. */
export async function memoryTally(botId: string): Promise<{ people: number; lastUpdated: number | null }> {
  const tally = await prisma.botsMemory.aggregate({ where: { botId }, _count: { _all: true }, _max: { updatedAt: true } });
  return { people: tally._count._all, lastUpdated: tally._max.updatedAt?.getTime() ?? null };
}

export interface Forgetting {
  everyone: boolean;
  userUuids: Set<string>;
  rows: { id: string; userUuid: string | null }[];
}

/** How long a forget stays after the bot server was told, in case the answer was lost on the way. */
export const FORGET_GRACE_MS = 60_000;

/**
 * The people this bot has been asked to forget (#435), and marks them as told to the bot server. The bot server asks
 * every 30 seconds (the privacy answer) and hears it again with its next memory save. A row stays a minute after the
 * bot server was first told, so an answer that got lost is told again and a save in that minute still skips them;
 * after that it is removed, and what the bot learns about the person from then on is saved as usual.
 */
export async function takeForgets(botId: string): Promise<Forgetting> {
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
    rows: live.map((row) => ({ id: row.id, userUuid: row.userUuid })),
  };
}

/**
 * Takes out of the saved memory the people a Forget asked for after a save had checked, among the ones that save just
 * wrote. The save checks who was forgotten once and then writes people one by one, so a Forget pressed in between
 * would be written back. Reads the rows as they are and marks nothing as told. Returns how many people it removed.
 */
export async function dropForgottenFrom(botId: string, written: string[]): Promise<number> {
  if (written.length === 0) return 0;
  const now = Date.now();
  const rows = await prisma.botMemoryForget.findMany({ where: { botId }, select: { userUuid: true, reportedAt: true } });
  const live = rows.filter((row) => !row.reportedAt || now - row.reportedAt.getTime() <= FORGET_GRACE_MS);
  const everyone = live.some((row) => row.userUuid === null);
  const forgotten = new Set(live.flatMap((row) => (row.userUuid === null ? [] : [row.userUuid])));
  const drop = written.filter((userUuid) => everyone || forgotten.has(userUuid));
  if (drop.length === 0) return 0;
  await prisma.botsMemory.deleteMany({ where: { botId, userUuid: { in: drop } } });
  return drop.length;
}

/**
 * What the bot server is told to forget, or nothing when nobody was. Each row comes with its id: the same Forget is
 * repeated for a minute, so the bot server applies a row once by its id, and a second Forget of the same person within
 * that minute is a new row it still applies (`userUuid` null is everyone).
 */
export function forgetNotice(forgetting: Forgetting): { everyone: boolean; userUuids: string[]; rows: Forgetting['rows'] } | undefined {
  if (!forgetting.everyone && forgetting.userUuids.size === 0) return undefined;
  return { everyone: forgetting.everyone, userUuids: [...forgetting.userUuids], rows: forgetting.rows };
}
