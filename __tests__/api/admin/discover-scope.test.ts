/**
 * Discover lists only what anyone may see, filtered before paging: a room needs its world and universe public too
 * (as canSeeRoom), a world its universe; the built-in default room never shows.
 */
import { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';

jest.mock('@/lib/db', () => ({
  prisma: {
    $queryRaw: jest.fn(),
    room: { findMany: jest.fn(), count: jest.fn() },
    world: { findMany: jest.fn(), count: jest.fn() },
    favorite: { groupBy: jest.fn() },
  },
}));
jest.mock('@/lib/auth', () => ({ requireAuth: jest.fn() }));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn() }));

import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { GET as listRooms } from '@/app/api/admin/rooms/route';
import { GET as listWorlds } from '@/app/api/admin/worlds/route';

const db = prisma as unknown as { $queryRaw: jest.Mock; room: Record<string, jest.Mock>; world: Record<string, jest.Mock>; favorite: Record<string, jest.Mock> };

/** The full SQL of a $queryRaw call, nested Prisma.sql fragments included. */
function sqlOf(call: unknown[]): string {
  const [first, ...values] = call as [TemplateStringsArray | Prisma.Sql, ...unknown[]];
  return Array.isArray(first) ? Prisma.sql(first as TemplateStringsArray, ...values).sql : (first as Prisma.Sql).sql;
}

beforeEach(() => {
  jest.clearAllMocks();
  (getSessionUser as jest.Mock).mockResolvedValue({ id: 'me', uuid: 'me', isSuperAdmin: false });
  db.$queryRaw.mockImplementation(async (...args: unknown[]) => {
    const text = sqlOf(args);
    return text.includes('COUNT(') && !text.includes('access_count') ? [{ count: BigInt(0) }] : [];
  });
  db.room.findMany.mockResolvedValue([]);
  db.world.findMany.mockResolvedValue([]);
  db.favorite.groupBy.mockResolvedValue([]);
});

describe('Discover', () => {
  it('lists a room only when it, its world and its universe are public, never the default room', async () => {
    const response = await listRooms(new NextRequest('http://localhost:3333/api/admin/rooms?scope=discover&page=2&limit=12&search=lobby'));
    expect(response.status).toBe(200);
    const statements = db.$queryRaw.mock.calls.map(sqlOf);
    expect(statements).toHaveLength(2);
    for (const sql of statements) {
      expect(sql).toMatch(/r\.is_public = true AND w\.is_public = true AND u\.is_public = true/);
      expect(sql).toMatch(/NOT \(u\.slug = 'default' AND w\.slug = 'default' AND r\.slug = 'default'\)/);
      expect(sql).toContain('ILIKE');
    }
  });

  it('lists a world only when its universe is public too', async () => {
    const response = await listWorlds(new NextRequest('http://localhost:3333/api/admin/worlds?scope=discover&page=1&limit=12'));
    expect(response.status).toBe(200);
    const statements = db.$queryRaw.mock.calls.map(sqlOf);
    expect(statements.length).toBeGreaterThanOrEqual(2);
    for (const sql of statements) expect(sql).toContain('w.is_public = true AND u.is_public = true');
  });
});
