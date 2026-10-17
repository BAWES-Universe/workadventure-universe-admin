import { NextRequest } from 'next/server';
import { GET } from '@/app/api/admin/rooms/[id]/members/[userId]/route';
import { prisma } from '@/lib/db';
import { accessDetailFor, getViewer } from '@/lib/access-scope';
import { accessFor } from '@/lib/role-access';

jest.mock('@/lib/db', () => ({ prisma: {
  room: { findUnique: jest.fn() },
  user: { findUnique: jest.fn() },
  worldMember: { findUnique: jest.fn() },
  membershipInvitation: { findFirst: jest.fn() },
} }));
jest.mock('@/lib/access-scope', () => ({
  getViewer: jest.fn(), accessDetailFor: jest.fn(),
  viewerUserId: (viewer: { kind: string; user?: { id: string } }) => viewer.kind === 'user' ? viewer.user?.id : null,
  unauthorizedResponse: () => new Response('{}', { status: 401 }),
  forbiddenResponse: () => new Response('{}', { status: 403 }),
}));

jest.mock('@/lib/role-access', () => ({ ...jest.requireActual('@/lib/role-access'), accessFor: jest.fn() }));

/** What someone holds in the universe: the owner, nothing, or an inviting role that works in the worlds given. */
const holding = (kind: 'owner' | 'none' | string[]) => {
  const { computeAccess } = jest.requireActual('@/lib/role-access');
  const { flag } = jest.requireActual('@/lib/permissions');
  const worldIds = ['w1', 'w2'];
  const roles = Array.isArray(kind) ? [{ key: 'greeter', position: 10, permissions: flag('INVITE_AND_REMOVE'), allWorlds: false, worldIds: kind }] : [];
  return computeAccess({
    universeId: 'u1', worldIds, full: kind === 'owner', isOwner: kind === 'owner', everyone: BigInt(0), member: BigInt(0),
    membership: { allWorlds: true, worldIds: [] }, roles,
  });
};

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;
const call = () => GET(new NextRequest('http://localhost/api/admin/rooms/r1/members/person'), {
  params: Promise.resolve({ id: 'r1', userId: 'person' }),
});

beforeEach(() => {
  jest.resetAllMocks();
  (getViewer as jest.Mock).mockResolvedValue({ kind: 'user', user: { id: 'manager' } });
  (accessDetailFor as jest.Mock).mockResolvedValue('manager');
  (accessFor as jest.Mock).mockResolvedValue(holding('owner'));
  db.room.findUnique.mockResolvedValue({ world: { id: 'w1', name: 'HQ', universeId: 'u1', universe: { ownerId: 'owner' } } });
  db.user.findUnique.mockResolvedValue({ isGuest: false });
  db.worldMember.findUnique.mockResolvedValue(null);
  db.membershipInvitation.findFirst.mockResolvedValue(null);
});

it('requires authentication and visitor-detail permission before querying membership', async () => {
  (getViewer as jest.Mock).mockResolvedValue(null);
  expect((await call()).status).toBe(401);
  (getViewer as jest.Mock).mockResolvedValue({ kind: 'user', user: { id: 'stranger' } });
  (accessDetailFor as jest.Mock).mockResolvedValue('minimal');
  expect((await call()).status).toBe(403);
  expect(db.room.findUnique).not.toHaveBeenCalled();
  expect(db.worldMember.findUnique).not.toHaveBeenCalled();
});

it('looks up current membership and pending invites in the room’s world, without exposing user details', async () => {
  const response = await call();
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(await response.json()).toEqual({ world: { id: 'w1', name: 'HQ' }, universeId: 'u1', status: 'none', tags: [], canInvite: true });
  expect(accessDetailFor).toHaveBeenCalledWith(expect.anything(), { roomId: 'r1' });
  expect(db.worldMember.findUnique).toHaveBeenCalledWith({ where: { userId_worldId: { userId: 'person', worldId: 'w1' } }, select: { tags: true } });
  expect(db.membershipInvitation.findFirst).toHaveBeenCalledWith({ where: { OR: [{ worldId: 'w1' }, { universeId: 'u1' }], invitedUserId: 'person', status: 'pending' }, select: { id: true } });
  expect(accessFor).toHaveBeenCalledWith(expect.anything(), 'u1', { id: 'manager' });
});

it('shows current roles, giving membership precedence over an old pending invite', async () => {
  db.worldMember.findUnique.mockResolvedValue({ tags: ['editor'] });
  db.membershipInvitation.findFirst.mockResolvedValue({ id: 'invite' });
  expect(await (await call()).json()).toMatchObject({ status: 'member', tags: ['editor'], canInvite: false });
});

it('does not invite a pending invitee, guest account, or universe owner', async () => {
  db.membershipInvitation.findFirst.mockResolvedValue({ id: 'invite' });
  expect(await (await call()).json()).toMatchObject({ status: 'invited', canInvite: false });
  db.user.findUnique.mockResolvedValue({ isGuest: true });
  expect(await (await call()).json()).toMatchObject({ status: 'guest', canInvite: false });
  db.user.findUnique.mockResolvedValue({ isGuest: false });
  db.room.findUnique.mockResolvedValue({ world: { id: 'w1', name: 'HQ', universeId: 'u1', universe: { ownerId: 'person' } } });
  expect(await (await call()).json()).toMatchObject({ status: 'owner', canInvite: false });
});

it('offers the invite only where the viewer’s role has Invite and remove people', async () => {
  (accessFor as jest.Mock).mockResolvedValue(holding(['w1']));
  expect(await (await call()).json()).toMatchObject({ status: 'none', canInvite: true });
  (accessFor as jest.Mock).mockResolvedValue(holding(['w2']));
  expect(await (await call()).json()).toMatchObject({ status: 'none', canInvite: false });
  (accessFor as jest.Mock).mockResolvedValue(holding('none'));
  expect(await (await call()).json()).toMatchObject({ status: 'none', canInvite: false });
});

it('lets privileged readers see status without a session user to invite as', async () => {
  (getViewer as jest.Mock).mockResolvedValue({ kind: 'admin-token' });
  (accessFor as jest.Mock).mockClear();
  expect(await (await call()).json()).toMatchObject({ canInvite: false });
  expect(accessFor).not.toHaveBeenCalled();
});

it('returns 404 for a missing room or user', async () => {
  db.user.findUnique.mockResolvedValue(null);
  expect((await call()).status).toBe(404);
  db.room.findUnique.mockResolvedValue(null);
  expect((await call()).status).toBe(404);
  expect(db.worldMember.findUnique).not.toHaveBeenCalled();
});

it('handles a database failure', async () => {
  const log = jest.spyOn(console, 'error').mockImplementation(() => {});
  db.room.findUnique.mockRejectedValue(new Error('offline'));
  expect((await call()).status).toBe(500);
  log.mockRestore();
});
