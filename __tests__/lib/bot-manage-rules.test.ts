/**
 * "Manage this bot" rules (#427): a role's or a person's No / Default / Yes on top of what Manage bots gives in the
 * bot's room (test plan row 11). The database is a small in-memory stand-in so the real permission logic runs.
 */
type Role = { id: string; key: string; position: number; permissions: bigint };
type Given = { role: Role; allWorlds: boolean; worldIds: string[] };
type Rule = { roleId: string | null; userId: string | null; allow: bigint; deny: bigint };

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
      findMany: jest.fn(async () => state.rules),
    },
  },
}));

import { canManageBotMcpServers, canManageBots, canManageThisBot } from '@/lib/bot-permissions';
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

const bot = { id: 'bot-1', createdById: 'maker', roomId: 'room-hq' };

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

  it('keeps the creator’s and the super admin’s extra ways in, only where the caller allows them', async () => {
    expect(await canManageBotMcpServers('maker', null, bot)).toBe(true);
    expect(await manage('maker')).toBe(false);
    process.env.SUPER_ADMINS = 'root@example.com';
    expect(await canManageBotMcpServers('someone', 'root@example.com', bot)).toBe(true);
    expect(await manage('someone', null)).toBe(false);
  });
});

describe('row 11: Manage this bot', () => {
  it('a person set to Yes manages this bot without the permission', async () => {
    member('plain', []);
    rule({ userId: 'plain' }, { manage: 'yes' });
    expect(await manage('plain')).toBe(true);
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
