import { prisma } from '@/lib/db';
import { has, type PermissionKey } from '@/lib/permissions';
import { ADMIN_KEY, worldAccessFor } from '@/lib/roles';
import { verdictFor, type RuleBits } from '@/lib/bot-rules';
import { canSeeRoom } from '@/lib/room-visibility';
import { findUserByIdentifier } from '@/lib/user-identifier';
import { isSuperAdmin } from '@/lib/super-admin';

/**
 * Can this person do this with this bot? (#426) What people do with a bot: chat in its bubble on the map, message it
 * privately, or summon it. The bot server and the game ask this with the service token before they let it happen,
 * and show `reason` when the answer is no.
 *
 * The answer comes from the role permissions in the bot's world (the same number the game gets, see permissionsForWorld),
 * then the bot's own rules (#427), in this order: its creator, the universe owner, super admins and Admin always pass;
 * then the person's own row; then the rows of their roles; then Private bot, which shuts out everyone a row does not
 * say Yes to; then the role permissions. Guests have no account, so they get Everyone's and Everyone's rows.
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
  /** The owner's own line for people who may not chat with the bot, only on a refused chat when the owner wrote one. */
  reply?: string;
}

const ALLOWED: BotAccessAnswer = { allowed: true, code: 'allowed', reason: null };

function refusal(
  code: Exclude<BotAccessCode, 'allowed'>,
  action: BotAction,
  botName: string,
  fixedReply?: string | null,
): BotAccessAnswer {
  if (code === 'sign_in_required') return { allowed: false, code, reason: `Sign in to message ${botName}.` };
  if (action === 'summon') return { allowed: false, code, reason: `${botName}'s owner limits who can summon it.` };
  if (action === 'chat') {
    const reason = `${botName}'s owner limits who can chat with it.`;
    return fixedReply ? { allowed: false, code, reason, reply: fixedReply } : { allowed: false, code, reason };
  }
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
  /** Holds Admin here: the bot's rules never apply to them. */
  isAdmin?: boolean;
  permissions: bigint;
  /** Private bot: only a Yes from a row lets someone use it. */
  privateBot?: boolean;
  /** The person's own row for this bot, and the rows of the roles they have here. */
  personRule?: RuleBits | null;
  roleRules?: readonly RuleBits[];
  /** What the owner wants refused people to hear when they chat nearby. */
  fixedReply?: string | null;
  /** Whether they may see the bot's room: only a private chat asks. */
  canSeeRoom: boolean;
}): BotAccessAnswer {
  const { action, botName } = input;
  if (action === 'dm' && !input.signedIn) return refusal('sign_in_required', action, botName);
  if (input.passes) return ALLOWED;
  if (!input.isAdmin) {
    const verdict = verdictFor(action, input.personRule ?? null, input.roleRules ?? []);
    if (verdict === 'no') return refusal('not_allowed', action, botName, input.fixedReply);
    if (verdict === 'none' && (input.privateBot || !has(input.permissions, ACTION_PERMISSION[action]))) {
      return refusal('not_allowed', action, botName, input.fixedReply);
    }
  }
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
      privateBot: true,
      refusalReply: true,
      accessRules: { select: { roleId: true, userId: true, allow: true, deny: true } },
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
  const worldTags = membership?.tags ?? [];
  const { permissions, roles } = await worldAccessFor({
    userId: user?.id ?? null,
    worldId: world.id,
    universeId: world.universeId,
    worldTags,
  });
  const superAdmin = !!user && isSuperAdmin(user.email);

  const rules = bot.accessRules ?? [];
  const roleIds = new Set(roles.map((role) => role.id));
  const personRule = user ? (rules.find((rule) => rule.userId === user.id) ?? null) : null;
  const roleRules = rules.filter((rule) => rule.roleId && roleIds.has(rule.roleId));

  return decideBotAccess({
    action,
    botName: bot.name,
    signedIn: person.signedIn,
    passes: !!user && (bot.createdById === user.id || world.universe.ownerId === user.id || superAdmin),
    isAdmin: has(permissions, 'ADMINISTRATOR') || roles.some((role) => role.key === ADMIN_KEY) || worldTags.includes(ADMIN_KEY),
    permissions,
    privateBot: bot.privateBot,
    personRule,
    roleRules,
    fixedReply: bot.refusalReply,
    canSeeRoom: canSeeRoom(
      bot.room,
      user ? { id: user.id, isSuperAdmin: superAdmin } : null,
      new Set(membership ? [world.id] : []),
    ),
  });
}
