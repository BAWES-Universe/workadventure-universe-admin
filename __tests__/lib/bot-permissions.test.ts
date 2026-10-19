/**
 * Who can manage bots (#423): the Manage bots permission decides, read the way the game reads it
 * (permissionsForWorld). The database is a small in-memory stand-in so the real permission logic runs.
 */
type Role = { key: string; position: number; permissions: bigint };
type Given = { role: Role; allWorlds: boolean; worldIds: string[] };

const state = {
  ownerId: 'owner',
  rooms: new Map<string, { worldId: string }>(),
  worldMembers: [] as { worldId: string; userId: string; tags: string[] }[],
  everyone: BigInt(0),
  member: BigInt(0),
  memberships: new Map<string, { allWorlds: boolean; worldIds: string[]; roles: Given[] }>(),
};

jest.mock('@/lib/db', () => ({
  prisma: {
    room: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
        const room = state.rooms.get(where.id);
        return room
          ? { world: { id: room.worldId, universeId: 'u1', universe: { ownerId: state.ownerId } } }
          : null;
      }),
    },
    worldMember: {
      findFirst: jest.fn(async ({ where }: { where: { worldId: string; userId: string } }) =>
        state.worldMembers.find((row) => row.worldId === where.worldId && row.userId === where.userId) ?? null,
      ),
    },
    role: {
      findUnique: jest.fn(async ({ where }: { where: { universeId_key: { key: string } } }) => {
        const key = where.universeId_key.key;
        if (key === 'everyone') return { permissions: state.everyone };
        if (key === 'member') return { permissions: state.member };
        return null;
      }),
    },
    universeMember: {
      findUnique: jest.fn(async ({ where }: { where: { universeId_userId: { userId: string } } }) =>
        state.memberships.get(where.universeId_userId.userId) ?? null,
      ),
    },
    botAccessRule: {
      findMany: jest.fn(async () => []),
    },
  },
}));

import { canManageBotMcpServers, canManageBots } from '@/lib/bot-permissions';
import { ADMIN_KEY, EDITOR_DEFAULT_PERMISSIONS } from '@/lib/roles';
import { ALL_PERMISSIONS, flag } from '@/lib/permissions';

const ZERO = BigInt(0);
const role = (key: string, permissions: bigint, position = 20): Role => ({ key, position, permissions });
const everywhere = (r: Role): Given => ({ role: r, allWorlds: true, worldIds: [] });
const inWorlds = (r: Role, worldIds: string[]): Given => ({ role: r, allWorlds: false, worldIds });

const EDITOR = role('editor', EDITOR_DEFAULT_PERMISSIONS, 2);
const EDITOR_NO_BOTS = role('editor', EDITOR_DEFAULT_PERMISSIONS & ~flag('MANAGE_BOTS'), 2);
const ADMIN = role(ADMIN_KEY, ALL_PERMISSIONS, 1_000_000);

function member(userId: string, roles: Given[], scope = { allWorlds: true, worldIds: [] as string[] }) {
  state.memberships.set(userId, { ...scope, roles });
}

beforeEach(() => {
  state.ownerId = 'owner';
  state.rooms = new Map([
    ['room-hq', { worldId: 'hq' }],
    ['room-lab', { worldId: 'lab' }],
  ]);
  state.worldMembers = [];
  state.everyone = ZERO;
  state.member = ZERO;
  state.memberships = new Map();
});

