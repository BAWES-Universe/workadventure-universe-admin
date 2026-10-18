/**
 * What the Members screens read (#314): the members list filters by world, a member's page carries their last visit,
 * the invite sheet's people exclude members, and pending invitations can be listed and taken back.
 */
import { NextRequest } from 'next/server';
import { computeAccess } from '@/lib/role-access';
import { flag, combine } from '@/lib/permissions';

jest.mock('@/lib/db', () => ({
  prisma: {
    universeMember: { count: jest.fn(), findMany: jest.fn(), findUnique: jest.fn() },
    user: { findUnique: jest.fn(), findMany: jest.fn() },
    universe: { findUnique: jest.fn() },
    role: { findMany: jest.fn() },
    roomAccess: { aggregate: jest.fn(), findMany: jest.fn(), groupBy: jest.fn() },
    membershipInvitation: { findMany: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
  },
}));
jest.mock('@/lib/woka-avatar', () => ({ withWokas: jest.fn(async (records: unknown[]) => records) }));
jest.mock('@/lib/friends', () => ({
  ...jest.requireActual('@/lib/friends'),
  listFriends: jest.fn(),
  searchPeople: jest.fn(),
}));
jest.mock('@/lib/universe-route', () => ({ ...jest.requireActual('@/lib/universe-route'), universeContext: jest.fn() }));

import { prisma } from '@/lib/db';
import { listFriends, searchPeople } from '@/lib/friends';
import { universeContext } from '@/lib/universe-route';
import { GET as listMembers } from '@/app/api/admin/universes/[id]/members/route';
import { GET as getMember } from '@/app/api/admin/universes/[id]/members/[userId]/route';
import { GET as candidates } from '@/app/api/admin/universes/[id]/invite-candidates/route';
import { GET as listInvitations } from '@/app/api/admin/universes/[id]/invitations/route';
import { DELETE as cancelInvitation } from '@/app/api/admin/universes/[id]/invitations/[invitationId]/route';

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;
const context = universeContext as jest.Mock;
const friends = listFriends as jest.Mock;
const search = searchPeople as jest.Mock;

const UNIVERSE = { id: 'u1', name: 'BAWES', ownerId: 'owner' };
const WORLDS = ['hq', 'campus'];
const ZERO = BigInt(0);

function asViewer(kind: 'owner' | 'inviter' | 'hq-inviter' | 'plain') {
  const inviter = combine(flag('INVITE_AND_REMOVE'));
  const access = computeAccess({
    universeId: 'u1',
    worldIds: WORLDS,
    full: kind === 'owner',
    isOwner: kind === 'owner',
    everyone: ZERO,
    member: ZERO,
    membership: kind === 'owner' ? null : { allWorlds: true, worldIds: [] },
    roles:
      kind === 'inviter'
        ? [{ key: 'helper', position: 11, permissions: inviter, allWorlds: true, worldIds: [] }]
        : kind === 'hq-inviter'
          ? [{ key: 'helper', position: 11, permissions: inviter, allWorlds: false, worldIds: ['hq'] }]
          : [],
  });
  const user = { id: kind === 'owner' ? 'owner' : 'me', uuid: `uuid-${kind}`, email: `${kind}@example.test`, name: kind, tags: [], isSuperAdmin: false };
  context.mockResolvedValue({ ok: true, user, access, universe: UNIVERSE });
}

const request = (path: string, init?: ConstructorParameters<typeof NextRequest>[1]) => new NextRequest(`http://localhost${path}`, init);
const params = <Extra extends Record<string, string> = Record<never, string>>(extra?: Extra) => ({ params: Promise.resolve({ id: 'u1', ...extra } as { id: string } & Extra) });

beforeEach(() => {
  jest.clearAllMocks();
  db.universeMember.count.mockResolvedValue(0);
  db.universeMember.findMany.mockResolvedValue([]);
  db.universeMember.findUnique.mockResolvedValue(null);
  db.user.findUnique.mockResolvedValue({ id: 'owner', name: 'Khalid', email: 'khalid@example.test' });
  db.user.findMany.mockResolvedValue([]);
  db.universe.findUnique.mockResolvedValue({ createdAt: new Date('2026-10-01T00:00:00Z') });
  db.role.findMany.mockResolvedValue([]);
  db.roomAccess.aggregate.mockResolvedValue({ _max: { accessedAt: null } });
  db.roomAccess.findMany.mockResolvedValue([]);
  db.roomAccess.groupBy.mockResolvedValue([]);
  db.membershipInvitation.findMany.mockResolvedValue([]);
  friends.mockResolvedValue({ friends: [], incoming: [], outgoing: [], blocked: [] });
  search.mockResolvedValue([]);
});

describe('GET members?worldId=', () => {
  it('keeps people whose membership or a role reaches that world', async () => {
    asViewer('owner');
    const response = await listMembers(request('/api/admin/universes/u1/members?worldId=hq'), params());
    expect(response.status).toBe(200);
    const where = db.universeMember.findMany.mock.calls[0][0].where;
    expect(where.OR).toEqual([
      { allWorlds: true },
      { worldIds: { has: 'hq' } },
      { roles: { some: { OR: [{ allWorlds: true }, { worldIds: { has: 'hq' } }] } } },
    ]);
  });

  it('sends the owner with their face and whether they joined, so the screens can list them first', async () => {
    asViewer('owner');
    const body = await (await listMembers(request('/api/admin/universes/u1/members'), params())).json();
    expect(body.owner).toMatchObject({ userId: 'owner', name: 'Khalid', email: 'khalid@example.test', joined: false });
  });

  it('keeps the owner’s email from people who do not manage members', async () => {
    asViewer('plain');
    const body = await (await listMembers(request('/api/admin/universes/u1/members'), params())).json();
    expect(body.owner.email).toBeNull();
  });
});

describe('GET members/[userId]', () => {
  const row = (userId: string) => ({
    id: `m-${userId}`,
    userId,
    universeId: 'u1',
    allWorlds: true,
    worldIds: [],
    joinedAt: new Date('2026-10-02T00:00:00Z'),
    user: { id: userId, name: 'Sara', email: 'sara@example.test' },
    roles: [],
  });

  it('adds when they last came into any room of the universe, from the room visits', async () => {
    asViewer('owner');
    db.universeMember.findUnique.mockResolvedValue(row('sara'));
    db.roomAccess.aggregate.mockResolvedValue({ _max: { accessedAt: new Date('2026-10-16T10:00:00Z') } });
    const body = await (await getMember(request('/api/admin/universes/u1/members/sara'), params({ userId: 'sara' }))).json();
    expect(db.roomAccess.aggregate).toHaveBeenCalledWith({ where: { universeId: 'u1', userId: 'sara' }, _max: { accessedAt: true } });
    expect(body.member.lastVisitedAt).toBe('2026-10-16T10:00:00.000Z');
  });

  it('says null when they never came', async () => {
    asViewer('owner');
    db.universeMember.findUnique.mockResolvedValue(row('sara'));
    const body = await (await getMember(request('/api/admin/universes/u1/members/sara'), params({ userId: 'sara' }))).json();
    expect(body.member.lastVisitedAt).toBeNull();
  });

  it('opens the owner’s page even though they never joined, with nothing to give and nothing to remove', async () => {
    asViewer('owner');
    const body = await (await getMember(request('/api/admin/universes/u1/members/owner'), params({ userId: 'owner' }))).json();
    expect(body.member).toMatchObject({ userId: 'owner', isOwner: true, roles: [] });
    expect(body.can).toMatchObject({ giveRoleIds: [], remove: false });
  });

  it('is a 404 for someone who is neither a member nor the owner', async () => {
    asViewer('owner');
    const response = await getMember(request('/api/admin/universes/u1/members/nobody'), params({ userId: 'nobody' }));
    expect(response.status).toBe(404);
  });
});

describe('GET invite-candidates', () => {
  const visit = (userId: string, name: string, at: string, room = 'Lobby', world = 'HQ') => ({
    userId,
    accessedAt: new Date(at),
    room: { id: `room-${room}`, name: room },
    world: { id: `w-${world}`, name: world },
    user: { name },
  });

  it('needs the permission to invite', async () => {
    asViewer('plain');
    const response = await candidates(request('/api/admin/universes/u1/invite-candidates'), params());
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe('Needs Invite and remove people');
  });

  it('lists this week’s visitors once each, then friends who did not visit, and leaves out members and pending invitations', async () => {
    asViewer('inviter');
    // Each person's newest visit first, then those visits
    db.roomAccess.groupBy.mockResolvedValueOnce([
      { userId: 'hanan', _max: { accessedAt: new Date('2026-10-16T10:00:00Z') } },
      { userId: 'sara', _max: { accessedAt: new Date('2026-10-16T09:00:00Z') } },
      { userId: 'jana', _max: { accessedAt: new Date('2026-10-16T08:00:00Z') } },
      { userId: 'reem', _max: { accessedAt: new Date('2026-10-14T08:00:00Z') } },
    ]);
    db.roomAccess.findMany.mockResolvedValue([
      visit('hanan', 'Hanan', '2026-10-16T10:00:00Z'),
      visit('hanan', 'Hanan', '2026-10-15T10:00:00Z'),
      visit('sara', 'Sara', '2026-10-16T09:00:00Z'),
      visit('jana', 'Jana', '2026-10-16T08:00:00Z'),
      visit('reem', 'Reem', '2026-10-14T08:00:00Z'),
    ]);
    friends.mockResolvedValue({ friends: [{ uuid: 'uuid-hanan' }, { uuid: 'uuid-tariq' }, { uuid: 'uuid-sara' }], incoming: [], outgoing: [], blocked: [] });
    db.user.findMany.mockResolvedValue([
      { id: 'hanan', uuid: 'uuid-hanan', name: 'Hanan' },
      { id: 'tariq', uuid: 'uuid-tariq', name: 'Tariq' },
      { id: 'sara', uuid: 'uuid-sara', name: 'Sara' },
    ]);
    db.universeMember.findMany.mockResolvedValue([{ userId: 'sara' }]);
    db.membershipInvitation.findMany.mockResolvedValue([{ invitedUserId: 'jana' }]);

    const body = await (await candidates(request('/api/admin/universes/u1/invite-candidates'), params())).json();
    expect(body.visitors.map((person: { userId: string }) => person.userId)).toEqual(['hanan', 'reem']);
    expect(body.visitors[0]).toMatchObject({ friend: true, room: { name: 'Lobby' }, world: { name: 'HQ' } });
    expect(body.visitors[1].friend).toBe(false);
    expect(body.friends.map((person: { userId: string }) => person.userId)).toEqual(['tariq']);
    expect(body.friends[0].lastVisitedAt).toBeNull();
    // This week only, one row per person, newest first, and never the owner, you, members or people invited already
    const grouped = db.roomAccess.groupBy.mock.calls[0][0];
    expect(grouped).toMatchObject({ by: ['userId'], orderBy: { _max: { accessedAt: 'desc' } }, take: 20 });
    expect(grouped.where.universeId).toBe('u1');
    expect(grouped.where.userId.notIn).toEqual(['me', 'owner']);
    expect(grouped.where.accessedAt.gte).toBeInstanceOf(Date);
    expect(grouped.where.user.AND).toEqual(
      expect.arrayContaining([
        { universeMemberships: { none: { universeId: 'u1' } } },
        { membershipInvitationsReceived: { none: { status: 'pending', OR: [{ universeId: 'u1' }, { world: { universeId: 'u1' } }] } } },
      ]),
    );
    expect(db.roomAccess.findMany.mock.calls[0][0].where.OR).toEqual([
      { userId: 'hanan', accessedAt: new Date('2026-10-16T10:00:00Z') },
      { userId: 'sara', accessedAt: new Date('2026-10-16T09:00:00Z') },
      { userId: 'jana', accessedAt: new Date('2026-10-16T08:00:00Z') },
      { userId: 'reem', accessedAt: new Date('2026-10-14T08:00:00Z') },
    ]);
  });

  it('searches by name with the friends search once two letters are typed, never listing members', async () => {
    asViewer('inviter');
    search.mockResolvedValue([{ uuid: 'uuid-lina', name: 'Lina' }, { uuid: 'uuid-sara', name: 'Sara' }]);
    db.user.findMany.mockResolvedValue([
      { id: 'lina', uuid: 'uuid-lina', name: 'Lina' },
      { id: 'sara', uuid: 'uuid-sara', name: 'Sara' },
    ]);
    db.universeMember.findMany.mockResolvedValue([{ userId: 'sara' }]);
    const body = await (await candidates(request('/api/admin/universes/u1/invite-candidates?q=li'), params())).json();
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ id: 'me' }), 'li');
    expect(body.results.map((person: { userId: string }) => person.userId)).toEqual(['lina']);
  });

  it('does not search for one letter', async () => {
    asViewer('inviter');
    await candidates(request('/api/admin/universes/u1/invite-candidates?q=l'), params());
    expect(search).not.toHaveBeenCalled();
  });
});

