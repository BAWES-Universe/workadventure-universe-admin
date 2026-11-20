/** The operations view of computer give-backs and the one-incident correction: super admins only. What they compute is tested against a real database in computer-giveback-db.test.ts. */
import { NextRequest } from 'next/server';
import { GET } from '@/app/api/admin/computer/give-backs/route';
import { POST } from '@/app/api/admin/computer/give-backs/correct/route';
import { getSessionUser } from '@/lib/auth-session';
import { isSuperAdmin } from '@/lib/super-admin';
import { correctRouteTogether, giveBackOverview } from '@/lib/computer-fault-ops';

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
    overview.mockResolvedValue({ at: 'now', settingsProblems: [], decisions: [], pending: { jobs: 0, costMicros: 0, oldestAt: null, oldestMinutes: null }, routes: [] });
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('corrects a route between two times, and refuses a body that is not that', async () => {
    correct.mockResolvedValue({ corrected: 2, costMicros: 9000 });
    const res = await post({ route: 'universe-ai/m', from: '2026-11-20T00:00:00Z', to: '2026-11-20T01:00:00Z' });
    expect(await res.json()).toEqual({ corrected: 2, costMicros: 9000 });
    expect(correct).toHaveBeenCalledWith({ route: 'universe-ai/m', from: new Date('2026-11-20T00:00:00Z'), to: new Date('2026-11-20T01:00:00Z') });
    for (const body of [{}, { route: 'r', from: 'x', to: 'y' }, { route: 'r', from: '2026-11-20T02:00:00Z', to: '2026-11-20T01:00:00Z' }, { route: 'r', from: '2026-11-20T00:00:00Z', to: '2026-11-20T01:00:00Z', extra: 1 }]) {
      expect((await post(body)).status).toBe(400);
    }
    expect(correct).toHaveBeenCalledTimes(1);
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
