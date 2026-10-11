/**
 * A super admin can edit and delete any universe, world or room, whoever owns it, and sees the Edit and Delete
 * buttons for them (`canEdit`) without running the place (`manages` stays false). Everyone else keeps the old rule.
 */
import { NextRequest } from 'next/server';

jest.mock('@/lib/db', () => ({
  prisma: {
    universe: { findUnique: jest.fn(), update: jest.fn(), delete: jest.fn() },
    world: { findUnique: jest.fn(), update: jest.fn(), delete: jest.fn() },
    room: { findUnique: jest.fn(), update: jest.fn(), delete: jest.fn() },
    user: { findUnique: jest.fn() },
    worldMember: { findMany: jest.fn(), findFirst: jest.fn() },
    favorite: { groupBy: jest.fn(), findMany: jest.fn(), count: jest.fn().mockResolvedValue(0), findFirst: jest.fn() },
  },
}));

jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn() }));
jest.mock('@/lib/woka-avatar', () => ({ wokaLayersFor: jest.fn().mockResolvedValue([]) }));

import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { GET as getUniverse, PATCH as patchUniverse, DELETE as deleteUniverse } from '@/app/api/admin/universes/[id]/route';
import { GET as getWorld, PATCH as patchWorld, DELETE as deleteWorld } from '@/app/api/admin/worlds/[id]/route';
import { GET as getRoom, PATCH as patchRoom, DELETE as deleteRoom } from '@/app/api/admin/rooms/[id]/route';

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;

const ROOT_UUID = '3f1c7a5e-9a52-4a52-8d3b-0c0f6d2f9a11';

const SESSIONS = {
  owner: { id: 'u-owner', uuid: 'uuid-owner', email: 'owner@example.test', name: 'Owner', tags: [], isSuperAdmin: false },
  stranger: { id: 'u-stranger', uuid: 'uuid-stranger', email: 's@example.test', name: 'Stranger', tags: [], isSuperAdmin: false },
  root: { id: ROOT_UUID, uuid: 'uuid-root', email: 'root@example.test', name: 'Root', tags: [], isSuperAdmin: true },
};
type Who = keyof typeof SESSIONS;

