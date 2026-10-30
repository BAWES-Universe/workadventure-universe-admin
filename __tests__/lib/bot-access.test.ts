/**
 * Can this person do this with this bot? (#426) The database is a small in-memory stand-in, so the real permission
 * logic (permissionsForWorld, canSeeRoom) runs for every case. Test plan rows 1, 2, 6, 14 and the role-bit part of 12
 * (per-person rows come with the next issue).
 */
type Role = { key: string; position: number; permissions: bigint };
type Given = { role: Role; allWorlds: boolean; worldIds: string[] };

const state = {
  bot: null as null | { id: string; name: string; createdById: string | null; isPublicRoom: boolean; isPublicWorld: boolean },
  ownerId: 'owner',
  universePublic: true,
  users: [] as { id: string; uuid: string; email: string | null; name?: string | null; isGuest?: boolean; matrixChatId?: string | null }[],
  bannedUserIds: [] as string[],
  worldMembers: [] as { worldId: string; userId: string; tags: string[] }[],
  everyone: null as bigint | null,
  member: BigInt(0),
  memberships: new Map<string, { allWorlds: boolean; worldIds: string[]; roles: Given[] }>(),
};

jest.mock('@/lib/db', () => ({
  prisma: {
    bot: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) =>
        state.bot && state.bot.id === where.id
          ? {
              id: state.bot.id,
              name: state.bot.name,
              createdById: state.bot.createdById,
              room: {
                isPublic: state.bot.isPublicRoom,
                world: {
                  id: 'w1',
                  isPublic: state.bot.isPublicWorld,
                  universeId: 'u1',
                  universe: { isPublic: state.universePublic, ownerId: state.ownerId },
                },
              },
            }
          : null,
      ),
    },
    user: {
      findFirst: jest.fn(async ({ where }: { where: { OR: { uuid?: string; email?: string }[] } }) =>
        state.users.find((user) => where.OR.some((cond) => cond.uuid === user.uuid || cond.email === user.email)) ?? null,
      ),
      findMany: jest.fn(async ({ where, take }: { where: { matrixChatId: string }; take: number }) =>
        state.users
          .filter((user) => user.matrixChatId === where.matrixChatId)
          .slice(0, take)
          .map((user) => ({ id: user.id, uuid: user.uuid, email: user.email, name: user.name ?? null, isGuest: !!user.isGuest })),
      ),
    },
    ban: {
      findFirst: jest.fn(async ({ where }: { where: { AND: [unknown, { userId: string }] } }) =>
        state.bannedUserIds.includes(where.AND[1].userId) ? { id: 'ban-1' } : null,
      ),
    },
    worldMember: {
      findFirst: jest.fn(async ({ where }: { where: { worldId: string; userId: string } }) =>
        state.worldMembers.find((row) => row.worldId === where.worldId && row.userId === where.userId) ?? null,
      ),
    },
    role: {
      findUnique: jest.fn(async ({ where }: { where: { universeId_key: { key: string } } }) => {
        const key = where.universeId_key.key;
        if (key === 'everyone') return state.everyone === null ? null : { permissions: state.everyone };
        if (key === 'member') return { permissions: state.member };
        return null;
      }),
    },
    universeMember: {
      findUnique: jest.fn(async ({ where }: { where: { universeId_userId: { userId: string } } }) =>
        state.memberships.get(where.universeId_userId.userId) ?? null,
      ),
    },
  },
}));

import { BOT_ACTIONS, checkBotAccess, decideBotAccess, type BotAction } from '@/lib/bot-access';
import {
  ADMIN_KEY,
  BUILT_IN_ROLES,
  EDITOR_DEFAULT_PERMISSIONS,
  EVERYONE_DEFAULT_PERMISSIONS,
  EVERYONE_KEY,
  MEMBER_DEFAULT_PERMISSIONS,
} from '@/lib/roles';
import { ALL_PERMISSIONS, combine, flag } from '@/lib/permissions';

const ZERO = BigInt(0);
const role = (key: string, permissions: bigint, position = 20): Role => ({ key, position, permissions });
const everywhere = (r: Role): Given => ({ role: r, allWorlds: true, worldIds: [] });
const inWorlds = (r: Role, worldIds: string[]): Given => ({ role: r, allWorlds: false, worldIds });

const ADMIN = role(ADMIN_KEY, ALL_PERMISSIONS, 1_000_000);
const EDITOR = role('editor', EDITOR_DEFAULT_PERMISSIONS, 2);

