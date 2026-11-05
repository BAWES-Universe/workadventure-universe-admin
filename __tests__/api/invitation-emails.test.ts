/**
 * Invitation answers show a person's name and Woka, never their email: the people who invite (or take invitations back)
 * must not be able to read an address off the pending list or off the answer to an invitation.
 */
import { NextRequest } from 'next/server';
import { computeAccess } from '@/lib/role-access';
import { flag, combine } from '@/lib/permissions';

jest.mock('@/lib/db', () => ({
  prisma: {
    world: { findUnique: jest.fn() },
    worldMember: { findUnique: jest.fn() },
    user: { findUnique: jest.fn() },
    membershipInvitation: { findMany: jest.fn(), findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
  },
}));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn() }));
jest.mock('@/lib/universe-members', () => ({
  ...jest.requireActual('@/lib/universe-members'),
  tagsGiveAdministrator: jest.fn(async () => false),
}));
jest.mock('@/lib/push-messages', () => ({ notifyInvitation: jest.fn() }));
jest.mock('@/lib/woka-avatar', () => ({
  withWokas: jest.fn(async (records: unknown[]) => records),
  wokaLayersForMany: jest.fn(async () => new Map()),
}));
jest.mock('@/lib/viewer-world', () => ({ viewerWorldId: jest.fn(async () => undefined) }));
jest.mock('@/lib/universe-route', () => ({ ...jest.requireActual('@/lib/universe-route'), universeContext: jest.fn() }));

import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { universeContext } from '@/lib/universe-route';
import { GET as listUniverseInvitations } from '@/app/api/admin/universes/[id]/invitations/route';
import { GET as listWorldInvitations } from '@/app/api/admin/worlds/[id]/invitations/route';
import { POST as inviteToWorld } from '@/app/api/admin/worlds/[id]/members/route';

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;
const session = getSessionUser as jest.Mock;
const context = universeContext as jest.Mock;

const INVITEE_EMAIL = 'invitee@example.test';
const INVITER_EMAIL = 'inviter@example.test';
const INVITEE = { id: 'jana', name: 'Jana', email: INVITEE_EMAIL };
const INVITER = { id: 'sara', name: 'Sara', email: INVITER_EMAIL };
const UUID = '0b6a5a52-6f0e-4f6b-9f3a-6a6f3b2c9d11';

/** What the database does with a `select`: only the columns asked for come back. */
function select<T extends Record<string, unknown>>(row: T, columns?: Record<string, boolean>) {
  if (!columns) return row;
  return Object.fromEntries(Object.entries(row).filter(([key]) => columns[key]));
}

/** A pending invitation row as the database gives it, honouring the `include.select` of the query. */
function row(query: { include?: { invitedUser?: { select?: Record<string, boolean> }; invitedBy?: { select?: Record<string, boolean> } } }) {
  return {
    id: 'inv1',
    worldId: 'campus',
    universeId: 'u1',
    allWorlds: false,
    worldIds: ['campus'],
    roleIds: [],
    tags: ['member'],
    status: 'pending',
    invitedAt: new Date('2026-11-04T10:00:00Z'),
    invitedUserId: INVITEE.id,
    invitedUser: select(INVITEE, query.include?.invitedUser?.select),
    invitedBy: select(INVITER, query.include?.invitedBy?.select),
  };
}

const request = (path: string, init?: ConstructorParameters<typeof NextRequest>[1]) => new NextRequest(`http://localhost${path}`, init);
const params = (id: string) => ({ params: Promise.resolve({ id }) });

