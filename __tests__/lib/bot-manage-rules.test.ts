/**
 * "Manage this bot" rules (#427): a role's or a person's No / Default / Yes on top of what Manage bots gives in the
 * bot's room (test plan row 11). The database is a small in-memory stand-in so the real permission logic runs.
 */
type Role = { id: string; key: string; position: number; permissions: bigint };
type Given = { role: Role; allWorlds: boolean; worldIds: string[] };
type Rule = { botId?: string; roleId: string | null; userId: string | null; allow: bigint; deny: bigint };

const state = {
  ownerId: 'owner',
  rules: [] as Rule[],
  worldMembers: [] as { worldId: string; userId: string; tags: string[] }[],
  everyone: BigInt(0),
  member: BigInt(0),
  memberships: new Map<string, { allWorlds: boolean; worldIds: string[]; roles: Given[] }>(),
};

jest.mock('@/lib/db', () => ({
  prisma: {
    room: {
      findUnique: jest.fn(async () => ({ world: { id: 'hq', universeId: 'u1', universe: { ownerId: state.ownerId } } })),
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
    botAccessRule: {
      // A rule belongs to bot-1 unless it names another bot; asked for one bot or for several in one go
      findMany: jest.fn(async ({ where }: { where?: { botId?: string | { in: string[] } } } = {}) => {
        const wanted = where?.botId === undefined ? null : typeof where.botId === 'string' ? [where.botId] : where.botId.in;
        return state.rules.map((rule) => ({ ...rule, botId: rule.botId ?? 'bot-1' })).filter((rule) => !wanted || wanted.includes(rule.botId));
      }),
    },
  },
}));

import { canManageBotMcpServers, canManageBots, canManageThisBot, preloadBotRules, type ManageMemo } from '@/lib/bot-permissions';
import { prisma } from '@/lib/db';
import { ADMIN_KEY, EDITOR_DEFAULT_PERMISSIONS } from '@/lib/roles';
import { ALL_PERMISSIONS, flag } from '@/lib/permissions';
import { NO_RULE, withValues, type RuleAction, type RuleValue } from '@/lib/bot-rules';

const ZERO = BigInt(0);
const role = (key: string, permissions = ZERO, position = 20): Role => ({ id: `r-${key}`, key, position, permissions });
const everywhere = (r: Role): Given => ({ role: r, allWorlds: true, worldIds: [] });

const EDITOR = role('editor', EDITOR_DEFAULT_PERMISSIONS, 2);
const ADMIN = role(ADMIN_KEY, ALL_PERMISSIONS, 1_000_000);
const KEEPER = role('keeper', flag('MANAGE_BOTS'));
const INTERN = role('intern');

const bot = { id: 'bot-1', createdById: 'maker', roomId: 'room-hq', ownerId: null, deletedAt: null };

const rule = (subject: { roleId?: string; userId?: string }, values: Partial<Record<RuleAction, RuleValue>>) =>
  state.rules.push({ roleId: subject.roleId ?? null, userId: subject.userId ?? null, ...withValues(NO_RULE, values) });

function member(userId: string, roles: Given[]) {
  state.memberships.set(userId, { allWorlds: true, worldIds: [], roles });
  state.worldMembers.push({ worldId: 'hq', userId, tags: ['member'] });
}

const manage = (userId: string, email: string | null = null) => canManageThisBot(userId, email, bot, { creatorPasses: false });

beforeEach(() => {
  state.ownerId = 'owner';
  state.rules = [];
  state.worldMembers = [];
  state.everyone = ZERO;
  state.member = ZERO;
  state.memberships = new Map();
  delete process.env.SUPER_ADMINS;
});

describe('a bot with no rules', () => {
  it('answers exactly as canManageBots does, for the owner, an Editor, a keeper and someone with nothing', async () => {
    member('ed', [everywhere(EDITOR)]);
    member('keeper', [everywhere(KEEPER)]);
    member('plain', []);
    for (const userId of ['owner', 'ed', 'keeper', 'plain', 'stranger']) {
      expect(await manage(userId)).toBe(await canManageBots(userId, 'room-hq'));
    }
    expect(await manage('ed')).toBe(true);
    expect(await manage('plain')).toBe(false);
  });

  it('keeps the super admin’s extra way in, and gives the creator none, for the bot’s tools', async () => {
    expect(await canManageBotMcpServers('maker', null, bot)).toBe(false);
    expect(await manage('maker')).toBe(false);
    process.env.SUPER_ADMINS = 'root@example.com';
    expect(await canManageBotMcpServers('someone', 'root@example.com', bot)).toBe(true);
    expect(await manage('someone', null)).toBe(false);
  });
});

describe('row 22: the bot’s creator loses the room', () => {
  it('a creator with no role left cannot manage their bot, with or without rules on it; the owner and Admin still can', async () => {
    member('ad', [everywhere(ADMIN)]);
    for (const withRules of [false, true]) {
      state.rules = [];
      if (withRules) rule({ userId: 'someone-else' }, { chat: 'yes' });
      expect(await manage('maker')).toBe(false);
      expect(await canManageBotMcpServers('maker', null, bot)).toBe(false);
      expect(await manage('ad')).toBe(true);
      expect(await manage('owner')).toBe(true);
    }
  });

  it('a creator who still holds Manage bots keeps managing their bot', async () => {
    member('maker', [everywhere(EDITOR)]);
    expect(await manage('maker')).toBe(true);
    expect(await canManageBotMcpServers('maker', null, bot)).toBe(true);
  });
});

describe('row 11: Manage this bot', () => {
  it('a person set to Yes manages this bot without the permission', async () => {
    member('plain', []);
    rule({ userId: 'plain' }, { manage: 'yes' });
    expect(await manage('plain')).toBe(true);
  });

  it('a Yes stops counting when the person leaves the universe, and counts again if they come back (CodeRabbit finding on #458)', async () => {
    member('plain', []);
    rule({ userId: 'plain' }, { manage: 'yes' });
    expect(await manage('plain')).toBe(true);
    state.memberships.delete('plain');
    state.worldMembers = [];
    expect(await manage('plain')).toBe(false);
    member('plain', []);
    expect(await manage('plain')).toBe(true);
  });

  it('a Yes still counts for someone who is only a world member (a row written some other way)', async () => {
    state.worldMembers.push({ worldId: 'hq', userId: 'old', tags: ['member'] });
    rule({ userId: 'old' }, { manage: 'yes' });
    expect(await manage('old')).toBe(true);
  });

  it('a Yes for Everyone does not reach people who never joined, and a No still takes it away from anyone', async () => {
    rule({ roleId: 'r-everyone' }, { manage: 'yes' });
    expect(await manage('stranger')).toBe(false);
    state.rules = [];
    rule({ roleId: 'r-everyone' }, { manage: 'no' });
    member('ed', [everywhere(EDITOR)]);
    expect(await manage('stranger')).toBe(false);
    expect(await manage('ed')).toBe(false);
  });

  it('a person set to No cannot manage it although their role has Manage bots', async () => {
    member('ed', [everywhere(EDITOR)]);
    rule({ userId: 'ed' }, { manage: 'no' });
    expect(await manage('ed')).toBe(false);
  });

  it('a role set to No takes it from Editors on this bot only', async () => {
    member('ed', [everywhere(EDITOR)]);
    rule({ roleId: EDITOR.id }, { manage: 'no' });
    expect(await manage('ed')).toBe(false);
    state.rules = [];
    expect(await manage('ed')).toBe(true);
  });

  it('a role set to Yes gives it to its holders', async () => {
    member('intern', [everywhere(INTERN)]);
    rule({ roleId: INTERN.id }, { manage: 'yes' });
    expect(await manage('intern')).toBe(true);
  });

  it('a person’s own row beats their role’s', async () => {
    member('ed', [everywhere(EDITOR)]);
    rule({ roleId: EDITOR.id }, { manage: 'no' });
    rule({ userId: 'ed' }, { manage: 'yes' });
    expect(await manage('ed')).toBe(true);
  });

  it('a row about chatting says nothing about managing', async () => {
    member('ed', [everywhere(EDITOR)]);
    rule({ userId: 'ed' }, { chat: 'no', dm: 'no', summon: 'no' });
    expect(await manage('ed')).toBe(true);
  });

  it('the universe owner and Admin always manage it, whatever a rule says', async () => {
    member('boss', [everywhere(ADMIN)]);
    rule({ userId: 'owner' }, { manage: 'no' });
    rule({ userId: 'boss' }, { manage: 'no' });
    rule({ roleId: ADMIN.id }, { manage: 'no' });
    expect(await manage('owner')).toBe(true);
    expect(await manage('boss')).toBe(true);
  });

  it('the creator keeps it where the caller says the creator passes, and a super admin always does', async () => {
    rule({ userId: 'maker' }, { manage: 'no' });
    rule({ userId: 'root' }, { manage: 'no' });
    process.env.SUPER_ADMINS = 'root@example.com';
    expect(await canManageThisBot('maker', null, bot, { creatorPasses: true })).toBe(true);
    expect(await canManageBotMcpServers('root', 'root@example.com', bot)).toBe(true);
  });

  it('a rule for someone else changes nothing for you', async () => {
    member('ed', [everywhere(EDITOR)]);
    rule({ userId: 'someone-else' }, { manage: 'no' });
    expect(await manage('ed')).toBe(true);
  });
});

describe('many bots in one room for one person (the room list)', () => {
  const bots = [
    { id: 'bot-1', createdById: 'maker-a', roomId: 'room-hq', ownerId: null, deletedAt: null },
    { id: 'bot-2', createdById: 'maker-b', roomId: 'room-hq', ownerId: null, deletedAt: null },
    { id: 'bot-3', createdById: 'maker-c', roomId: 'room-hq', ownerId: null, deletedAt: null },
    { id: 'bot-4', createdById: 'maker-d', roomId: 'room-hq', ownerId: null, deletedAt: null },
  ];
  const mocks = prisma as unknown as { room: { findUnique: jest.Mock }; botAccessRule: { findMany: jest.Mock } };
  const verdicts = (userId: string, memo?: ManageMemo) => Promise.all(bots.map((b) => canManageThisBot(userId, null, b, { creatorPasses: false, memo })));

  beforeEach(() => {
    // bot-1 and bot-2 carry rules of their own, bot-3 and bot-4 follow the room
    member('plain', []);
    rule({ userId: 'plain' }, { manage: 'yes' });
    state.rules.push({ botId: 'bot-2', roleId: null, userId: 'plain', ...withValues(NO_RULE, { manage: 'no' }) });
    mocks.room.findUnique.mockClear();
    mocks.botAccessRule.findMany.mockClear();
  });

  it('gives the same answers with the memo as without, whoever made each bot', async () => {
    member('keeper', [everywhere(KEEPER)]);
    for (const userId of ['plain', 'keeper', 'owner', 'stranger']) {
      const memo: ManageMemo = new Map();
      await preloadBotRules(memo, bots.map((b) => b.id));
      expect(await verdicts(userId, memo)).toEqual(await verdicts(userId));
    }
    // plain: Yes on bot-1, No on bot-2, nothing from the room for bot-3 and bot-4
    const memo: ManageMemo = new Map();
    await preloadBotRules(memo, bots.map((b) => b.id));
    expect(await verdicts('plain', memo)).toEqual([true, false, false, false]);
  });

  it('works out the room once and reads the bots’ rules in one query', async () => {
    const memo: ManageMemo = new Map();
    await preloadBotRules(memo, bots.map((b) => b.id));
    await verdicts('plain', memo);
    expect(mocks.botAccessRule.findMany).toHaveBeenCalledTimes(1);
    // Once for who they are in the room, once for what the room gives when a bot has no rules of its own
    expect(mocks.room.findUnique).toHaveBeenCalledTimes(2);

    mocks.room.findUnique.mockClear();
    mocks.botAccessRule.findMany.mockClear();
    await verdicts('plain');
    expect(mocks.botAccessRule.findMany).toHaveBeenCalledTimes(4);
    expect(mocks.room.findUnique).toHaveBeenCalledTimes(4);
  });

  it('asks the room once, not once per bot, for bots whose rules say nothing about this person', async () => {
    // Every bot has a rule, but only about someone else: the room answer decides each of them
    state.rules = bots.map((b) => ({ botId: b.id, roleId: null, userId: 'someone-else', ...withValues(NO_RULE, { manage: 'no' }) }));
    member('keeper', [everywhere(KEEPER)]);
    const memo: ManageMemo = new Map();
    await preloadBotRules(memo, bots.map((b) => b.id));
    expect(await verdicts('keeper', memo)).toEqual([true, true, true, true]);
    // Once for who they are in the room, once for what the room gives them
    expect(mocks.room.findUnique).toHaveBeenCalledTimes(2);
  });

  it('keeps one person’s answers from another’s when a memo is shared by mistake', async () => {
    member('keeper', [everywhere(KEEPER)]);
    const memo: ManageMemo = new Map();
    await preloadBotRules(memo, bots.map((b) => b.id));
    expect(await verdicts('keeper', memo)).toEqual([true, true, true, true]);
    expect(await verdicts('stranger', memo)).toEqual([false, false, false, false]);
  });
});
