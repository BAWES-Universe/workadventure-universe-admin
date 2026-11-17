/**
 * Who may call a bot (game #2004, check 55): the "Call" row starts as No. Only the bot's creator, its universe's owner,
 * super admins, Admin and the people who manage the bot call it until a rule or a role says Yes. A call also needs
 * everything a direct message needs (an account, the bot's room, no ban, Private bot). The database is a small in-memory
 * stand-in so the real permission logic (worldAccessFor, canSeeRoom, the order of the rules) runs for every case.
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
    ban: { findFirst: jest.fn(async () => null) },
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
        if (key === 'editor') return { id: 'r-editor', permissions: ZERO };
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

const managers = new Set<string>();
jest.mock('@/lib/bot-permissions', () => ({
  canManageThisBot: jest.fn(async (userId: string) => managers.has(userId)),
}));

import { checkBotAccess, type BotAction } from '@/lib/bot-access';
import { ADMIN_KEY, EVERYONE_DEFAULT_PERMISSIONS } from '@/lib/roles';
import { ALL_PERMISSIONS, flag } from '@/lib/permissions';
import { NO_RULE, withValues, type RuleAction, type RuleValue } from '@/lib/bot-rules';

const ZERO = BigInt(0);
const role = (key: string, permissions = ZERO, position = 20): Role => ({ id: `r-${key}`, key, position, permissions });
const everywhere = (r: Role): Given => ({ role: r, allWorlds: true, worldIds: [] });

const ADMIN = role(ADMIN_KEY, ALL_PERMISSIONS, 1_000_000);
const ACCOUNTANT = role('accountant');

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
  managers.clear();
  delete process.env.SUPER_ADMINS;
});

describe('the Call row starts as No', () => {
  it('refuses a signed-in member, with a line of its own, while chat, DM and summon stay as they were', async () => {
    join(USERS.sara);
    expect(await ask('call', signedIn(USERS.sara))).toEqual({ allowed: false, code: 'not_allowed', reason: "You can't call Nora now." });
    for (const action of ['chat', 'dm', 'summon'] as const) expect(await allowed(action, signedIn(USERS.sara))).toBe(true);
  });

  it('a guest is asked to sign in, even where a rule says Yes for Everyone', async () => {
    state.rules.push({ roleId: 'r-everyone', userId: null, ...withValues(NO_RULE, { call: 'yes' }) });
    expect(await ask('call', GUEST)).toEqual({ allowed: false, code: 'sign_in_required', reason: 'Sign in to call Nora.' });
  });
});

describe('who always passes', () => {
  it('the bot’s creator, the universe owner and a super admin', async () => {
    process.env.SUPER_ADMINS = USERS.root.email;
    expect(await allowed('call', signedIn(USERS.nora))).toBe(true);
    expect(await allowed('call', signedIn(USERS.boss))).toBe(true);
    expect(await allowed('call', signedIn(USERS.root))).toBe(true);
  });

  it('Admin, and a person who manages this bot', async () => {
    join(USERS.omar, [everywhere(ADMIN)]);
    join(USERS.mishari);
    managers.add(USERS.mishari.id);
    expect(await allowed('call', signedIn(USERS.omar))).toBe(true);
    expect(await allowed('call', signedIn(USERS.mishari))).toBe(true);
  });

  it('a manager is not asked about when a rule already decided, and a No still stops them', async () => {
    join(USERS.mishari);
    managers.add(USERS.mishari.id);
    rule({ userId: USERS.mishari.id }, { call: 'no' });
    expect((await ask('call', signedIn(USERS.mishari)))!.code).toBe('not_allowed');
  });
});

describe('a Yes', () => {
  it('from a rule for a person lets that person call, and nobody else', async () => {
    join(USERS.sara);
    join(USERS.omar);
    rule({ userId: USERS.sara.id }, { call: 'yes' });
    expect(await allowed('call', signedIn(USERS.sara))).toBe(true);
    expect(await allowed('call', signedIn(USERS.omar))).toBe(false);
  });

  it('from a role’s rule lets its holders call, and no role permission does it by itself', async () => {
    join(USERS.sara, [everywhere(ACCOUNTANT)]);
    join(USERS.omar, [everywhere(role('everything', ALL_PERMISSIONS & ~flag('ADMINISTRATOR')))]);
    join(USERS.mishari);
    rule({ roleId: ACCOUNTANT.id }, { call: 'yes' });
    expect(await allowed('call', signedIn(USERS.sara))).toBe(true);
    expect(await allowed('call', signedIn(USERS.omar))).toBe(false);
    expect(await allowed('call', signedIn(USERS.mishari))).toBe(false);
  });

  it('a person’s own No beats their role’s Yes', async () => {
    join(USERS.sara, [everywhere(ACCOUNTANT)]);
    rule({ roleId: ACCOUNTANT.id }, { call: 'yes' });
    rule({ userId: USERS.sara.id }, { call: 'no' });
    expect(await allowed('call', signedIn(USERS.sara))).toBe(false);
  });
});

describe('a call needs everything a direct message needs', () => {
  it('a No on Direct messages stops the call even with a Yes on Call', async () => {
    join(USERS.sara);
    rule({ userId: USERS.sara.id }, { call: 'yes', dm: 'no' });
    expect(await allowed('dm', signedIn(USERS.sara))).toBe(false);
    expect(await ask('call', signedIn(USERS.sara))).toEqual({ allowed: false, code: 'not_allowed', reason: "You can't call Nora now." });
  });

  it('a manager whose own Direct messages row says No cannot call either', async () => {
    join(USERS.mishari);
    managers.add(USERS.mishari.id);
    rule({ userId: USERS.mishari.id }, { dm: 'no' });
    expect(await allowed('call', signedIn(USERS.mishari))).toBe(false);
  });

  it('Private bot shuts out everyone a row does not say Yes to, calls included', async () => {
    join(USERS.sara);
    state.bot!.privateBot = true;
    rule({ userId: USERS.sara.id }, { call: 'yes' });
    expect(await allowed('call', signedIn(USERS.sara))).toBe(false);
    state.rules = [];
    rule({ userId: USERS.sara.id }, { dm: 'yes', call: 'yes' });
    expect(await allowed('call', signedIn(USERS.sara))).toBe(true);
  });

  it('a person who cannot see the bot’s room cannot call it', async () => {
    state.bot!.isPublicRoom = false;
    expect(await ask('call', signedIn(USERS.omar))).toMatchObject({ allowed: false });
  });

  it('a person who was never asked about, and has no account, only has what Everyone has: no call', async () => {
    expect(await allowed('call', { signedIn: true, identifier: 'stranger@example.com' })).toBe(false);
  });
});
