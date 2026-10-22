/**
 * The check with a bot's own rules (#427): a role's or a person's No / Default / Yes, and Private bot. The database is a
 * small in-memory stand-in so the real permission logic (worldAccessFor, canSeeRoom, the order of the rules) runs for
 * every case. Test plan rows 11 to 15 for the check side: 12 (Private bot), 13 (a person's No beats their role's Yes),
 * 14 (the room still counts) and 15 (the owner changes access, the next question gets the new answer).
 */
type Role = { id: string; key: string; position: number; permissions: bigint };
type Given = { role: Role; allWorlds: boolean; worldIds: string[] };
type Rule = { roleId: string | null; userId: string | null; allow: bigint; deny: bigint };

const state = {
  bot: null as null | { id: string; name: string; createdById: string | null; isPublicRoom: boolean; privateBot: boolean; refusalReply: string | null },
  rules: [] as Rule[],
  ownerId: 'owner',
  users: [] as { id: string; uuid: string; email: string | null }[],
  worldMembers: [] as { worldId: string; userId: string; tags: string[] }[],
  everyone: BigInt(0),
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
              privateBot: state.bot.privateBot,
              refusalReply: state.bot.refusalReply,
              accessRules: state.rules,
              room: {
                isPublic: state.bot.isPublicRoom,
                world: {
                  id: 'w1',
                  isPublic: true,
                  universeId: 'u1',
                  universe: { isPublic: true, ownerId: state.ownerId },
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
    },
    worldMember: {
      findFirst: jest.fn(async ({ where }: { where: { worldId: string; userId: string } }) =>
        state.worldMembers.find((row) => row.worldId === where.worldId && row.userId === where.userId) ?? null,
      ),
    },
    role: {
      findUnique: jest.fn(async ({ where }: { where: { universeId_key: { key: string } } }) => {
        const key = where.universeId_key.key;
        if (key === 'everyone') return { id: 'r-everyone', permissions: state.everyone };
        if (key === 'member') return { id: 'r-member', permissions: state.member };
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

import { BOT_ACTIONS, checkBotAccess, type BotAction } from '@/lib/bot-access';
import { ADMIN_KEY, EVERYONE_DEFAULT_PERMISSIONS } from '@/lib/roles';
import { ALL_PERMISSIONS, flag } from '@/lib/permissions';
import { NO_RULE, withValues, type RuleAction, type RuleValue } from '@/lib/bot-rules';

const ZERO = BigInt(0);
const role = (key: string, permissions = ZERO, position = 20): Role => ({ id: `r-${key}`, key, position, permissions });
const everywhere = (r: Role): Given => ({ role: r, allWorlds: true, worldIds: [] });
const inWorlds = (r: Role, worldIds: string[]): Given => ({ role: r, allWorlds: false, worldIds });

const ADMIN = role(ADMIN_KEY, ALL_PERMISSIONS, 1_000_000);
const ACCOUNTANT = role('accountant');
const INTERN = role('intern');

const USERS = {
  sara: { id: 'u-sara', uuid: 'uuid-sara', email: 'sara@example.com' },
  omar: { id: 'u-omar', uuid: 'uuid-omar', email: 'omar@example.com' },
  mishari: { id: 'u-mishari', uuid: 'uuid-mishari', email: 'mishari@example.com' },
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

const rule = (subject: { roleId?: string; userId?: string }, values: Partial<Record<RuleAction, RuleValue>>) => {
  const bits = withValues(NO_RULE, values);
  state.rules.push({ roleId: subject.roleId ?? null, userId: subject.userId ?? null, ...bits });
};

const ask = (action: BotAction, person: { signedIn: boolean; identifier?: string | null }) =>
  checkBotAccess({ botId: 'bot-1', action, person });
const allowed = async (action: BotAction, person: { signedIn: boolean; identifier?: string | null }) => (await ask(action, person))!.allowed;

beforeEach(() => {
  state.bot = { id: 'bot-1', name: 'Nora', createdById: USERS.nora.id, isPublicRoom: true, privateBot: false, refusalReply: null };
  state.rules = [];
  state.ownerId = USERS.boss.id;
  state.users = Object.values(USERS);
  state.worldMembers = [];
  state.everyone = EVERYONE_DEFAULT_PERMISSIONS;
  state.member = ZERO;
  state.memberships = new Map();
  delete process.env.SUPER_ADMINS;
});

describe('a bot with no rules and Private bot off answers exactly as before', () => {
  it('rows 1, 2, 6: guests chat and summon, members do all three, a guest still cannot DM', async () => {
    join(USERS.sara);
    expect(await ask('chat', GUEST)).toEqual({ allowed: true, code: 'allowed', reason: null });
    expect(await ask('summon', GUEST)).toEqual({ allowed: true, code: 'allowed', reason: null });
    expect((await ask('dm', GUEST))!.code).toBe('sign_in_required');
    for (const action of BOT_ACTIONS) expect(await ask(action, signedIn(USERS.sara))).toEqual({ allowed: true, code: 'allowed', reason: null });
  });

  it('a refusal has the same three fields as before, with no owner line in it', async () => {
    state.everyone = ZERO;
    expect(await ask('chat', GUEST)).toEqual({ allowed: false, code: 'not_allowed', reason: "Nora's owner limits who can chat with it." });
  });

  it('a row with every action on Default changes nothing', async () => {
    join(USERS.sara, [everywhere(ACCOUNTANT)]);
    rule({ roleId: ACCOUNTANT.id }, {});
    rule({ userId: USERS.sara.id }, { chat: 'default', dm: 'default', summon: 'default' });
    for (const action of BOT_ACTIONS) expect(await allowed(action, signedIn(USERS.sara))).toBe(true);
    state.everyone = ZERO;
    for (const action of BOT_ACTIONS) expect(await allowed(action, signedIn(USERS.sara))).toBe(false);
  });
});

describe('row 12: Private bot', () => {
  beforeEach(() => {
    state.bot!.privateBot = true;
  });

  it('lets a listed person in for chat, DM and Summon, and shuts out everyone else', async () => {
    join(USERS.mishari);
    join(USERS.sara);
    rule({ userId: USERS.mishari.id }, { chat: 'yes', dm: 'yes', summon: 'yes' });
    for (const action of BOT_ACTIONS) {
      expect(await allowed(action, signedIn(USERS.mishari))).toBe(true);
      expect(await allowed(action, signedIn(USERS.sara))).toBe(false);
    }
  });

  it('shuts out guests, who get the line for each action', async () => {
    expect(await ask('chat', GUEST)).toMatchObject({ allowed: false, code: 'not_allowed' });
    expect(await ask('summon', GUEST)).toMatchObject({ allowed: false, reason: "Nora's owner limits who can summon it." });
    expect((await ask('dm', GUEST))!.code).toBe('sign_in_required');
  });

  it('a listed role lets everyone who has it in, and nobody who does not', async () => {
    join(USERS.sara, [everywhere(ACCOUNTANT)]);
    join(USERS.omar, [everywhere(INTERN)]);
    rule({ roleId: ACCOUNTANT.id }, { chat: 'yes', dm: 'yes', summon: 'yes' });
    for (const action of BOT_ACTIONS) {
      expect(await allowed(action, signedIn(USERS.sara))).toBe(true);
      expect(await allowed(action, signedIn(USERS.omar))).toBe(false);
    }
  });

  it('a role listed for another world does not count here', async () => {
    join(USERS.sara, [inWorlds(ACCOUNTANT, ['elsewhere'])]);
    rule({ roleId: ACCOUNTANT.id }, { chat: 'yes' });
    expect(await allowed('chat', signedIn(USERS.sara))).toBe(false);
  });

  it('only the actions a row says Yes to are open: the rest stay shut', async () => {
    join(USERS.mishari);
    rule({ userId: USERS.mishari.id }, { dm: 'yes' });
    expect(await allowed('dm', signedIn(USERS.mishari))).toBe(true);
    expect(await allowed('chat', signedIn(USERS.mishari))).toBe(false);
    expect(await allowed('summon', signedIn(USERS.mishari))).toBe(false);
  });

  it('being listed with Default is not being let in', async () => {
    join(USERS.sara, [everywhere(ACCOUNTANT)]);
    rule({ userId: USERS.sara.id }, { chat: 'default', dm: 'default', summon: 'default' });
    rule({ roleId: ACCOUNTANT.id }, {});
    for (const action of BOT_ACTIONS) expect(await allowed(action, signedIn(USERS.sara))).toBe(false);
  });

  it('the bot’s creator, the universe owner, a super admin and Admin always pass', async () => {
    process.env.SUPER_ADMINS = USERS.root.email!;
    join(USERS.sara, [everywhere(ADMIN)]);
    for (const user of [USERS.nora, USERS.boss, USERS.root, USERS.sara]) {
      for (const action of BOT_ACTIONS) expect(await allowed(action, signedIn(user))).toBe(true);
    }
  });

  it('Administrator and a world admin tag pass too', async () => {
    join(USERS.sara, [everywhere(role('boss', flag('ADMINISTRATOR')))]);
    state.worldMembers.push({ worldId: 'w1', userId: USERS.omar.id, tags: ['admin'] });
    for (const action of BOT_ACTIONS) {
      expect(await allowed(action, signedIn(USERS.sara))).toBe(true);
      expect(await allowed(action, signedIn(USERS.omar))).toBe(true);
    }
  });

  it('a Yes from the Everyone row opens the bot to all, guests included', async () => {
    rule({ roleId: 'r-everyone' }, { chat: 'yes', summon: 'yes' });
    expect(await allowed('chat', GUEST)).toBe(true);
    expect(await allowed('summon', GUEST)).toBe(true);
  });

  it('turning Private bot off brings back the role permissions for everyone', async () => {
    join(USERS.sara);
    expect(await allowed('chat', signedIn(USERS.sara))).toBe(false);
    state.bot!.privateBot = false;
    expect(await allowed('chat', signedIn(USERS.sara))).toBe(true);
  });
});

describe('row 13: a person’s row beats their role’s', () => {
  it('a person set to No is refused although their role says Yes', async () => {
    join(USERS.sara, [everywhere(ACCOUNTANT)]);
    rule({ roleId: ACCOUNTANT.id }, { chat: 'yes', dm: 'yes', summon: 'yes' });
    rule({ userId: USERS.sara.id }, { chat: 'no', dm: 'no', summon: 'no' });
    for (const action of BOT_ACTIONS) expect(await allowed(action, signedIn(USERS.sara))).toBe(false);
  });

  it('only the actions set to No are refused', async () => {
    join(USERS.sara);
    rule({ userId: USERS.sara.id }, { summon: 'no' });
    expect(await allowed('summon', signedIn(USERS.sara))).toBe(false);
    expect(await allowed('chat', signedIn(USERS.sara))).toBe(true);
    expect(await allowed('dm', signedIn(USERS.sara))).toBe(true);
  });

  it('a person set to Yes is let in although their role says No and the permission is off', async () => {
    state.everyone = ZERO;
    join(USERS.sara, [everywhere(INTERN)]);
    rule({ roleId: INTERN.id }, { chat: 'no' });
    rule({ userId: USERS.sara.id }, { chat: 'yes' });
    expect(await allowed('chat', signedIn(USERS.sara))).toBe(true);
  });

  it('a role set to No refuses its holders, and others keep the default', async () => {
    join(USERS.omar, [everywhere(INTERN)]);
    join(USERS.sara);
    rule({ roleId: INTERN.id }, { chat: 'no' });
    expect(await allowed('chat', signedIn(USERS.omar))).toBe(false);
    expect(await allowed('chat', signedIn(USERS.sara))).toBe(true);
  });

  it('a Yes from one of a person’s roles beats a No from another', async () => {
    join(USERS.sara, [everywhere(ACCOUNTANT), everywhere(INTERN)]);
    rule({ roleId: INTERN.id }, { summon: 'no' });
    rule({ roleId: ACCOUNTANT.id }, { summon: 'yes' });
    expect(await allowed('summon', signedIn(USERS.sara))).toBe(true);
  });

  it('Everyone set to No for Summon refuses guests, and chat still works for them', async () => {
    rule({ roleId: 'r-everyone' }, { summon: 'no' });
    expect(await allowed('summon', GUEST)).toBe(false);
    expect(await allowed('chat', GUEST)).toBe(true);
  });

  it('a rule for one person never touches another', async () => {
    join(USERS.sara);
    join(USERS.omar);
    rule({ userId: USERS.sara.id }, { chat: 'no' });
    expect(await allowed('chat', signedIn(USERS.sara))).toBe(false);
    expect(await allowed('chat', signedIn(USERS.omar))).toBe(true);
  });

  it('a guest cannot take someone’s row by sending their identifier', async () => {
    join(USERS.sara);
    rule({ userId: USERS.sara.id }, { chat: 'no' });
    expect(await allowed('chat', { signedIn: false, identifier: USERS.sara.email })).toBe(true); // the guest's own: Everyone's
  });

  it('the creator, the owner, a super admin and Admin ignore a No', async () => {
    process.env.SUPER_ADMINS = USERS.root.email!;
    join(USERS.sara, [everywhere(ADMIN)]);
    for (const user of [USERS.nora, USERS.boss, USERS.root, USERS.sara]) rule({ userId: user.id }, { chat: 'no', dm: 'no', summon: 'no' });
    rule({ roleId: ADMIN.id }, { chat: 'no' });
    for (const user of [USERS.nora, USERS.boss, USERS.root, USERS.sara]) {
      for (const action of BOT_ACTIONS) expect(await allowed(action, signedIn(user))).toBe(true);
    }
  });
});

describe('row 14: the room still counts for a private chat', () => {
  beforeEach(() => {
    state.bot!.isPublicRoom = false;
  });

  it('a Yes does not let someone who may not see the room DM the bot', async () => {
    rule({ userId: USERS.omar.id }, { dm: 'yes' });
    expect(await ask('dm', signedIn(USERS.omar))).toEqual({ allowed: false, code: 'no_room_access', reason: "You can't message Nora now." });
  });

  it('a world member with a Yes can', async () => {
    join(USERS.sara);
    rule({ userId: USERS.sara.id }, { dm: 'yes' });
    expect(await allowed('dm', signedIn(USERS.sara))).toBe(true);
  });

  it('a Yes does not let a guest DM: it needs an account', async () => {
    rule({ roleId: 'r-everyone' }, { dm: 'yes' });
    expect((await ask('dm', GUEST))!.code).toBe('sign_in_required');
  });
});

describe('the line refused people hear', () => {
  beforeEach(() => {
    state.bot!.privateBot = true;
    state.bot!.refusalReply = 'Sorry, I only help the finance team. Ask at the front desk.';
  });

  it('comes back with a refused chat, next to the plain reason', async () => {
    expect(await ask('chat', GUEST)).toEqual({
      allowed: false,
      code: 'not_allowed',
      reason: "Nora's owner limits who can chat with it.",
      reply: 'Sorry, I only help the finance team. Ask at the front desk.',
    });
  });

  it('is only for chatting nearby: summon and DM refusals keep their own lines', async () => {
    join(USERS.sara);
    expect(await ask('summon', signedIn(USERS.sara))).toEqual({ allowed: false, code: 'not_allowed', reason: "Nora's owner limits who can summon it." });
    expect(await ask('dm', signedIn(USERS.sara))).toEqual({ allowed: false, code: 'not_allowed', reason: "You can't message Nora now." });
  });

  it('never comes with a yes', async () => {
    join(USERS.sara);
    rule({ userId: USERS.sara.id }, { chat: 'yes' });
    expect(await ask('chat', signedIn(USERS.sara))).toEqual({ allowed: true, code: 'allowed', reason: null });
  });

  it('also comes with a refusal that is a No on a row, not only Private bot', async () => {
    state.bot!.privateBot = false;
    join(USERS.sara);
    rule({ userId: USERS.sara.id }, { chat: 'no' });
    expect((await ask('chat', signedIn(USERS.sara)))!.reply).toBe('Sorry, I only help the finance team. Ask at the front desk.');
  });
});

describe('row 15: the owner changes access', () => {
  it('the next question gets the new answer, with nothing remembered', async () => {
    join(USERS.sara);
    expect(await allowed('chat', signedIn(USERS.sara))).toBe(true);
    rule({ userId: USERS.sara.id }, { chat: 'no' });
    expect(await allowed('chat', signedIn(USERS.sara))).toBe(false);
    state.rules = [];
    expect(await allowed('chat', signedIn(USERS.sara))).toBe(true);
    state.bot!.privateBot = true;
    expect(await allowed('chat', signedIn(USERS.sara))).toBe(false);
  });
});