const USERS = {
  sara: { id: 'u-sara', uuid: 'uuid-sara', email: 'sara@example.com' },
  omar: { id: 'u-omar', uuid: 'uuid-omar', email: 'omar@example.com' },
  nora: { id: 'u-nora', uuid: 'uuid-nora', email: 'nora@example.com' },
  boss: { id: 'owner', uuid: 'uuid-boss', email: 'boss@example.com' },
  root: { id: 'u-root', uuid: 'uuid-root', email: 'root@example.com' },
};

const GUEST = { signedIn: false };
const signedIn = (user: { email: string | null }) => ({ signedIn: true, identifier: user.email });

function join(user: { id: string }, given: Given[] = [], scope: { allWorlds: boolean; worldIds: string[] } = { allWorlds: true, worldIds: [] }) {
  state.memberships.set(user.id, { ...scope, roles: given });
  state.worldMembers.push({ worldId: 'w1', userId: user.id, tags: ['member'] });
}

/** What people do with a bot before the permissions to have it change things, or delete or send (#737). */
const USE_ACTIONS: readonly BotAction[] = BOT_ACTIONS.filter((action) => action === 'chat' || action === 'dm' || action === 'summon');

const ask = (action: BotAction, person: { signedIn: boolean; identifier?: string | null; chatId?: string | null }) =>
  checkBotAccess({ botId: 'bot-1', action, person });

beforeEach(() => {
  state.bot = { id: 'bot-1', name: 'Nora', createdById: USERS.nora.id, isPublicRoom: true, isPublicWorld: true };
  state.ownerId = USERS.boss.id;
  state.universePublic = true;
  state.users = Object.values(USERS).map((user) => ({ ...user }));
  state.bannedUserIds = [];
  state.worldMembers = [];
  state.everyone = EVERYONE_DEFAULT_PERMISSIONS;
  state.member = ZERO;
  state.memberships = new Map();
  delete process.env.SUPER_ADMINS;
});

describe('what bots work like before anyone changes anything', () => {
  it('starts Everyone with chat nearby, DM and summon on, and nothing else', () => {
    const everyone = BUILT_IN_ROLES.find((built) => built.key === EVERYONE_KEY)!;
    expect(everyone.permissions).toBe(BigInt(114688));
    expect(everyone.permissions).toBe(combine(flag('CHAT_BOTS_NEARBY'), flag('DM_BOTS'), flag('SUMMON_BOTS')));
    for (const built of BUILT_IN_ROLES.filter((item) => item.key !== EVERYONE_KEY && item.key !== ADMIN_KEY)) {
      expect(built.permissions & everyone.permissions).toBe(ZERO);
    }
  });

  it('row 1 and 6: a guest chats nearby and summons', async () => {
    expect(await ask('chat', GUEST)).toEqual({ allowed: true, code: 'allowed', reason: null });
    expect(await ask('summon', GUEST)).toEqual({ allowed: true, code: 'allowed', reason: null });
  });

  it('a guest can never DM: it needs an account, and says so', async () => {
    expect(await ask('dm', GUEST)).toEqual({ allowed: false, code: 'sign_in_required', reason: 'Sign in to message Nora.' });
  });

  it('row 2 and 6: a member of the universe chats nearby, DMs and summons', async () => {
    join(USERS.sara);
    for (const action of USE_ACTIONS) expect(await ask(action, signedIn(USERS.sara))).toEqual({ allowed: true, code: 'allowed', reason: null });
  });

  it('a signed-in person Orbit has no account for gets what Everyone has', async () => {
    for (const action of USE_ACTIONS) {
      expect((await ask(action, { signedIn: true, identifier: 'stranger@example.com' }))!.allowed).toBe(true);
    }
  });

  it('a universe with no Everyone row yet works like one with the default', async () => {
    state.everyone = null;
    expect((await ask('chat', GUEST))!.allowed).toBe(true);
    expect((await ask('summon', GUEST))!.allowed).toBe(true);
    join(USERS.sara);
    expect((await ask('dm', signedIn(USERS.sara)))!.allowed).toBe(true);
  });

  it('answers null for a bot that does not exist', async () => {
    expect(await checkBotAccess({ botId: 'nope', action: 'chat', person: GUEST })).toBeNull();
  });
});

