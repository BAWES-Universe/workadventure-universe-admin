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

/** What someone holds: the owner, nothing, an inviting role in the worlds given, or a role that only gives roles. */
const holding = (kind: 'owner' | 'none' | 'give-roles' | string[]) => {
  const { computeAccess } = jest.requireActual('@/lib/role-access');
  const { flag } = jest.requireActual('@/lib/permissions');
  const roles = Array.isArray(kind)
    ? [{ key: 'greeter', position: 10, permissions: flag('INVITE_AND_REMOVE'), allWorlds: false, worldIds: kind }]
    : kind === 'give-roles'
      ? [{ key: 'mod', position: 10, permissions: flag('GIVE_ROLES'), allWorlds: true, worldIds: [] }]
      : [];
  return computeAccess({
    universeId: 'u', worldIds: ['hq', 'campus'], full: kind === 'owner', isOwner: kind === 'owner', everyone: BigInt(0), member: BigInt(0),
    membership: { allWorlds: true, worldIds: [] }, roles,
  });
};

/** An invitation still waiting, as the route selects it. */
const waiting = (by = { id: 'me', name: 'Me' }) => ({
  id: 'inv1', universeId: 'u', worldId: 'hq', invitedAt: new Date('2026-10-20T08:00:00Z'), roleIds: ['r1'], allWorlds: true, worldIds: [] as string[], invitedBy: by,
});
/** An invitation sent before roles: no universe, one world, no roles. */
const legacyWaiting = () => ({ ...waiting({ id: 'other', name: 'Sara' }), universeId: null, roleIds: [] as string[], allWorlds: false, worldIds: [] as string[] });

/** A universe row as the route selects it: whether the person owns it, is in it, or has an invitation to it or to one of its worlds. */
const universe = (id: string, name: string, person: { owner?: boolean; member?: boolean | number; invited?: boolean | { id: string; name: string }; invitedToWorld?: boolean } = {}) => ({
  id,
  name,
  ownerId: person.owner ? 'person' : 'someone',
  // A member of the world hq, with no roles or with a role at the position given
  members: person.member
    ? [{ id: 'm', allWorlds: false, worldIds: ['hq'], roles: typeof person.member === 'number' ? [{ allWorlds: false, worldIds: ['hq'], role: { position: person.member } }] : [] }]
    : [],
  // The roles you could give here: one below the greeter and moderator
  roles: [{ id: 'low', position: 5 }],
  membershipInvitations: person.invited ? [waiting(typeof person.invited === 'object' ? person.invited : undefined)] : [],
  worlds: person.invitedToWorld ? [{ membershipInvitations: [legacyWaiting()] }] : [],
});

/** What you hold in each universe, by id. */
const youHold = (byId: Record<string, ReturnType<typeof holding>>) =>
  (accessForMany as jest.Mock).mockImplementation(async (_db: unknown, ids: string[]) => new Map(ids.map((id) => [id, byId[id] ?? holding('none')])));

beforeEach(() => {
  jest.clearAllMocks();
  (getSessionUser as jest.Mock).mockResolvedValue({ id: 'me', uuid: 'uuid-me', email: null, name: 'Me', tags: [], isSuperAdmin: false });
  db.world.findMany.mockResolvedValue([]);
  db.universe.findMany.mockResolvedValue([universe('u1', 'BAWES'), universe('u2', 'Other')]);
  db.friendship.findUnique.mockResolvedValue(null);
  db.roomAccess.findMany.mockResolvedValue([]);
  (accessForMany as jest.Mock).mockImplementation(async (_db: unknown, ids: string[]) => new Map(ids.map((id) => [id, holding('owner')])));
});

it('offers the universes where you may invite people, and only to people not in them yet', async () => {
  youHold({ u1: holding(['hq']) });
  const body = await (await call()).json();
  expect(body.universes).toEqual([{ id: 'u1', name: 'BAWES', visit: null }]);
  expect(body.taken).toEqual([]);
  expect(body.friend).toBe(false);
  const { where, select } = db.universe.findMany.mock.calls[0][0];
  // Yours, or ones you joined; whether the person is in each, or has an invitation waiting, comes with it
  expect(where.OR).toEqual([{ ownerId: 'me' }, { members: { some: { userId: 'me' } } }]);
  expect(select.members.where).toEqual({ userId: 'person' });
  expect(select.membershipInvitations.where).toEqual({ invitedUserId: 'person', status: 'pending' });
  // An invitation sent the old way to one of its worlds counts too
  expect(select.worlds.where).toEqual({ membershipInvitations: { some: { invitedUserId: 'person', status: 'pending' } } });
  expect(select.worlds.take).toBe(1);
});

