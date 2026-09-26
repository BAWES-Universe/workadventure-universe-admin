/**
 * Who may see what across the users, analytics and bot cleanup routes.
 *
 * Prisma is mocked; the user and room-access mocks honour `select` so the
 * assertions check what the database would actually return.
 */
import { NextRequest } from 'next/server';

jest.mock('@/lib/db', () => ({
  prisma: {
    user: { findMany: jest.fn(), findUnique: jest.fn() },
    universe: { findUnique: jest.fn() },
    world: { findUnique: jest.fn() },
    room: { findUnique: jest.fn(), findMany: jest.fn() },
    worldMember: { findFirst: jest.fn() },
    favorite: { groupBy: jest.fn() },
    roomAccess: {
      count: jest.fn(),
      findMany: jest.fn(),
      findFirst: jest.fn(),
      groupBy: jest.fn(),
    },
    bot: { findUnique: jest.fn() },
    botsConversation: {
      count: jest.fn(),
      findMany: jest.fn(),
      findFirst: jest.fn(),
      deleteMany: jest.fn(),
    },
  },
}));

jest.mock('@/lib/auth-session', () => ({
  getSessionUser: jest.fn(),
}));

jest.mock('@/lib/bot-permissions', () => ({
  canManageBots: jest.fn(),
}));

import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { canManageBots } from '@/lib/bot-permissions';
import { GET as listUsers } from '@/app/api/admin/users/route';
import { GET as getUser } from '@/app/api/admin/users/[id]/route';
import { GET as globalAnalytics } from '@/app/api/admin/analytics/route';
import { GET as userAnalytics } from '@/app/api/admin/analytics/users/[id]/route';
import { GET as worldAnalytics } from '@/app/api/admin/analytics/worlds/[id]/route';
import { GET as roomAnalytics } from '@/app/api/admin/analytics/rooms/[id]/route';
import { GET as universeAnalytics } from '@/app/api/admin/analytics/universes/[id]/route';
import { DELETE as cleanupAllConversations } from '@/app/api/bots/conversations/cleanup/route';
import { GET as databaseStats } from '@/app/api/bots/database/stats/route';
import { DELETE as cleanupBotConversations } from '@/app/api/bots/[id]/conversations/cleanup/route';

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;

type Session = {
  id: string;
  uuid: string;
  email: string | null;
  name: string | null;
  tags: string[];
  isSuperAdmin: boolean;
};

const SESSIONS: Record<string, Session> = {
  alice: { id: 'u-alice', uuid: 'uuid-alice', email: 'alice@example.test', name: 'Alice', tags: [], isSuperAdmin: false },
  bob: { id: 'u-bob', uuid: 'uuid-bob', email: 'bob@example.test', name: 'Bob', tags: [], isSuperAdmin: false },
  root: { id: 'u-root', uuid: 'uuid-root', email: 'root@example.test', name: 'Root', tags: [], isSuperAdmin: true },
};

function req(url: string, as?: keyof typeof SESSIONS | 'admin-token', method = 'GET') {
  const headers: Record<string, string> = {};
  if (as === 'admin-token') headers.Authorization = `Bearer ${process.env.ADMIN_API_TOKEN}`;
  else if (as) headers.Authorization = `Bearer session-${as}`;
  return new NextRequest(`http://localhost:3333${url}`, { method, headers });
}

type MockArgs = {
  where: { id: string };
  select?: Record<string, unknown>;
  include?: unknown;
  distinct?: unknown;
};

const params = (id: string) => ({ params: Promise.resolve({ id }) });

/** Apply a Prisma root `select` (booleans only) the way the client would. */
function applySelect<T extends Record<string, unknown>>(row: T, select?: Record<string, unknown>) {
  if (!select) return row;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(select)) {
    if (value && key in row) out[key] = row[key];
  }
  return out;
}

const USER_ROWS = [
  {
    id: 'u-bob', uuid: 'uuid-bob', email: 'bob@example.test', name: 'Bob',
    matrixChatId: '@bob:matrix.test', lastIpAddress: '203.0.113.7', isGuest: false,
    createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-02'),
    _count: { ownedUniverses: 0, worldMemberships: 0 },
  },
];

