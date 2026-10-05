/**
 * System's universes, worlds and rooms leave every list once START_ROOM_URL points outside them, filtered in the
 * database so pages and totals agree. While the start room is still System's, the lists behave as before.
 */
import { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';

jest.mock('@/lib/db', () => ({
  prisma: {
    $queryRaw: jest.fn(),
    universe: { findMany: jest.fn(), count: jest.fn(), findUnique: jest.fn(), findFirst: jest.fn() },
    world: { findMany: jest.fn(), count: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn() },
    room: { findMany: jest.fn(), count: jest.fn(), findFirst: jest.fn() },
    user: { findUnique: jest.fn(), count: jest.fn() },
    favorite: { groupBy: jest.fn(), count: jest.fn() },
    worldMember: { findMany: jest.fn(), findUnique: jest.fn(), count: jest.fn() },
    membershipInvitation: { count: jest.fn() },
    roomAccess: { findMany: jest.fn() },
  },
}));
jest.mock('@/lib/auth', () => ({ requireAuth: jest.fn() }));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn() }));
jest.mock('@/lib/woka-avatar', () => ({ withWokas: jest.fn(async (rows: unknown) => rows) }));
jest.mock('@/lib/auth-token', () => ({ getSessionId: jest.fn(() => 'sid'), getSessionData: jest.fn() }));
jest.mock('@/lib/system-user', () => ({ ...jest.requireActual('@/lib/system-user'), hiddenSystemOwnerId: jest.fn() }));

import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { getSessionData } from '@/lib/auth-token';
import { hiddenSystemOwnerId, NOT_SYSTEM_USER } from '@/lib/system-user';
import { GET as listUniverses } from '@/app/api/admin/universes/route';
import { GET as listWorlds } from '@/app/api/admin/worlds/route';
import { GET as listRooms } from '@/app/api/admin/rooms/route';
import { GET as recentRooms } from '@/app/api/admin/rooms/recent/route';
import { GET as fromPlayUri } from '@/app/api/admin/rooms/from-play-uri/route';
import { GET as bootstrap } from '@/app/api/admin/bootstrap/route';
import { GET as members } from '@/app/api/members/route';
import { GET as myMemberships } from '@/app/api/memberships/my/route';
import { GET as worldMembers } from '@/app/api/admin/worlds/[id]/members/route';
import { GET as managedWorlds } from '@/app/api/admin/worlds/managed/route';

type Mocked = Record<string, jest.Mock>;
const db = prisma as unknown as {
  $queryRaw: jest.Mock;
  universe: Mocked;
  world: Mocked;
  room: Mocked;
  user: Mocked;
  favorite: Mocked;
  worldMember: Mocked;
  membershipInvitation: Mocked;
  roomAccess: Mocked;
};
const hidden = hiddenSystemOwnerId as jest.Mock;

/** The full SQL of a $queryRaw call, nested Prisma.sql fragments included. */
function sqlOf(call: unknown[]): Prisma.Sql {
  const [first, ...values] = call as [TemplateStringsArray | Prisma.Sql, ...unknown[]];
  return Array.isArray(first) ? Prisma.sql(first as TemplateStringsArray, ...values) : (first as Prisma.Sql);
}
const statements = () => db.$queryRaw.mock.calls.map(sqlOf);

const session = (path: string) => new NextRequest(`http://orbit.test${path}`, { headers: { authorization: 'Bearer orb_sess_v2_x' } });
const adminToken = (path: string) =>
  new NextRequest(`http://orbit.test${path}`, { headers: { authorization: `Bearer ${process.env.ADMIN_API_TOKEN}` } });

beforeEach(() => {
  jest.clearAllMocks();
  (getSessionUser as jest.Mock).mockResolvedValue({ id: 'me', uuid: 'me', isSuperAdmin: true });
  db.$queryRaw.mockImplementation(async (...args: unknown[]) => {
    const text = sqlOf(args).sql;
    return text.includes('COUNT(') && !text.includes('access_count') ? [{ count: BigInt(0) }] : [];
  });
  for (const model of [db.universe, db.world, db.room]) {
    model.findMany.mockResolvedValue([]);
    model.count.mockResolvedValue(0);
  }
  db.favorite.groupBy.mockResolvedValue([]);
  db.worldMember.findMany.mockResolvedValue([]);
});

describe.each([
  ['universes', listUniverses],
  ['worlds', listWorlds],
  ['rooms', listRooms],
] as const)('Discover %s', (kind, list) => {
  const discover = () => list(session(`/api/admin/${kind}?scope=discover&page=1&limit=12&search=a`));

  it('leaves out everything System owns once its spaces are hidden', async () => {
    hidden.mockResolvedValue('sys');
    expect((await discover()).status).toBe(200);
    const queries = statements();
    expect(queries.length).toBeGreaterThanOrEqual(2);
    for (const query of queries) {
      expect(query.sql).toContain('u.owner_id <> ?');
      expect(query.values).toContain('sys');
    }
  });

  it('is unchanged while the start room is still System’s', async () => {
    hidden.mockResolvedValue(null);
    expect((await discover()).status).toBe(200);
    for (const query of statements()) {
      expect(query.sql).not.toContain('owner_id');
      expect(query.sql).toMatch(/slug != 'default'|slug = 'default'/);
    }
  });
});

