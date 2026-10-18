import { prisma } from '@/lib/db';
import { has, type PermissionKey } from '@/lib/permissions';
import { permissionsForWorld } from '@/lib/roles';
import { canSeeRoom } from '@/lib/room-visibility';
import { findUserByIdentifier } from '@/lib/user-identifier';
import { isSuperAdmin } from '@/lib/super-admin';

/**
 * Can this person do this with this bot? (#426) What people do with a bot: chat in its bubble on the map, message it
 * privately, or call it over. The bot server and the game ask this with the service token before they let it happen,
 * and show `reason` when the answer is no.
 *
 * Until each bot has its own overrides, the answer comes from the role permissions in the bot's world (the same
 * number the game gets, see permissionsForWorld). Guests have no account, so they get Everyone's.
 */
export type BotAction = 'chat' | 'dm' | 'summon';

export const BOT_ACTIONS: readonly BotAction[] = ['chat', 'dm', 'summon'];

const ACTION_PERMISSION: Record<BotAction, PermissionKey> = {
  chat: 'CHAT_BOTS_NEARBY',
  dm: 'DM_BOTS',
  summon: 'SUMMON_BOTS',
};

export type BotAccessCode =
  /** Allowed. */
  | 'allowed'
  /** A private chat needs an account. */
  | 'sign_in_required'
  /** The roles this person has don't allow it. */
  | 'not_allowed'
  /** A private chat with a bot in a room this person can't see. */
  | 'no_room_access';

export interface BotAccessAnswer {
  allowed: boolean;
  code: BotAccessCode;
  /** A line the game can show as it is. Null when allowed. */
  reason: string | null;
}

const ALLOWED: BotAccessAnswer = { allowed: true, code: 'allowed', reason: null };

function refusal(code: Exclude<BotAccessCode, 'allowed'>, action: BotAction, botName: string): BotAccessAnswer {
  if (code === 'sign_in_required') return { allowed: false, code, reason: `Sign in to message ${botName}.` };
  if (action === 'summon') return { allowed: false, code, reason: `${botName}'s owner limits who can call it over.` };
  if (action === 'chat') return { allowed: false, code, reason: `${botName}'s owner limits who can chat with it.` };
  return { allowed: false, code, reason: `You can't message ${botName} now.` };
}

/**
 * The decision itself, from what was found out about the person. A private chat always needs sign-in, even for an
 * owner. The bot's creator, the universe's owner, super admins and Admin pass; everyone else needs the permission.
 */
export function decideBotAccess(input: {
  action: BotAction;
  botName: string;
  signedIn: boolean;
  /** The bot's creator, the owner of its universe or a super admin: no permission needed. */
  passes: boolean;
  permissions: bigint;
  /** Whether they may see the bot's room: only a private chat asks. */
  canSeeRoom: boolean;
}): BotAccessAnswer {
  const { action, botName } = input;
  if (action === 'dm' && !input.signedIn) return refusal('sign_in_required', action, botName);
  if (input.passes) return ALLOWED;
  if (!has(input.permissions, ACTION_PERMISSION[action])) return refusal('not_allowed', action, botName);
  if (action === 'dm' && !input.canSeeRoom) return refusal('no_room_access', action, botName);
  return ALLOWED;
}

export interface BotAccessRequest {
  botId: string;
  action: BotAction;
  person: {
    /** The caller vouches that this person is signed in. A guest's identifier is never looked at. */
    signedIn: boolean;
    /** Their WorkAdventure identifier: their email when signed in. */
    identifier?: string | null;
  };
}

/** The answer, or null when there is no such bot. */
export async function checkBotAccess(request: BotAccessRequest): Promise<BotAccessAnswer | null> {
  const { botId, action, person } = request;
  const bot = await prisma.bot.findUnique({
    where: { id: botId },
    select: {
      id: true,
      name: true,
      createdById: true,
      room: {
        select: {
          isPublic: true,
          world: {
            select: { id: true, isPublic: true, universeId: true, universe: { select: { isPublic: true, ownerId: true } } },
          },
        },
      },
    },
  });
  if (!bot) return null;
  const { world } = bot.room;

  // An account that signed in; a guest, or a signed-in person Orbit has no account for, has only what Everyone has
  const user = person.signedIn && person.identifier ? await findUserByIdentifier(person.identifier) : null;
  const membership = user
    ? await prisma.worldMember.findFirst({ where: { worldId: world.id, userId: user.id }, select: { tags: true } })
    : null;
  const permissions = await permissionsForWorld({
    userId: user?.id ?? null,
    worldId: world.id,
    universeId: world.universeId,
    worldTags: membership?.tags ?? [],
  });
  const superAdmin = !!user && isSuperAdmin(user.email);

  return decideBotAccess({
    action,
    botName: bot.name,
    signedIn: person.signedIn,
    passes: !!user && (bot.createdById === user.id || world.universe.ownerId === user.id || superAdmin),
    permissions,
    canSeeRoom: canSeeRoom(
      bot.room,
      user ? { id: user.id, isSuperAdmin: superAdmin } : null,
      new Set(membership ? [world.id] : []),
    ),
  });
}
