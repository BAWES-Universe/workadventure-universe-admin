import { prisma } from '@/lib/db';
import { canManageBots, canManageThisBot } from '@/lib/bot-permissions';
import { lendModels } from '@/lib/ai-key-model-list';
import { ownsBrick } from '@/lib/brick';

/**
 * Who pays for a bot's AI (#374, #709). A bot runs on Universe AI or on one person's own key, never on the chatter's.
 * Anyone who manages a bot may put it on their own key; nobody can put it on someone else's (lib/ai-provider-ref.ts
 * checks that the person saving owns the key). The maker stays the maker whichever key it is on. A personal key may run a
 * bot only while both hold:
 *   1. the key is lent to the universe the bot stands in;
 *   2. the key's owner can still manage this bot (its room's Manage bots, or the bot's own Manage rules), on their own
 *      roles: the super admin pass doesn't count, as it doesn't for lending.
 * Orbit checks this when a bot is saved, and again every time the bot server asks for the key. A key that may run the bot
 * also says which of its models the lend allows there (#575): null for all of them.
 *
 * A Brick (game #1992) stands in no universe, so there is no lend to look for. Only its owner manages it, so only its
 * owner's own key may run it, with all of that key's models.
 */
export type KeyForBot =
  | { ok: true; lendModels: string[] | null }
  | { ok: false; reason: 'no-owner' | 'not-lent' | 'no-access' | 'no-room' };

/** The bot a key would run: a bot not made yet has no id, and then the room's Manage bots decides. */
export interface BotForKey {
  id: string | null;
  createdById: string | null;
  /** Null for a Brick, which has no room: then `ownerId` decides. */
  roomId: string | null;
  ownerId: string | null;
  /** Set while a Brick waits deleted (game #1996): then no key runs it, its owner's included. */
  deletedAt: Date | null;
}

export async function checkKeyForBot(input: { keyId: string; keyOwnerId: string | null; bot: BotForKey }): Promise<KeyForBot> {
  if (!input.keyOwnerId) return { ok: false, reason: 'no-owner' };
  const roomId = input.bot.roomId;
  if (roomId === null) {
    return ownsBrick(input.bot, input.keyOwnerId) ? { ok: true, lendModels: null } : { ok: false, reason: 'no-access' };
  }
  const room = await prisma.room.findUnique({ where: { id: roomId }, select: { world: { select: { universeId: true } } } });
  if (!room) return { ok: false, reason: 'no-room' };
  const lent = await prisma.aiKeyLend.findUnique({
    where: { providerId_universeId: { providerId: input.keyId, universeId: room.world.universeId } },
    select: { id: true, models: true },
  });
  if (!lent) return { ok: false, reason: 'not-lent' };
  const manages = input.bot.id
    ? await canManageThisBot(input.keyOwnerId, null, { id: input.bot.id, createdById: input.bot.createdById, roomId, ownerId: input.bot.ownerId, deletedAt: input.bot.deletedAt }, { creatorPasses: false })
    : await canManageBots(input.keyOwnerId, roomId);
  if (!manages) return { ok: false, reason: 'no-access' };
  return { ok: true, lendModels: lendModels(lent.models) };
}

/** What to tell the person saving a bot when its key can't run it, in plain words. */
export const KEY_FOR_BOT_TEXT: Record<Exclude<KeyForBot, { ok: true }>['reason'], string> = {
  'no-owner': 'This key isn’t there anymore.',
  'not-lent': 'That key isn’t lent to this bot’s universe. Lend it from AI keys first.',
  'no-access': 'You need Manage bots here to run this bot on your key.',
  'no-room': 'That room isn’t there.',
};

/**
 * A Brick that walks beside its owner in a place (game #2005) answers the people there too. Whose key runs it for them
 * is decided here, and the rule is the lending rule every bot has:
 *   - On Universe AI, or on a server provider, nothing of the owner's is spent: each person's own allowance is counted
 *     as it is for any bot (lib/reply-limits.ts), and the answer is yes.
 *   - On its owner's own key, only where the owner lent that key to this universe, and with the models that lend allows.
 *   - Never on the key of the person who is chatting: a Brick has one key, its owner's, and that is the only one asked.
 * A key that is gone is not a reason to refuse: the Brick is moved to Universe AI when its owner next talks to it, and
 * until then it is served from Universe AI, like any bot whose key went.
 */
export type KeyForOthers = { ok: true; lendModels: string[] | null } | { ok: false; reason: 'not-lent' | 'not-owners' };

export async function checkKeyForOthers(botId: string, universeId: string): Promise<KeyForOthers> {
  const bot = await prisma.bot.findUnique({ where: { id: botId }, select: { aiProviderRef: true, ownerId: true } });
  const ref = bot?.aiProviderRef;
  if (!bot || !ref) return { ok: true, lendModels: null };
  const key = await prisma.botsAiProvider.findUnique({ where: { providerId: ref }, select: { ownerId: true } });
  // Universe AI, a server provider or a key that is gone: nothing of the owner's to lend
  if (!key || !key.ownerId) return { ok: true, lendModels: null };
  if (key.ownerId !== bot.ownerId) return { ok: false, reason: 'not-owners' };
  const lent = await prisma.aiKeyLend.findUnique({ where: { providerId_universeId: { providerId: ref, universeId } }, select: { models: true } });
  return lent ? { ok: true, lendModels: lendModels(lent.models) } : { ok: false, reason: 'not-lent' };
}

/** Whether a Brick may answer other people in this universe at all, on what runs it. */
export async function keyServesOthersIn(botId: string, universeId: string): Promise<boolean> {
  return (await checkKeyForOthers(botId, universeId)).ok;
}
