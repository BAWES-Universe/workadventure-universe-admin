/**
 * GET /api/admin/users does its filtering, ordering, counting and paging in the database: one count, one page query
 * (ordered by access aggregates, with LIMIT/OFFSET), then only that page's users and Wokas are loaded.
 */
import { NextRequest } from 'next/server';

jest.mock('@/lib/db', () => ({
  prisma: {
    $queryRaw: jest.fn(),
    user: { findMany: jest.fn(), count: jest.fn() },
    roomAccess: { findMany: jest.fn(), groupBy: jest.fn() },
  },
}));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn() }));
jest.mock('@/lib/woka-avatar', () => ({ wokaLayersForMany: jest.fn() }));

import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { wokaLayersForMany } from '@/lib/woka-avatar';
import { GET } from '@/app/api/admin/users/route';

const db = prisma as unknown as {
  $queryRaw: jest.Mock;
  user: { findMany: jest.Mock; count: jest.Mock };
  roomAccess: { findMany: jest.Mock; groupBy: jest.Mock };
};
const session = getSessionUser as jest.Mock;
const wokas = wokaLayersForMany as jest.Mock;

const alice = { id: 'u-alice', uuid: 'uuid-alice', email: 'alice@example.test', name: 'Alice', tags: [], isSuperAdmin: false };
const root = { id: 'u-root', uuid: 'uuid-root', email: 'root@example.test', name: 'Root', tags: [], isSuperAdmin: true };

type Row = { id: string; uuid: string; email: string | null; name: string | null; isGuest: boolean; createdAt: Date; _count: { ownedUniverses: number; worldMemberships: number } };
const ROWS: Row[] = [
  { id: 'u-1', uuid: 'uuid-1', email: 'one@example.test', name: 'One', isGuest: false, createdAt: new Date('2026-01-01T00:00:00Z'), _count: { ownedUniverses: 1, worldMemberships: 2 } },
  { id: 'u-2', uuid: 'uuid-2', email: null, name: 'Two', isGuest: true, createdAt: new Date('2026-02-01T00:00:00Z'), _count: { ownedUniverses: 0, worldMemberships: 0 } },
];

function request(query = '', as: 'alice' | 'root' | 'admin-token' = 'root') {
  const authorization = as === 'admin-token' ? `Bearer ${process.env.ADMIN_API_TOKEN}` : `Bearer session-${as}`;
  return new NextRequest(`http://orbit.test/api/admin/users${query}`, { headers: { authorization } });
}

/** Mimic Prisma's root `select` for the page's users, returning them in an arbitrary (reversed) order. */
function findManyForPage(args: { where: { id: { in: string[] } }; select: Record<string, unknown> }) {
  return ROWS.filter((row) => args.where.id.in.includes(row.id))
    .reverse()
    .map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => args.select[key])));
}

/** The page query as sent to Postgres (`text` has the `$n` placeholders) and its bound values. */
const pageQuery = () => {
  const query = db.$queryRaw.mock.calls[0][0] as { text: string; values: unknown[] };
  return { sql: query.text, values: query.values };
};

beforeEach(() => {
  jest.resetAllMocks();
  process.env.ADMIN_API_TOKEN = 'test-admin-token';
  session.mockImplementation(async (req: NextRequest) => {
    const auth = req.headers.get('authorization') || '';
    return ({ 'Bearer session-alice': alice, 'Bearer session-root': root } as Record<string, unknown>)[auth] ?? null;
  });
  db.user.count.mockResolvedValue(123);
  db.$queryRaw.mockResolvedValue([
    { id: 'u-2', last_accessed: new Date('2026-09-01T10:00:00Z'), total_accesses: BigInt(7) },
    { id: 'u-1', last_accessed: null, total_accesses: BigInt(0) },
  ]);
  db.user.findMany.mockImplementation(async (args) => findManyForPage(args));
  wokas.mockResolvedValue(new Map([['u-2', ['layer-a', 'layer-b']]]));
});

