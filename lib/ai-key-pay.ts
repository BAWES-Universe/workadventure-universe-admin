import { prisma } from '@/lib/db';
import { canManageBots, canManageThisBot } from '@/lib/bot-permissions';
import { lendModels } from '@/lib/ai-key-model-list';

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
 */
export type KeyForBot =
  | { ok: true; lendModels: string[] | null }
  | { ok: false; reason: 'no-owner' | 'not-lent' | 'no-access' | 'no-room' };

/** The bot a key would run: a bot not made yet has no id, and then the room's Manage bots decides. */
export interface BotForKey {
  id: string | null;
  createdById: string | null;
  roomId: string;
}

export async function checkKeyForBot(input: { keyId: string; keyOwnerId: string | null; bot: BotForKey }): Promise<KeyForBot> {
  if (!input.keyOwnerId) return { ok: false, reason: 'no-owner' };
  const room = await prisma.room.findUnique({ where: { id: input.bot.roomId }, select: { world: { select: { universeId: true } } } });
  if (!room) return { ok: false, reason: 'no-room' };
  const lent = await prisma.aiKeyLend.findUnique({
    where: { providerId_universeId: { providerId: input.keyId, universeId: room.world.universeId } },
    select: { id: true, models: true },
  });
  if (!lent) return { ok: false, reason: 'not-lent' };
  const manages = input.bot.id
    ? await canManageThisBot(input.keyOwnerId, null, { id: input.bot.id, createdById: input.bot.createdById, roomId: input.bot.roomId }, { creatorPasses: false })
    : await canManageBots(input.keyOwnerId, input.bot.roomId);
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