const ACCESS_ROW = {
  id: 'acc-1',
  accessedAt: new Date('2026-09-01T10:00:00Z'),
  userId: 'u-bob',
  userUuid: 'uuid-bob',
  userName: 'Bob',
  userEmail: 'bob@example.test',
  ipAddress: '203.0.113.7',
  isGuest: false,
  isAuthenticated: true,
  hasMembership: true,
  membershipTags: ['member'],
  playUri: 'https://play.example.test/@/u/w/r',
  room: { id: 'room-b', slug: 'r', name: 'Room B' },
  world: { id: 'world-b', slug: 'w', name: 'World B' },
};

beforeEach(() => {
  jest.clearAllMocks();
  (getSessionUser as jest.Mock).mockImplementation(async (request: NextRequest) => {
    const auth = request.headers.get('authorization') || '';
    const name = auth.replace('Bearer session-', '');
    return auth.startsWith('Bearer session-') ? SESSIONS[name] ?? null : null;
  });

  db.user.findMany.mockImplementation(async (args: MockArgs) => USER_ROWS.map((u) => applySelect(u, args?.select)));
  db.user.findUnique.mockImplementation(async (args: MockArgs) => {
    const row = {
      ...USER_ROWS[0],
      visitCard: null,
      ownedUniverses: [],
      worldMemberships: [],
      _count: { ownedUniverses: 0, worldMemberships: 0, bans: 0, favorites: 0, avatars: 0 },
    };
    if (args.where.id !== row.id) return null;
    return applySelect(row, args.select);
  });
  db.favorite.groupBy.mockResolvedValue([]);

  db.roomAccess.count.mockResolvedValue(1);
  db.roomAccess.groupBy.mockResolvedValue([]);
  db.roomAccess.findMany.mockImplementation(async (args: MockArgs) => {
    if (args?.distinct) return [];
    if (args?.select && !args.include) return [applySelect(ACCESS_ROW, args.select)];
    return [ACCESS_ROW];
  });
  db.roomAccess.findFirst.mockImplementation(async (args: MockArgs) =>
    args?.select ? applySelect(ACCESS_ROW, args.select) : ACCESS_ROW,
  );
  db.room.findMany.mockResolvedValue([]);
  db.room.findUnique.mockResolvedValue(null);

  // World B belongs to a universe owned by someone else; nobody is a member.
  db.world.findUnique.mockResolvedValue({ universe: { ownerId: 'u-owner' } });
  db.universe.findUnique.mockResolvedValue({ ownerId: 'u-owner' });
  db.worldMember.findFirst.mockResolvedValue(null);
  (canManageBots as jest.Mock).mockResolvedValue(false);
});

