/**
 * Passport: a stamp for every world someone has been to; a stranger sees only public ones.
 */
jest.mock('@/lib/db', () => ({
  prisma: {
    roomAccess: { groupBy: jest.fn() },
    world: { findMany: jest.fn() },
    $queryRaw: jest.fn(),
  },
}));

import { prisma } from '@/lib/db';
import { loadPassport } from '@/lib/passport';

const db = prisma as unknown as { roomAccess: { groupBy: jest.Mock }; world: { findMany: jest.Mock }; $queryRaw: jest.Mock };

const group = (worldId: string, count: number, first: string) => ({ worldId, _count: { _all: count }, _min: { accessedAt: new Date(first) } });
const world = (id: string, name: string, universe: string, isPublic = true, universePublic = true) => ({
  id,
  name,
  isPublic,
  universe: { id: universe, name: universe.toUpperCase(), isPublic: universePublic },
});

beforeEach(() => {
  jest.resetAllMocks();
  db.$queryRaw.mockResolvedValue([{ days: 84 }]);
  db.roomAccess.groupBy.mockResolvedValue([
    group('nebula', 64, '2026-02-03T08:00:00Z'),
    group('hq', 212, '2026-01-12T08:00:00Z'),
    group('vault', 9, '2026-03-01T08:00:00Z'),
    group('studio', 23, '2026-03-19T08:00:00Z'),
  ]);
  db.world.findMany.mockResolvedValue([
    world('hq', 'HQ', 'bawes'),
    world('nebula', 'Nebula', 'bawes'),
    world('studio', 'Studio', 'mishari'),
    world('vault', 'Vault', 'bawes', false),
  ]);
});

describe('loadPassport', () => {
  it('gives the owner every world, most visited first, with the first visit and the days around', async () => {
    const passport = await loadPassport('me', { owner: true });
    expect(passport.stamps.map((stamp) => [stamp.world, stamp.visits])).toEqual([
      ['HQ', 212],
      ['Nebula', 64],
      ['Studio', 23],
      ['Vault', 9],
    ]);
    expect(passport).toMatchObject({ worlds: 4, universes: 2, since: '2026-01-12T08:00:00.000Z', days: 84 });
    expect(db.roomAccess.groupBy).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 'me' } }));
  });

  it('gives a stranger only public worlds in public universes, and counts only those', async () => {
    db.world.findMany.mockResolvedValue([
      world('hq', 'HQ', 'bawes'),
      world('nebula', 'Nebula', 'bawes'),
      world('studio', 'Studio', 'mishari', true, false),
      world('vault', 'Vault', 'bawes', false),
    ]);
    const passport = await loadPassport('me', { owner: false });
    expect(passport.stamps.map((stamp) => stamp.world)).toEqual(['HQ', 'Nebula']);
    expect(passport).toMatchObject({ worlds: 2, universes: 1, since: '2026-01-12T08:00:00.000Z' });
  });

  it('is empty for someone who has been nowhere, without asking for worlds', async () => {
    db.roomAccess.groupBy.mockResolvedValue([]);
    expect(await loadPassport('me', { owner: true })).toEqual({ stamps: [], worlds: 0, universes: 0, since: null, days: 0 });
    expect(db.world.findMany).not.toHaveBeenCalled();
  });

  it('is empty to a stranger when every world they visited is private', async () => {
    db.world.findMany.mockResolvedValue([world('hq', 'HQ', 'bawes', false), world('nebula', 'Nebula', 'bawes', false)]);
    expect((await loadPassport('me', { owner: false })).stamps).toEqual([]);
  });

  it('skips a world that no longer exists', async () => {
    db.world.findMany.mockResolvedValue([world('hq', 'HQ', 'bawes')]);
    expect((await loadPassport('me', { owner: true })).stamps.map((stamp) => stamp.world)).toEqual(['HQ']);
  });
});