describe('invitations list and cancel', () => {
  const pending = {
    id: 'inv1',
    status: 'pending',
    universeId: 'u1',
    allWorlds: false,
    worldIds: ['campus'],
    worldId: 'campus',
    roleIds: [],
    tags: [],
    invitedAt: new Date('2026-10-17T10:00:00Z'),
    invitedUser: { id: 'jana', name: 'Jana', email: 'jana@example.test' },
    invitedBy: { id: 'sara', name: 'Sara' },
  };

  it('lists pending invitations for people who may invite, and nothing for others', async () => {
    asViewer('inviter');
    db.membershipInvitation.findMany.mockResolvedValue([pending]);
    const body = await (await listInvitations(request('/api/admin/universes/u1/invitations'), params())).json();
    expect(body.canCancel).toBe(true);
    expect(body.invitations[0]).toMatchObject({ id: 'inv1', userId: 'jana', worlds: { allWorlds: false, worldIds: ['campus'] }, invitedBy: { name: 'Sara' } });

    asViewer('plain');
    const none = await (await listInvitations(request('/api/admin/universes/u1/invitations'), params())).json();
    expect(none).toEqual({ invitations: [], canCancel: false });
  });

  it('lists only the invitations the viewer could send or take back: every-world ones need the permission everywhere', async () => {
    const campusOnly = { ...pending, id: 'inv-campus' };
    const hqOnly = { ...pending, id: 'inv-hq', worldIds: ['hq'], worldId: 'hq' };
    const everyWorld = { ...pending, id: 'inv-all', allWorlds: true, worldIds: [] };
    const older = { ...pending, id: 'inv-old', universeId: null, allWorlds: false, worldIds: [], worldId: 'campus' };
    db.membershipInvitation.findMany.mockResolvedValue([campusOnly, hqOnly, everyWorld, older]);

    asViewer('hq-inviter');
    const scoped = await (await listInvitations(request('/api/admin/universes/u1/invitations'), params())).json();
    expect(scoped.invitations.map((invitation: { id: string }) => invitation.id)).toEqual(['inv-hq']);
    expect(scoped.canCancel).toBe(true);

    asViewer('inviter');
    const everywhere = await (await listInvitations(request('/api/admin/universes/u1/invitations'), params())).json();
    expect(everywhere.invitations).toHaveLength(4);

    // Nothing they may touch is waiting: no list, and nothing to cancel
    asViewer('hq-inviter');
    db.membershipInvitation.findMany.mockResolvedValue([campusOnly, everyWorld]);
    expect(await (await listInvitations(request('/api/admin/universes/u1/invitations'), params())).json()).toEqual({ invitations: [], canCancel: false });
  });

  it('takes back an invitation, as someone who may invite in the worlds it names', async () => {
    asViewer('inviter');
    db.membershipInvitation.findFirst.mockResolvedValue(pending);
    const response = await cancelInvitation(request('/api/admin/universes/u1/invitations/inv1', { method: 'DELETE' }), params({ invitationId: 'inv1' }));
    expect(response.status).toBe(200);
    expect(db.membershipInvitation.update).toHaveBeenCalledWith({ where: { id: 'inv1' }, data: expect.objectContaining({ status: 'cancelled' }) });
  });

  it('refuses without the permission, and an invitation already answered', async () => {
    asViewer('plain');
    db.membershipInvitation.findFirst.mockResolvedValue(pending);
    const refused = await cancelInvitation(request('/api/admin/universes/u1/invitations/inv1', { method: 'DELETE' }), params({ invitationId: 'inv1' }));
    expect(refused.status).toBe(403);
    expect(db.membershipInvitation.update).not.toHaveBeenCalled();

    asViewer('inviter');
    db.membershipInvitation.findFirst.mockResolvedValue({ ...pending, status: 'accepted' });
    const answered = await cancelInvitation(request('/api/admin/universes/u1/invitations/inv1', { method: 'DELETE' }), params({ invitationId: 'inv1' }));
    expect(answered.status).toBe(400);
  });
});
