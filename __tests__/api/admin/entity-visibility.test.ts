/**
 * Private universes, worlds and rooms, and what the detail and starred-rooms routes reveal about them: a private
 * entity is only for its owner, its members and super admins, and the owner's email only for those who manage it.
 */
import { NextRequest } from 'next/server';

jest.mock('@/lib/db', () => ({
  prisma: {
    universe: { findUnique: jest.fn() },
    world: { findUnique: jest.fn() },
    room: { findUnique: jest.fn(), update: jest.fn() },
    worldMember: { findMany: jest.fn(), findFirst: jest.fn() },
    favorite: { groupBy: jest.fn(), findMany: jest.fn(), count: jest.fn().mockResolvedValue(0), findFirst: jest.fn() },
    userAvatar: { count: jest.fn() },
    avatarSet: { findUnique: jest.fn() },
  },
}));

jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn() }));
jest.mock('@/lib/woka-avatar', () => ({ wokaLayersFor: jest.fn().mockResolvedValue([]) }));
jest.mock('@/lib/auth', () => ({
  ...jest.requireActual('@/lib/auth'),
  requireSuperAdminSession: jest.fn(),
}));

import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { requireSuperAdminSession } from '@/lib/auth';
import { GET as getUniverse } from '@/app/api/admin/universes/[id]/route';
import { GET as getWorld } from '@/app/api/admin/worlds/[id]/route';
import { GET as getRoom } from '@/app/api/admin/rooms/[id]/route';
import { GET as getStarredRooms } from '@/app/api/admin/users/[id]/starred-rooms/route';
import { GET as accessCheck } from '@/app/api/admin/avatar-sets/[id]/access-check/route';
import { GET as textureUsage } from '@/app/api/admin/texture-usage/route';

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;

const SESSIONS = {
  owner: { id: 'u-owner', uuid: 'uuid-owner', email: 'owner@example.test', name: 'Owner', tags: [], isSuperAdmin: false },
  member: { id: 'u-member', uuid: 'uuid-member', email: 'm@example.test', name: 'Member', tags: [], isSuperAdmin: false },
  stranger: { id: 'u-stranger', uuid: 'uuid-stranger', email: 's@example.test', name: 'Stranger', tags: [], isSuperAdmin: false },
  root: { id: 'u-root', uuid: 'uuid-root', email: 'root@example.test', name: 'Root', tags: [], isSuperAdmin: true },
};
type Who = keyof typeof SESSIONS;

function req(url: string, as?: Who | 'admin-token') {
  const headers: Record<string, string> = {};
  if (as === 'admin-token') headers.Authorization = `Bearer ${process.env.ADMIN_API_TOKEN}`;
  else if (as) headers.Authorization = `Bearer session-${as}`;
  return new NextRequest(`http://localhost:3333${url}`, { headers });
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });

/** The member belongs to world w-private only. */
function memberships({ where }: { where: { userId: string; worldId?: { in: string[] } } }) {
  const rows = where.userId === 'u-member' ? [{ worldId: 'w-private' }] : [];
  return Promise.resolve(where.worldId ? rows.filter((r) => where.worldId!.in.includes(r.worldId)) : rows);
}

function universe(isPublic: boolean) {
  return {
    id: 'un-1',
    isPublic,
    ownerId: 'u-owner',
    owner: { id: 'u-owner', name: 'Owner', email: 'owner@example.test' },
    worlds: [
      { id: 'w-public', isPublic: true, slug: 'pub', name: 'Public', _count: { rooms: 1, members: 0 } },
      { id: 'w-private', isPublic: false, slug: 'priv', name: 'Private', _count: { rooms: 1, members: 1 } },
    ],
  };
}

function world(id: string, isPublic: boolean, universePublic = true) {
  return {
    id,
    isPublic,
    universe: { id: 'un-1', name: 'U', slug: 'u', ownerId: 'u-owner', isPublic: universePublic },
    rooms: [
      { id: 'r-public', isPublic: true, slug: 'a', name: 'A', _count: { favorites: 0 } },
      { id: 'r-private', isPublic: false, slug: 'b', name: 'B', _count: { favorites: 0 } },
    ],
    _count: { members: 1 },
  };
}

