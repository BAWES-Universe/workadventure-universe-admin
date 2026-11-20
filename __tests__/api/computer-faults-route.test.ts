/** What the game relay may write about a job's model calls, and who may: the bot server's token only (what is kept is tested against a real database in computer-giveback-db.test.ts). */
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/bots/[id]/computer-jobs/[jobId]/faults/route';
import { recordFaults } from '@/lib/computer-faults';
import { afterLateEvidence } from '@/lib/computer-giveback';
import { requireServiceToken } from '@/lib/service-tokens';

jest.mock('@/lib/service-tokens', () => ({ requireServiceToken: jest.fn() }));
jest.mock('@/lib/computer-faults', () => ({ ...jest.requireActual('@/lib/computer-faults'), recordFaults: jest.fn() }));
jest.mock('@/lib/computer-giveback', () => ({ afterLateEvidence: jest.fn() }));
jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));

const record = recordFaults as jest.Mock;
const late = afterLateEvidence as jest.Mock;
const auth = requireServiceToken as jest.Mock;
const params = { params: Promise.resolve({ id: 'brick-1', jobId: 'job-1' }) };
const call = (body: unknown) => POST(new NextRequest('http://localhost/api/bots/brick-1/computer-jobs/job-1/faults', { method: 'POST', body: JSON.stringify(body) }), params);
const good = { callId: 'c1', turn: 2, kind: 'fault', reason: 'provider_key_ours', source: 'universe-ai', route: 'universe-ai/m', providerStatus: 402, at: '2026-11-20T10:00:00.000Z' };

beforeEach(() => {
  jest.clearAllMocks();
  auth.mockImplementation(() => undefined);
  late.mockResolvedValue(undefined);
});

describe('POST /api/bots/:id/computer-jobs/:jobId/faults', () => {
  it('is for the bot server’s token only', async () => {
    auth.mockImplementation(() => {
      throw new Error('no');
    });
    expect((await call({ faults: [good] })).status).toBe(401);
    expect(record).not.toHaveBeenCalled();
  });

  it('keeps the rows for the Brick and job it is told and answers how many were new, then looks again at what was decided about the job', async () => {
    record.mockResolvedValue({ stored: 1 });
    const res = await call({ faults: [good] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, stored: 1 });
    expect(record).toHaveBeenCalledWith('brick-1', 'job-1', [expect.objectContaining({ callId: 'c1', reason: 'provider_key_ours', providerStatus: 402, at: new Date('2026-11-20T10:00:00.000Z') })]);
    expect(late).toHaveBeenCalledWith('job-1');
  });

  it('knows no job that is not the Brick’s', async () => {
    record.mockResolvedValue(null);
    expect((await call({ faults: [good] })).status).toBe(404);
    expect(late).not.toHaveBeenCalled();
  });

  it('refuses what is not shaped as the relay writes it: an unknown kind or source, a reason with spaces, no rows, too many rows', async () => {
    for (const body of [
      { faults: [{ ...good, kind: 'maybe' }] },
      { faults: [{ ...good, source: 'elsewhere' }] },
      { faults: [{ ...good, reason: 'has spaces' }] },
      { faults: [] },
      { faults: Array.from({ length: 51 }, () => good) },
      { faults: [{ ...good, at: 'not a date' }] },
      {},
    ]) {
      expect((await call(body)).status).toBe(400);
    }
    expect(record).not.toHaveBeenCalled();
  });

  it('keeps the rows even when judging the job again fails', async () => {
    record.mockResolvedValue({ stored: 2 });
    late.mockRejectedValue(new Error('down'));
    expect((await call({ faults: [good, { ...good, callId: 'c2' }] })).status).toBe(200);
  });
});
