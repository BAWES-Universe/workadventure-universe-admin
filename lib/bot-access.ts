import { prisma } from '@/lib/db';
import { has, type PermissionKey } from '@/lib/permissions';
import { ADMIN_KEY, worldAccessFor } from '@/lib/roles';
import { verdictFor, type RuleBits } from '@/lib/bot-rules';
import { canSeeRoom } from '@/lib/room-visibility';
import { findUserByIdentifier } from '@/lib/user-identifier';
import { isSuperAdmin } from '@/lib/super-admin';
import { bansCoveringWorld } from '@/lib/moderation';
import { ownsBrick } from '@/lib/brick';
import { whereIsBrick } from '@/lib/brick-visit';
import { canManageThisBot } from '@/lib/bot-permissions';

/**
 * Can this person do this with this bot? (#426) What people do with a bot: chat in its bubble on the map, send it
 * direct messages, call it (game #2004), or summon it; and (#737) having it change things, or delete or send. The bot server and the game ask
 * this with the service token before they let it happen, and show `reason` when the answer is no (null for having a bot
 * change things, or delete or send: the code says no, and the caller words it).
 *
 * The answer comes from the role permissions in the bot's world (the same number the game gets, see permissionsForWorld),
 * then the bot's own rules (#427), in this order: its creator, the universe owner, super admins and Admin always pass;
 * then the person's own row; then the rows of their roles; then Private bot, which shuts out everyone a row does not
 * say Yes to; then the role permissions. Guests have no account, so they get Everyone's and Everyone's rows.
 *
 * A Brick (game #1992) has no room, so no world, roles or rules decide for it: its owner may do all of this with it, and
 * nobody else may do any of it. That holds for a super admin too, because a Brick answers from its owner's private memory.
 *
 * One exception, for a Brick that walks beside its owner in a place that takes visiting Bricks (game #2005, see
 * lib/brick-visit.ts): other people may chat with it nearby and send it direct messages as they could with any bot
 * there, by the roles of that place, and for nothing else: nobody summons it, has it change things or delete or send for
 * them. Nothing of its owner's is used for them (that is the bot server's rule, F4.1). No rule of the owner's, no
 * Private bot and no "its creator passes" apply, and a super admin or the universe's owner has no more say than any
 * member: it is not their bot. Whose key answers them is not decided here but in lib/bot-ai-credentials.ts: where the
 * owner's own key runs it, others are served it only where it is lent to the place, and Universe AI otherwise, so a Brick
 * is not refused here for its key; only when nothing can answer do they get the line that says so.
 */
export type BotAction = 'chat' | 'dm' | 'call' | 'summon' | 'change' | 'deleteOrSend';

export const BOT_ACTIONS: readonly BotAction[] = ['chat', 'dm', 'call', 'summon', 'change', 'deleteOrSend'];

/** The role permission behind each action. A call has none: only a Yes in a rule, or being the creator, owner, super admin, Admin or a manager, lets someone call. */
const ACTION_PERMISSION: Record<Exclude<BotAction, 'call'>, PermissionKey> = {
  chat: 'CHAT_BOTS_NEARBY',
  dm: 'DM_BOTS',
  summon: 'SUMMON_BOTS',
  change: 'BOTS_CHANGE_THINGS',
  deleteOrSend: 'BOTS_DELETE_OR_SEND',
};

export type BotAccessCode =
  /** Allowed. */
  | 'allowed'
  /** A direct message, or a call, needs an account. */
  | 'sign_in_required'
  /** The roles this person has don't allow it. */
  | 'not_allowed'
  /** A direct message or a call with a bot in a room this person can't see. */
  | 'no_room_access'
  /** A direct message from a chat account no Orbit account has. */
  | 'unknown_person'
  /** A direct message from a chat account two Orbit accounts claim: Orbit can't tell whose it is. */
  | 'shared_chat_id'
  /** A direct message, a call, or having the bot change things or delete or send, from someone banned from the bot's world. */
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
  if (code === 'sign_in_required') {
    return { allowed: false, code, reason: action === 'call' ? `Sign in to call ${botName}.` : `Sign in to message ${botName}.` };
  }
  if (action === 'summon') return { allowed: false, code, reason: `${botName}'s owner limits who can summon it.` };
  if (action === 'call') return { allowed: false, code, reason: `You can't call ${botName} now.` };
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
  if ((action === 'dm' || action === 'call') && !input.signedIn) return refusal('sign_in_required', action, botName);
  if (input.passes) return ALLOWED;
  if (!input.isAdmin) {
    const verdict = verdictFor(action, input.personRule ?? null, input.roleRules ?? []);
    if (verdict === 'no') return refusal('not_allowed', action, botName, input.fixedReply);
    // Private bot decides who may use the bot at all; changing, deleting and sending are the roles' to decide
    const shutOut = input.privateBot && (action === 'chat' || action === 'dm' || action === 'call' || action === 'summon');
    if (verdict === 'none' && (shutOut || (action === 'call' || !has(input.permissions, ACTION_PERMISSION[action])))) {
      return refusal('not_allowed', action, botName, input.fixedReply);
    }
  }
  if ((action === 'dm' || action === 'call') && !input.canSeeRoom) return refusal('no_room_access', action, botName);
  return ALLOWED;
}

export interface BotAccessRequest {
  botId: string;
  action: BotAction;
  /**
   * The room the person is in, when the caller knows it. A visiting Brick is only ever reached from the room it is in:
   * from any other it answers as a Brick that is not there for them.
   */
  roomUrl?: string | null;
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
      roomId: true,
      ownerId: true,
      deletedAt: true,
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

