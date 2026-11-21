/** What the game relay may write about a job's model calls, and who may: the bot server's token only (what is kept is tested against a real database in computer-giveback-db.test.ts). */
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/bots/[id]/computer-jobs/[jobId]/faults/route';
import { faultClassOf, recordFaults } from '@/lib/computer-faults';
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
    record.mockResolvedValue({ stored: 1, conflicts: 0 });
    const res = await call({ faults: [good] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, stored: 1, conflicts: 0 });
    // A row another run or turn of the job already holds under its call id is said, never dropped silently
    record.mockResolvedValue({ stored: 0, conflicts: 1 });
    expect(await (await call({ faults: [good] })).json()).toEqual({ ok: true, stored: 0, conflicts: 1 });
    expect(record).toHaveBeenCalledWith('brick-1', 'job-1', [expect.objectContaining({ callId: 'c1', reason: 'provider_key_ours', providerStatus: 402, at: new Date('2026-11-20T10:00:00.000Z') })]);
    expect(late).toHaveBeenCalledWith('job-1');
  });

  it('takes the relay’s row for a computer that could not reach it (reason relay_unreachable, route "unknown", turn 1, no status), as the game writes it, and the per-turn one', async () => {
    record.mockResolvedValue({ stored: 2, conflicts: 0 });
    const rows = [
      { callId: 'relay_unreachable', turn: 1, run: 'r-1', kind: 'fault', reason: 'relay_unreachable', source: 'universe-ai', route: 'unknown', providerStatus: null, at: '2026-11-21T00:00:00.000Z' },
      { callId: 'relay_unreachable_r-1_2', turn: 2, run: 'r-1', kind: 'fault', reason: 'relay_unreachable', source: 'universe-ai', route: 'unknown', providerStatus: null, at: '2026-11-21T00:00:01.000Z' },
    ];
    expect((await call({ faults: rows })).status).toBe(200);
    expect(record).toHaveBeenCalledWith('brick-1', 'job-1', [expect.objectContaining({ reason: 'relay_unreachable', route: 'unknown', turn: 1, providerStatus: null }), expect.objectContaining({ callId: 'relay_unreachable_r-1_2', turn: 2 })]);
    // Read as ours when the relay says fault (never the person's, never unresolved)
    expect(faultClassOf({ kind: 'fault', reason: 'relay_unreachable', source: 'universe-ai' })).toBe('ours');
    expect(faultClassOf({ kind: 'uncertain', reason: 'relay_unreachable', source: 'universe-ai' })).toBe('unresolved');
    expect(faultClassOf({ kind: 'fault', reason: 'relay_unreachable', source: 'own-key' })).toBe('ours');
  });

  it('takes the run a row’s turn was numbered in, up to 40 characters, and keeps none for a runner that names none', async () => {
    record.mockResolvedValue({ stored: 2 });
    expect((await call({ faults: [{ ...good, run: 'mi8x3k2a1b2c3d4e' }, { ...good, callId: 'c2' }] })).status).toBe(200);
    expect(record).toHaveBeenCalledWith('brick-1', 'job-1', [expect.objectContaining({ callId: 'c1', run: 'mi8x3k2a1b2c3d4e' }), expect.objectContaining({ callId: 'c2', run: null })]);
    for (const run of ['x'.repeat(41), '', 'has space']) expect((await call({ faults: [{ ...good, run }] })).status).toBe(400);
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