describe('GET /api/admin/users', () => {
  it('pushes page and limit to the database as LIMIT/OFFSET and takes the total from a count', async () => {
    const res = await GET(request('?page=3&limit=20'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(db.user.count).toHaveBeenCalledTimes(1);
    expect(db.$queryRaw).toHaveBeenCalledTimes(1);
    const { sql, values } = pageQuery();
    expect(sql).toMatch(/LIMIT \$\d+ OFFSET \$\d+/);
    expect(values.slice(-2)).toEqual([20, 40]);
    expect(sql).toMatch(/ORDER BY last_accessed DESC NULLS LAST, total_accesses DESC, m\.created_at DESC, m\.id ASC/);
    expect(body.pagination).toEqual({ page: 3, limit: 20, total: 123, totalPages: 7 });
  });

  it('never loads accesses into the app, and loads only the page’s users and Wokas', async () => {
    await GET(request('?limit=2'));

    expect(db.roomAccess.findMany).not.toHaveBeenCalled();
    expect(db.roomAccess.groupBy).not.toHaveBeenCalled();
    expect(db.user.findMany).toHaveBeenCalledTimes(1);
    expect(db.user.findMany.mock.calls[0][0].where).toEqual({ id: { in: ['u-2', 'u-1'] } });
    expect(wokas).toHaveBeenCalledWith(['u-2', 'u-1']);
    // Access aggregates are computed in SQL, restricted to the matching users.
    const { sql } = pageQuery();
    expect(sql).toMatch(/WHERE ra\.user_id IN \(SELECT id FROM matched\)/);
    expect(sql).toMatch(/WHERE ra\.user_uuid IN \(SELECT uuid FROM matched\)/);
  });

  it('keeps the database order and returns the fields the list pages read', async () => {
    const body = await (await GET(request())).json();

    expect(body.users.map((u: { id: string }) => u.id)).toEqual(['u-2', 'u-1']);
    expect(body.users[0]).toEqual({
      id: 'u-2',
      uuid: 'uuid-2',
      email: null,
      name: 'Two',
      isGuest: true,
      createdAt: '2026-02-01T00:00:00.000Z',
      _count: { ownedUniverses: 0, worldMemberships: 0 },
      totalAccesses: 7,
      lastAccessed: '2026-09-01T10:00:00.000Z',
      woka: ['layer-a', 'layer-b'],
    });
    expect(body.users[1]).toMatchObject({ id: 'u-1', totalAccesses: 0, lastAccessed: null, woka: [] });
  });

  it('defaults to page 1 of 50 and clamps limit to 1..200 and page to at least 1', async () => {
    await GET(request());
    expect(pageQuery().values.slice(-2)).toEqual([50, 0]);

    for (const [query, limit, offset] of [
      ['?limit=5000&page=2', 200, 200],
      ['?limit=0&page=0', 1, 0],
      ['?limit=-3&page=-9', 1, 0],
      ['?limit=abc&page=xyz', 50, 0],
    ] as const) {
      db.$queryRaw.mockClear();
      const body = await (await GET(request(query))).json();
      expect(pageQuery().values.slice(-2)).toEqual([limit, offset]);
      expect(body.pagination.limit).toBe(limit);
      expect(body.pagination.page).toBe(offset / limit + 1);
    }
  });

  it('returns an empty page without loading users when the page is past the end', async () => {
    db.$queryRaw.mockResolvedValue([]);
    db.user.count.mockResolvedValue(3);
    const body = await (await GET(request('?page=9&limit=2'))).json();

    expect(body).toEqual({ users: [], pagination: { page: 9, limit: 2, total: 3, totalPages: 2 } });
    expect(db.user.findMany).not.toHaveBeenCalled();
    expect(wokas).not.toHaveBeenCalled();
  });

  it('searches name, email and uuid case-insensitively for privileged viewers, in the count and the page', async () => {
    await GET(request('?search=Bob', 'admin-token'));

    expect(db.user.count.mock.calls[0][0].where).toEqual({
      OR: [
        { name: { contains: 'Bob', mode: 'insensitive' } },
        { email: { contains: 'Bob', mode: 'insensitive' } },
        { uuid: { contains: 'Bob', mode: 'insensitive' } },
      ],
    });
    const { sql, values } = pageQuery();
    expect(sql).toMatch(/\(u\.name ILIKE \$1 OR u\.email ILIKE \$2 OR u\.uuid ILIKE \$3\)/);
    expect(values.slice(0, 3)).toEqual(['%Bob%', '%Bob%', '%Bob%']);
    expect(sql).not.toMatch(/system@workadventure\.local|<>/);
  });

  it('non-privileged viewers: no email in results, no searching by email, no system account', async () => {
    const body = await (await GET(request('?search=example', 'alice'))).json();

    // The count filters the same way…
    expect(db.user.count.mock.calls[0][0].where).toEqual({
      AND: [
        {
          OR: [
            { name: { contains: 'example', mode: 'insensitive' } },
            { uuid: { contains: 'example', mode: 'insensitive' } },
          ],
        },
        { OR: [{ email: null }, { email: { not: 'system@workadventure.local' } }] },
      ],
    });
    // …as the page query.
    const { sql, values } = pageQuery();
    expect(sql).not.toMatch(/u\.email ILIKE/);
    expect(sql).toMatch(/\(u\.name ILIKE \$1 OR u\.uuid ILIKE \$2\)/);
    expect(sql).toMatch(/\(u\.email IS NULL OR u\.email <> \$3\)/);
    expect(values[2]).toBe('system@workadventure.local');
    // Email is never selected, so never returned.
    expect(db.user.findMany.mock.calls[0][0].select.email).toBe(false);
    for (const user of body.users) expect(user).not.toHaveProperty('email');
    expect(body.users[1].name).toBe('One');
  });

  it('guests=exclude leaves guests out of both the count and the page', async () => {
    await GET(request('?page=1&limit=5&guests=exclude&search=Bo', 'root'));

    expect(db.user.count.mock.calls[0][0].where).toEqual({
      AND: [
        {
          OR: [
            { name: { contains: 'Bo', mode: 'insensitive' } },
            { email: { contains: 'Bo', mode: 'insensitive' } },
            { uuid: { contains: 'Bo', mode: 'insensitive' } },
          ],
        },
        { isGuest: false },
      ],
    });
    expect(pageQuery().sql).toMatch(/WHERE \(u\.name ILIKE \$1 OR u\.email ILIKE \$2 OR u\.uuid ILIKE \$3\) AND u\.is_guest = false\s/);
  });

  it('guests=exclude also applies for non-privileged viewers, with no search', async () => {
    await GET(request('?guests=exclude', 'alice'));

    expect(db.user.count.mock.calls[0][0].where).toEqual({
      AND: [{ AND: [{}, { OR: [{ email: null }, { email: { not: 'system@workadventure.local' } }] }] }, { isGuest: false }],
    });
    expect(pageQuery().sql).toMatch(/WHERE \(u\.email IS NULL OR u\.email <> \$1\) AND u\.is_guest = false\s/);
  });

  it('includes guests by default and for any other guests value', async () => {
    for (const query of ['', '?guests=include', '?guests=']) {
      db.user.count.mockClear();
      db.$queryRaw.mockClear();
      await GET(request(query, 'root'));
      expect(db.user.count.mock.calls[0][0].where).toEqual({});
      expect(pageQuery().sql).not.toMatch(/is_guest/);
      expect(pageQuery().sql).toMatch(/FROM users u\s+\)/);
    }
  });

  it('privileged viewers see email', async () => {
    const body = await (await GET(request('', 'root'))).json();
    expect(db.user.findMany.mock.calls[0][0].select.email).toBe(true);
    expect(body.users[1].email).toBe('one@example.test');
  });

  it('a missing Woka never fails the list', async () => {
    wokas.mockRejectedValue(new Error('avatars down'));
    const res = await GET(request());
    expect(res.status).toBe(200);
    expect((await res.json()).users.map((u: { woka: string[] }) => u.woka)).toEqual([[], []]);
  });

  it('leaves off a user deleted between the page query and the load', async () => {
    db.user.findMany.mockImplementation(async (args) => findManyForPage(args).filter((u) => u.id !== 'u-1'));
    const body = await (await GET(request())).json();
    expect(body.users.map((u: { id: string }) => u.id)).toEqual(['u-2']);
  });

  it('401s anonymous callers without touching the database', async () => {
    const res = await GET(new NextRequest('http://orbit.test/api/admin/users'));
    expect(res.status).toBe(401);
    expect(db.user.count).not.toHaveBeenCalled();
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });
});
