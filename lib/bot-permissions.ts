import { prisma } from '@/lib/db';
import { has } from '@/lib/permissions';
import { ADMIN_KEY, permissionsForWorld, worldAccessFor } from '@/lib/roles';
import { verdictFor } from '@/lib/bot-rules';
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


export interface ManagedBot {
  id: string;
  createdById: string | null;
  roomId: string;
}

/**
 * Whether someone manages this one bot (#427): what canManageBots says for its room, then the bot's own "Manage this
 * bot" rules. A rule of theirs says Yes or No (their own row first, then their roles' rows, a Yes from any role beating
 * a No from another); with none, the room answer stands. The bot's creator (when `creatorPasses`), the owner of the
 * universe, super admins and Admin always manage it, whatever a rule says. A bot with no rules answers exactly as
 * canManageBots does.
 */
export async function canManageThisBot(
  userId: string,
  userEmail: string | null,
  bot: ManagedBot,
  options: { creatorPasses: boolean },
): Promise<boolean> {
  if (options.creatorPasses && bot.createdById === userId) return true;
  if (isSuperAdmin(userEmail)) return true;

  const base = await canManageBots(userId, bot.roomId);
  const rules = await prisma.botAccessRule.findMany({
    where: { botId: bot.id },
    select: { roleId: true, userId: true, allow: true, deny: true },
  });
  if (rules.length === 0) return base;

  const room = await prisma.room.findUnique({
    where: { id: bot.roomId },
    select: { world: { select: { id: true, universeId: true, universe: { select: { ownerId: true } } } } },
  });
  if (!room) return base;
  if (room.world.universe.ownerId === userId) return true;

  const member = await prisma.worldMember.findFirst({
    where: { worldId: room.world.id, userId },
    select: { tags: true },
  });
  const worldTags = member?.tags ?? [];
  const { permissions, roles } = await worldAccessFor({
    userId,
    worldId: room.world.id,
    universeId: room.world.universeId,
    worldTags,
  });
  if (has(permissions, 'ADMINISTRATOR') || roles.some((role) => role.key === ADMIN_KEY) || worldTags.includes(ADMIN_KEY)) {
    return true;
  }

  const roleIds = new Set(roles.map((role) => role.id));
  const verdict = verdictFor(
    'manage',
    rules.find((rule) => rule.userId === userId) ?? null,
    rules.filter((rule) => rule.roleId && roleIds.has(rule.roleId)),
  );
  if (verdict === 'yes') return true;
  if (verdict === 'no') return false;
  return base;
}

/**
 * Checks if a user can see and change a bot's MCP servers.
 * Returns true for whoever created the bot, anyone who can manage bots in its
 * room (see canManageBots), and super admins; then the bot's own Manage rules
 * apply (see canManageThisBot).
 */
export async function canManageBotMcpServers(
  userId: string,
  userEmail: string | null,
  bot: ManagedBot
): Promise<boolean> {
  return canManageThisBot(userId, userEmail, bot, { creatorPasses: true });
}