describe('a permission turned off', () => {
  beforeEach(() => {
    state.everyone = ZERO;
  });

  it('refuses each action with its own line, for guests and members alike', async () => {
    join(USERS.sara);
    expect(await ask('chat', GUEST)).toEqual({ allowed: false, code: 'not_allowed', reason: "Nora's owner limits who can chat with it." });
    expect(await ask('summon', GUEST)).toEqual({ allowed: false, code: 'not_allowed', reason: "Nora's owner limits who can summon it." });
    expect(await ask('dm', signedIn(USERS.sara))).toEqual({ allowed: false, code: 'not_allowed', reason: "You can't message Nora now." });
    expect((await ask('chat', signedIn(USERS.sara)))!.allowed).toBe(false);
    expect((await ask('summon', signedIn(USERS.sara)))!.allowed).toBe(false);
  });

  it('each action follows its own permission', async () => {
    for (const [key, action] of [['CHAT_BOTS_NEARBY', 'chat'], ['DM_BOTS', 'dm'], ['SUMMON_BOTS', 'summon']] as const) {
      state.everyone = flag(key);
      join(USERS.sara);
      const answers = Object.fromEntries(await Promise.all(USE_ACTIONS.map(async (a) => [a, (await ask(a, signedIn(USERS.sara)))!.allowed])));
      expect(answers).toEqual({ chat: action === 'chat', dm: action === 'dm', summon: action === 'summon' });
      state.memberships.clear();
      state.worldMembers = [];
    }
  });

  it('a role with the permission lets its holders through, and others stay out', async () => {
    join(USERS.sara, [everywhere(role('friend', combine(flag('CHAT_BOTS_NEARBY'), flag('DM_BOTS'))))]);
    join(USERS.omar);
    expect((await ask('chat', signedIn(USERS.sara)))!.allowed).toBe(true);
    expect((await ask('dm', signedIn(USERS.sara)))!.allowed).toBe(true);
    expect((await ask('summon', signedIn(USERS.sara)))!.allowed).toBe(false);
    expect((await ask('chat', signedIn(USERS.omar)))!.allowed).toBe(false);
  });

  it('a role limited to other worlds does not help here', async () => {
    join(USERS.sara, [inWorlds(role('friend', flag('CHAT_BOTS_NEARBY')), ['elsewhere'])]);
    expect((await ask('chat', signedIn(USERS.sara)))!.allowed).toBe(false);
    state.memberships.get(USERS.sara.id)!.roles = [inWorlds(role('friend', flag('CHAT_BOTS_NEARBY')), ['w1'])];
    expect((await ask('chat', signedIn(USERS.sara)))!.allowed).toBe(true);
  });

  it('an Editor with Manage bots gets no chat, DM or summon from it: using a bot is its own permission', async () => {
    join(USERS.sara, [everywhere(EDITOR)]);
    expect(EDITOR.permissions & flag('MANAGE_BOTS')).not.toBe(ZERO);
    expect((await ask('chat', signedIn(USERS.sara)))!.allowed).toBe(false);
  });

  it('the built-in Admin always passes, and so does Administrator', async () => {
    join(USERS.sara, [everywhere(ADMIN)]);
    join(USERS.omar, [everywhere(role('boss', flag('ADMINISTRATOR')))]);
    for (const action of USE_ACTIONS) {
      expect((await ask(action, signedIn(USERS.sara)))!.allowed).toBe(true);
      expect((await ask(action, signedIn(USERS.omar)))!.allowed).toBe(true);
    }
  });

  it('an Admin who joined only some worlds does not pass in a world they are not in', async () => {
    join(USERS.sara, [inWorlds(ADMIN, ['elsewhere'])]);
    expect((await ask('chat', signedIn(USERS.sara)))!.allowed).toBe(false);
  });

  it('a world member with no universe membership keeps what their admin tag gave them', async () => {
    state.worldMembers.push({ worldId: 'w1', userId: USERS.sara.id, tags: ['admin'] });
    for (const action of USE_ACTIONS) expect((await ask(action, signedIn(USERS.sara)))!.allowed).toBe(true);
  });

  it('the bot’s creator, the universe owner and a super admin always pass', async () => {
    process.env.SUPER_ADMINS = USERS.root.email!;
    for (const user of [USERS.nora, USERS.boss, USERS.root]) {
      for (const action of USE_ACTIONS) expect((await ask(action, signedIn(user)))!.allowed).toBe(true);
    }
  });

  it('even the owner needs an account for a direct message', async () => {
    expect((await ask('dm', GUEST))!.code).toBe('sign_in_required');
  });

  it('a guest who sends an admin’s identifier is still a guest', async () => {
    join(USERS.sara, [everywhere(ADMIN)]);
    const answer = await ask('chat', { signedIn: false, identifier: USERS.sara.email });
    expect(answer!.allowed).toBe(false);
  });
});

