/**
 * People handle their own universes: a super admin who has no part in a universe cannot invite people to it, take an
 * invitation back or remove a member, through the real routes. The owner can, and a super admin who holds an inviting
 * role there can, like anyone else.
 */
import { NextRequest } from 'next/server';
import { fromKeys } from '@/lib/permissions';

jest.mock('@/lib/db', () => ({
  prisma: {
    universe: { findUnique: jest.fn() },
    role: { findMany: jest.fn() },
    universeMember: { findUnique: jest.fn() },
    user: { findUnique: jest.fn() },
    membershipInvitation: { findFirst: jest.fn(), update: jest.fn(), create: jest.fn() },
    $transaction: jest.fn(),
  },
}));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn() }));
jest.mock('@/lib/woka-avatar', () => ({ withWokas: jest.fn(async (records: unknown[]) => records) }));

import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { POST as invite } from '@/app/api/admin/universes/[id]/invitations/route';
import { DELETE as cancel } from '@/app/api/admin/universes/[id]/invitations/[invitationId]/route';
import { DELETE as remove } from '@/app/api/admin/universes/[id]/members/[userId]/route';

const db = prisma as unknown as Record<string, Record<string, jest.Mock>> & { $transaction: jest.Mock };
const OTHER = '11111111-1111-4111-8111-111111111111';
const greeterRole = { role: { key: 'greeter', position: 10, permissions: fromKeys(['INVITE_AND_REMOVE']) }, allWorlds: true, worldIds: [] };

/** Who is signed in, and what they hold in the universe: nothing, or an inviting role. */
function signedIn(userId: string, superAdmin: boolean, holds: 'nothing' | 'greeter') {
  (getSessionUser as jest.Mock).mockResolvedValue({ id: userId, uuid: userId, email: `${userId}@example.test`, name: userId, tags: [], isSuperAdmin: superAdmin });
  db.universeMember.findUnique.mockImplementation(async ({ where }: { where: { universeId_userId: { userId: string } } }) => {
    const who = where.universeId_userId.userId;
    if (who === OTHER) return { userId: who, allWorlds: true, worldIds: [], roles: [] };
    if (who === userId && holds === 'greeter') return { userId, allWorlds: true, worldIds: [], roles: [greeterRole] };
    return null;
  });
}

type Handler = (request: NextRequest, context: { params: Promise<never> }) => Promise<Response>;
const call = (handler: unknown, path: string, init: ConstructorParameters<typeof NextRequest>[1] = { method: 'POST' }, extra: Record<string, string> = {}) =>
  (handler as Handler)(new NextRequest(`http://localhost${path}`, init), { params: Promise.resolve({ id: 'u1', ...extra }) as Promise<never> });

const send = () =>
  call(invite, '/api/admin/universes/u1/invitations', { method: 'POST', body: JSON.stringify({ userId: OTHER, roleIds: [], worlds: { allWorlds: true, worldIds: [] } }) });

beforeEach(() => {
  jest.clearAllMocks();
  // A private universe owned by someone else, with two worlds
  db.universe.findUnique.mockResolvedValue({ id: 'u1', name: 'BAWES', ownerId: 'owner', isPublic: false, worlds: [{ id: 'hq' }, { id: 'campus' }] });
  // The Everyone and Member roles for the access check; no roles picked for the invitation
  db.role.findMany.mockImplementation(async ({ where }: { where: { id?: unknown } }) =>
    where.id ? [] : [{ key: 'everyone', permissions: BigInt(0) }, { key: 'member', permissions: BigInt(0) }],
  );
  db.user.findUnique.mockResolvedValue(null);
  db.membershipInvitation.findFirst.mockResolvedValue({ id: 'i1', status: 'pending', universeId: 'u1', allWorlds: true, worldIds: [], worldId: 'hq' });
  db.$transaction.mockResolvedValue(undefined);
});

describe('a super admin with no part in the universe', () => {
  beforeEach(() => signedIn('root', true, 'nothing'));

  it('cannot invite anyone: refused, nothing created', async () => {
    const response = await send();
    expect(response.status).toBe(403);
    expect((await response.json()).error).toMatch(/Needs Invite and remove people/);
    expect(db.membershipInvitation.create).not.toHaveBeenCalled();
  });

  it('cannot take an invitation back', async () => {
    const response = await call(cancel, '/api/admin/universes/u1/invitations/i1', { method: 'DELETE' }, { invitationId: 'i1' });
    expect(response.status).toBe(403);
    expect(db.membershipInvitation.update).not.toHaveBeenCalled();
  });

  it('cannot remove a member', async () => {
    const response = await call(remove, `/api/admin/universes/u1/members/${OTHER}`, { method: 'DELETE' }, { userId: OTHER });
    expect(response.status).toBe(403);
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});

describe('the same person', () => {
  it('keeps full rights in a universe they own', async () => {
    signedIn('owner', true, 'nothing');
    // Past the permission check: the person to invite is looked up (and is not found here)
    expect((await send()).status).toBe(404);
    const removed = await call(remove, `/api/admin/universes/u1/members/${OTHER}`, { method: 'DELETE' }, { userId: OTHER });
    expect(removed.status).toBe(200);
    const cancelled = await call(cancel, '/api/admin/universes/u1/invitations/i1', { method: 'DELETE' }, { invitationId: 'i1' });
    expect(cancelled.status).toBe(200);
  });

  it('has an inviting role’s rights in a universe where they hold it', async () => {
    signedIn('root', true, 'greeter');
    expect((await send()).status).toBe(404);
    const cancelled = await call(cancel, '/api/admin/universes/u1/invitations/i1', { method: 'DELETE' }, { invitationId: 'i1' });
    expect(cancelled.status).toBe(200);
  });

  it('does what anyone else with the same role does, and a super admin flag makes no difference', async () => {
    signedIn('helper', false, 'greeter');
    expect((await send()).status).toBe(404);
  });
});