describe('Admin token lists', () => {
  it('list every universe, world and room but System’s once hidden', async () => {
    hidden.mockResolvedValue('sys');
    await listUniverses(adminToken('/api/admin/universes'));
    await listWorlds(adminToken('/api/admin/worlds'));
    await listRooms(adminToken('/api/admin/rooms'));
    expect(db.universe.count.mock.calls[0][0].where).toEqual({ ownerId: { not: 'sys' } });
    expect(db.world.count.mock.calls[0][0].where).toEqual({ universe: { ownerId: { not: 'sys' } } });
    expect(db.room.count.mock.calls[0][0].where).toEqual({ world: { universe: { ownerId: { not: 'sys' } } } });
  });

  it('list everything as before while nothing is hidden, and an explicit owner is honoured', async () => {
    hidden.mockResolvedValue(null);
    await listUniverses(adminToken('/api/admin/universes'));
    expect(db.universe.count.mock.calls[0][0].where).toEqual({});
    hidden.mockResolvedValue('sys');
    await listUniverses(adminToken('/api/admin/universes?ownerId=sys'));
    expect(db.universe.count.mock.calls[1][0].where).toEqual({ ownerId: 'sys' });
  });
});

describe('Recently visited', () => {
  const systemRoom = {
    id: 'r-sys',
    name: 'Lobby',
    slug: 'lobby',
    description: null,
    mapUrl: null,
    isPublic: true,
    world: { id: 'w', name: 'W', slug: 'w', isPublic: true, universe: { id: 'u', name: 'U', slug: 'u', isPublic: true, ownerId: 'sys' } },
    _count: { favorites: 0 },
  };

  beforeEach(() => {
    db.$queryRaw.mockResolvedValue([{ room_id: 'r-sys', last_at: new Date() }]);
    db.room.findMany.mockResolvedValue([systemRoom]);
  });

  it('filters System’s rooms in the query once hidden', async () => {
    hidden.mockResolvedValue('sys');
    const body = await (await recentRooms(session('/api/admin/rooms/recent?limit=5'))).json();
    const [query] = statements();
    expect(query.sql).toContain('u.owner_id <> ?');
    expect(query.values).toContain('sys');
    expect(body.rooms).toEqual([]);
  });

  it('keeps them while the start room is still System’s', async () => {
    hidden.mockResolvedValue(null);
    const body = await (await recentRooms(session('/api/admin/rooms/recent?limit=5'))).json();
    expect(statements()[0].sql).not.toContain('owner_id');
    expect(body.rooms.map((room: { roomId: string }) => room.roomId)).toEqual(['r-sys']);
  });
});

describe('From a play URI', () => {
  beforeEach(() => {
    db.world.findFirst.mockResolvedValue({ id: 'w', universe: { id: 'u', name: 'Default', slug: 'default', ownerId: 'sys' } });
    db.room.findFirst.mockResolvedValue({ id: 'r', slug: 'default', name: 'Default' });
  });
  const resolve = () => fromPlayUri(session(`/api/admin/rooms/from-play-uri?playUri=${encodeURIComponent('https://play.test/@/default/default/default')}`));

  it('still resolves a System room by link, marked unlisted once hidden', async () => {
    hidden.mockResolvedValue('sys');
    const response = await resolve();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: 'r', slug: 'default', name: 'Default', unlisted: true });
  });

  it('is not marked while the start room is still System’s', async () => {
    hidden.mockResolvedValue(null);
    expect(await (await resolve()).json()).toEqual({ id: 'r', slug: 'default', name: 'Default' });
  });
});

