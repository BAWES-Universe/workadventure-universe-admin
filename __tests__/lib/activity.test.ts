/**
 * Activity: what happened to you, newest first, from invitations, memberships, stars and what you made.
 */
jest.mock('@/lib/db', () => ({
  prisma: {
    membershipInvitation: { findMany: jest.fn() },
    worldMember: { findMany: jest.fn() },
    favorite: { findMany: jest.fn() },
    universe: { findMany: jest.fn() },
    world: { findMany: jest.fn() },
  },
}));

import { prisma } from '@/lib/db';
import { loadActivity, MAX_EVENTS } from '@/lib/activity';

const db = prisma as unknown as Record<string, { findMany: jest.Mock }>;
const at = (iso: string) => new Date(iso);

beforeEach(() => {
  jest.resetAllMocks();
  for (const model of ['membershipInvitation', 'worldMember', 'favorite', 'universe', 'world']) db[model].findMany.mockResolvedValue([]);
});

describe('loadActivity', () => {
  it('says what happened, in plain words, newest first, each leading to its page', async () => {
    db.membershipInvitation.findMany.mockResolvedValue([
      { id: 'i1', invitedAt: at('2026-10-07T05:00:00Z'), tags: ['admin'], world: { id: 'w-work', name: 'Workshop' }, invitedBy: { name: 'Mishari' } },
    ]);
    db.worldMember.findMany.mockResolvedValue([
      { id: 'm1', joinedAt: at('2026-09-25T05:00:00Z'), world: { id: 'w-studio', name: 'Studio', universe: { name: 'Mishari’s universe' } } },
    ]);
    db.favorite.findMany.mockResolvedValue([
      { id: 's1', favoritedAt: at('2026-10-04T05:00:00Z'), room: { id: 'r-lounge', name: 'Nebula Lounge' }, world: null, universe: null },
      { id: 's2', favoritedAt: at('2026-10-02T05:00:00Z'), room: null, world: { id: 'w-hq', name: 'HQ' }, universe: null },
      { id: 's3', favoritedAt: at('2026-10-01T05:00:00Z'), room: null, world: null, universe: { id: 'u-bawes', name: 'BAWES' } },
      { id: 's4', favoritedAt: at('2026-09-30T05:00:00Z'), room: null, world: null, universe: null },
    ]);
    db.universe.findMany.mockResolvedValue([{ id: 'u-bawes', name: 'BAWES', createdAt: at('2026-01-12T05:00:00Z') }]);
    db.world.findMany.mockResolvedValue([{ id: 'w-neb', name: 'Nebula', createdAt: at('2026-08-28T05:00:00Z'), universe: { name: 'BAWES' } }]);

    const events = await loadActivity('me');
    expect(events.map((event) => event.text)).toEqual([
      'Mishari invited you to Workshop as an admin',
      'You starred Nebula Lounge',
      'You starred HQ',
      'You starred BAWES',
      'You became a member of Studio in Mishari’s universe',
      'You made the world Nebula in BAWES',
      'You made the universe BAWES',
    ]);
    expect(events.map((event) => event.href)).toEqual([
      '/admin/invitations/i1',
      '/admin/rooms/r-lounge',
      '/admin/worlds/w-hq',
      '/admin/universes/u-bawes',
      '/admin/worlds/w-studio',
      '/admin/worlds/w-neb',
      '/admin/universes/u-bawes',
    ]);
    expect(events.map((event) => event.kind)).toEqual(['world', 'star', 'star', 'star', 'world', 'world', 'universe']);
  });

  it('asks only about the caller, and about universes and worlds they own', async () => {
    await loadActivity('me');
    expect(db.membershipInvitation.findMany.mock.calls[0][0].where).toEqual({ invitedUserId: 'me' });
    expect(db.worldMember.findMany.mock.calls[0][0].where).toEqual({ userId: 'me' });
    expect(db.favorite.findMany.mock.calls[0][0].where).toEqual({ userId: 'me' });
    expect(db.universe.findMany.mock.calls[0][0].where).toEqual({ ownerId: 'me' });
    expect(db.world.findMany.mock.calls[0][0].where).toEqual({ universe: { ownerId: 'me' } });
  });

  it('names an invitation with no inviter name "Someone", and a plain invite a member', async () => {
    db.membershipInvitation.findMany.mockResolvedValue([
      { id: 'i1', invitedAt: at('2026-10-07T05:00:00Z'), tags: [], world: { id: 'w', name: 'Workshop' }, invitedBy: { name: null } },
    ]);
    expect((await loadActivity('me'))[0].text).toBe('Someone invited you to Workshop as a member');
  });

  it('keeps only the latest few', async () => {
    db.favorite.findMany.mockResolvedValue(
      Array.from({ length: 15 }, (_, index) => ({
        id: `s${index}`,
        favoritedAt: at(`2026-09-${String(index + 1).padStart(2, '0')}T05:00:00Z`),
        room: { id: `r${index}`, name: `Room ${index}` },
        world: null,
        universe: null,
      })),
    );
    const events = await loadActivity('me');
    expect(events).toHaveLength(MAX_EVENTS);
    expect(events[0].text).toBe('You starred Room 14');
  });
});
