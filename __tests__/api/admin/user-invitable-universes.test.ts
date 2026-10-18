import { NextRequest } from 'next/server';

jest.mock('@/lib/db', () => ({
  prisma: {
    world: { findMany: jest.fn() },
    universe: { findMany: jest.fn() },
    friendship: { findUnique: jest.fn() },
    roomAccess: { findMany: jest.fn() },
  },
}));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn() }));
jest.mock('@/lib/system-user', () => ({ hiddenSystemOwnerId: jest.fn().mockResolvedValue(null), notSystemWorld: () => ({}) }));
jest.mock('@/lib/role-access', () => ({ ...jest.requireActual('@/lib/role-access'), accessForMany: jest.fn() }));

import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { accessForMany } from '@/lib/role-access';
import { GET } from '@/app/api/admin/users/[id]/worlds/route';

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;
const call = (person = 'person') => GET(new NextRequest(`http://localhost/api/admin/users/${person}/worlds`), { params: Promise.resolve({ id: person }) });

/** What someone holds: the owner, nothing, or an inviting role in the worlds given. */
const holding = (kind: 'owner' | 'none' | string[]) => {
  const { computeAccess } = jest.requireActual('@/lib/role-access');
  const { flag } = jest.requireActual('@/lib/permissions');
  const roles = Array.isArray(kind) ? [{ key: 'greeter', position: 10, permissions: flag('INVITE_AND_REMOVE'), allWorlds: false, worldIds: kind }] : [];
  return computeAccess({
    universeId: 'u', worldIds: ['hq', 'campus'], full: kind === 'owner', isOwner: kind === 'owner', everyone: BigInt(0), member: BigInt(0),
    membership: { allWorlds: true, worldIds: [] }, roles,
  });
};

beforeEach(() => {
  jest.clearAllMocks();
  (getSessionUser as jest.Mock).mockResolvedValue({ id: 'me', uuid: 'uuid-me', email: null, name: 'Me', tags: [], isSuperAdmin: false });
  db.world.findMany.mockResolvedValue([]);
  db.universe.findMany.mockResolvedValue([{ id: 'u1', name: 'BAWES' }, { id: 'u2', name: 'Other' }]);
  db.friendship.findUnique.mockResolvedValue(null);
  db.roomAccess.findMany.mockResolvedValue([]);
  (accessForMany as jest.Mock).mockImplementation(async (_db: unknown, ids: string[]) => new Map(ids.map((id) => [id, holding('owner')])));
});

it('offers the universes where you may invite people, and only to people not in them yet', async () => {
  (accessForMany as jest.Mock).mockImplementation(async (_db: unknown, ids: string[]) => new Map(ids.map((id) => [id, id === 'u1' ? holding(['hq']) : holding('none')])));
  const body = await (await call()).json();
  expect(body.universes).toEqual([{ id: 'u1', name: 'BAWES', visit: null }]);
  expect(body.friend).toBe(false);
  const where = db.universe.findMany.mock.calls[0][0].where;
  // Yours, or ones you joined; never one the person owns, is in, or has an invitation to
  expect(where.OR).toEqual([{ ownerId: 'me' }, { members: { some: { userId: 'me' } } }]);
  expect(where.NOT).toEqual([
    { ownerId: 'person' },
    { members: { some: { userId: 'person' } } },
    { membershipInvitations: { some: { invitedUserId: 'person', status: 'pending' } } },
    { worlds: { some: { membershipInvitations: { some: { invitedUserId: 'person', status: 'pending' } } } } },
  ]);
});

it('offers nothing on your own profile', async () => {
  const body = await (await call('me')).json();
  expect(body.universes).toEqual([]);
  expect(db.universe.findMany).not.toHaveBeenCalled();
});

it('offers every universe to a super admin, who may invite everywhere', async () => {
  (getSessionUser as jest.Mock).mockResolvedValue({ id: 'root', uuid: 'uuid-root', email: null, name: 'Root', tags: [], isSuperAdmin: true });
  await call();
  expect(db.universe.findMany.mock.calls[0][0].where.OR).toBeUndefined();
});

it('says whether they are your friend and when and where they last came into each universe, for the line under their name', async () => {
  db.friendship.findUnique.mockResolvedValue({ status: 'accepted' });
  db.roomAccess.findMany.mockResolvedValue([{ universeId: 'u1', accessedAt: new Date('2026-10-16T10:00:00Z'), room: { name: 'Lobby' }, world: { name: 'HQ' } }]);
  const body = await (await call()).json();
  expect(body.friend).toBe(true);
  expect(body.universes[0].visit).toEqual({ at: '2026-10-16T10:00:00.000Z', room: { name: 'Lobby' }, world: { name: 'HQ' } });
  expect(db.roomAccess.findMany.mock.calls[0][0].where).toEqual({ universeId: { in: ['u1', 'u2'] }, userId: 'person' });
  // A request that is still pending is not a friend
  db.friendship.findUnique.mockResolvedValue({ status: 'pending' });
  expect((await (await call()).json()).friend).toBe(false);
});


it('asks for access and for visits once, however many universes there are', async () => {
  db.universe.findMany.mockResolvedValue(Array.from({ length: 30 }, (_, n) => ({ id: `u${n}`, name: `Universe ${n}` })));
  const body = await (await call()).json();
  expect(body.universes).toHaveLength(30);
  expect(accessForMany).toHaveBeenCalledTimes(1);
  expect(db.roomAccess.findMany).toHaveBeenCalledTimes(1);
  // Newest first, one row for each universe
  expect(db.roomAccess.findMany.mock.calls[0][0]).toMatchObject({ orderBy: { accessedAt: 'desc' }, distinct: ['universeId'] });
});

it('asks for no visits when no universe passes', async () => {
  (accessForMany as jest.Mock).mockImplementation(async (_db: unknown, ids: string[]) => new Map(ids.map((id) => [id, holding('none')])));
  expect((await (await call()).json()).universes).toEqual([]);
  expect(db.roomAccess.findMany).not.toHaveBeenCalled();
});
