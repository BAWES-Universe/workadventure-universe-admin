import { NextRequest } from 'next/server';
import { GET } from '@/app/api/admin/visitors/route';
import { getViewer, memberWorldIdsOf } from '@/lib/access-scope';
import { prisma } from '@/lib/db';
import { loadPersonVisits, loadVisitorPeople } from '@/lib/visitor-people';
import { viewerWorldId } from '@/lib/viewer-world';

jest.mock('@/lib/access-scope', () => ({
  getViewer: jest.fn(),
  memberWorldIdsOf: jest.fn(),
  unauthorizedResponse: () => new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }),
}));
jest.mock('@/lib/visitor-people', () => ({ loadVisitorPeople: jest.fn(), loadPersonVisits: jest.fn(), PEOPLE_PER_PAGE: 20, VISITS_SHOWN: 10, MAX_VISITS_PER_LOAD: 50 }));
jest.mock('@/lib/viewer-world', () => ({ viewerWorldId: jest.fn() }));
jest.mock('@/lib/db', () => ({ prisma: { room: { findUnique: jest.fn() }, world: { findUnique: jest.fn() }, universe: { findUnique: jest.fn() } } }));

const viewer = { kind: 'user', user: { id: 'me', isSuperAdmin: false } };
const findRoom = prisma.room.findUnique as jest.Mock;
const findWorld = prisma.world.findUnique as jest.Mock;
const findUniverse = prisma.universe.findUnique as jest.Mock;

/** A place as the visibility rules read it: public unless told otherwise, owned by someone else. */
function places({ room = true, world = true, universe = true, ownerId = 'owner' } = {}) {
  const universeRecord = { isPublic: universe, ownerId };
  findUniverse.mockResolvedValue({ ...universeRecord, worlds: [{ id: 'w1' }] });
  findWorld.mockResolvedValue({ id: 'w1', isPublic: world, universe: universeRecord });
  findRoom.mockResolvedValue({ isPublic: room, world: { id: 'w1', isPublic: world, universe: universeRecord } });
}
const get = (query: string) => GET(new NextRequest(`http://localhost:3333/api/admin/visitors${query}`));

beforeEach(() => {
  jest.resetAllMocks();
  (getViewer as jest.Mock).mockResolvedValue(viewer);
  (loadVisitorPeople as jest.Mock).mockResolvedValue({ people: [], total: 0 });
  (loadPersonVisits as jest.Mock).mockResolvedValue([]);
  (viewerWorldId as jest.Mock).mockResolvedValue('w-here');
  (memberWorldIdsOf as jest.Mock).mockResolvedValue(new Set());
  places();
});

describe('/api/admin/visitors', () => {
  it('turns the scope and id into the place, and pages people 20 at a time', async () => {
    for (const [scope, key] of [['universe', 'universeId'], ['world', 'worldId'], ['room', 'roomId']]) {
      const response = await get(`?scope=${scope}&id=abc&page=2`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ people: [], total: 0 });
      expect((loadVisitorPeople as jest.Mock).mock.calls.at(-1)).toEqual([viewer, { [key]: 'abc' }, { page: 2, limit: 20, lookingFromWorldId: 'w-here' }]);
    }
  });

  it('keeps the page and size sensible', async () => {
    await get('?scope=room&id=abc&page=-4&limit=5000');
    expect((loadVisitorPeople as jest.Mock).mock.calls[0][2]).toEqual(expect.objectContaining({ page: 1, limit: 50 }));
    await get('?scope=room&id=abc&page=abc');
    expect((loadVisitorPeople as jest.Mock).mock.calls[1][2]).toEqual(expect.objectContaining({ page: 1, limit: 20 }));
  });

  it('loads more of one person’s visits', async () => {
    (loadPersonVisits as jest.Mock).mockResolvedValue([{ id: 'a1' }]);
    const response = await get('?scope=room&id=abc&person=u%3Afawaz&offset=10&limit=20');
    expect(await response.json()).toEqual({ visits: [{ id: 'a1' }] });
    expect(loadPersonVisits).toHaveBeenCalledWith(viewer, { roomId: 'abc' }, 'u:fawaz', { offset: 10, limit: 20 });
    expect(loadVisitorPeople).not.toHaveBeenCalled();
  });

  it('wants someone signed in, a known scope and an id', async () => {
    (getViewer as jest.Mock).mockResolvedValue(null);
    expect((await get('?scope=room&id=abc')).status).toBe(401);
    (getViewer as jest.Mock).mockResolvedValue(viewer);
    expect((await get('?scope=planet&id=abc')).status).toBe(400);
    expect((await get('?scope=room')).status).toBe(400);
    expect((await get('?scope=toString&id=abc')).status).toBe(400);
  });

  it('says a private place does not exist to someone signed in who may not see it, and names nothing in it', async () => {
    places({ room: false });
    const response = await get('?scope=room&id=secret');
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Not found' });
    expect((await get('?scope=room&id=secret&person=u%3Afawaz&offset=10')).status).toBe(404);
    places({ world: false });
    expect((await get('?scope=world&id=w1')).status).toBe(404);
    expect((await get('?scope=room&id=r1')).status).toBe(404);
    places({ universe: false });
    expect((await get('?scope=universe&id=u1')).status).toBe(404);
    expect((await get('?scope=world&id=w1')).status).toBe(404);
    findRoom.mockResolvedValue(null);
    expect((await get('?scope=room&id=gone')).status).toBe(404);
    expect(loadVisitorPeople).not.toHaveBeenCalled();
    expect(loadPersonVisits).not.toHaveBeenCalled();
  });

  it('shows a private place to its owner, the world’s members, super admins and the admin token, as before', async () => {
    places({ room: false, world: false, universe: false });
    (memberWorldIdsOf as jest.Mock).mockResolvedValue(new Set(['w1']));
    for (const scope of ['room', 'world', 'universe']) expect((await get(`?scope=${scope}&id=x`)).status).toBe(200);
    (memberWorldIdsOf as jest.Mock).mockResolvedValue(new Set());
    places({ room: false, world: false, universe: false, ownerId: 'me' });
    expect((await get('?scope=room&id=x')).status).toBe(200);
    places({ room: false, world: false, universe: false });
    (getViewer as jest.Mock).mockResolvedValue({ kind: 'user', user: { id: 'boss', isSuperAdmin: true } });
    expect((await get('?scope=universe&id=x')).status).toBe(200);
    (getViewer as jest.Mock).mockResolvedValue({ kind: 'admin-token' });
    findRoom.mockClear();
    expect((await get('?scope=room&id=x')).status).toBe(200);
    expect(findRoom).not.toHaveBeenCalled();
  });

  it('answers 500 when it cannot load', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    (loadVisitorPeople as jest.Mock).mockRejectedValue(new Error('db'));
    expect((await get('?scope=room&id=abc')).status).toBe(500);
  });
});
