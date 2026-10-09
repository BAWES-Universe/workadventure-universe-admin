import { NextRequest } from 'next/server';
import { GET } from '@/app/api/admin/rooms/[id]/members/[userId]/route';
import { prisma } from '@/lib/db';
import { accessDetailFor, canManageWorldMembers, getViewer } from '@/lib/access-scope';

jest.mock('@/lib/db', () => ({ prisma: {
  room: { findUnique: jest.fn() },
  user: { findUnique: jest.fn() },
  worldMember: { findUnique: jest.fn() },
  membershipInvitation: { findFirst: jest.fn() },
} }));
jest.mock('@/lib/access-scope', () => ({
  getViewer: jest.fn(), accessDetailFor: jest.fn(), canManageWorldMembers: jest.fn(),
  viewerUserId: (viewer: { kind: string; user?: { id: string } }) => viewer.kind === 'user' ? viewer.user?.id : null,
  unauthorizedResponse: () => new Response('{}', { status: 401 }),
  forbiddenResponse: () => new Response('{}', { status: 403 }),
}));

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;
const call = () => GET(new NextRequest('http://localhost/api/admin/rooms/r1/members/person'), {
  params: Promise.resolve({ id: 'r1', userId: 'person' }),
});

beforeEach(() => {
  jest.resetAllMocks();
  (getViewer as jest.Mock).mockResolvedValue({ kind: 'user', user: { id: 'manager' } });
  (accessDetailFor as jest.Mock).mockResolvedValue('manager');
  (canManageWorldMembers as jest.Mock).mockResolvedValue(true);
  db.room.findUnique.mockResolvedValue({ world: { id: 'w1', name: 'HQ', universe: { ownerId: 'owner' } } });
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
  expect(await response.json()).toEqual({ world: { id: 'w1', name: 'HQ' }, status: 'none', tags: [], canInvite: true });
  expect(accessDetailFor).toHaveBeenCalledWith(expect.anything(), { roomId: 'r1' });
  expect(db.worldMember.findUnique).toHaveBeenCalledWith({ where: { userId_worldId: { userId: 'person', worldId: 'w1' } }, select: { tags: true } });
  expect(db.membershipInvitation.findFirst).toHaveBeenCalledWith({ where: { worldId: 'w1', invitedUserId: 'person', status: 'pending' }, select: { id: true } });
  expect(canManageWorldMembers).toHaveBeenCalledWith('manager', 'w1');
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
  db.room.findUnique.mockResolvedValue({ world: { id: 'w1', name: 'HQ', universe: { ownerId: 'person' } } });
  expect(await (await call()).json()).toMatchObject({ status: 'owner', canInvite: false });
});

it('lets editors and privileged readers see status without granting invitation permission', async () => {
  (canManageWorldMembers as jest.Mock).mockResolvedValue(false);
  expect(await (await call()).json()).toMatchObject({ status: 'none', canInvite: false });
  (getViewer as jest.Mock).mockResolvedValue({ kind: 'admin-token' });
  (canManageWorldMembers as jest.Mock).mockClear();
  expect(await (await call()).json()).toMatchObject({ canInvite: false });
  expect(canManageWorldMembers).not.toHaveBeenCalled();
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
