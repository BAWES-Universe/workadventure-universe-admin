import { NextRequest } from 'next/server';

jest.mock('@/lib/db', () => ({
  prisma: {
    universeMember: { findMany: jest.fn() },
    universe: { findMany: jest.fn() },
    worldMember: { findMany: jest.fn() },
  },
}));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn() }));
jest.mock('@/lib/system-user', () => ({ hiddenSystemOwnerId: jest.fn().mockResolvedValue(null) }));

import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { GET } from '@/app/api/memberships/my/universes/route';

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;
const worlds = [{ id: 'hq', name: 'HQ', isPublic: true }, { id: 'campus', name: 'Campus', isPublic: true }];
const shown = [{ id: 'hq', name: 'HQ' }, { id: 'campus', name: 'Campus' }];
const call = () => GET(new NextRequest('http://localhost/api/memberships/my/universes'));

beforeEach(() => {
  jest.clearAllMocks();
  (getSessionUser as jest.Mock).mockResolvedValue({ id: 'me', uuid: 'uuid-me', email: null, name: 'Me', tags: [], isSuperAdmin: false });
  db.universeMember.findMany.mockResolvedValue([]);
  db.universe.findMany.mockResolvedValue([]);
  db.worldMember.findMany.mockResolvedValue([]);
});

it('needs a session', async () => {
  (getSessionUser as jest.Mock).mockResolvedValue(null);
  expect((await call()).status).toBe(401);
});

it('lists each universe you joined with your roles there, highest first, and where they work', async () => {
  db.universeMember.findMany.mockResolvedValue([
    {
      joinedAt: new Date('2026-10-01T00:00:00Z'),
      allWorlds: true,
      worldIds: [],
      universe: { id: 'u1', name: 'BAWES', ownerId: 'someone', isPublic: true, createdAt: new Date('2025-06-01T00:00:00Z'), worlds },
      roles: [
        { allWorlds: true, worldIds: [], role: { key: 'accountant', name: 'Accountant', color: '#34D399', position: 12 } },
        { allWorlds: false, worldIds: ['hq'], role: { key: 'editor', name: 'Editor', color: '#60A5FA', position: 2 } },
        { allWorlds: true, worldIds: [], role: { key: 'moderator', name: 'Moderator', color: '#FB923C', position: 20 } },
      ],
    },
  ]);
  const body = await (await call()).json();
  expect(body.universes).toHaveLength(1);
  const [membership] = body.universes;
  expect(membership.universe).toEqual({ id: 'u1', name: 'BAWES', createdAt: '2025-06-01T00:00:00.000Z', worlds: shown });
  expect(membership.isOwner).toBe(false);
  expect(membership.worlds).toEqual({ allWorlds: true, worldIds: [] });
  expect(membership.roles.map((role: { name: string }) => role.name)).toEqual(['Moderator', 'Accountant', 'Editor']);
  expect(membership.roles[2]).toMatchObject({ allWorlds: false, worldIds: ['hq'] });
  // Only yours: the query is for your own membership rows
  expect(db.universeMember.findMany.mock.calls[0][0].where).toMatchObject({ userId: 'me' });
});

it('lists a universe you own even when you never joined it, as the owner everywhere', async () => {
  db.universe.findMany.mockResolvedValue([{ id: 'u2', name: 'Mine', ownerId: 'me', isPublic: false, createdAt: new Date('2026-01-01T00:00:00Z'), worlds }]);
  const body = await (await call()).json();
  expect(body.universes).toHaveLength(1);
  expect(body.universes[0]).toMatchObject({ universe: { id: 'u2', createdAt: '2026-01-01T00:00:00.000Z' }, isOwner: true, worlds: { allWorlds: true }, roles: [] });
});

it('lists an owned universe once when you also joined it', async () => {
  const universe = { id: 'u3', name: 'Both', ownerId: 'me', isPublic: false, createdAt: new Date(), worlds };
  db.universeMember.findMany.mockResolvedValue([{ joinedAt: new Date(), allWorlds: true, worldIds: [], universe, roles: [] }]);
  db.universe.findMany.mockResolvedValue([universe]);
  const body = await (await call()).json();
  expect(body.universes).toHaveLength(1);
  expect(body.universes[0].isOwner).toBe(true);
});

describe('private worlds', () => {
  const mixed = [
    { id: 'hq', name: 'HQ', isPublic: true },
    { id: 'vault', name: 'Vault', isPublic: false },
    { id: 'lab', name: 'Lab', isPublic: false },
  ];
  const joinedUniverse = { id: 'u4', name: 'Mixed', ownerId: 'someone', isPublic: true, createdAt: new Date(), worlds: mixed };

  it('names a private world only to someone who is a member of it, not to everyone in the universe', async () => {
    db.universeMember.findMany.mockResolvedValue([{ joinedAt: new Date(), allWorlds: false, worldIds: ['hq', 'lab'], universe: joinedUniverse, roles: [] }]);
    db.worldMember.findMany.mockResolvedValue([{ worldId: 'hq' }, { worldId: 'lab' }]);
    const body = await (await call()).json();
    expect(body.universes[0].universe.worlds).toEqual([{ id: 'hq', name: 'HQ' }, { id: 'lab', name: 'Lab' }]);
    // Asked for the person's own world memberships only, over the worlds listed
    expect(db.worldMember.findMany.mock.calls[0][0].where).toEqual({ userId: 'me', worldId: { in: ['hq', 'vault', 'lab'] } });
  });

  it('lists every world of a universe you own, and none of the private ones of a universe you merely joined without them', async () => {
    db.universe.findMany.mockResolvedValue([{ ...joinedUniverse, id: 'u5', ownerId: 'me' }]);
    expect((await (await call()).json()).universes[0].universe.worlds.map((world: { id: string }) => world.id)).toEqual(['hq', 'vault', 'lab']);
    db.universe.findMany.mockResolvedValue([]);
    db.universeMember.findMany.mockResolvedValue([{ joinedAt: new Date(), allWorlds: true, worldIds: [], universe: joinedUniverse, roles: [] }]);
    expect((await (await call()).json()).universes[0].universe.worlds.map((world: { id: string }) => world.id)).toEqual(['hq']);
  });

  it('shows a super admin everything', async () => {
    (getSessionUser as jest.Mock).mockResolvedValue({ id: 'root', uuid: 'uuid-root', email: null, name: 'Root', tags: [], isSuperAdmin: true });
    db.universeMember.findMany.mockResolvedValue([{ joinedAt: new Date(), allWorlds: true, worldIds: [], universe: joinedUniverse, roles: [] }]);
    expect((await (await call()).json()).universes[0].universe.worlds).toHaveLength(3);
  });
});