describe('users list', () => {
  it('a signed-in non-admin cannot read another user\'s email in the users list', async () => {
    const res = await listUsers(req('/api/admin/users', 'alice'));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.users).toHaveLength(1);
    expect(body.users[0]).not.toHaveProperty('email');
    expect(body.users[0].name).toBe('Bob');
    expect(body.pagination.total).toBe(1);
  });

  it('a signed-in non-admin cannot search the users list by email', async () => {
    await listUsers(req('/api/admin/users?search=bob%40example', 'alice'));
    const where = JSON.stringify(db.user.findMany.mock.calls[0][0].where);
    expect(where).not.toMatch(/"email":\{"contains"/);
    expect(where).toMatch(/"name":\{"contains"/);
    expect(where).toMatch(/"uuid":\{"contains"/);
  });

  it('a super admin sees and can search by email in the users list', async () => {
    const res = await listUsers(req('/api/admin/users?search=bob', 'root'));
    const body = await res.json();
    expect(body.users[0].email).toBe('bob@example.test');
    const where = JSON.stringify(db.user.findMany.mock.calls[0][0].where);
    expect(where).toMatch(/"email":\{"contains"/);
  });

  it('an anonymous caller gets 401 from the users list', async () => {
    const res = await listUsers(req('/api/admin/users'));
    expect(res.status).toBe(401);
  });
});

describe('user by id', () => {
  it('a signed-in non-admin cannot read another user\'s email, Matrix id or IP address', async () => {
    const res = await getUser(req('/api/admin/users/u-bob', 'alice'), params('u-bob'));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.name).toBe('Bob');
    expect(body).not.toHaveProperty('email');
    expect(body).not.toHaveProperty('matrixChatId');
    expect(body).not.toHaveProperty('lastIpAddress');
    expect(body).toHaveProperty('ownedUniverses');
    expect(body).toHaveProperty('worldMemberships');
    expect(body).toHaveProperty('_count');
  });

  it('a user sees their own email and Matrix id but not their own IP address', async () => {
    const res = await getUser(req('/api/admin/users/u-bob', 'bob'), params('u-bob'));
    const body = await res.json();
    expect(body.email).toBe('bob@example.test');
    expect(body.matrixChatId).toBe('@bob:matrix.test');
    expect(body).not.toHaveProperty('lastIpAddress');
  });

  it('a super admin sees another user\'s email, Matrix id and IP address', async () => {
    const res = await getUser(req('/api/admin/users/u-bob', 'root'), params('u-bob'));
    const body = await res.json();
    expect(body.email).toBe('bob@example.test');
    expect(body.matrixChatId).toBe('@bob:matrix.test');
    expect(body.lastIpAddress).toBe('203.0.113.7');
  });
});

describe('scope analytics', () => {
  it('a member of world A cannot see visitor names, emails or IPs in world B\'s analytics', async () => {
    const res = await worldAnalytics(req('/api/admin/analytics/worlds/world-b', 'alice'), params('world-b'));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.totalAccesses).toBe(1);
    expect(Object.keys(body.recentActivity[0]).sort()).toEqual(['accessedAt', 'id', 'room']);
    expect(Object.keys(body.lastVisitedOverall)).toEqual(['accessedAt']);
  });

  it('a world manager sees visitor names but not emails or IPs', async () => {
    db.worldMember.findFirst.mockResolvedValue({ id: 'm1', tags: ['editor'] });
    const res = await worldAnalytics(req('/api/admin/analytics/worlds/world-b', 'alice'), params('world-b'));
    const body = await res.json();
    const entry = body.recentActivity[0];
    expect(entry.userName).toBe('Bob');
    expect(entry.userUuid).toBe('uuid-bob');
    expect(entry.membershipTags).toEqual(['member']);
    expect(entry.playUri).toBeDefined();
    expect(entry).not.toHaveProperty('userEmail');
    expect(entry).not.toHaveProperty('ipAddress');
    expect(body.lastVisitedOverall.userName).toBe('Bob');
    expect(body.lastVisitedOverall).not.toHaveProperty('userEmail');
  });

  it('a universe owner sees visitor names but not emails or IPs in their universe', async () => {
    db.universe.findUnique.mockResolvedValue({ ownerId: 'u-alice' });
    const res = await universeAnalytics(req('/api/admin/analytics/universes/uni-b', 'alice'), params('uni-b'));
    const entry = (await res.json()).recentActivity[0];
    expect(entry.userName).toBe('Bob');
    expect(entry.world).toBeDefined();
    expect(entry).not.toHaveProperty('userEmail');
    expect(entry).not.toHaveProperty('ipAddress');
  });

  it('a non-manager of a room gets visit times only, enough for peak hours', async () => {
    const res = await roomAnalytics(req('/api/admin/analytics/rooms/room-b', 'alice'), params('room-b'));
    const body = await res.json();
    expect(Object.keys(body.recentActivity[0]).sort()).toEqual(['accessedAt', 'id']);
    expect(new Date(body.recentActivity[0].accessedAt).getTime()).toBe(ACCESS_ROW.accessedAt.getTime());
  });

  it('a non-manager still sees who made their own visits, without IPs', async () => {
    const res = await worldAnalytics(req('/api/admin/analytics/worlds/world-b', 'bob'), params('world-b'));
    const body = await res.json();
    expect(body.recentActivity[0].userId).toBe('u-bob');
    expect(body.recentActivity[0]).not.toHaveProperty('ipAddress');
    expect(body.lastVisitedOverall.userId).toBe('u-bob');
  });

  it('a super admin sees visitor emails and IPs in any world\'s analytics', async () => {
    const res = await worldAnalytics(req('/api/admin/analytics/worlds/world-b', 'root'), params('world-b'));
    const entry = (await res.json()).recentActivity[0];
    expect(entry.userEmail).toBe('bob@example.test');
    expect(entry.ipAddress).toBe('203.0.113.7');
  });
});

describe('user analytics', () => {
  it('a signed-in non-admin cannot read another user\'s access history', async () => {
    const res = await userAnalytics(req('/api/admin/analytics/users/u-bob', 'alice'), params('u-bob'));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden' });
  });

  it('a user reads their own access history without IP addresses', async () => {
    const res = await userAnalytics(req('/api/admin/analytics/users/u-bob', 'bob'), params('u-bob'));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.accesses[0]).not.toHaveProperty('ipAddress');
  });

  it('a signed-in non-admin cannot filter global analytics by another user', async () => {
    const res = await globalAnalytics(req('/api/admin/analytics?userId=u-bob', 'alice'));
    expect(res.status).toBe(403);
  });

  it('a signed-in user still gets aggregate global analytics for a world', async () => {
    const res = await globalAnalytics(req('/api/admin/analytics?worldId=world-b', 'alice'));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.totalAccesses).toBe(1);
  });
});