  let user: { id: string; uuid: string; email: string | null; name: string | null; isGuest: boolean } | null;
  // Whose ban to look up. Only the ban: a guest account has no roles or membership, so `user` stays null for it
  let banUserId: string | null = null;
  let signedIn = person.signedIn;
  let named: BotAccessAnswer['person'];
  if (person.chatId) {
    // The game saves the chat ID each player's client reports, so two accounts can claim one. Refuse rather than
    // guess, or one person's words would reach the bot as someone else and land in the other's memory.
    const owners = await prisma.user.findMany({ where: { matrixChatId: person.chatId }, take: 2, select: PERSON_SELECT });
    if (owners.length === 0) return refusal('unknown_person', action, bot.name);
    if (owners.length > 1) return refusal('shared_chat_id', action, bot.name);
    user = owners[0].isGuest ? null : owners[0];
    banUserId = owners[0].id;
    signedIn = !owners[0].isGuest;
    named = { uuid: owners[0].uuid, name: owners[0].name };
  } else {
    // An account that signed in; a guest, or a signed-in person Orbit has no account for, has only what Everyone has
    user = person.signedIn && person.identifier ? await findUserByIdentifier(person.identifier) : null;
    banUserId = user?.id ?? null;
  }

  // A visiting Brick, and the person who is not its owner talking to it (game #2005): decided below by the roles of the
  // place it visits, never by anything of its owner's
  let visitor: { place: NonNullable<Awaited<ReturnType<typeof whereIsBrick>>>['place'] } | null = null;
  if (!bot.room) {
    // A Brick: its owner, signed in, and nobody else. No world to be banned from, and no roles or rules to read.
    if ((action === 'dm' || action === 'call') && !signedIn) {
      const answer = refusal('sign_in_required', action, bot.name);
      return named ? { ...answer, person: named } : answer;
    }
    if (ownsBrick(bot, user?.id)) return named ? { ...ALLOWED, person: named } : ALLOWED;
    // Talking nearby is talking in a room, so it is only ever answered for a room the caller names, and that must be the room the
    // Brick is in. Callers that name none (the files and artifacts of a reply, a tool) get the answer of a Brick that is not there.
    // Only a direct message may come from anywhere, as with any bot.
    const roomNamed = action === 'dm' || !!request.roomUrl;
    const here = (action === 'chat' || action === 'dm') && bot.deletedAt === null && roomNamed ? await whereIsBrick(bot.id, request.roomUrl ?? null) : null;
    if (!here) {
      const answer = refusal('not_allowed', action, bot.name);
      return named ? { ...answer, person: named } : answer;
    }
    visitor = { place: here.place };
  }
  const place = bot.room ?? visitor!.place.room;
  const { world } = place;

  // A direct message and a call can come from anywhere, so a ban from the bot's world keeps them out too, and so does
  // having the bot change things, or delete or send, which can be asked in a direct message. Chatting nearby and
  // summoning need the person in the room, which a ban already stops.
  if ((action === 'dm' || action === 'call' || action === 'change' || action === 'deleteOrSend') && banUserId) {
    const ban = await prisma.ban.findFirst({
      where: { AND: [bansCoveringWorld({ id: world.id, universeId: world.universeId }), { userId: banUserId }] },
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

  // A visiting Brick has no rules of its own here: the roles of the place decide, like any bot that has none
  const rules = visitor ? [] : (bot.accessRules ?? []);
  const roleIds = new Set(roles.map((role) => role.id));
  const personRule = user ? (rules.find((rule) => rule.userId === user.id) ?? null) : null;
  const roleRules = rules.filter((rule) => rule.roleId && roleIds.has(rule.roleId));

  const decide = (asked: BotAction, passes: boolean) =>
    decideBotAccess({
      action: asked,
      botName: bot.name,
      signedIn,
      passes,
      isAdmin: has(permissions, 'ADMINISTRATOR') || roles.some((role) => role.key === ADMIN_KEY) || worldTags.includes(ADMIN_KEY),
      permissions,
      privateBot: visitor ? false : bot.privateBot,
      personRule,
      roleRules,
      fixedReply: visitor ? null : bot.refusalReply,
      canSeeRoom: canSeeRoom(
        place,
        user ? { id: user.id, isSuperAdmin: superAdmin } : null,
        new Set(membership ? [world.id] : []),
      ),
    });
  const passes = !visitor && !!user && (bot.createdById === user.id || world.universe.ownerId === user.id || superAdmin);

  let answer: BotAccessAnswer;
  if (action === 'call') {
    // A call is a direct message spoken out loud, so the person must be allowed to message the bot first (sign-in, the
    // bot's room, a ban, Private bot, the rules for Direct messages); then the Call row decides on top of that.
    const message = decide('dm', passes);
    if (!message.allowed) {
      answer = refusal(message.code as Exclude<BotAccessCode, 'allowed'>, 'call', bot.name);
    } else {
      // Call starts as No, so only the bot's creator, its universe's owner, super admins, Admin and the people who manage
      // this bot call it unless a rule or a role says Yes. A rule that says No still stops a manager.
      const said = verdictFor('call', personRule, roleRules);
      const manages =
        !passes && !!user && said === 'none'
          ? await canManageThisBot(
              user.id,
              user.email,
              { id: bot.id, createdById: bot.createdById, roomId: bot.roomId, ownerId: bot.ownerId, deletedAt: bot.deletedAt },
              { creatorPasses: true },
            )
          : false;
      answer = decide('call', passes || manages);
    }
  } else {
    answer = decide(action, passes);
  }
  return named ? { ...answer, person: named } : answer;
}
