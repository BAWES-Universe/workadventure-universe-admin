/**
 * Starring a universe or a world itself: its own toggle, its own count, never mixed with the stars on its rooms, and
 * only for places you can see. The Stars page lists them next to starred rooms.
 */
import { NextRequest } from 'next/server';

jest.mock('@/lib/db', () => ({
  prisma: {
    world: { findUnique: jest.fn() },
    universe: { findUnique: jest.fn() },
    worldMember: { findMany: jest.fn() },
    favorite: { findFirst: jest.fn(), create: jest.fn(), delete: jest.fn(), count: jest.fn(), findMany: jest.fn(), groupBy: jest.fn() },
  },
}));
jest.mock('@/lib/auth-session', () => ({ requireSession: jest.fn() }));
jest.mock('@/lib/system-user', () => ({ hiddenSystemOwnerId: jest.fn().mockResolvedValue(null) }));

import { prisma } from '@/lib/db';
import { requireSession } from '@/lib/auth-session';
import { POST as starWorld } from '@/app/api/admin/worlds/[id]/favorite/route';
import { POST as starUniverse } from '@/app/api/admin/universes/[id]/favorite/route';
import { GET as listPlaces } from '@/app/api/admin/stars/places/route';

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;
const ME = { id: 'me', uuid: 'me-uuid', email: 'm@x.test', name: 'Me', tags: [], isSuperAdmin: false };

const post = (handler: typeof starWorld, id: string) =>
  handler(new NextRequest(`http://localhost/api/x/${id}/favorite`, { method: 'POST' }), { params: Promise.resolve({ id }) });

beforeEach(() => {
  jest.clearAllMocks();
  (requireSession as jest.Mock).mockResolvedValue(ME);
  db.worldMember.findMany.mockResolvedValue([]);
});

describe('POST /api/admin/worlds/[id]/favorite', () => {
  const world = { id: 'w1', isPublic: true, universeId: 'u1', universe: { isPublic: true, ownerId: 'someone' } };

  it('stars a world with no room, then unstars it', async () => {
    db.world.findUnique.mockResolvedValue(world);
    db.favorite.findFirst.mockResolvedValueOnce(null);
    db.favorite.count.mockResolvedValue(1);
    expect(await (await post(starWorld, 'w1')).json()).toEqual({ isStarred: true, starCount: 1 });
    expect(db.favorite.create).toHaveBeenCalledWith({ data: { userId: 'me', worldId: 'w1', universeId: 'u1' } });
    // Only stars on the world itself are counted.
    expect(db.favorite.count).toHaveBeenCalledWith({ where: { worldId: 'w1', roomId: null } });

    db.favorite.findFirst.mockResolvedValueOnce({ id: 'f1' });
    db.favorite.count.mockResolvedValue(0);
    expect(await (await post(starWorld, 'w1')).json()).toEqual({ isStarred: false, starCount: 0 });
    expect(db.favorite.delete).toHaveBeenCalledWith({ where: { id: 'f1' } });
    // The room-less filter keeps a room's star from being taken for the world's.
    expect(db.favorite.findFirst).toHaveBeenCalledWith({ where: { userId: 'me', worldId: 'w1', roomId: null } });
  });

  it('does not find a private world for someone outside it', async () => {
    db.world.findUnique.mockResolvedValue({ ...world, isPublic: false });
    expect((await post(starWorld, 'w1')).status).toBe(404);
    expect(db.favorite.create).not.toHaveBeenCalled();
  });

  it('refuses anyone signed out', async () => {
    (requireSession as jest.Mock).mockRejectedValue(new Error('Unauthorized'));
    expect((await post(starWorld, 'w1')).status).toBe(401);
  });
});

describe('POST /api/admin/universes/[id]/favorite', () => {
  const universe = { id: 'u1', isPublic: true, ownerId: 'someone', worlds: [{ id: 'w1' }] };

  it('stars a universe with no world and no room', async () => {
    db.universe.findUnique.mockResolvedValue(universe);
    db.favorite.findFirst.mockResolvedValue(null);
    db.favorite.count.mockResolvedValue(3);
    expect(await (await post(starUniverse, 'u1')).json()).toEqual({ isStarred: true, starCount: 3 });
    expect(db.favorite.create).toHaveBeenCalledWith({ data: { userId: 'me', universeId: 'u1' } });
    expect(db.favorite.count).toHaveBeenCalledWith({ where: { universeId: 'u1', worldId: null, roomId: null } });
  });

  it('does not find a private universe for someone outside it', async () => {
    db.universe.findUnique.mockResolvedValue({ ...universe, isPublic: false });
    expect((await post(starUniverse, 'u1')).status).toBe(404);
  });
});

describe('GET /api/admin/stars/places', () => {
  it('lists the universes and worlds you starred, with their own counts, leaving out ones you can no longer see', async () => {
    const at = new Date('2026-10-01T10:00:00Z');
    const universe = { id: 'u1', slug: 'u', name: 'BAWES', description: null, isPublic: true, ownerId: 'o', owner: { name: 'Khalid' } };
    const world = { id: 'w1', slug: 'w', name: 'HQ', description: null, isPublic: true, universe: { id: 'u1', slug: 'u', name: 'BAWES', isPublic: true, ownerId: 'o' } };
    const hiddenWorld = { ...world, id: 'w2', name: 'Secret', isPublic: false };
    db.favorite.findMany.mockResolvedValue([
      { id: 'a', userId: 'me', universeId: 'u1', worldId: null, roomId: null, favoritedAt: at, universe, world: null },
      { id: 'b', userId: 'me', universeId: 'u1', worldId: 'w1', roomId: null, favoritedAt: at, universe: null, world },
      { id: 'c', userId: 'me', universeId: 'u1', worldId: 'w2', roomId: null, favoritedAt: at, universe: null, world: hiddenWorld },
    ]);
    db.favorite.groupBy
      .mockResolvedValueOnce([{ universeId: 'u1', _count: { id: 4 } }])
      .mockResolvedValueOnce([{ worldId: 'w1', _count: { id: 2 } }, { worldId: 'w2', _count: { id: 1 } }]);

    const body = await (await listPlaces(new NextRequest('http://localhost/api/admin/stars/places'))).json();
    expect(body.universes).toEqual([expect.objectContaining({ id: 'u1', name: 'BAWES', ownerName: 'Khalid', starCount: 4, isStarred: true })]);
    expect(body.worlds).toEqual([expect.objectContaining({ id: 'w1', name: 'HQ', starCount: 2, universe: { id: 'u1', slug: 'u', name: 'BAWES' } })]);
    // Only your stars with no room are asked for.
    expect(db.favorite.findMany.mock.calls[0][0].where).toEqual({ userId: 'me', roomId: null });
  });
});
