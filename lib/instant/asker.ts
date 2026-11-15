import { prisma } from '@/lib/db';
import { ownsBrick } from '@/lib/brick';
import { findUserByIdentifier } from '@/lib/user-identifier';

/**
 * Who an Instant run is for. Instant runs only on a person's own Brick (no room), for the Brick's OWNER's own request, and is paid
 * from that owner's Instant Apps credit. A visitor talking to someone's Brick, or a room bot, never runs it and never pays for it.
 * Returns the owner's id, or null when the asker is not the owner (same words for "not there").
 */
export async function ownerAsker(botId: string, input: { forOwner?: boolean; requesterKey?: string }): Promise<string | null> {
  const bot = await prisma.bot.findUnique({ where: { id: botId }, select: { roomId: true, ownerId: true, deletedAt: true } });
  if (!bot || !bot.ownerId || !ownsBrick(bot, bot.ownerId)) return null;
  if (input.forOwner === true) return bot.ownerId;
  if (!input.requesterKey) return null;
  const asker = await findUserByIdentifier(input.requesterKey);
  return asker && !asker.isGuest && asker.id === bot.ownerId ? bot.ownerId : null;
}