function room(worldId: string, isPublic: boolean, worldPublic: boolean) {
  return {
    id: 'r-1',
    worldId,
    isPublic,
    mapUrl: null,
    world: {
      id: worldId,
      name: 'W',
      slug: 'w',
      isPublic: worldPublic,
      universe: { id: 'un-1', name: 'U', slug: 'u', ownerId: 'u-owner', isPublic: true },
    },
    templateMap: null,
  };
}

beforeAll(() => {
  process.env.ADMIN_API_TOKEN = 'test-admin-token';
});

beforeEach(() => {
  jest.clearAllMocks();
  (getSessionUser as jest.Mock).mockImplementation((request: NextRequest) => {
    const who = request.headers.get('authorization')?.replace('Bearer session-', '') as Who | undefined;
    return Promise.resolve(who && who in SESSIONS ? SESSIONS[who] : null);
  });
  db.worldMember.findMany.mockImplementation(memberships);
  db.worldMember.findFirst.mockResolvedValue(null);
  db.favorite.groupBy.mockResolvedValue([]);
  db.favorite.count.mockResolvedValue(0);
});

describe('universe detail', () => {
  it('hides a private universe from a stranger, as if it did not exist', async () => {
    db.universe.findUnique.mockResolvedValue(universe(false));
    const res = await getUniverse(req('/api/admin/universes/un-1', 'stranger'), params('un-1'));
    expect(res.status).toBe(404);
  });

  it('shows a private universe to a member of one of its worlds, without the owner email', async () => {
    db.universe.findUnique.mockResolvedValue(universe(false));
    const res = await getUniverse(req('/api/admin/universes/un-1', 'member'), params('un-1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.owner.email).toBeUndefined();
    expect(body.owner.name).toBe('Owner');
  });

  it('lists only the worlds a stranger may see in a public universe, and never the owner email', async () => {
    db.universe.findUnique.mockResolvedValue(universe(true));
    const res = await getUniverse(req('/api/admin/universes/un-1', 'stranger'), params('un-1'));
    const body = await res.json();
    expect(body.worlds.map((w: { id: string }) => w.id)).toEqual(['w-public']);
    expect(body.owner.email).toBeUndefined();
  });

  it('gives the owner every world and their own email', async () => {
    db.universe.findUnique.mockResolvedValue(universe(false));
    const body = await (await getUniverse(req('/api/admin/universes/un-1', 'owner'), params('un-1'))).json();
    expect(body.worlds).toHaveLength(2);
    expect(body.owner.email).toBe('owner@example.test');
    expect(body.canEdit).toBe(true);
  });

  it('lets a super admin and the admin token see everything', async () => {
    db.universe.findUnique.mockResolvedValue(universe(false));
    for (const who of ['root', 'admin-token'] as const) {
      const res = await getUniverse(req('/api/admin/universes/un-1', who), params('un-1'));
      expect(res.status).toBe(200);
      expect((await res.json()).worlds).toHaveLength(2);
    }
  });

  it('still refuses someone who is not signed in', async () => {
    const res = await getUniverse(req('/api/admin/universes/un-1'), params('un-1'));
    expect(res.status).toBe(401);
  });
});

describe('world detail', () => {
  it('hides a private world from a stranger', async () => {
    db.world.findUnique.mockResolvedValue(world('w-private', false));
    expect((await getWorld(req('/api/admin/worlds/w-private', 'stranger'), params('w-private'))).status).toBe(404);
  });

  it('hides a public world in a private universe from a stranger', async () => {
    db.world.findUnique.mockResolvedValue(world('w-public', true, false));
    expect((await getWorld(req('/api/admin/worlds/w-public', 'stranger'), params('w-public'))).status).toBe(404);
  });

  it('shows a private world and its private rooms to a member', async () => {
    db.world.findUnique.mockResolvedValue(world('w-private', false));
    const res = await getWorld(req('/api/admin/worlds/w-private', 'member'), params('w-private'));
    expect(res.status).toBe(200);
    expect((await res.json()).rooms).toHaveLength(2);
  });

  it('lists only public rooms of a public world to a stranger', async () => {
    db.world.findUnique.mockResolvedValue(world('w-public', true));
    const body = await (await getWorld(req('/api/admin/worlds/w-public', 'stranger'), params('w-public'))).json();
    expect(body.rooms.map((r: { id: string }) => r.id)).toEqual(['r-public']);
  });
});

describe('room detail', () => {
  it('hides a private room from a stranger', async () => {
    db.room.findUnique.mockResolvedValue(room('w-public', false, true));
    expect((await getRoom(req('/api/admin/rooms/r-1', 'stranger'), params('r-1'))).status).toBe(404);
  });

  it('hides a public room in a private world from a stranger', async () => {
    db.room.findUnique.mockResolvedValue(room('w-private', true, false));
    expect((await getRoom(req('/api/admin/rooms/r-1', 'stranger'), params('r-1'))).status).toBe(404);
  });

  it('shows a private room to a member of its world, and to the universe owner', async () => {
    db.room.findUnique.mockResolvedValue(room('w-private', false, false));
    expect((await getRoom(req('/api/admin/rooms/r-1', 'member'), params('r-1'))).status).toBe(200);
    expect((await getRoom(req('/api/admin/rooms/r-1', 'owner'), params('r-1'))).status).toBe(200);
  });

  it('shows a public room to anyone signed in', async () => {
    db.room.findUnique.mockResolvedValue(room('w-public', true, true));
    expect((await getRoom(req('/api/admin/rooms/r-1', 'stranger'), params('r-1'))).status).toBe(200);
  });
});

describe('starred rooms', () => {
  const starred = [
    { favoritedAt: new Date(), room: { ...room('w-public', true, true), id: 'r-public', name: 'Public' } },
    { favoritedAt: new Date(), room: { ...room('w-private', false, false), id: 'r-private', name: 'Private' } },
  ];

  it("shows a stranger only the public rooms in someone else's stars", async () => {
    db.favorite.findMany.mockResolvedValue(starred);
    const body = await (await getStarredRooms(req('/api/admin/users/u-member/starred-rooms', 'stranger'), params('u-member'))).json();
    expect(body.rooms.map((r: { id: string }) => r.id)).toEqual(['r-public']);
    expect(body.rooms[0].world.universe.ownerId).toBeUndefined();
  });

  it('shows you all of your own stars, and a super admin all of anyone’s', async () => {
    db.favorite.findMany.mockResolvedValue(starred);
    const own = await (await getStarredRooms(req('/api/admin/users/u-stranger/starred-rooms', 'stranger'), params('u-stranger'))).json();
    expect(own.rooms).toHaveLength(2);
    const root = await (await getStarredRooms(req('/api/admin/users/u-member/starred-rooms', 'root'), params('u-member'))).json();
    expect(root.rooms).toHaveLength(2);
  });
});

describe('super admin tools', () => {
  it('refuses the avatar-set access check to anyone but a super admin', async () => {
    (requireSuperAdminSession as jest.Mock).mockRejectedValue(new Error('Forbidden'));
    const res = await accessCheck(req('/api/admin/avatar-sets/s-1/access-check?userId=u&worldId=w', 'stranger'), params('s-1'));
    expect(res.status).toBe(403);
    expect(db.avatarSet.findUnique).not.toHaveBeenCalled();
  });

  it('refuses texture usage to anyone but a super admin', async () => {
    (requireSuperAdminSession as jest.Mock).mockRejectedValue(new Error('Forbidden'));
    const res = await textureUsage(req('/api/admin/texture-usage?textureId=t', 'stranger'));
    expect(res.status).toBe(403);
    expect(db.userAvatar.count).not.toHaveBeenCalled();
  });

  it('answers 500, not 401, when the super admin check itself fails', async () => {
    (requireSuperAdminSession as jest.Mock).mockRejectedValue(new Error('connection refused'));
    const res = await accessCheck(req('/api/admin/avatar-sets/s-1/access-check?userId=u&worldId=w', 'root'), params('s-1'));
    expect(res.status).toBe(500);
  });

  it('answers 401 when nobody is signed in', async () => {
    (requireSuperAdminSession as jest.Mock).mockRejectedValue(new Error('Unauthorized'));
    expect((await textureUsage(req('/api/admin/texture-usage?textureId=t'))).status).toBe(401);
  });
});
