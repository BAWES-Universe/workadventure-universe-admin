/**
 * A world's member list: only people who can see the world get it, and only the people who manage the world (and
 * super admins) see members' emails.
 */
import { NextRequest } from 'next/server';

jest.mock('@/lib/db', () => ({
  prisma: {
    world: { findUnique: jest.fn() },
    worldMember: { findUnique: jest.fn(), findMany: jest.fn() },
    roomAccess: { findMany: jest.fn().mockResolvedValue([]) },
  },
}));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn() }));
jest.mock('@/lib/woka-avatar', () => ({ withWokas: jest.fn((records) => Promise.resolve(records)) }));

import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { GET as getMembers } from '@/app/api/admin/worlds/[id]/members/route';

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;

const SESSIONS = {
  owner: { id: 'u-owner', uuid: 'uuid-owner', email: 'owner@example.test', name: 'Owner', tags: [], isSuperAdmin: false },
  admin: { id: 'u-admin', uuid: 'uuid-admin', email: 'a@example.test', name: 'Admin', tags: [], isSuperAdmin: false },
  member: { id: 'u-member', uuid: 'uuid-member', email: 'm@example.test', name: 'Member', tags: [], isSuperAdmin: false },
  stranger: { id: 'u-stranger', uuid: 'uuid-stranger', email: 's@example.test', name: 'Stranger', tags: [], isSuperAdmin: false },
  root: { id: 'u-root', uuid: 'uuid-root', email: 'root@example.test', name: 'Root', tags: [], isSuperAdmin: true },
};
type Who = keyof typeof SESSIONS;

const MEMBERS = [
  { id: 'm-1', userId: 'u-member', worldId: 'w', tags: ['member'], user: { id: 'u-member', name: 'Member', email: 'm@example.test' } },
  { id: 'm-2', userId: 'u-admin', worldId: 'w', tags: ['admin'], user: { id: 'u-admin', name: 'Admin', email: 'a@example.test' } },
];

function setUp(isPublic: boolean) {
  db.world.findUnique.mockImplementation(({ where, include }) => {
    if (where.id !== 'w') return Promise.resolve(null);
    const world = { id: 'w', isPublic, universe: { isPublic: true, ownerId: 'u-owner' } };
    // canManageWorldMembers asks for the caller's admin membership
    if (include?.members) {
      const userId = include.members.where.userId;
      return Promise.resolve({ ...world, members: userId === 'u-admin' ? [MEMBERS[1]] : [] });
    }
    return Promise.resolve(world);
  });
  db.worldMember.findUnique.mockImplementation(({ where }) =>
    Promise.resolve(MEMBERS.find((m) => m.userId === where.userId_worldId.userId) ?? null),
  );
  db.worldMember.findMany.mockResolvedValue(MEMBERS);
}

async function membersAs(who: Who) {
  (getSessionUser as jest.Mock).mockResolvedValue(SESSIONS[who]);
  const response = await getMembers(new NextRequest('http://localhost/api/admin/worlds/w/members'), {
    params: Promise.resolve({ id: 'w' }),
  });
  return { status: response.status, body: await response.json() };
}

const emails = (body: { members: Array<{ user: { email: string | null } }> }) => body.members.map((m) => m.user.email);

describe('GET /api/admin/worlds/[id]/members', () => {
  beforeEach(() => jest.clearAllMocks());

  it('hides a private world from strangers', async () => {
    setUp(false);
    expect((await membersAs('stranger')).status).toBe(404);
  });

  it('shows a private world to its members, without emails', async () => {
    setUp(false);
    const { status, body } = await membersAs('member');
    expect(status).toBe(200);
    expect(emails(body)).toEqual([null, null]);
  });

  it('shows a public world to strangers, without emails', async () => {
    setUp(true);
    const { status, body } = await membersAs('stranger');
    expect(status).toBe(200);
    expect(body.canManage).toBe(false);
    expect(emails(body)).toEqual([null, null]);
  });

  it.each<Who>(['owner', 'admin', 'root'])('shows emails to %s', async (who) => {
    setUp(false);
    const { status, body } = await membersAs(who);
    expect(status).toBe(200);
    expect(emails(body)).toEqual(['m@example.test', 'a@example.test']);
  });
});
