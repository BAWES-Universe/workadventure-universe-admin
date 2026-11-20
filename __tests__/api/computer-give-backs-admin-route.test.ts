/** The operations view of computer give-backs and the one-incident correction: super admins only. What they compute is tested against a real database in computer-giveback-db.test.ts. */
import { NextRequest } from 'next/server';
import { GET } from '@/app/api/admin/computer/give-backs/route';
import { POST } from '@/app/api/admin/computer/give-backs/correct/route';
import { getSessionUser } from '@/lib/auth-session';
import { isSuperAdmin } from '@/lib/super-admin';
import { correctRouteTogether, giveBackOverview } from '@/lib/computer-fault-ops';
import type { correctRouteTogether as correctRouteTogetherReal, giveBackOverview as giveBackOverviewReal } from '@/lib/computer-fault-ops';

jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn() }));
jest.mock('@/lib/super-admin', () => ({ isSuperAdmin: jest.fn() }));
jest.mock('@/lib/computer-fault-ops', () => ({ giveBackOverview: jest.fn(), correctRouteTogether: jest.fn() }));
jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));

const session = getSessionUser as jest.Mock;
const admin = isSuperAdmin as jest.Mock;
const overview = giveBackOverview as jest.Mock;
const correct = correctRouteTogether as jest.Mock;
const post = (body: unknown) => POST(new NextRequest('http://localhost/api/admin/computer/give-backs/correct', { method: 'POST', body: JSON.stringify(body) }));
const get = () => GET(new NextRequest('http://localhost/api/admin/computer/give-backs'));

beforeEach(() => {
  jest.clearAllMocks();
  session.mockResolvedValue({ id: 'u1', email: 'root@example.test' });
  admin.mockReturnValue(true);
});

describe('computer give-backs for operations', () => {
  it('shows nothing to anyone who is not a super admin', async () => {
    admin.mockReturnValue(false);
    expect((await get()).status).toBe(403);
    expect((await post({ route: 'r', from: '2026-11-20T00:00:00Z', to: '2026-11-20T01:00:00Z' })).status).toBe(403);
    session.mockResolvedValue(null);
    expect((await get()).status).toBe(403);
    expect(overview).not.toHaveBeenCalled();
    expect(correct).not.toHaveBeenCalled();
  });

  it('gives a super admin the overview without caching it', async () => {
    const shown: Awaited<ReturnType<typeof giveBackOverviewReal>> = {
      at: 'now',
      settingsProblems: [],
      decisions: [],
      pending: { jobs: 0, costMicros: 0, oldestAt: null, oldestMinutes: null },
      routes: [],
      refunds: { count: 1, amountMicros: 5000, oldestAt: '2026-11-20T08:00:00.000Z', oldestMinutes: 90, overdue: 1 },
    };
    overview.mockResolvedValue(shown);
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    // What the route sends is the whole overview, the refunds owed included
    expect(await res.json()).toEqual(shown);
  });

  it('corrects a route between two times, and refuses a body that is not that', async () => {
    const corrected: Awaited<ReturnType<typeof correctRouteTogetherReal>> = { corrected: 2, uncounted: 1, costMicros: 9000 };
    correct.mockResolvedValue(corrected);
    const res = await post({ route: 'universe-ai/m', from: '2026-11-20T00:00:00Z', to: '2026-11-20T01:00:00Z' });
    expect(await res.json()).toEqual(corrected);
    expect(correct).toHaveBeenCalledWith({ route: 'universe-ai/m', from: new Date('2026-11-20T00:00:00Z'), to: new Date('2026-11-20T01:00:00Z') });
    // A bound that is not an ISO timestamp string never becomes a date: null (the start of 1970 for a coercing date), a number, a bare year, a date with no time
    for (const bad of [null, 0, 1_700_000_000_000, '', '0', '2026', '2026-11-20', 'x', true]) {
      expect((await post({ route: 'r', from: bad, to: '2026-11-20T01:00:00Z' })).status).toBe(400);
      expect((await post({ route: 'r', from: '2026-11-20T00:00:00Z', to: bad })).status).toBe(400);
    }
    expect((await post({ route: 'r', from: '2026-11-20T00:00:00.5+03:00', to: '2026-11-20T01:00:00.250Z' })).status).toBe(200);
    // More than milliseconds is refused, not cut: a range from .0009 to .0001 inside one second would reverse after the cut and pass the order check
    for (const fine of ['2026-11-20T00:00:00.0009Z', '2026-11-20T00:00:00.123456789+03:00']) {
      expect((await post({ route: 'r', from: fine, to: '2026-11-20T01:00:00Z' })).status).toBe(400);
      expect((await post({ route: 'r', from: '2026-11-20T00:00:00Z', to: fine })).status).toBe(400);
    }
    expect((await post({ route: 'r', from: '2026-11-20T00:00:00.001Z', to: '2026-11-20T00:00:00.001Z' })).status).toBe(200);
    // A date that is not on the calendar is refused, not moved to the next month (a leap day only in a leap year); offsets stay accepted
    for (const impossible of ['2026-02-30T00:00:00Z', '2026-02-29T00:00:00Z', '2026-04-31T00:00:00+03:00', '2026-13-01T00:00:00Z', '2026-00-10T00:00:00Z', '2026-11-00T00:00:00Z', '2026-11-20T24:00:00Z', '2026-11-20T23:60:00Z', '2026-11-20T23:59:60Z']) {
      expect((await post({ route: 'r', from: impossible, to: '2027-01-01T00:00:00Z' })).status).toBe(400);
      expect((await post({ route: 'r', from: '2026-01-01T00:00:00Z', to: impossible })).status).toBe(400);
    }
    expect((await post({ route: 'r', from: '2028-02-29T00:00:00Z', to: '2028-03-01T00:00:00-05:30' })).status).toBe(200);
    correct.mockClear();
    for (const body of [{}, { route: 'r', from: 'x', to: 'y' }, { route: 'r', from: '2026-11-20T02:00:00Z', to: '2026-11-20T01:00:00Z' }, { route: 'r', from: '2026-11-20T00:00:00Z', to: '2026-11-20T01:00:00Z', extra: 1 }]) {
      expect((await post(body)).status).toBe(400);
    }
    expect(correct).not.toHaveBeenCalled();
  });
});

