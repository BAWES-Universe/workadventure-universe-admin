/**
 * One invitation, read by the person invited: nobody else learns it exists, and it carries what the page needs
 * without anyone's email.
 */
import { NextRequest } from 'next/server';

jest.mock('@/lib/db', () => ({
  prisma: {
    membershipInvitation: { findUnique: jest.fn() },
    worldMember: { findMany: jest.fn(), findFirst: jest.fn() },
  },
}));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn() }));
jest.mock('@/lib/woka-avatar', () => ({
  wokaLayersForMany: jest.fn(async (ids: string[]) => new Map(ids.map((id) => [id, [`https://play.test/${id}.png`]]))),
}));

import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { GET } from '@/app/api/memberships/invitations/[id]/route';

const db = prisma as unknown as {
  membershipInvitation: { findUnique: jest.Mock };
  worldMember: { findMany: jest.Mock; findFirst: jest.Mock };
};

type Row = { tags: string[]; user: { id: string; name: string; visitCard: { bio: string | null; links: unknown } | null } };
const row = (id: string, name: string, tags: string[], visitCard: Row['user']['visitCard'] = null): Row => ({
  tags,
  user: { id, name, visitCard },
});
/** The world's members, in joining order. */
let worldMembers: Row[] = [];
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
    universe: { id: 'un-1', name: 'Plugn', slug: 'plugn', ownerId: 'u-boss' },
    _count: { rooms: 3, members: 9 },
    rooms: [{ slug: 'lobby', name: 'Lobby' }],
  },
};

const call = (id = 'inv-1') =>
  GET(new NextRequest(`http://orbit.test/api/memberships/invitations/${id}`), { params: Promise.resolve({ id }) });

describe('GET /api/memberships/invitations/[id]', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.membershipInvitation.findUnique.mockResolvedValue(record);
    worldMembers = [
      row('u-omar', 'Omar', ['member'], { bio: 'Hi', links: [{ label: 'Site', url: 'https://omar.test' }, { label: 'Bad', url: 'javascript:alert(1)' }] }),
      row('u-sara', 'Sara', ['editor']),
    ];
    db.worldMember.findMany.mockImplementation(async ({ where, take }: { where: { tags?: { hasSome: string[] } }; take: number }) =>
      worldMembers
        .filter((member) => !where.tags || member.tags.some((tag) => where.tags!.hasSome.includes(tag)))
        .slice(0, take));
    db.worldMember.findFirst.mockImplementation(async ({ where }: { where: { userId: string } }) =>
      worldMembers.find((member) => member.user.id === where.userId) ?? null);
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
      { id: 'u-sara', name: 'Sara', tags: ['editor'], bio: null, links: [], woka: ['https://play.test/u-sara.png'] },
      {
        id: 'u-omar',
        name: 'Omar',
        tags: ['member'],
        bio: 'Hi',
        links: [{ label: 'Site', url: 'https://omar.test' }],
        woka: ['https://play.test/u-omar.png'],
      },
    ]);
    expect(JSON.stringify(invitation)).not.toMatch(/email|invitedUserId/);
  });

  it('asks for at most 24 members, no emails, and the first room', async () => {
    session.mockResolvedValue(invitee);
    await call();
    const query = db.membershipInvitation.findUnique.mock.calls[0][0];
    expect(query.select.world.select.rooms.take).toBe(1);
    for (const [members] of db.worldMember.findMany.mock.calls) expect(members.take).toBe(24);
    expect(JSON.stringify([query, db.worldMember.findMany.mock.calls, db.worldMember.findFirst.mock.calls])).not.toMatch(/email/);
  });

  it('puts the owner, admins and editors first, even past the earliest 24 who joined', async () => {
    session.mockResolvedValue(invitee);
    worldMembers = [
      ...Array.from({ length: 30 }, (_, i) => row(`u-${i}`, `Member ${i}`, ['member'])),
      row('u-ada', 'Ada', ['admin']),
      row('u-boss', 'Boss', ['member']),
    ];
    const { invitation } = await (await call()).json();
    const members = invitation.world.members as Array<{ id: string; tags: string[] }>;
    expect(members).toHaveLength(24);
    expect(members.slice(0, 3).map((member) => member.id)).toEqual(['u-boss', 'u-ada', 'u-0']);
    expect(members[0].tags).toEqual(['owner', 'member']);
  });

  it('never lists a member twice', async () => {
    session.mockResolvedValue(invitee);
    worldMembers = [row('u-boss', 'Boss', ['admin']), row('u-omar', 'Omar', ['member'])];
    const { invitation } = await (await call()).json();
    expect(invitation.world.members.map((member: { id: string }) => member.id)).toEqual(['u-boss', 'u-omar']);
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
