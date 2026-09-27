/**
 * Recently visited is personal and access-filtered: only the caller's own visits, and only rooms they may still see.
 */
import { NextRequest } from 'next/server';

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

/**
 * The database's answer: each room's latest visit, newest first, paged by the query's LIMIT/OFFSET (its last two
 * values), and the rooms themselves by id.
 */
function visited(rooms: Room[]) {
  const rows = rooms.map((entry, index) => ({ room_id: entry.id, last_at: new Date(Date.UTC(2026, 8, 27, 12) - index * 60_000) }));
  db.$queryRaw.mockImplementation(async (...args: unknown[]) => {
    const [limit, offset] = args.slice(-2) as [number, number];
    return rows.slice(offset, offset + limit);
  });
  db.room.findMany.mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) =>
    rooms.filter((entry) => where.id.in.includes(entry.id)),
  );
}

const sqlOf = (call: unknown[]) => (call[0] as TemplateStringsArray).join('?');
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
    const call = db.$queryRaw.mock.calls[0];
    expect(sqlOf(call)).toMatch(/GROUP BY room_id/);
    expect(call).toEqual(expect.arrayContaining([
      expect.objectContaining({ values: expect.arrayContaining(['u-alice']) }),
    ]));
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

  it('reads further when hidden rooms fill the first page, until the limit is met', async () => {
    const hidden = Array.from({ length: 20 }, (_, index) => room(`hidden-${index}`, { isPublic: false }));
    visited([...hidden, room('open-1'), room('open-2')]);
    expect(ids(await (await GET(request('?limit=2'))).json())).toEqual(['open-1', 'open-2']);
    expect(db.$queryRaw).toHaveBeenCalledTimes(2);
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