describe('a direct message and the room', () => {
  beforeEach(() => {
    state.bot!.isPublicRoom = false;
  });

  it('row 14: a world member can DM a bot in a private room, a signed-in stranger cannot', async () => {
    join(USERS.sara);
    expect(await ask('dm', signedIn(USERS.sara))).toEqual({ allowed: true, code: 'allowed', reason: null });
    expect(await ask('dm', signedIn(USERS.omar))).toEqual({ allowed: false, code: 'no_room_access', reason: "You can't message Nora now." });
  });

  it('chatting nearby and summoning are decided where the person stands, so only the permission counts', async () => {
    expect((await ask('chat', signedIn(USERS.omar)))!.allowed).toBe(true);
    expect((await ask('summon', GUEST))!.allowed).toBe(true);
  });

  it('the bot’s creator can still DM their own bot', async () => {
    expect((await ask('dm', signedIn(USERS.nora)))!.allowed).toBe(true);
  });

  it('a room that is private because its world is, is private', async () => {
    state.bot!.isPublicRoom = true;
    state.bot!.isPublicWorld = false;
    expect((await ask('dm', signedIn(USERS.omar)))!.code).toBe('no_room_access');
  });
});

describe('a direct message that reached the bot over chat', () => {
  const chatOf = (user: { id: string }, chatId: string, extra: { name?: string; isGuest?: boolean } = {}) => {
    const row = state.users.find((candidate) => candidate.id === user.id)!;
    Object.assign(row, { matrixChatId: chatId, ...extra });
  };
  const byChat = (chatId: string) => ask('dm', { signedIn: true, chatId });

  it('finds whose chat account it is, decides as for them, and says who they are', async () => {
    chatOf(USERS.sara, '@sara:chat.example', { name: 'Sara' });
    join(USERS.sara);
    expect(await byChat('@sara:chat.example')).toEqual({
      allowed: true,
      code: 'allowed',
      reason: null,
      person: { uuid: 'uuid-sara', name: 'Sara' },
    });
  });

  it('follows the owner’s rules for that person, exactly as for the same person asking from the game', async () => {
    chatOf(USERS.sara, '@sara:chat.example');
    join(USERS.sara);
    state.everyone = ZERO;
    const fromChat = await byChat('@sara:chat.example');
    const fromGame = (await ask('dm', signedIn(USERS.sara)))!;
    expect(fromGame.allowed).toBe(false);
    expect(fromChat).toMatchObject({ allowed: false, code: fromGame.code, reason: fromGame.reason });
  });

  it('refuses a chat account no Orbit account has', async () => {
    expect(await byChat('@stranger:elsewhere.example')).toEqual({
      allowed: false,
      code: 'unknown_person',
      reason: "You can't message Nora now.",
    });
  });

  it('refuses a chat account two accounts claim, and names neither', async () => {
    chatOf(USERS.sara, '@shared:chat.example');
    chatOf(USERS.omar, '@shared:chat.example');
    const answer = await byChat('@shared:chat.example');
    expect(answer).toEqual({ allowed: false, code: 'shared_chat_id', reason: "You can't message Nora now." });
  });

  it('a guest account’s chat is a guest’s: it needs to sign in', async () => {
    chatOf(USERS.omar, '@guest-omar:chat.example', { isGuest: true });
    expect(await byChat('@guest-omar:chat.example')).toMatchObject({ allowed: false, code: 'sign_in_required' });
  });

  it('keeps out someone banned from the bot’s world, from chat and from the game, even the bot’s creator', async () => {
    chatOf(USERS.sara, '@sara:chat.example');
    join(USERS.sara);
    state.bannedUserIds = [USERS.sara.id, USERS.nora.id];
    expect(await byChat('@sara:chat.example')).toEqual({ allowed: false, code: 'banned', reason: "You can't message Nora now." });
    expect(await ask('dm', signedIn(USERS.sara))).toMatchObject({ allowed: false, code: 'banned' });
    expect(await ask('dm', signedIn(USERS.nora))).toMatchObject({ allowed: false, code: 'banned' });
  });

  it('a ban changes nothing for chatting nearby or summoning: being in the room is already decided', async () => {
    join(USERS.sara);
    state.bannedUserIds = [USERS.sara.id];
    expect(await ask('chat', signedIn(USERS.sara))).toMatchObject({ allowed: true });
    expect(await ask('summon', signedIn(USERS.sara))).toMatchObject({ allowed: true });
  });

  it('the bot’s creator reaches their own bot over chat', async () => {
    chatOf(USERS.nora, '@nora:chat.example');
    state.everyone = ZERO;
    expect(await byChat('@nora:chat.example')).toMatchObject({ allowed: true, person: { uuid: 'uuid-nora' } });
  });
});

