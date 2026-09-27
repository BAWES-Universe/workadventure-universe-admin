/**
 * The analytics routes answer "was the latest visitor you?" by identity, on the server, and bucket every access by
 * UTC hour for the peak, without showing who visited to viewers who may not see it.
 */
import { NextRequest } from 'next/server';

jest.mock('@/lib/db', () => ({
  prisma: {
    universe: { findUnique: jest.fn() },
    world: { findUnique: jest.fn() },
    room: { findUnique: jest.fn() },
    worldMember: { findFirst: jest.fn() },
    roomAccess: { count: jest.fn(), findMany: jest.fn(), findFirst: jest.fn(), groupBy: jest.fn() },
    $queryRaw: jest.fn(),
  },
}));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn() }));
jest.mock('@/lib/bot-permissions', () => ({ canManageBots: jest.fn() }));
jest.mock('@/lib/woka-avatar', () => ({ withWokas: async <T,>(rows: T) => rows }));

import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { canManageBots } from '@/lib/bot-permissions';
import { GET as roomAnalytics } from '@/app/api/admin/analytics/rooms/[id]/route';
import { GET as worldAnalytics } from '@/app/api/admin/analytics/worlds/[id]/route';
import { GET as universeAnalytics } from '@/app/api/admin/analytics/universes/[id]/route';
import { busiestUtcHour, formatPeak, localHourFromUtc, utcHourBuckets } from '@/lib/analytics-peak';

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;

const SESSIONS: Record<string, { id: string; uuid: string; isSuperAdmin: boolean }> = {
  alice: { id: 'u-alice', uuid: 'uuid-alice', isSuperAdmin: false },
  bob: { id: 'u-bob', uuid: 'uuid-bob', isSuperAdmin: false },
};

const req = (url: string, as: string) =>
  new NextRequest(`http://localhost:3333${url}`, { headers: { Authorization: `Bearer session-${as}` } });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

// Bob made the latest visit; Alice visited at exactly the same moment, earlier in the log.
const LATEST = { accessedAt: new Date('2026-09-01T10:00:00Z'), userId: 'u-bob', userUuid: 'uuid-bob', userName: 'Bob', userEmail: 'bob@example.test' };
const TIMES = ['2026-09-01T16:05:00Z', '2026-09-02T16:30:00Z', '2026-09-03T09:00:00Z'].map((at) => ({ accessedAt: new Date(at) }));

beforeEach(() => {
  jest.clearAllMocks();
  (getSessionUser as jest.Mock).mockImplementation(async (request: NextRequest) => {
    const name = (request.headers.get('authorization') || '').replace('Bearer session-', '');
    return SESSIONS[name] ?? null;
  });
  db.roomAccess.count.mockResolvedValue(3);
  // The database's count per UTC hour for TIMES, in no particular order.
  (db.$queryRaw as unknown as jest.Mock).mockResolvedValue([
    { hour: 9, count: 1 },
    { hour: 16, count: 2 },
  ]);
  db.roomAccess.groupBy.mockResolvedValue([]);
  db.roomAccess.findMany.mockImplementation(async (args: { distinct?: unknown; select?: Record<string, unknown> }) => {
    if (args?.distinct) return [];
    // Loading every access just for the peak is what the route must not do.
    if (args?.select && Object.keys(args.select).join() === 'accessedAt') throw new Error('loaded every access row');
    return [];
  });
  db.roomAccess.findFirst.mockImplementation(async (args: { where: { OR?: unknown } }) =>
    args.where.OR ? { ...LATEST, userId: 'u-alice', userUuid: 'uuid-alice' } : LATEST,
  );
  db.world.findUnique.mockResolvedValue({ universe: { ownerId: 'u-owner' } });
  db.universe.findUnique.mockResolvedValue({ ownerId: 'u-owner' });
  db.worldMember.findFirst.mockResolvedValue(null);
  (canManageBots as jest.Mock).mockResolvedValue(false);
});

describe.each([
  ['rooms', roomAnalytics],
  ['worlds', worldAnalytics],
  ['universes', universeAnalytics],
] as const)('%s analytics', (kind, GET) => {
  it('says you were last only when the latest record is yours, never from equal timestamps', async () => {
    const alice = await (await GET(req(`/api/admin/analytics/${kind}/x`, 'alice'), params('x'))).json();
    expect(alice.youWereLast).toBe(false);
    // Alice's own last visit has the same timestamp, and she still sees no one else's identity.
    expect(alice.lastVisitedByUser.accessedAt).toBe(alice.lastVisitedOverall.accessedAt);
    expect(Object.keys(alice.lastVisitedOverall)).toEqual(['accessedAt']);

    const bob = await (await GET(req(`/api/admin/analytics/${kind}/x`, 'bob'), params('x'))).json();
    expect(bob.youWereLast).toBe(true);
  });

  it('returns every access bucketed by UTC hour, busiest first, counted in the database', async () => {
    const body = await (await GET(req(`/api/admin/analytics/${kind}/x`, 'alice'), params('x'))).json();
    const sql = ((db.$queryRaw as unknown as jest.Mock).mock.calls[0][0] as TemplateStringsArray).join('?');
    expect(sql).toMatch(/GROUP BY/);
    expect(body.peakTimes).toEqual([
      { hour: 16, count: 2 },
      { hour: 9, count: 1 },
    ]);
  });
});

describe('peak', () => {
  it('has one definition: the busiest all-time UTC bucket, shown on the viewer’s clock', () => {
    expect(utcHourBuckets(TIMES.map((t) => t.accessedAt))[0]).toEqual({ hour: 16, count: 2 });
    expect(busiestUtcHour([{ hour: 3, count: 1 }, { hour: 16, count: 9 }])).toBe(16);
    expect(busiestUtcHour([])).toBeNull();
    expect(busiestUtcHour(undefined)).toBeNull();
    const now = new Date('2026-09-27T12:00:00Z');
    const local = localHourFromUtc(16, now);
    const expected = new Date(Date.UTC(2026, 8, 27, 16)).getHours();
    expect(local).toBe(expected);
    expect(formatPeak([{ hour: 16, count: 9 }], now)).toBe(`${expected % 12 || 12} ${expected < 12 ? 'AM' : 'PM'}`);
    expect(formatPeak([{ hour: 16, count: 9 }], now)).not.toMatch(/UTC/);
  });
});