import { GET as refundsGet } from '@/app/api/admin/computer/refund-obligations/route';
import { POST as refundsRetry } from '@/app/api/admin/computer/refund-obligations/retry/route';
import { refundOverview, retryRefundObligation } from '@/lib/computer-refunds';

jest.mock('@/lib/computer-refunds', () => ({ refundOverview: jest.fn(), retryRefundObligation: jest.fn() }));

describe('owed refunds for support', () => {
  const retry = (body: unknown) => refundsRetry(new NextRequest('http://localhost/api/admin/computer/refund-obligations/retry', { method: 'POST', body: JSON.stringify(body) }));

  it('shows nothing to anyone who is not a super admin', async () => {
    admin.mockReturnValue(false);
    expect((await refundsGet(new NextRequest('http://localhost/api/admin/computer/refund-obligations'))).status).toBe(403);
    expect((await retry({ holdKey: 'h' })).status).toBe(403);
    expect(refundOverview).not.toHaveBeenCalled();
    expect(retryRefundObligation).not.toHaveBeenCalled();
  });

  it('lists what is owed for a super admin, and retries one by its hold key (404 for one that is not owed)', async () => {
    (refundOverview as jest.Mock).mockResolvedValue({ owed: { count: 1, amountMicros: 30000, oldestAt: null, oldestMinutes: 5, overdue: 0 }, rows: [] });
    const list = await refundsGet(new NextRequest('http://localhost/api/admin/computer/refund-obligations'));
    expect(list.status).toBe(200);
    expect(list.headers.get('Cache-Control')).toBe('no-store');
    (retryRefundObligation as jest.Mock).mockResolvedValueOnce({ found: true, result: 'acknowledged' }).mockResolvedValueOnce({ found: false, result: 'none' });
    const done = await retry({ holdKey: 'computer:credit:x' });
    expect(done.status).toBe(200);
    expect(await done.json()).toEqual({ found: true, result: 'acknowledged' });
    expect((await retry({ holdKey: 'nope' })).status).toBe(404);
    expect((await retry({})).status).toBe(400);
    expect((await retry({ holdKey: 'h', extra: 1 })).status).toBe(400);
  });
});
