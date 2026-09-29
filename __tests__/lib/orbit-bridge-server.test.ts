jest.mock('@/lib/access-scope', () => ({
  canManageWorldMembers: jest.fn(),
  isPrivileged: (viewer: { kind: string; user?: { isSuperAdmin?: boolean } }) =>
    viewer.kind === 'admin-token' || viewer.user?.isSuperAdmin === true,
  viewerUserId: (viewer: { kind: string; user?: { id: string } }) => (viewer.kind === 'user' ? viewer.user!.id : null),
}));

jest.mock('@/lib/db', () => ({ prisma: { user: { findUnique: jest.fn() } } }));

import { canManageWorldMembers, type Viewer } from '@/lib/access-scope';
import { prisma } from '@/lib/db';
import { resolveNavigateIntent } from '@/lib/orbit-bridge-server';

const member = { kind: 'user', user: { id: 'user-1', isSuperAdmin: false } } as unknown as Viewer;
const worldId = '0f6b8d4e-2a1c-4d3b-9e8f-7a6b5c4d3e2f';
const canManage = canManageWorldMembers as jest.MockedFunction<typeof canManageWorldMembers>;
const findUser = prisma.user.findUnique as unknown as jest.Mock;

describe('resolveNavigateIntent', () => {
  beforeEach(() => {
    canManage.mockReset();
    findUser.mockReset();
  });

  it('lands on New universe', async () => {
    await expect(resolveNavigateIntent(member, 'new-universe', undefined)).resolves.toBe('/admin/universes/new');
  });

  it('opens your profile, ready to edit', async () => {
    await expect(resolveNavigateIntent(member, 'visit-card', undefined)).resolves.toBe('/admin/you?edit=profile');
  });

  it('falls back to home for an unknown intent, with no error', async () => {
    await expect(resolveNavigateIntent(member, 'delete-everything', undefined)).resolves.toBe('/admin');
  });

  it("opens a world's members for someone who manages them", async () => {
    canManage.mockResolvedValue(true);
    await expect(resolveNavigateIntent(member, 'world-members', { worldId })).resolves.toBe(`/admin/worlds/${worldId}?tab=members`);
    expect(canManage).toHaveBeenCalledWith('user-1', worldId);
  });

  it("sends someone who may not manage a world's members home", async () => {
    canManage.mockResolvedValue(false);
    await expect(resolveNavigateIntent(member, 'world-members', { worldId })).resolves.toBe('/admin');
  });

  it('sends bad parameters home without asking the database', async () => {
    await expect(resolveNavigateIntent(member, 'world-members', { worldId: '../users' })).resolves.toBe('/admin');
    await expect(resolveNavigateIntent(member, 'world-members', undefined)).resolves.toBe('/admin');
    expect(canManage).not.toHaveBeenCalled();
  });

  it("opens someone's profile page from their game id", async () => {
    findUser.mockResolvedValue({ id: 'user-2', isGuest: false });
    await expect(resolveNavigateIntent(member, 'user-profile', { userUuid: 'ada@example.com' })).resolves.toBe('/admin/users/user-2');
    expect(findUser).toHaveBeenCalledWith({ where: { uuid: 'ada@example.com' }, select: { id: true, isGuest: true } });
  });

  it('opens You for your own profile', async () => {
    findUser.mockResolvedValue({ id: 'user-1', isGuest: false });
    await expect(resolveNavigateIntent(member, 'user-profile', { userUuid: 'me' })).resolves.toBe('/admin/you');
  });

  it('sends guests, unknown players and bad parameters home', async () => {
    findUser.mockResolvedValue({ id: 'user-3', isGuest: true });
    await expect(resolveNavigateIntent(member, 'user-profile', { userUuid: 'guest' })).resolves.toBe('/admin');
    findUser.mockResolvedValue(null);
    await expect(resolveNavigateIntent(member, 'user-profile', { userUuid: 'nobody' })).resolves.toBe('/admin');
    findUser.mockReset();
    await expect(resolveNavigateIntent(member, 'user-profile', undefined)).resolves.toBe('/admin');
    await expect(resolveNavigateIntent(member, 'user-profile', { userUuid: '' })).resolves.toBe('/admin');
    expect(findUser).not.toHaveBeenCalled();
  });
});