describe('decideBotAccess', () => {
  const base = { action: 'chat' as BotAction, botName: 'Atlas', signedIn: true, passes: false, permissions: ZERO, canSeeRoom: true };

  it('names the bot in the line it returns', () => {
    expect(decideBotAccess(base).reason).toBe("Atlas's owner limits who can chat with it.");
    expect(decideBotAccess({ ...base, action: 'summon' }).reason).toBe("Atlas's owner limits who can summon it.");
    expect(decideBotAccess({ ...base, action: 'dm' }).reason).toBe("You can't message Atlas now.");
    expect(decideBotAccess({ ...base, action: 'dm', signedIn: false }).reason).toBe('Sign in to message Atlas.');
  });

  it('only asks about the room for a direct message', () => {
    const everyone = EVERYONE_DEFAULT_PERMISSIONS;
    expect(decideBotAccess({ ...base, permissions: everyone, canSeeRoom: false }).allowed).toBe(true);
    expect(decideBotAccess({ ...base, action: 'summon', permissions: everyone, canSeeRoom: false }).allowed).toBe(true);
    expect(decideBotAccess({ ...base, action: 'dm', permissions: everyone, canSeeRoom: false }).allowed).toBe(false);
  });
});

describe('having a bot change things, or delete or send (#737)', () => {
  const MEMBER = role('member', MEMBER_DEFAULT_PERMISSIONS, 1);
  const both = ['change', 'deleteOrSend'] as const;

  it('starts Everyone, guests included, with neither', async () => {
    for (const action of both) expect((await ask(action, GUEST))!.allowed).toBe(false);
    join(USERS.sara);
    for (const action of both) expect((await ask(action, signedIn(USERS.sara)))!.allowed).toBe(false);
  });

  it('starts Member with change things only, Editor and Admin with both', async () => {
    state.member = MEMBER.permissions;
    join(USERS.sara);
    expect((await ask('change', signedIn(USERS.sara)))!.allowed).toBe(true);
    expect((await ask('deleteOrSend', signedIn(USERS.sara)))!.allowed).toBe(false);

    join(USERS.omar, [everywhere(EDITOR)]);
    for (const action of both) expect((await ask(action, signedIn(USERS.omar)))!.allowed).toBe(true);

    state.users.push({ id: 'u-adam', uuid: 'uuid-adam', email: 'adam@example.com' });
    join({ id: 'u-adam' }, [everywhere(ADMIN)]);
    for (const action of both) expect((await ask(action, signedIn({ email: 'adam@example.com' })))!.allowed).toBe(true);
  });

  it('each follows its own permission, and neither comes from chatting, DMing or Manage bots', async () => {
    for (const [key, action] of [['BOTS_CHANGE_THINGS', 'change'], ['BOTS_DELETE_OR_SEND', 'deleteOrSend']] as const) {
      state.everyone = flag(key);
      join(USERS.sara);
      const answers = Object.fromEntries(await Promise.all(both.map(async (a) => [a, (await ask(a, signedIn(USERS.sara)))!.allowed])));
      expect(answers).toEqual({ change: action === 'change', deleteOrSend: action === 'deleteOrSend' });
      state.memberships.clear();
      state.worldMembers = [];
    }
    state.everyone = combine(flag('CHAT_BOTS_NEARBY'), flag('DM_BOTS'), flag('SUMMON_BOTS'), flag('MANAGE_BOTS'));
    join(USERS.sara);
    for (const action of both) expect((await ask(action, signedIn(USERS.sara)))!.allowed).toBe(false);
  });

  it('refuses each with its own line', async () => {
    expect(await ask('change', GUEST)).toEqual({ allowed: false, code: 'not_allowed', reason: "You can't have Nora change things here." });
    expect(await ask('deleteOrSend', GUEST)).toEqual({
      allowed: false,
      code: 'not_allowed',
      reason: "You can't have Nora delete or send things here.",
    });
  });

  it('the bot’s creator, the universe owner and a super admin always pass', async () => {
    process.env.SUPER_ADMINS = USERS.root.email!;
    for (const user of [USERS.nora, USERS.boss, USERS.root]) {
      for (const action of both) expect((await ask(action, signedIn(user)))!.allowed).toBe(true);
    }
  });

  it('a guest who sends an admin’s identifier is still a guest', async () => {
    join(USERS.sara, [everywhere(ADMIN)]);
    expect((await ask('deleteOrSend', { signedIn: false, identifier: USERS.sara.email }))!.allowed).toBe(false);
  });
});
