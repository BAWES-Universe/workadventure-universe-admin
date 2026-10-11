/**
 * Orbit opened in the game names the room the player is in; the world of that room decides which outfit people are
 * drawn in. A world the viewer could not see anyway counts as no world.
 */
import { NextRequest } from 'next/server';

jest.mock('@/lib/db', () => ({
  prisma: { world: { findFirst: jest.fn() }, worldMember: { findMany: jest.fn() } },
}));

import { prisma } from '@/lib/db';
import { ORBIT_PLAY_URI_HEADER, viewerWorldId } from '@/lib/viewer-world';

const db = prisma as unknown as { world: { findFirst: jest.Mock }; worldMember: { findMany: jest.Mock } };

const ROOM = 'http://play.test/@/uni/world/room';
const me = { id: 'me', isSuperAdmin: false };
const request = (playUri?: string) =>
  new NextRequest('http://orbit.test/api/admin/users', { headers: playUri ? { [ORBIT_PLAY_URI_HEADER]: playUri } : {} });
const world = (isPublic: boolean, universePublic = true, ownerId = 'someone') => ({
  id: 'world-1',
  isPublic,
  universe: { isPublic: universePublic, ownerId },
});

beforeEach(() => {
  jest.clearAllMocks();
  db.worldMember.findMany.mockResolvedValue([]);
});

describe('viewerWorldId', () => {
  it('is the world of the room the game says the player is in', async () => {
    db.world.findFirst.mockResolvedValue(world(true));
    expect(await viewerWorldId(request(ROOM), me)).toBe('world-1');
    expect(db.world.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { slug: 'world', universe: { slug: 'uni' } } }));
  });

  it('is nothing outside the game (no header), without looking anything up', async () => {
    expect(await viewerWorldId(request(), me)).toBeUndefined();
    expect(db.world.findFirst).not.toHaveBeenCalled();
  });

  it('is nothing for a room address that is not a world\'s, a world that does not exist, or a very long address', async () => {
    expect(await viewerWorldId(request('http://play.test/_/global/example.com/map.json'), me)).toBeUndefined();
    expect(await viewerWorldId(request('not an address'), me)).toBeUndefined();
    db.world.findFirst.mockResolvedValue(null);
    expect(await viewerWorldId(request(ROOM), me)).toBeUndefined();
    expect(await viewerWorldId(request(`${ROOM}/${'a'.repeat(3000)}`), me)).toBeUndefined();
  });

  it('is nothing for a private world the viewer is not in, so the header cannot be used to look inside it', async () => {
    db.world.findFirst.mockResolvedValue(world(false));
    expect(await viewerWorldId(request(ROOM), me)).toBeUndefined();
  });

  it('is the world for a private world the viewer is a member of, owns, or may see as a super admin', async () => {
    db.world.findFirst.mockResolvedValue(world(false));
    db.worldMember.findMany.mockResolvedValue([{ worldId: 'world-1' }]);
    expect(await viewerWorldId(request(ROOM), me)).toBe('world-1');
    db.worldMember.findMany.mockResolvedValue([]);
    db.world.findFirst.mockResolvedValue(world(false, true, 'me'));
    expect(await viewerWorldId(request(ROOM), me)).toBe('world-1');
    db.world.findFirst.mockResolvedValue(world(false));
    expect(await viewerWorldId(request(ROOM), { id: 'root', isSuperAdmin: true })).toBe('world-1');
  });

  it('is nothing for a caller with the admin token, or nobody signed in', async () => {
    expect(await viewerWorldId(request(ROOM), { kind: 'admin-token' })).toBeUndefined();
    expect(await viewerWorldId(request(ROOM), null)).toBeUndefined();
  });

  it('accepts a signed-in viewer as the access scope gives it', async () => {
    db.world.findFirst.mockResolvedValue(world(true));
    const viewer = { kind: 'user' as const, user: { id: 'me', uuid: 'u', email: null, name: null, tags: [], isSuperAdmin: false } };
    expect(await viewerWorldId(request(ROOM), viewer)).toBe('world-1');
  });

  it('is nothing when the lookup fails', async () => {
    db.world.findFirst.mockRejectedValue(new Error('database down'));
    expect(await viewerWorldId(request(ROOM), me)).toBeUndefined();
  });
});