it('lists your universes the person is in or is invited to (to the universe or one of its worlds) as taken, never as offered', async () => {
  db.universe.findMany.mockResolvedValue([
    universe('u1', 'BAWES', { member: true }),
    universe('u2', 'Sandbox'),
    universe('u3', 'Cup', { invited: true }),
    universe('u4', 'Theirs', { owner: true }),
    universe('u5', 'Club', { invitedToWorld: true }),
  ]);
  const body = await (await call()).json();
  expect(body.universes).toEqual([{ id: 'u2', name: 'Sandbox', visit: null }]);
  expect(body.taken.map(({ id, name, status }: { id: string; name: string; status: string }) => ({ id, name, status }))).toEqual([
    { id: 'u1', name: 'BAWES', status: 'member' },
    { id: 'u3', name: 'Cup', status: 'invited' },
    { id: 'u5', name: 'Club', status: 'invited' },
  ]);
});

it('says who sent a waiting invitation, when, and what it would give, whether it names the universe or one of its worlds', async () => {
  db.universe.findMany.mockResolvedValue([
    universe('u3', 'Cup', { invited: true }),
    universe('u5', 'Club', { invitedToWorld: true }),
    universe('u6', 'Team', { invited: { id: 'sara', name: 'Sara' } }),
  ]);
  const { taken } = await (await call()).json();
  const at = '2026-10-20T08:00:00.000Z';
  const worlds = { allWorlds: true, worldIds: [] };
  expect(taken[0].invitation).toEqual({ id: 'inv1', at, by: { name: 'Me', you: true }, roleIds: ['r1'], worlds });
  // Sent before roles, to one world: that world is what it gives
  expect(taken[1].invitation).toEqual({ id: 'inv1', at, by: { name: 'Sara', you: false }, roleIds: [], worlds: { allWorlds: false, worldIds: ['hq'] } });
  expect(taken[2].invitation.by).toEqual({ name: 'Sara', you: false });
});

it('lists a waiting invitation only where you may invite (to take it back); giving roles alone does not', async () => {
  db.universe.findMany.mockResolvedValue([universe('u1', 'BAWES', { invited: true }), universe('u2', 'Cup', { invited: true })]);
  youHold({ u1: holding(['hq']), u2: holding('give-roles') });
  const { universes, taken } = await (await call()).json();
  expect(universes).toEqual([]);
  expect(taken.map((row: { id: string }) => row.id)).toEqual(['u1']);
});

it('offers a person who is not in a universe only where you may invite, never where you only give roles', async () => {
  db.universe.findMany.mockResolvedValue([universe('u1', 'BAWES'), universe('u2', 'Cup')]);
  youHold({ u1: holding('give-roles'), u2: holding(['hq']) });
  const { universes, taken } = await (await call()).json();
  expect(universes.map((row: { id: string }) => row.id)).toEqual(['u2']);
  expect(taken).toEqual([]);
});

it('lists a member where you may invite or give roles, so the card can say Roles or Membership, and not where you may do neither', async () => {
  db.universe.findMany.mockResolvedValue([universe('u1', 'A', { member: true }), universe('u2', 'B', { member: true }), universe('u3', 'C', { member: true })]);
  youHold({ u1: holding('give-roles'), u2: holding(['hq']) });
  const { taken } = await (await call()).json();
  expect(taken.map((row: { id: string; status: string }) => [row.id, row.status])).toEqual([['u1', 'member'], ['u2', 'member']]);
});

it('lists a member only where there is something you may change about them: not where they outrank you', async () => {
  db.universe.findMany.mockResolvedValue([universe('u1', 'A', { member: 20 }), universe('u2', 'B', { member: 3 }), universe('u3', 'C', { owner: true })]);
  youHold({ u1: holding(['hq']), u2: holding(['hq']), u3: holding(['hq']) });
  const { taken } = await (await call()).json();
  // In A they are above your role; in B below it; in C they own it
  expect(taken.map((row: { id: string }) => row.id)).toEqual(['u2']);
});

it('never lists a universe you can’t invite people to, even when the person is in it', async () => {
  db.universe.findMany.mockResolvedValue([universe('u1', 'BAWES', { member: true })]);
  (accessForMany as jest.Mock).mockImplementation(async (_db: unknown, ids: string[]) => new Map(ids.map((id) => [id, holding('none')])));
  const body = await (await call()).json();
  expect(body.universes).toEqual([]);
  expect(body.taken).toEqual([]);
});

it('offers nothing on your own profile', async () => {
  const body = await (await call('me')).json();
  expect(body.universes).toEqual([]);
  expect(db.universe.findMany).not.toHaveBeenCalled();
});

it('offers a super admin only the universes they own or joined and may invite to: people handle their own universes', async () => {
  (getSessionUser as jest.Mock).mockResolvedValue({ id: 'root', uuid: 'uuid-root', email: null, name: 'Root', tags: [], isSuperAdmin: true });
  await call();
  expect(db.universe.findMany.mock.calls[0][0].where.OR).toEqual([{ ownerId: 'root' }, { members: { some: { userId: 'root' } } }]);
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
  db.universe.findMany.mockResolvedValue(Array.from({ length: 30 }, (_, n) => universe(`u${n}`, `Universe ${n}`)));
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