describe('bot data cleanup', () => {
  it('a non-super-admin cannot call deleteAll on bot conversations', async () => {
    const res = await cleanupAllConversations(
      req('/api/bots/conversations/cleanup?deleteAll=true', 'alice', 'DELETE'),
    );
    expect(res.status).toBe(403);
    expect(db.botsConversation.deleteMany).not.toHaveBeenCalled();
  });

  it('a super admin can call deleteAll on bot conversations', async () => {
    db.botsConversation.count.mockResolvedValue(2);
    db.botsConversation.findMany.mockResolvedValue([{ botId: 'b1' }]);
    const res = await cleanupAllConversations(
      req('/api/bots/conversations/cleanup?deleteAll=true', 'root', 'DELETE'),
    );
    expect(res.status).toBe(200);
    expect(db.botsConversation.deleteMany).toHaveBeenCalledWith({});
  });

  it('an anonymous caller gets 401 from bot conversation cleanup', async () => {
    const res = await cleanupAllConversations(
      req('/api/bots/conversations/cleanup?deleteAll=true', undefined, 'DELETE'),
    );
    expect(res.status).toBe(401);
  });

  it('a non-super-admin cannot read bot database stats', async () => {
    const res = await databaseStats(req('/api/bots/database/stats', 'alice'));
    expect(res.status).toBe(403);
  });

  it('a bot manager can clean up their own bot\'s conversations but not another room\'s', async () => {
    db.bot.findUnique.mockImplementation(async (args: MockArgs) =>
      ({ 'bot-mine': { roomId: 'room-mine' }, 'bot-other': { roomId: 'room-other' } } as Record<string, { roomId: string }>)[args.where.id] ?? null,
    );
    (canManageBots as jest.Mock).mockImplementation(async (userId: string, roomId: string) =>
      userId === 'u-alice' && roomId === 'room-mine',
    );
    db.botsConversation.findMany.mockResolvedValue([{ id: 'c1', messageCount: 3 }]);

    const own = await cleanupBotConversations(
      req('/api/bots/bot-mine/conversations/cleanup?olderThanDays=30', 'alice', 'DELETE'),
      params('bot-mine'),
    );
    expect(own.status).toBe(200);
    expect(db.botsConversation.deleteMany).toHaveBeenCalledTimes(1);

    const other = await cleanupBotConversations(
      req('/api/bots/bot-other/conversations/cleanup?olderThanDays=30', 'alice', 'DELETE'),
      params('bot-other'),
    );
    expect(other.status).toBe(403);
    expect(db.botsConversation.deleteMany).toHaveBeenCalledTimes(1);
  });
});