describe('Bootstrap', () => {
  beforeEach(() => {
    delete process.env.START_ROOM_URL;
    (getSessionData as jest.Mock).mockResolvedValue({ userId: 'me', tags: [] });
    db.user.findUnique.mockResolvedValue({ id: 'me', uuid: 'me', email: 'me@example.test', name: 'Me' });
    db.user.count.mockResolvedValue(7);
    db.universe.count.mockResolvedValue(3);
    db.world.count.mockResolvedValue(4);
    db.room.count.mockResolvedValue(5);
    db.universe.findFirst.mockResolvedValue({ id: 'u-default' });
    db.world.findFirst.mockResolvedValue({ id: 'w-default' });
    db.room.findFirst.mockResolvedValue({ id: 'r-default' });
    db.favorite.count.mockResolvedValue(0);
    db.worldMember.count.mockResolvedValue(0);
    db.membershipInvitation.count.mockResolvedValue(0);
  });

  it('never counts System as a person, and counts only others’ spaces once hidden', async () => {
    hidden.mockResolvedValue('sys');
    const body = await (await bootstrap(session('/api/admin/bootstrap'))).json();
    expect(db.user.count).toHaveBeenCalledWith({ where: NOT_SYSTEM_USER });
    expect(db.universe.count.mock.calls[0][0]).toEqual({ where: { ownerId: { not: 'sys' } } });
    expect(db.room.count.mock.calls[0][0]).toEqual({ where: { world: { universe: { ownerId: { not: 'sys' } } } } });
    // The default space is looked up among others' spaces only: System's own default is already out of the counts.
    expect(db.universe.findFirst.mock.calls[0][0].where).toEqual({ AND: [{ slug: 'default' }, { ownerId: { not: 'sys' } }] });
    expect(db.room.findFirst.mock.calls[0][0].where).toEqual({
      AND: [
        { slug: 'default', world: { slug: 'default', universe: { slug: 'default' } } },
        { world: { universe: { ownerId: { not: 'sys' } } } },
      ],
    });
    expect(db.worldMember.count.mock.calls[0][0]).toEqual({
      where: { userId: 'me', world: { universe: { ownerId: { not: 'sys' } } } },
    });
    expect(db.favorite.count.mock.calls[0][0]).toEqual({
      where: { userId: 'me', roomId: { not: null }, room: { world: { universe: { ownerId: { not: 'sys' } } } } },
    });
    expect(body.startRoom).toBe('@/default/default/default');
  });

  it('leaves System’s default space alone once hidden, since the counts already leave it out', async () => {
    hidden.mockResolvedValue('sys');
    db.universe.findFirst.mockResolvedValue(null);
    db.world.findFirst.mockResolvedValue(null);
    db.room.findFirst.mockResolvedValue(null);
    const body = await (await bootstrap(session('/api/admin/bootstrap'))).json();
    expect(body.stats).toEqual({ universes: 3, worlds: 4, rooms: 5, users: 7 });
  });

  it('subtracts a default space someone else owns once System’s spaces are hidden, like the lists do', async () => {
    hidden.mockResolvedValue('sys');
    const body = await (await bootstrap(session('/api/admin/bootstrap'))).json();
    expect(body.stats).toEqual({ universes: 2, worlds: 3, rooms: 4, users: 7 });
  });

  it('subtracts the default room as before while nothing is hidden', async () => {
    hidden.mockResolvedValue(null);
    const body = await (await bootstrap(session('/api/admin/bootstrap'))).json();
    expect(db.universe.count.mock.calls[0][0]).toEqual({ where: {} });
    expect(body.stats).toEqual({ universes: 2, worlds: 3, rooms: 4, users: 7 });
  });
});

describe('Game member search', () => {
  it('never returns the System account', async () => {
    db.world.findFirst.mockResolvedValue({ id: 'w' });
    await members(adminToken(`/api/members?playUri=${encodeURIComponent('https://play.test/@/u/w/r')}&searchText=sys`));
    await members(adminToken(`/api/members?playUri=${encodeURIComponent('https://play.test/@/u/w/r')}`));
    expect(db.worldMember.findMany.mock.calls[0][0].where.user.AND[0]).toEqual(NOT_SYSTEM_USER);
    expect(db.worldMember.findMany.mock.calls[1][0].where.user).toEqual(NOT_SYSTEM_USER);
  });
});

describe('Your worlds and the worlds you manage', () => {
  beforeEach(() => {
    (getSessionUser as jest.Mock).mockResolvedValue({ id: 'me' });
    db.worldMember.findMany.mockResolvedValue([]);
    db.world.findMany.mockResolvedValue([]);
    db.roomAccess.findMany.mockResolvedValue([]);
  });

  it('leave out System’s worlds once hidden', async () => {
    hidden.mockResolvedValue('sys');
    await myMemberships(session('/api/memberships/my'));
    await managedWorlds(session('/api/admin/worlds/managed'));
    const notSystem = { universe: { ownerId: { not: 'sys' } } };
    expect(db.worldMember.findMany.mock.calls[0][0].where).toEqual({ userId: 'me', world: notSystem });
    expect(db.world.findMany.mock.calls[0][0].where.universe).toEqual(notSystem.universe);
  });

  it('are unchanged while the start room is still System’s', async () => {
    hidden.mockResolvedValue(null);
    await myMemberships(session('/api/memberships/my'));
    await managedWorlds(session('/api/admin/worlds/managed'));
    expect(db.worldMember.findMany.mock.calls[0][0].where).toEqual({ userId: 'me', world: {} });
    expect(db.world.findMany.mock.calls[0][0].where.universe).toBeUndefined();
  });
});

describe('A world’s members', () => {
  it('never include the System account', async () => {
    (getSessionUser as jest.Mock).mockResolvedValue({ id: 'me' });
    // A public world in a public universe, so anyone signed in may see its members
    db.world.findUnique.mockResolvedValue({ id: 'w', isPublic: true, universe: { isPublic: true, ownerId: 'owner' }, members: [] });
    db.worldMember.findMany.mockResolvedValue([]);
    db.roomAccess.findMany.mockResolvedValue([]);
    await worldMembers(session('/api/admin/worlds/w/members'), { params: Promise.resolve({ id: 'w' }) });
    expect(db.worldMember.findMany.mock.calls[0][0].where).toEqual({ worldId: 'w', user: NOT_SYSTEM_USER });
  });
});
