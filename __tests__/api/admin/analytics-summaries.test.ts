import { NextRequest } from 'next/server';

jest.mock('@/lib/db', () => ({
  prisma: {
    roomAccess: { groupBy: jest.fn() },
    $queryRaw: jest.fn(),
  },
}));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn() }));
jest.mock('@/lib/auth', () => ({ validateAdminToken: jest.fn(() => false) }));

import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { GET } from '@/app/api/admin/analytics/summaries/route';

const db = prisma as unknown as { roomAccess: { groupBy: jest.Mock }; $queryRaw: jest.Mock };
const ME = { id: 'me', uuid: 'me-uuid', email: 'me@x.test', name: 'Me', tags: [], isSuperAdmin: false };

const get = (query: string) => GET(new NextRequest(`http://localhost:3333/api/admin/analytics/summaries?${query}`));
/** The SQL text of a tagged $queryRaw call (Prisma.Sql or a template strings array). */
const sqlOf = (call: unknown[]) => {
  const first = call[0] as { strings?: string[] } | TemplateStringsArray;
  return (Array.isArray(first) ? first : (first as { strings: string[] }).strings).join('?');
};

beforeEach(() => {
  jest.clearAllMocks();
  (getSessionUser as jest.Mock).mockResolvedValue(ME);
});

describe('GET /api/admin/analytics/summaries', () => {
  it('answers a whole list in a few queries: totals, this week, hour buckets, the latest visit and yours', async () => {
    db.roomAccess.groupBy
      .mockResolvedValueOnce([{ roomId: 'r1', _count: { _all: 12 } }])
      .mockResolvedValueOnce([{ roomId: 'r1', _count: { _all: 5 } }]);
    const latest = new Date('2026-09-20T10:00:00Z');
    const mine = new Date('2026-09-19T08:00:00Z');
    db.$queryRaw
      .mockResolvedValueOnce([
        { id: 'r1', hour: 3, count: 2 },
        { id: 'r1', hour: 16, count: BigInt(10) }, // COUNT(*) comes back as a bigint
      ])
      .mockResolvedValueOnce([{ id: 'r1', accessed_at: latest, user_id: 'someone', user_uuid: null }])
      .mockResolvedValueOnce([{ id: 'r1', accessed_at: mine, user_id: 'me', user_uuid: null }]);

    const response = await get('kind=rooms&ids=r1,r2');
    expect(response.status).toBe(200);
    const { summaries } = await response.json();

    expect(db.roomAccess.groupBy).toHaveBeenCalledTimes(2);
    expect(db.roomAccess.groupBy.mock.calls[0][0].where).toEqual({ roomId: { in: ['r1', 'r2'] } });
    // The second asks only for the last 7 days.
    expect(db.roomAccess.groupBy.mock.calls[1][0].where.roomId).toEqual({ in: ['r1', 'r2'] });
    expect(db.roomAccess.groupBy.mock.calls[1][0].where.accessedAt.gte).toBeInstanceOf(Date);
    expect(db.$queryRaw).toHaveBeenCalledTimes(3);
    expect(summaries.r1).toEqual({
      totalAccesses: 12,
      visitsThisWeek: 5,
      peakTimes: [
        { hour: 16, count: 10 },
        { hour: 3, count: 2 },
      ],
      lastVisitedByUser: { accessedAt: mine.toISOString(), userId: 'me', userUuid: null },
      // Time only: the answer never says who the latest visitor was.
      lastVisitedOverall: { accessedAt: latest.toISOString() },
      youWereLast: false,
    });
    // A place with no visits still gets an answer, with zeros.
    expect(summaries.r2).toEqual({ totalAccesses: 0, visitsThisWeek: 0, peakTimes: [], lastVisitedByUser: null, lastVisitedOverall: null, youWereLast: false });
  });

  it('says "you were last" by identity, and uses the column for the kind asked', async () => {
    db.roomAccess.groupBy.mockResolvedValue([]);
    db.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'w1', accessed_at: new Date(), user_id: null, user_uuid: 'me-uuid' }])
      .mockResolvedValueOnce([]);
    const { summaries } = await (await get('kind=worlds&ids=w1')).json();
    expect(summaries.w1.youWereLast).toBe(true);
    expect(db.roomAccess.groupBy.mock.calls[0][0].by).toEqual(['worldId']);
    expect(sqlOf(db.$queryRaw.mock.calls[0])).not.toContain('room_id');
  });

  it('refuses a bad kind, too many ids, and anyone signed out', async () => {
    expect((await get('kind=people&ids=a')).status).toBe(400);
    const many = Array.from({ length: 101 }, (_, i) => `r${i}`).join(',');
    expect((await get(`kind=rooms&ids=${many}`)).status).toBe(400);
    (getSessionUser as jest.Mock).mockResolvedValue(null);
    expect((await get('kind=rooms&ids=r1')).status).toBe(401);
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });

  it('asks nothing for an empty list', async () => {
    const { summaries } = await (await get('kind=rooms&ids=')).json();
    expect(summaries).toEqual({});
    expect(db.roomAccess.groupBy).not.toHaveBeenCalled();
  });
});