function asUniverseInviter() {
  const access = computeAccess({
    universeId: 'u1',
    worldIds: ['campus'],
    full: false,
    isOwner: false,
    everyone: BigInt(0),
    member: BigInt(0),
    membership: { allWorlds: true, worldIds: [] },
    roles: [{ key: 'helper', position: 11, permissions: combine(flag('INVITE_AND_REMOVE')), allWorlds: true, worldIds: [] }],
  });
  context.mockResolvedValue({
    ok: true,
    user: { id: 'sara', uuid: 'uuid-sara', email: INVITER_EMAIL, name: 'Sara', tags: [], isSuperAdmin: false },
    access,
    universe: { id: 'u1', name: 'BAWES', ownerId: 'owner' },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  db.membershipInvitation.findMany.mockImplementation(async (query) => [row(query)]);
});

describe('pending invitations of a universe', () => {
  it('show the invitee by name, and never carry their email', async () => {
    asUniverseInviter();
    const response = await listUniverseInvitations(request('/api/admin/universes/u1/invitations'), params('u1'));
    const text = await response.text();

    expect(text).not.toContain(INVITEE_EMAIL);
    expect(JSON.parse(text).invitations[0]).toMatchObject({ id: 'inv1', userId: 'jana', name: 'Jana' });
    expect(JSON.parse(text).invitations[0]).not.toHaveProperty('email');
  });

  it('never read the email column at all', async () => {
    asUniverseInviter();
    await listUniverseInvitations(request('/api/admin/universes/u1/invitations'), params('u1'));
    expect(db.membershipInvitation.findMany.mock.calls[0][0].include.invitedUser.select).not.toHaveProperty('email');
  });
});

describe('pending invitations of a world', () => {
  beforeEach(() => {
    db.world.findUnique.mockResolvedValue({ universe: { ownerId: 'sara' }, members: [] });
  });

  it('show a world manager the invitee and the inviter by name, with no email for either', async () => {
    session.mockResolvedValue({ id: 'sara' });
    const text = await (await listWorldInvitations(request('/api/admin/worlds/campus/invitations'), params('campus'))).text();

    expect(text).not.toContain(INVITEE_EMAIL);
    expect(text).not.toContain(INVITER_EMAIL);
    expect(JSON.parse(text).invitations[0]).toMatchObject({ invitedUser: { id: 'jana', name: 'Jana' }, invitedBy: { id: 'sara', name: 'Sara' } });
  });

  it("show the invited person who invited them by name only, not the inviter's email", async () => {
    db.world.findUnique.mockResolvedValue({ universe: { ownerId: 'owner' }, members: [] });
    session.mockResolvedValue({ id: 'jana' });
    const text = await (await listWorldInvitations(request('/api/admin/worlds/campus/invitations'), params('campus'))).text();

    expect(text).not.toContain(INVITER_EMAIL);
    expect(text).not.toContain(INVITEE_EMAIL);
    expect(JSON.parse(text).invitations[0].invitedBy).toEqual({ id: 'sara', name: 'Sara' });
  });
});

describe('inviting someone to a world', () => {
  it("answers with the invitation, without the invitee's email", async () => {
    session.mockResolvedValue({ id: 'sara' });
    db.world.findUnique.mockResolvedValue({ id: 'campus', universeId: 'u1', universe: { ownerId: 'sara' }, members: [] });
    db.user.findUnique.mockResolvedValue({ ...INVITEE, uuid: UUID });
    db.worldMember.findUnique.mockResolvedValue(null);
    db.membershipInvitation.findFirst.mockResolvedValue(null);
    db.membershipInvitation.create.mockImplementation(async ({ include }) => row({ include }));

    const response = await inviteToWorld(
      request('/api/admin/worlds/campus/members', { method: 'POST', body: JSON.stringify({ userId: UUID, tags: ['member'] }) }),
      params('campus'),
    );
    const text = await response.text();

    expect(response.status).toBe(201);
    expect(text).not.toContain(INVITEE_EMAIL);
    expect(text).not.toContain(INVITER_EMAIL);
    expect(JSON.parse(text).invitation.invitedUser).toEqual({ id: 'jana', name: 'Jana' });
    expect(JSON.parse(text).invitation.invitedBy).toEqual({ id: 'sara', name: 'Sara' });
  });

  it('answers without either email when an earlier invitation is sent again', async () => {
    session.mockResolvedValue({ id: 'sara' });
    db.world.findUnique.mockResolvedValue({ id: 'campus', universeId: 'u1', universe: { ownerId: 'sara' }, members: [] });
    db.user.findUnique.mockResolvedValue({ ...INVITEE, uuid: UUID });
    db.worldMember.findUnique.mockResolvedValue(null);
    // No pending invitation, but a cancelled one to send again
    db.membershipInvitation.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'inv1', status: 'cancelled' });
    db.membershipInvitation.update.mockImplementation(async ({ include }) => row({ include }));

    const response = await inviteToWorld(
      request('/api/admin/worlds/campus/members', { method: 'POST', body: JSON.stringify({ userId: UUID, tags: ['member'] }) }),
      params('campus'),
    );
    const text = await response.text();

    expect(response.status).toBe(201);
    expect(text).not.toContain(INVITEE_EMAIL);
    expect(text).not.toContain(INVITER_EMAIL);
    expect(JSON.parse(text).invitation.invitedBy).toEqual({ id: 'sara', name: 'Sara' });
  });
});