describe('canManageBots', () => {
  it('lets the universe owner manage bots, with no role at all', async () => {
    expect(await canManageBots('owner', 'room-hq')).toBe(true);
  });

  it('refuses a room that does not exist', async () => {
    expect(await canManageBots('owner', 'room-missing')).toBe(false);
  });

  it('lets a custom role with only Manage bots manage bots in its world', async () => {
    member('keeper', [everywhere(role('bot-keeper', flag('MANAGE_BOTS')))]);
    expect(await canManageBots('keeper', 'room-hq')).toBe(true);
    expect(await canManageBots('keeper', 'room-lab')).toBe(true);
  });

  it('keeps a custom role limited to some worlds to those worlds', async () => {
    member('keeper', [inWorlds(role('bot-keeper', flag('MANAGE_BOTS')), ['hq'])], { allWorlds: false, worldIds: [] });
    expect(await canManageBots('keeper', 'room-hq')).toBe(true);
    expect(await canManageBots('keeper', 'room-lab')).toBe(false);
  });

  it('refuses a custom role without Manage bots, even with every other permission', async () => {
    member('writer', [everywhere(role('writer', ALL_PERMISSIONS & ~flag('MANAGE_BOTS')))]);
    expect(await canManageBots('writer', 'room-hq')).toBe(false);
  });

  it('still lets today\'s Editor and Admin manage bots', async () => {
    member('ed', [everywhere(EDITOR)]);
    member('ad', [everywhere(ADMIN)]);
    expect(await canManageBots('ed', 'room-hq')).toBe(true);
    expect(await canManageBots('ad', 'room-hq')).toBe(true);
  });

  it('refuses an Editor whose Manage bots is turned off', async () => {
    member('ed', [everywhere(EDITOR_NO_BOTS)]);
    expect(await canManageBots('ed', 'room-hq')).toBe(false);
  });

  it('lets Administrator manage bots whatever else it lacks', async () => {
    member('boss', [everywhere(role('boss', flag('ADMINISTRATOR')))]);
    expect(await canManageBots('boss', 'room-hq')).toBe(true);
  });

  it('refuses a plain member, and a member who holds no role', async () => {
    member('plain', []);
    expect(await canManageBots('plain', 'room-hq')).toBe(false);
    expect(await canManageBots('stranger', 'room-hq')).toBe(false);
  });

  it('adds up Everyone, Member and the roles: any of them with Manage bots is enough', async () => {
    member('plain', []);
    state.member = flag('MANAGE_BOTS');
    expect(await canManageBots('plain', 'room-hq')).toBe(true);
    state.member = ZERO;
    state.everyone = flag('MANAGE_BOTS');
    expect(await canManageBots('plain', 'room-hq')).toBe(true);
  });

  it('adds up several roles', async () => {
    member('both', [everywhere(role('a', flag('EDIT_MAPS'))), everywhere(role('b', flag('MANAGE_BOTS')))]);
    expect(await canManageBots('both', 'room-hq')).toBe(true);
  });

  it('refuses someone whose membership and roles do not reach the room\'s world', async () => {
    member('away', [inWorlds(EDITOR, ['lab'])], { allWorlds: false, worldIds: [] });
    expect(await canManageBots('away', 'room-hq')).toBe(false);
    expect(await canManageBots('away', 'room-lab')).toBe(true);
  });

  describe('someone with no universe membership (tags only)', () => {
    it('keeps what the admin and editor tags gave them', async () => {
      state.worldMembers = [
        { worldId: 'hq', userId: 'old-admin', tags: ['admin'] },
        { worldId: 'hq', userId: 'old-editor', tags: ['member', 'editor'] },
      ];
      expect(await canManageBots('old-admin', 'room-hq')).toBe(true);
      expect(await canManageBots('old-editor', 'room-hq')).toBe(true);
    });

    it('refuses a member tag, another tag, no row, and a row in another world', async () => {
      state.worldMembers = [
        { worldId: 'hq', userId: 'old-member', tags: ['member'] },
        { worldId: 'hq', userId: 'finance', tags: ['finance'] },
        { worldId: 'lab', userId: 'lab-admin', tags: ['admin'] },
      ];
      expect(await canManageBots('old-member', 'room-hq')).toBe(false);
      expect(await canManageBots('finance', 'room-hq')).toBe(false);
      expect(await canManageBots('nobody', 'room-hq')).toBe(false);
      expect(await canManageBots('lab-admin', 'room-hq')).toBe(false);
    });

    it('also gets Manage bots from Everyone', async () => {
      state.everyone = flag('MANAGE_BOTS');
      expect(await canManageBots('nobody', 'room-hq')).toBe(true);
    });
  });

  it('reads the roles, not the tags, once someone has a membership', async () => {
    state.worldMembers = [{ worldId: 'hq', userId: 'ed', tags: ['editor', 'member'] }];
    member('ed', [everywhere(EDITOR_NO_BOTS)]);
    expect(await canManageBots('ed', 'room-hq')).toBe(false);
  });
});

describe('canManageBotMcpServers', () => {
  const bot = { id: 'bot-1', createdById: 'maker', roomId: 'room-hq' };

  it('lets the bot\'s creator in, with no role', async () => {
    expect(await canManageBotMcpServers('maker', null, bot)).toBe(true);
  });

  it('lets a super admin in', async () => {
    process.env.SUPER_ADMINS = 'boss@example.com';
    try {
      expect(await canManageBotMcpServers('someone', 'boss@example.com', bot)).toBe(true);
    } finally {
      delete process.env.SUPER_ADMINS;
    }
  });

  it('otherwise follows Manage bots', async () => {
    member('keeper', [everywhere(role('bot-keeper', flag('MANAGE_BOTS')))]);
    member('ed', [everywhere(EDITOR_NO_BOTS)]);
    expect(await canManageBotMcpServers('keeper', null, bot)).toBe(true);
    expect(await canManageBotMcpServers('ed', null, bot)).toBe(false);
  });
});
