/**
 * Recently visited is personal and access-filtered: only the caller's own visits, and only rooms they may still see.
 */
import { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';

jest.mock('@/lib/db', () => ({
  prisma: {
    $queryRaw: jest.fn(),
    room: { findMany: jest.fn() },
    worldMember: { findMany: jest.fn() },
  },
}));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn() }));
jest.mock('@/lib/auth', () => ({ requireAuth: jest.fn() }));

import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { GET } from '@/app/api/admin/rooms/recent/route';

const db = prisma as unknown as { $queryRaw: jest.Mock; room: { findMany: jest.Mock }; worldMember: { findMany: jest.Mock } };

type Room = ReturnType<typeof room>;

/** The database's answer: each room's latest visit, newest first, up to the query's LIMIT (its last value). */
function visited(rooms: Room[]) {
  const rows = rooms.map((entry, index) => ({ room_id: entry.id, last_at: new Date(Date.UTC(2026, 8, 27, 12) - index * 60_000) }));
  db.$queryRaw.mockImplementation(async (...args: unknown[]) => rows.slice(0, args[args.length - 1] as number));
  db.room.findMany.mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) =>
    rooms.filter((entry) => where.id.in.includes(entry.id)),
  );
}

/** The full SQL of a $queryRaw call, nested Prisma.sql fragments included. */
const sqlOf = (call: unknown[]) => {
  const [first, ...values] = call as [TemplateStringsArray, ...unknown[]];
  return Prisma.sql(first, ...values).sql;
};
const ids = (body: { rooms: { roomId: string }[] }) => body.rooms.map((entry) => entry.roomId);
const session = getSessionUser as jest.Mock;

const alice = { id: 'u-alice', uuid: 'uuid-alice', email: 'a@example.test', name: 'Alice', tags: [], isSuperAdmin: false };

function room(id: string, overrides: Partial<{ isPublic: boolean; worldPublic: boolean; universePublic: boolean; ownerId: string; worldId: string; slugs: [string, string, string] }> = {}) {
  const [universeSlug, worldSlug, roomSlug] = overrides.slugs ?? ['bawes', 'town', id];
  return {
    id,
    name: id,
    slug: roomSlug,
    description: null,
    mapUrl: null,
    isPublic: overrides.isPublic ?? true,
    world: {
      id: overrides.worldId ?? 'w-1',
      name: 'Town',
      slug: worldSlug,
      isPublic: overrides.worldPublic ?? true,
      universe: { id: 'u-1', name: 'BAWES', slug: universeSlug, isPublic: overrides.universePublic ?? true, ownerId: overrides.ownerId ?? 'someone-else' },
    },
    _count: { favorites: 0 },
  };
}

function request(query = '') {
  return new NextRequest(`http://orbit.test/api/admin/rooms/recent${query}`, { headers: { authorization: 'Bearer orb_sess_v2_x' } });
}

describe('GET /api/admin/rooms/recent', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    session.mockResolvedValue(alice);
    db.worldMember.findMany.mockResolvedValue([]);
  });

  it('asks only for the caller’s own visits', async () => {
    visited([]);
    await GET(request());
    const query = Prisma.sql(...(db.$queryRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]]));
    expect(query.sql).toMatch(/GROUP BY ra\.room_id/);
    expect(query.sql).toMatch(/ra\.user_id = \? OR ra\.user_uuid = \?/);
    expect(query.values).toEqual(expect.arrayContaining(['u-alice', 'uuid-alice']));
  });

  it('lists each room once, newest first, without the start map', async () => {
    visited([room('square'), room('start', { slugs: ['default', 'default', 'default'] }), room('lab')]);
    expect(ids(await (await GET(request('?limit=5'))).json())).toEqual(['square', 'lab']);
  });

  it('finds an older room however many times a newer one was visited', async () => {
    // Sixty visits to the square no longer push the lab out: the database answers one row per room.
    visited([room('square'), room('lab')]);
    expect(ids(await (await GET(request('?limit=2'))).json())).toEqual(['square', 'lab']);
  });

  it('filters hidden rooms in the query, before the limit, so none can crowd out a visible one', async () => {
    visited([room('open')]);
    await GET(request('?limit=2&excludeRoomId=here'));
    expect(db.$queryRaw).toHaveBeenCalledTimes(1);
    const call = db.$queryRaw.mock.calls[0];
    const sql = sqlOf(call);
    // The same rule as canSeeRoom: all three public, or the universe is yours, or you belong to the world.
    expect(sql).toMatch(/r\.is_public AND w\.is_public AND u\.is_public/);
    expect(sql).toMatch(/u\.owner_id = /);
    expect(sql).toMatch(/FROM world_members wm WHERE wm\.world_id = w\.id AND wm\.user_id = /);
    expect(sql).toMatch(/NOT \(u\.slug = 'default' AND w\.slug = 'default' AND r\.slug = 'default'\)/);
    expect(sql).toMatch(/r\.id <> /);
    // The limit asked for is the query's LIMIT: no scan cap, no pages.
    expect(call[call.length - 1]).toBe(2);
  });

  it('shows the one room still visible after a hundred that are not', async () => {
    // What the database returns once hidden rooms are filtered in the query: just the visible one.
    visited([room('room-101')]);
    expect(ids(await (await GET(request('?limit=2'))).json())).toEqual(['room-101']);
  });

  it('gives a super admin every room they visited, with no visibility filter', async () => {
    session.mockResolvedValue({ ...alice, isSuperAdmin: true });
    visited([]);
    await GET(request());
    expect(sqlOf(db.$queryRaw.mock.calls[0])).not.toMatch(/is_public/);
  });

  it('leaves out rooms the person may no longer see', async () => {
    visited([
      room('private-room', { isPublic: false }),
      room('private-world', { worldPublic: false }),
      room('private-universe', { universePublic: false }),
      room('open'),
    ]);
    expect(ids(await (await GET(request('?limit=5'))).json())).toEqual(['open']);
  });

  it('keeps private rooms of worlds the person belongs to, and of universes they own', async () => {
    db.worldMember.findMany.mockResolvedValue([{ worldId: 'w-member' }]);
    visited([
      room('member-room', { isPublic: false, worldId: 'w-member' }),
      room('own-room', { isPublic: false, universePublic: false, ownerId: 'u-alice' }),
      room('other-room', { isPublic: false }),
    ]);
    expect(ids(await (await GET(request('?limit=5'))).json())).toEqual(['member-room', 'own-room']);
  });

  it('shows a super admin everything they visited', async () => {
    session.mockResolvedValue({ ...alice, isSuperAdmin: true });
    visited([room('private-room', { isPublic: false })]);
    const body = await (await GET(request())).json();
    expect(body.rooms).toHaveLength(1);
  });

  it('refuses an anonymous caller', async () => {
    session.mockResolvedValue(null);
    const response = await GET(new NextRequest('http://orbit.test/api/admin/rooms/recent'));
    expect(response.status).toBe(401);
  });
});
