/**
 * Recently visited is personal and access-filtered: only the caller's own visits, and only rooms they may still see.
 */
import { NextRequest } from 'next/server';

jest.mock('@/lib/db', () => ({
  prisma: {
    roomAccess: { findMany: jest.fn() },
    worldMember: { findMany: jest.fn() },
  },
}));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn() }));
jest.mock('@/lib/auth', () => ({ requireAuth: jest.fn() }));

import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { GET } from '@/app/api/admin/rooms/recent/route';

const db = prisma as unknown as { roomAccess: { findMany: jest.Mock }; worldMember: { findMany: jest.Mock } };
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
    db.roomAccess.findMany.mockResolvedValue([]);
    await GET(request());
    expect(db.roomAccess.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { OR: [{ userId: 'u-alice' }, { userUuid: 'uuid-alice' }] } }),
    );
  });

  it('lists each room once, newest first, without the start map', async () => {
    db.roomAccess.findMany.mockResolvedValue([
      { accessedAt: new Date('2026-09-27T10:00:00Z'), room: room('square') },
      { accessedAt: new Date('2026-09-27T09:00:00Z'), room: room('start', { slugs: ['default', 'default', 'default'] }) },
      { accessedAt: new Date('2026-09-27T08:00:00Z'), room: room('square') },
      { accessedAt: new Date('2026-09-27T07:00:00Z'), room: room('lab') },
    ]);
    const response = await GET(request('?limit=5'));
    const body = await response.json();
    expect(body.rooms.map((entry: { roomId: string }) => entry.roomId)).toEqual(['square', 'lab']);
  });

  it('leaves out rooms the person may no longer see', async () => {
    db.roomAccess.findMany.mockResolvedValue([
      { accessedAt: new Date(), room: room('private-room', { isPublic: false }) },
      { accessedAt: new Date(), room: room('private-world', { worldPublic: false }) },
      { accessedAt: new Date(), room: room('private-universe', { universePublic: false }) },
      { accessedAt: new Date(), room: room('open') },
    ]);
    const body = await (await GET(request('?limit=5'))).json();
    expect(body.rooms.map((entry: { roomId: string }) => entry.roomId)).toEqual(['open']);
  });

  it('keeps private rooms of worlds the person belongs to, and of universes they own', async () => {
    db.worldMember.findMany.mockResolvedValue([{ worldId: 'w-member' }]);
    db.roomAccess.findMany.mockResolvedValue([
      { accessedAt: new Date(), room: room('member-room', { isPublic: false, worldId: 'w-member' }) },
      { accessedAt: new Date(), room: room('own-room', { isPublic: false, universePublic: false, ownerId: 'u-alice' }) },
      { accessedAt: new Date(), room: room('other-room', { isPublic: false }) },
    ]);
    const body = await (await GET(request('?limit=5'))).json();
    expect(body.rooms.map((entry: { roomId: string }) => entry.roomId)).toEqual(['member-room', 'own-room']);
  });

  it('shows a super admin everything they visited', async () => {
    session.mockResolvedValue({ ...alice, isSuperAdmin: true });
    db.roomAccess.findMany.mockResolvedValue([{ accessedAt: new Date(), room: room('private-room', { isPublic: false }) }]);
    const body = await (await GET(request())).json();
    expect(body.rooms).toHaveLength(1);
  });

  it('refuses an anonymous caller', async () => {
    session.mockResolvedValue(null);
    const response = await GET(new NextRequest('http://orbit.test/api/admin/rooms/recent'));
    expect(response.status).toBe(401);
  });
});
