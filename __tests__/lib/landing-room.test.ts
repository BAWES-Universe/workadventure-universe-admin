jest.mock('@/lib/db', () => ({
  prisma: {
    universe: { findUnique: jest.fn() },
    world: { findUnique: jest.fn() },
    worldMember: { findMany: jest.fn() },
    ban: { findFirst: jest.fn(), findMany: jest.fn() },
  },
}));
jest.mock('@/lib/access-scope', () => ({
  isPrivileged: (viewer: { kind: string; user?: { isSuperAdmin?: boolean } }) =>
    viewer.kind === 'admin-token' || viewer.user?.isSuperAdmin === true,
  viewerUserId: (viewer: { kind: string; user?: { id: string } }) => (viewer.kind === 'user' ? viewer.user!.id : null),
}));

import { prisma } from '@/lib/db';
import type { Viewer } from '@/lib/access-scope';
import { landingRoomForUniverse, landingRoomForWorld } from '@/lib/landing-room';

const db = prisma as unknown as {
  universe: { findUnique: jest.Mock };
  world: { findUnique: jest.Mock };
  worldMember: { findMany: jest.Mock };
  ban: { findFirst: jest.Mock; findMany: jest.Mock };
};

const visitor = { kind: 'user', user: { id: 'visitor', isSuperAdmin: false } } as unknown as Viewer;
const owner = { kind: 'user', user: { id: 'owner', isSuperAdmin: false } } as unknown as Viewer;

function universe(overrides: Partial<{ isPublic: boolean; worlds: unknown[] }> = {}) {
  return {
    id: 'u1',
    slug: 'bawes',
    ownerId: 'owner',
    isPublic: true,
    worlds: [
      { id: 'w-private', slug: 'staff', isPublic: false, rooms: [{ slug: 'desk', isPublic: true }] },
      { id: 'w1', slug: 'town', isPublic: true, rooms: [{ slug: 'vault', isPublic: false }, { slug: 'square', isPublic: true }] },
    ],
    ...overrides,
  };
}

describe('landing room for Visit', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    db.worldMember.findMany.mockResolvedValue([]);
    db.ban.findFirst.mockResolvedValue(null);
    db.ban.findMany.mockResolvedValue([]);
  });

  it('goes to the first public room of the first world the person may see', async () => {
    db.universe.findUnique.mockResolvedValue(universe());
    await expect(landingRoomForUniverse(visitor, 'u1')).resolves.toEqual({ ok: true, roomUrl: '/@/bawes/town/square' });
  });

  it("takes the owner to the first room, private or not", async () => {
    db.universe.findUnique.mockResolvedValue(universe());
    await expect(landingRoomForUniverse(owner, 'u1')).resolves.toEqual({ ok: true, roomUrl: '/@/bawes/staff/desk' });
  });

  it('lets a world member into that private world', async () => {
    db.universe.findUnique.mockResolvedValue(universe());
    db.worldMember.findMany.mockResolvedValue([{ worldId: 'w-private' }]);
    await expect(landingRoomForUniverse(visitor, 'u1')).resolves.toEqual({ ok: true, roomUrl: '/@/bawes/staff/desk' });
  });

  it('says no-access for a private universe the person has no part in', async () => {
    db.universe.findUnique.mockResolvedValue(universe({ isPublic: false }));
    await expect(landingRoomForUniverse(visitor, 'u1')).resolves.toEqual({ ok: false, reason: 'no-access' });
  });

  it('says no-access when the person is banned from the universe', async () => {
    db.universe.findUnique.mockResolvedValue(universe());
    db.ban.findFirst.mockResolvedValue({ id: 'ban' });
    await expect(landingRoomForUniverse(visitor, 'u1')).resolves.toEqual({ ok: false, reason: 'no-access' });
  });

  it('skips a world the person is banned from', async () => {
    db.universe.findUnique.mockResolvedValue(universe());
    db.worldMember.findMany.mockResolvedValue([{ worldId: 'w-private' }]);
    db.ban.findMany.mockResolvedValue([{ worldId: 'w-private' }]);
    await expect(landingRoomForUniverse(visitor, 'u1')).resolves.toEqual({ ok: true, roomUrl: '/@/bawes/town/square' });
  });

  it('says no-room when there is nothing to visit yet', async () => {
    db.universe.findUnique.mockResolvedValue(universe({ worlds: [] }));
    await expect(landingRoomForUniverse(owner, 'u1')).resolves.toEqual({ ok: false, reason: 'no-room' });
    db.universe.findUnique.mockResolvedValue(universe({ worlds: [{ id: 'w1', slug: 'town', isPublic: true, rooms: [] }] }));
    await expect(landingRoomForUniverse(visitor, 'u1')).resolves.toEqual({ ok: false, reason: 'no-room' });
  });

  it('says not-found for a universe or world that does not exist', async () => {
    db.universe.findUnique.mockResolvedValue(null);
    db.world.findUnique.mockResolvedValue(null);
    await expect(landingRoomForUniverse(visitor, 'u1')).resolves.toEqual({ ok: false, reason: 'not-found' });
    await expect(landingRoomForWorld(visitor, 'w1')).resolves.toEqual({ ok: false, reason: 'not-found' });
  });

  it('visits a public world of a private universe directly', async () => {
    db.world.findUnique.mockResolvedValue({
      id: 'w1',
      slug: 'town',
      isPublic: true,
      rooms: [{ slug: 'square', isPublic: true }],
      universe: { id: 'u1', slug: 'bawes', ownerId: 'owner', isPublic: false },
    });
    await expect(landingRoomForWorld(visitor, 'w1')).resolves.toEqual({ ok: true, roomUrl: '/@/bawes/town/square' });
  });
});
