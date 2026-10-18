import { prisma } from '@/lib/db';
import { has } from '@/lib/permissions';
import { permissionsForWorld } from '@/lib/roles';
import { isSuperAdmin } from '@/lib/super-admin';

/**
 * Checks if a user can manage bots in a specific room (#423).
 * Returns true if:
 * 1. User is the Universe owner, OR
 * 2. User's permissions in the room's world include Manage bots: Everyone's, Member's, and every role of theirs that
 *    works in that world (the same number the game gets, see permissionsForWorld). A person with no universe
 *    membership is read from their world tags, so an admin or editor there keeps what the tags gave them.
 */
export async function canManageBots(userId: string, roomId: string): Promise<boolean> {
  const room = await prisma.room.findUnique({
    where: { id: roomId },
    select: { world: { select: { id: true, universeId: true, universe: { select: { ownerId: true } } } } },
  });
  if (!room) return false;

  if (room.world.universe.ownerId === userId) return true;

  const member = await prisma.worldMember.findFirst({
    where: { worldId: room.world.id, userId },
    select: { tags: true },
  });
  const permissions = await permissionsForWorld({
    userId,
    worldId: room.world.id,
    universeId: room.world.universeId,
    worldTags: member?.tags ?? [],
  });
  return has(permissions, 'MANAGE_BOTS');
}


/**
 * Checks if a user can see and change a bot's MCP servers.
 * Returns true for whoever created the bot, anyone who can manage bots in its
 * room (see canManageBots), and super admins.
 */
export async function canManageBotMcpServers(
  userId: string,
  userEmail: string | null,
  bot: { createdById: string | null; roomId: string }
): Promise<boolean> {
  if (bot.createdById === userId) {
    return true;
  }
  if (isSuperAdmin(userEmail)) {
    return true;
  }
  return canManageBots(userId, bot.roomId);
}
