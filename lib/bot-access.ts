import { prisma } from '@/lib/db';
import { has, type PermissionKey } from '@/lib/permissions';
import { ADMIN_KEY, worldAccessFor } from '@/lib/roles';
import { verdictFor, type RuleBits } from '@/lib/bot-rules';
import { canSeeRoom } from '@/lib/room-visibility';
import { findUserByIdentifier } from '@/lib/user-identifier';
import { isSuperAdmin } from '@/lib/super-admin';
import { bansCoveringWorld } from '@/lib/moderation';

/**
 * Can this person do this with this bot? (#426) What people do with a bot: chat in its bubble on the map, send it
 * direct messages, or summon it; and (#737) having it change things, or delete or send. The bot server and the game ask
 * this with the service token before they let it happen, and show `reason` when the answer is no (null for having a bot
 * change things, or delete or send: the code says no, and the caller words it).
 *
 * The answer comes from the role permissions in the bot's world (the same number the game gets, see permissionsForWorld),
 * then the bot's own rules (#427), in this order: its creator, the universe owner, super admins and Admin always pass;
 * then the person's own row; then the rows of their roles; then Private bot, which shuts out everyone a row does not
 * say Yes to; then the role permissions. Guests have no account, so they get Everyone's and Everyone's rows.
 */
export type BotAction = 'chat' | 'dm' | 'summon' | 'change' | 'deleteOrSend';

export const BOT_ACTIONS: readonly BotAction[] = ['chat', 'dm', 'summon', 'change', 'deleteOrSend'];

const ACTION_PERMISSION: Record<BotAction, PermissionKey> = {
  chat: 'CHAT_BOTS_NEARBY',
  dm: 'DM_BOTS',
  summon: 'SUMMON_BOTS',
  change: 'BOTS_CHANGE_THINGS',
  deleteOrSend: 'BOTS_DELETE_OR_SEND',
};

export type BotAccessCode =
  /** Allowed. */
  | 'allowed'
  /** A direct message needs an account. */
  | 'sign_in_required'
  /** The roles this person has don't allow it. */
  | 'not_allowed'
  /** A direct message with a bot in a room this person can't see. */
  | 'no_room_access'
  /** A direct message from a chat account no Orbit account has. */
  | 'unknown_person'
  /** A direct message from a chat account two Orbit accounts claim: Orbit can't tell whose it is. */
  | 'shared_chat_id'
  /** A direct message from someone banned from the bot's world. */
  | 'banned';

export interface BotAccessAnswer {
  allowed: boolean;
  code: BotAccessCode;
  /** A line the game can show as it is. Null when allowed, and for a refused change, delete or send. */
  reason: string | null;
  /** The owner's own line for people who may not chat with the bot, only on a refused chat when the owner wrote one. */
  reply?: string;
  /**
   * Who the chat account belongs to, when the caller named the person by it: their WorkAdventure uuid and name, so
   * the bot keeps one memory of them in its bubble and its chats. Only once Orbit has found exactly one account.
   */
  person?: { uuid: string; name: string | null };
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
  // Having a bot change things, or delete or send, has no line of its own: the caller (the bot) words its own refusal
  if (action === 'change' || action === 'deleteOrSend') return { allowed: false, code, reason: null };
  if (action === 'chat') {
    const reason = `${botName}'s owner limits who can chat with it.`;
    return fixedReply ? { allowed: false, code, reason, reply: fixedReply } : { allowed: false, code, reason };
  }
  return { allowed: false, code, reason: `You can't message ${botName} now.` };
}

/**
 * The decision itself, from what was found out about the person. A direct message always needs sign-in, even for an
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
  /** Whether they may see the bot's room: only a direct message asks. */
  canSeeRoom: boolean;
}): BotAccessAnswer {
  const { action, botName } = input;
  if (action === 'dm' && !input.signedIn) return refusal('sign_in_required', action, botName);
  if (input.passes) return ALLOWED;
  if (!input.isAdmin) {
    const verdict = verdictFor(action, input.personRule ?? null, input.roleRules ?? []);
    if (verdict === 'no') return refusal('not_allowed', action, botName, input.fixedReply);
    // Private bot decides who may use the bot at all; changing, deleting and sending are the roles' to decide
    const shutOut = input.privateBot && (action === 'chat' || action === 'dm' || action === 'summon');
    if (verdict === 'none' && (shutOut || !has(input.permissions, ACTION_PERMISSION[action]))) {
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
    /**
     * Their chat (Matrix) ID, for a direct message that reached the bot over chat, where the bot server knows nothing
     * else about them. Orbit finds the one account that has it, and that account's guest flag decides signed in.
     */
    chatId?: string | null;
  };
}

const PERSON_SELECT = { id: true, uuid: true, email: true, name: true, isGuest: true } as const;

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

  let user: { id: string; uuid: string; email: string | null; name: string | null; isGuest: boolean } | null;
  let signedIn = person.signedIn;
  let named: BotAccessAnswer['person'];
  if (person.chatId) {
    // The game saves the chat ID each player's client reports, so two accounts can claim one. Refuse rather than
    // guess, or one person's words would reach the bot as someone else and land in the other's memory.
    const owners = await prisma.user.findMany({ where: { matrixChatId: person.chatId }, take: 2, select: PERSON_SELECT });
    if (owners.length === 0) return refusal('unknown_person', action, bot.name);
    if (owners.length > 1) return refusal('shared_chat_id', action, bot.name);
    user = owners[0].isGuest ? null : owners[0];
    signedIn = !owners[0].isGuest;
    named = { uuid: owners[0].uuid, name: owners[0].name };
  } else {
    // An account that signed in; a guest, or a signed-in person Orbit has no account for, has only what Everyone has
    user = person.signedIn && person.identifier ? await findUserByIdentifier(person.identifier) : null;
  }

  // A direct message can come from anywhere, so a ban from the bot's world keeps it out too. Chatting nearby and
  // summoning need the person in the room, which a ban already stops.
  if (action === 'dm' && user) {
    const ban = await prisma.ban.findFirst({
      where: { AND: [bansCoveringWorld({ id: world.id, universeId: world.universeId }), { userId: user.id }] },
      select: { id: true },
    });
    if (ban) return refusal('banned', action, bot.name);
  }
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

  const answer = decideBotAccess({
    action,
    botName: bot.name,
    signedIn,
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
  return named ? { ...answer, person: named } : answer;
}
