import { prisma } from '@/lib/db';
import { canManageBots } from '@/lib/bot-permissions';

/**
 * Who pays for a bot's AI (#374). A bot runs on its maker's own key, or on Universe AI. Never on the chatter's key, never
 * on someone else's. A personal key may run a bot only while all three hold:
 *   1. the key's owner is the bot's maker (the person who created the bot);
 *   2. the key is lent to the universe the bot stands in;
 *   3. the maker can still manage bots in the bot's room (they have not lost access to the universe or the room).
 * Orbit checks this when a bot is saved, and again every time the bot server asks for the key.
 */
export type KeyForBot =
  | { ok: true }
  | { ok: false; reason: 'not-maker' | 'not-lent' | 'no-access' | 'no-room' };

export async function checkKeyForBot(input: { keyId: string; keyOwnerId: string | null; makerId: string | null; roomId: string }): Promise<KeyForBot> {
  if (!input.makerId || !input.keyOwnerId || input.keyOwnerId !== input.makerId) return { ok: false, reason: 'not-maker' };
  const room = await prisma.room.findUnique({ where: { id: input.roomId }, select: { world: { select: { universeId: true } } } });
  if (!room) return { ok: false, reason: 'no-room' };
  const lent = await prisma.aiKeyLend.findUnique({
    where: { providerId_universeId: { providerId: input.keyId, universeId: room.world.universeId } },
    select: { id: true },
  });
  if (!lent) return { ok: false, reason: 'not-lent' };
  if (!(await canManageBots(input.makerId, input.roomId))) return { ok: false, reason: 'no-access' };
  return { ok: true };
}

/** What to tell the person saving a bot when its key can't run it, in plain words. */
export const KEY_FOR_BOT_TEXT: Record<Exclude<KeyForBot, { ok: true }>['reason'], string> = {
  'not-maker': 'Only the person who made a bot can put it on their own key.',
  'not-lent': 'That key isn’t lent to this bot’s universe. Lend it from AI keys first.',
  'no-access': 'You need Manage bots here to run this bot on your key.',
  'no-room': 'That room isn’t there.',
};
