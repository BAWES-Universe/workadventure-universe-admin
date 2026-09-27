import { NextRequest } from 'next/server';
import { GET as listUniverses, POST as createUniverse } from '@/app/api/admin/universes/route';
import { POST as createWorld } from '@/app/api/admin/worlds/route';
import { PATCH as updateWorld } from '@/app/api/admin/worlds/[id]/route';
import { PATCH as updateUniverse } from '@/app/api/admin/universes/[id]/route';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { refusesFeaturedChange } from '@/lib/featured';

jest.mock('@/lib/db', () => ({
  prisma: {
    universe: { findUnique: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn(), count: jest.fn() },
    world: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
    user: { findUnique: jest.fn() },
    favorite: { groupBy: jest.fn() },
    $queryRaw: jest.fn(),
  },
}));
jest.mock('@/lib/auth', () => ({ requireAuth: jest.fn() }));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn() }));

const OWNER = '11111111-1111-4111-8111-111111111111';
const UNIVERSE = '22222222-2222-4222-8222-222222222222';

function signIn(isSuperAdmin: boolean) {
  (getSessionUser as jest.Mock).mockResolvedValue({ id: OWNER, uuid: 'u-1', email: 'a@b.c', name: 'A', tags: [], isSuperAdmin });
}

function request(url: string, method: string, body: unknown) {
  return new NextRequest(`http://localhost:3333${url}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

describe('refusesFeaturedChange', () => {
  it('refuses a change from anyone who may not feature', () => {
    expect(refusesFeaturedChange(false, true, false)).toBe(true);
    expect(refusesFeaturedChange(false, false, true)).toBe(true);
  });

  it('lets the same value through (edit forms send the whole record) and leaves super admins alone', () => {
    expect(refusesFeaturedChange(false, true, true)).toBe(false);
    expect(refusesFeaturedChange(false, undefined, false)).toBe(false);
    expect(refusesFeaturedChange(true, true, false)).toBe(false);
  });
});

describe('Featured is for super admins', () => {
  beforeEach(() => jest.clearAllMocks());

  it('refuses an owner creating a featured universe', async () => {
    signIn(false);
    const response = await createUniverse(
      request('/api/admin/universes', 'POST', { slug: 'mine', name: 'Mine', ownerId: OWNER, featured: true }),
    );
    expect(response.status).toBe(403);
    expect(prisma.universe.create).not.toHaveBeenCalled();
  });

  it('lets a super admin create a featured universe', async () => {
    signIn(true);
    (prisma.universe.findUnique as jest.Mock).mockResolvedValue(null);
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({ id: OWNER });
    (prisma.universe.create as jest.Mock).mockResolvedValue({ id: UNIVERSE, slug: 'mine', featured: true });
    const response = await createUniverse(
      request('/api/admin/universes', 'POST', { slug: 'mine', name: 'Mine', ownerId: OWNER, featured: true }),
    );
    expect(response.status).not.toBe(403);
    expect(prisma.universe.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ featured: true }) }));
  });

  it('refuses an owner creating a featured world', async () => {
    signIn(false);
    const response = await createWorld(
      request('/api/admin/worlds', 'POST', { universeId: UNIVERSE, slug: 'w', name: 'W', featured: true }),
    );
    expect(response.status).toBe(403);
    expect(prisma.world.create).not.toHaveBeenCalled();
  });

  it('refuses an owner featuring their world, but saves an edit that leaves it as it was', async () => {
    signIn(false);
    (prisma.world.findUnique as jest.Mock).mockResolvedValue({
      id: 'w-1',
      slug: 'w',
      universeId: UNIVERSE,
      featured: false,
      universe: { ownerId: OWNER },
    });
    const refused = await updateWorld(request('/api/admin/worlds/w-1', 'PATCH', { featured: true }), params('w-1'));
    expect(refused.status).toBe(403);
    expect(prisma.world.update).not.toHaveBeenCalled();

    (prisma.world.update as jest.Mock).mockResolvedValue({ id: 'w-1', name: 'New name' });
    const saved = await updateWorld(request('/api/admin/worlds/w-1', 'PATCH', { name: 'New name', featured: false }), params('w-1'));
    expect(saved.status).toBe(200);
  });

  it('refuses an owner un-featuring their universe', async () => {
    signIn(false);
    (prisma.universe.findUnique as jest.Mock).mockResolvedValue({ id: UNIVERSE, slug: 'u', ownerId: OWNER, featured: true });
    const response = await updateUniverse(request(`/api/admin/universes/${UNIVERSE}`, 'PATCH', { featured: false }), params(UNIVERSE));
    expect(response.status).toBe(403);
    expect(prisma.universe.update).not.toHaveBeenCalled();
  });

  it('lists featured universes first in Space and Discover', async () => {
    signIn(false);
    (prisma.$queryRaw as jest.Mock).mockResolvedValue([]);
    (prisma.universe.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.favorite.groupBy as jest.Mock).mockResolvedValue([]);
    await listUniverses(new NextRequest('http://localhost:3333/api/admin/universes?scope=discover'));
    const sql = ((prisma.$queryRaw as jest.Mock).mock.calls[0][0] as TemplateStringsArray).join('?');
    expect(sql).toMatch(/ORDER BY u\.featured DESC, access_count DESC/);
  });
});
