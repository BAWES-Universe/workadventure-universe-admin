/** A public universe's place this week, by visits among public universes: counts only, and nothing for a private one. */
import { NextRequest } from 'next/server';

jest.mock('@/lib/db', () => ({
  prisma: {
    universe: { findMany: jest.fn() },
    roomAccess: { groupBy: jest.fn() },
  },
}));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn() }));

import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { GET } from '@/app/api/admin/universes/[id]/rank/route';

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;

const rank = async (id: string) => {
  const response = await GET(new NextRequest(`http://localhost/api/admin/universes/${id}/rank`), { params: Promise.resolve({ id }) });
  return { status: response.status, body: await response.json() };
};

beforeEach(() => {
  jest.clearAllMocks();
  (getSessionUser as jest.Mock).mockResolvedValue({ id: 'me', uuid: 'me-uuid', email: 'm@x.test', name: 'Me', tags: [], isSuperAdmin: false });
  db.universe.findMany.mockResolvedValue([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
});

describe('GET /api/admin/universes/[id]/rank', () => {
  it('ranks a public universe by this week\'s visits among public universes', async () => {
    db.roomAccess.groupBy.mockResolvedValue([
      { universeId: 'a', _count: { _all: 50 } },
      { universeId: 'b', _count: { _all: 30 } },
      { universeId: 'c', _count: { _all: 5 } },
    ]);
    expect((await rank('b')).body).toEqual({ rank: { position: 2, of: 3 } });
    const where = db.roomAccess.groupBy.mock.calls[0][0].where;
    expect(where.universeId).toEqual({ in: ['a', 'b', 'c'] });
    expect(where.accessedAt.gte).toBeInstanceOf(Date);
  });

  it('gives tied universes the better place', async () => {
    db.roomAccess.groupBy.mockResolvedValue([
      { universeId: 'a', _count: { _all: 9 } },
      { universeId: 'b', _count: { _all: 9 } },
    ]);
    expect((await rank('b')).body.rank.position).toBe(1);
  });

  it('says nothing for a private universe, or one nobody visited this week', async () => {
    expect((await rank('private-one')).body).toEqual({ rank: null });
    expect(db.roomAccess.groupBy).not.toHaveBeenCalled();
    db.roomAccess.groupBy.mockResolvedValue([{ universeId: 'a', _count: { _all: 4 } }]);
    expect((await rank('c')).body).toEqual({ rank: null });
  });

  it('refuses anyone signed out', async () => {
    (getSessionUser as jest.Mock).mockResolvedValue(null);
    expect((await rank('a')).status).toBe(401);
  });
});
