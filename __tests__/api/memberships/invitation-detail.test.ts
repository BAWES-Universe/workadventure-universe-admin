/**
 * One invitation, read by the person invited: nobody else learns it exists, and it carries what the page needs
 * without anyone's email.
 */
import { NextRequest } from 'next/server';

jest.mock('@/lib/db', () => ({
  prisma: { membershipInvitation: { findUnique: jest.fn() } },
}));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn() }));
jest.mock('@/lib/woka-avatar', () => ({
  wokaLayersForMany: jest.fn(async (ids: string[]) => new Map(ids.map((id) => [id, [`https://play.test/${id}.png`]]))),
}));

import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { GET } from '@/app/api/memberships/invitations/[id]/route';

const db = prisma as unknown as { membershipInvitation: { findUnique: jest.Mock } };
const session = getSessionUser as jest.Mock;

const invitee = { id: 'u-bob', uuid: 'uuid-bob', email: 'b@example.test', name: 'Bob', tags: [], isSuperAdmin: false };
const stranger = { ...invitee, id: 'u-eve', name: 'Eve' };

const record = {
  id: 'inv-1',
  invitedUserId: 'u-bob',
  status: 'pending',
  tags: ['editor'],
  message: 'Come build with us',
  invitedAt: new Date('2026-09-25T10:00:00Z'),
  respondedAt: null,
  invitedBy: { id: 'u-sara', name: 'Sara' },
  world: {
    id: 'w-1',
    name: 'Studio',
    slug: 'studio',
    description: 'Where we make things',
    isPublic: false,
    thumbnailUrl: null,
    universe: { id: 'un-1', name: 'Plugn', slug: 'plugn' },
    _count: { rooms: 3, members: 9 },
    rooms: [{ slug: 'lobby', name: 'Lobby' }],
    members: [
      { user: { id: 'u-sara', name: 'Sara' } },
      { user: { id: 'u-omar', name: 'Omar' } },
    ],
  },
};

const call = (id = 'inv-1') =>
  GET(new NextRequest(`http://orbit.test/api/memberships/invitations/${id}`), { params: Promise.resolve({ id }) });

describe('GET /api/memberships/invitations/[id]', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.membershipInvitation.findUnique.mockResolvedValue(record);
  });

  it('needs a session', async () => {
    session.mockResolvedValue(null);
    expect((await call()).status).toBe(401);
  });

  it('gives the invitee the invitation, the inviter, the world and a few members', async () => {
    session.mockResolvedValue(invitee);
    const response = await call();
    expect(response.status).toBe(200);
    const { invitation } = await response.json();
    expect(invitation).toMatchObject({
      id: 'inv-1',
      status: 'pending',
      tags: ['editor'],
      message: 'Come build with us',
      respondedAt: null,
      invitedBy: { id: 'u-sara', name: 'Sara', woka: ['https://play.test/u-sara.png'] },
      world: {
        id: 'w-1',
        name: 'Studio',
        slug: 'studio',
        description: 'Where we make things',
        isPublic: false,
        thumbnailUrl: null,
        universe: { id: 'un-1', name: 'Plugn', slug: 'plugn' },
        counts: { rooms: 3, members: 9 },
        firstRoom: { slug: 'lobby', name: 'Lobby' },
      },
    });
    expect(invitation.invitedAt).toBeTruthy();
    expect(invitation.world.members).toEqual([
      { id: 'u-sara', name: 'Sara', woka: ['https://play.test/u-sara.png'] },
      { id: 'u-omar', name: 'Omar', woka: ['https://play.test/u-omar.png'] },
    ]);
    expect(JSON.stringify(invitation)).not.toMatch(/email|invitedUserId/);
  });

  it('asks for at most six members, no emails, and the first room', async () => {
    session.mockResolvedValue(invitee);
    await call();
    const query = db.membershipInvitation.findUnique.mock.calls[0][0];
    expect(query.select.world.select.members.take).toBe(8);
    expect(query.select.world.select.rooms.take).toBe(1);
    expect(JSON.stringify(query)).not.toMatch(/email/);
  });

  it('is a 404 for anyone else, the same as a missing invitation', async () => {
    session.mockResolvedValue(stranger);
    const forbidden = await call();
    db.membershipInvitation.findUnique.mockResolvedValue(null);
    const missing = await call('nope');
    expect(forbidden.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await forbidden.json()).toEqual(await missing.json());
  });

  it('has no first room when the world has none', async () => {
    session.mockResolvedValue(invitee);
    db.membershipInvitation.findUnique.mockResolvedValue({ ...record, world: { ...record.world, rooms: [] } });
    const { invitation } = await (await call()).json();
    expect(invitation.world.firstRoom).toBeNull();
  });
});