function req(url: string, as: Who, method = 'GET', body?: unknown) {
  return new NextRequest(`http://localhost:3333${url}`, {
    method,
    headers: { Authorization: `Bearer session-${as}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });

const universeRow = {
  id: 'un-1', slug: 'u', name: 'U', isPublic: true, featured: false, ownerId: 'u-owner',
  owner: { id: 'u-owner', name: 'Owner', email: 'owner@example.test' },
  worlds: [],
};
const worldRow = {
  id: 'w-1', slug: 'w', name: 'W', isPublic: true, featured: false, universeId: 'un-1',
  universe: { id: 'un-1', name: 'U', slug: 'u', ownerId: 'u-owner', isPublic: true },
  rooms: [], _count: { members: 0 },
};
const roomRow = {
  id: 'r-1', slug: 'r', name: 'R', isPublic: true, mapUrl: null, worldId: 'w-1', templateMap: null,
  world: { id: 'w-1', name: 'W', slug: 'w', isPublic: true, universe: { id: 'un-1', name: 'U', slug: 'u', ownerId: 'u-owner', isPublic: true } },
};

beforeAll(() => {
  process.env.ADMIN_API_TOKEN = 'test-admin-token';
});

beforeEach(() => {
  jest.clearAllMocks();
  (getSessionUser as jest.Mock).mockImplementation((request: NextRequest) => {
    const who = request.headers.get('authorization')?.replace('Bearer session-', '') as Who | undefined;
    return Promise.resolve(who && who in SESSIONS ? SESSIONS[who] : null);
  });
  db.worldMember.findMany.mockResolvedValue([]);
  db.worldMember.findFirst.mockResolvedValue(null);
  db.favorite.groupBy.mockResolvedValue([]);
  db.favorite.count.mockResolvedValue(0);
  db.universe.findUnique.mockResolvedValue(universeRow);
  db.world.findUnique.mockResolvedValue(worldRow);
  db.room.findUnique.mockResolvedValue(roomRow);
  db.universe.update.mockResolvedValue(universeRow);
  db.world.update.mockResolvedValue(worldRow);
  db.room.update.mockResolvedValue(roomRow);
});

describe('who gets the Edit and Delete buttons', () => {
  it.each([
    ['universe', () => getUniverse(req('/api/admin/universes/un-1', 'root'), params('un-1'))],
    ['world', () => getWorld(req('/api/admin/worlds/w-1', 'root'), params('w-1'))],
    ['room', () => getRoom(req('/api/admin/rooms/r-1', 'root'), params('r-1'))],
  ])('a super admin can edit a %s they do not run', async (_name, call) => {
    const body = await (await call()).json();
    expect(body.canEdit).toBe(true);
    expect(body.manages).toBe(false);
  });

  it.each([
    ['universe', () => getUniverse(req('/api/admin/universes/un-1', 'stranger'), params('un-1'))],
    ['world', () => getWorld(req('/api/admin/worlds/w-1', 'stranger'), params('w-1'))],
    ['room', () => getRoom(req('/api/admin/rooms/r-1', 'stranger'), params('r-1'))],
  ])('a stranger still cannot edit a %s', async (_name, call) => {
    const body = await (await call()).json();
    expect(body.canEdit).toBe(false);
    expect(body.manages).toBe(false);
  });

  it('the owner runs and can edit their universe', async () => {
    const body = await (await getUniverse(req('/api/admin/universes/un-1', 'owner'), params('un-1'))).json();
    expect(body.canEdit).toBe(true);
    expect(body.manages).toBe(true);
  });
});

describe('saving and deleting', () => {
  it('lets a super admin save and delete a universe they do not own, but not hand it to themselves', async () => {
    const patch = (b: unknown) => patchUniverse(req('/api/admin/universes/un-1', 'root', 'PATCH', b), params('un-1'));
    expect((await patch({ name: 'New name' })).status).toBe(200);
    expect(db.universe.update).toHaveBeenCalled();
    expect((await patch({ ownerId: ROOT_UUID })).status).toBe(403);
    expect((await deleteUniverse(req('/api/admin/universes/un-1', 'root', 'DELETE'), params('un-1'))).status).toBe(200);
    expect(db.universe.delete).toHaveBeenCalled();
  });

  it('lets a super admin save and delete a world they do not run', async () => {
    expect((await patchWorld(req('/api/admin/worlds/w-1', 'root', 'PATCH', { name: 'New name' }), params('w-1'))).status).toBe(200);
    expect(db.world.update).toHaveBeenCalled();
    expect((await deleteWorld(req('/api/admin/worlds/w-1', 'root', 'DELETE'), params('w-1'))).status).toBe(200);
    expect(db.world.delete).toHaveBeenCalled();
  });

  it('lets a super admin save and delete a room in a world they do not run', async () => {
    expect((await patchRoom(req('/api/admin/rooms/r-1', 'root', 'PATCH', { name: 'New name' }), params('r-1'))).status).toBe(200);
    expect(db.room.update).toHaveBeenCalled();
    expect((await deleteRoom(req('/api/admin/rooms/r-1', 'root', 'DELETE'), params('r-1'))).status).toBe(200);
    expect(db.room.delete).toHaveBeenCalled();
  });

  it('still refuses a stranger', async () => {
    expect((await patchUniverse(req('/api/admin/universes/un-1', 'stranger', 'PATCH', { name: 'x' }), params('un-1'))).status).toBe(403);
    expect((await deleteUniverse(req('/api/admin/universes/un-1', 'stranger', 'DELETE'), params('un-1'))).status).toBe(403);
    expect((await patchWorld(req('/api/admin/worlds/w-1', 'stranger', 'PATCH', { name: 'x' }), params('w-1'))).status).toBe(403);
    expect((await deleteWorld(req('/api/admin/worlds/w-1', 'stranger', 'DELETE'), params('w-1'))).status).toBe(403);
    expect((await patchRoom(req('/api/admin/rooms/r-1', 'stranger', 'PATCH', { name: 'x' }), params('r-1'))).status).toBe(403);
    expect((await deleteRoom(req('/api/admin/rooms/r-1', 'stranger', 'DELETE'), params('r-1'))).status).toBe(403);
    expect(db.universe.update).not.toHaveBeenCalled();
    expect(db.universe.delete).not.toHaveBeenCalled();
    expect(db.world.delete).not.toHaveBeenCalled();
    expect(db.room.delete).not.toHaveBeenCalled();
  });
});
