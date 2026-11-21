/** What the game relay may write about a job's model calls, and who may: the bot server's token only (what is kept is tested against a real database in computer-giveback-db.test.ts). */
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/bots/[id]/computer-jobs/[jobId]/faults/route';
import { faultClassOf, recordFaults } from '@/lib/computer-faults';
import { afterArrival, afterLateEvidence } from '@/lib/computer-giveback';
import { requireServiceToken } from '@/lib/service-tokens';
import * as Sentry from '@sentry/nextjs';

jest.mock('@/lib/service-tokens', () => ({ requireServiceToken: jest.fn() }));
jest.mock('@/lib/computer-faults', () => ({ ...jest.requireActual('@/lib/computer-faults'), recordFaults: jest.fn() }));
jest.mock('@/lib/computer-giveback', () => ({ afterLateEvidence: jest.fn(), afterArrival: jest.fn() }));
jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn(), captureMessage: jest.fn() }));

const record = recordFaults as jest.Mock;
const warned = Sentry.captureMessage as jest.Mock;
const late = afterLateEvidence as jest.Mock;
const arrived = afterArrival as jest.Mock;
const auth = requireServiceToken as jest.Mock;
const params = { params: Promise.resolve({ id: 'brick-1', jobId: 'job-1' }) };
const call = (body: unknown) => POST(new NextRequest('http://localhost/api/bots/brick-1/computer-jobs/job-1/faults', { method: 'POST', body: JSON.stringify(body) }), params);
const good = { callId: 'c1', turn: 2, kind: 'fault', reason: 'provider_key_ours', source: 'universe-ai', route: 'universe-ai/m', providerStatus: 402, at: '2026-11-20T10:00:00.000Z' };

beforeEach(() => {
  jest.clearAllMocks();
  auth.mockImplementation(() => undefined);
  late.mockResolvedValue(undefined);
  arrived.mockResolvedValue(undefined);
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

  it('takes the relay’s arrival row as the game writes it (answered / relay_reached, no route, no status, a call id of its own per run and turn), with a turn or without one, and it is never a fault', async () => {
    record.mockResolvedValue({ stored: 2, conflicts: 0 });
    const rows = [
      { callId: 'arrival_r-1_2', turn: 2, run: 'r-1', kind: 'answered', reason: 'relay_reached', source: 'universe-ai', route: null, providerStatus: null, at: '2026-11-21T00:00:00.000Z' },
      { callId: 'arrival_r-1_', turn: null, run: 'r-1', kind: 'answered', reason: 'relay_reached', source: 'universe-ai', at: '2026-11-21T00:00:01.000Z' },
    ];
    expect((await call({ faults: rows })).status).toBe(200);
    expect(record).toHaveBeenCalledWith('brick-1', 'job-1', [expect.objectContaining({ callId: 'arrival_r-1_2', kind: 'answered', reason: 'relay_reached', route: null, providerStatus: null, turn: 2 }), expect.objectContaining({ callId: 'arrival_r-1_', turn: null, run: 'r-1', route: null })]);
    expect(arrived).toHaveBeenCalledWith('job-1');
    expect(faultClassOf({ kind: 'answered', reason: 'relay_reached', source: 'universe-ai' })).toBeNull();
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

  it('a row that is not shaped as the relay writes it never holds back the real fault rows sent with it: the rest are kept, and the answer says how many were left out', async () => {
    record.mockResolvedValue({ stored: 1, conflicts: 0 });
    const res = await call({ faults: [{ ...good, kind: 'maybe' }, good, { ...good, callId: 'c9', reason: 'has spaces' }] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, stored: 1, conflicts: 0, rejected: [{ callId: 'c1', why: 'kind' }, { callId: 'c9', why: 'reason' }], rejectedCount: 2 });
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith('brick-1', 'job-1', [expect.objectContaining({ callId: 'c1', reason: 'provider_key_ours' })]);
    // ONE warning for the batch, with the job, the count and the names of the wrong fields, and no content of any row
    expect(warned).toHaveBeenCalledTimes(1);
    expect(warned).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ level: 'warning', tags: { area: 'computer', step: 'faults_rejected' }, extra: { jobId: 'job-1', count: 2, paths: ['kind', 'reason'] } }));
    expect(JSON.stringify(warned.mock.calls)).not.toContain('has spaces');
    // A row with no readable call id is named by null (a call id over 120 characters is not readable either)
    warned.mockClear();
    const odd = await call({ faults: [{ ...good, callId: 42 }, { ...good, callId: 'x'.repeat(121) }, 'not a row', null, good]});
    expect(await odd.json()).toMatchObject({ stored: 1, rejectedCount: 4, rejected: [{ callId: null }, { callId: null }, { callId: null }, { callId: null }] });
    expect(warned).toHaveBeenCalledTimes(1);
    // A row that is no object at all is named as a ROW (never as an answered row: that name is only for the arrival refinement), and the answered one keeps its own name
    warned.mockClear();
    const shapes = await call({ faults: [null, 'text', 7, { ...good, callId: 'a9', kind: 'answered', reason: 'provider_5xx' }, good] });
    expect((await shapes.json()).rejected).toEqual([{ callId: null, why: 'row' }, { callId: null, why: 'row' }, { callId: null, why: 'row' }, { callId: 'a9', why: 'answered' }]);
    expect(warned).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ extra: { jobId: 'job-1', count: 4, paths: ['row', 'answered'] } }));
    // A clean batch warns about nothing and names nothing
    warned.mockClear();
    const clean = await call({ faults: [good] });
    expect(await clean.json()).not.toHaveProperty('rejected');
    expect(warned).not.toHaveBeenCalled();
    // Nothing that can be kept: refused, nothing written, and the rows are named (and told once)
    record.mockClear();
    const none = await call({ faults: [{ ...good, kind: 'maybe' }, { ...good, callId: 'c5', source: 'x' }] });
    expect(none.status).toBe(400);
    expect(await none.json()).toMatchObject({ error: 'Invalid request', rejectedCount: 2, rejected: [{ callId: 'c1', why: 'kind' }, { callId: 'c5', why: 'source' }] });
    expect(warned).toHaveBeenCalledTimes(1);
    expect(record).not.toHaveBeenCalled();
    // A broken Sentry never changes the answer
    warned.mockImplementation(() => {
      throw new Error('down');
    });
    record.mockResolvedValue({ stored: 1, conflicts: 0 });
    expect((await call({ faults: [{ ...good, kind: 'maybe' }, good] })).status).toBe(200);
  });

  it('a batch of nothing but arrival rows judges nothing (it only re-labels a reason); with any other row the job is judged again as ever', async () => {
    record.mockResolvedValue({ stored: 2, conflicts: 0 });
    const arrival = (callId: string) => ({ callId, turn: 1, run: 'r-1', kind: 'answered', reason: 'relay_reached', source: 'universe-ai', route: null, providerStatus: null, at: '2026-11-21T00:00:00.000Z' });
    expect((await call({ faults: [arrival('arrival_r-1_1'), arrival('arrival_r-1_2')] })).status).toBe(200);
    expect(arrived).toHaveBeenCalledWith('job-1');
    expect(late).not.toHaveBeenCalled();
    arrived.mockClear();
    expect((await call({ faults: [arrival('arrival_r-1_1'), good] })).status).toBe(200);
    expect(late).toHaveBeenCalledWith('job-1');
    expect(arrived).not.toHaveBeenCalled();
  });

  it('refuses every answered row that is not the relay’s arrival row, per row: a real fault row sent in the same batch is kept', async () => {
    const arrival = { callId: 'arrival_r-1_1', turn: 1, run: 'r-1', kind: 'answered', reason: 'relay_reached', source: 'universe-ai', route: null, providerStatus: null, at: '2026-11-21T00:00:00.000Z' };
    for (const other of [
      { ...arrival, callId: 'c7', reason: 'provider_5xx' },
      { ...arrival, callId: 'c8', reason: 'body_unreadable', providerStatus: 413 },
      { ...arrival, source: 'own-key' },
      { ...arrival, route: 'universe-ai/m' },
      { ...arrival, providerStatus: 200 },
    ]) {
      jest.clearAllMocks();
      auth.mockImplementation(() => undefined);
      late.mockResolvedValue(undefined);
      record.mockResolvedValue({ stored: 1, conflicts: 0 });
      const res = await call({ faults: [other, good] });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, stored: 1, conflicts: 0, rejectedCount: 1, rejected: [{ callId: other.callId, why: expect.any(String) }] });
      // Only the real fault row was kept, and the job is judged as for any fault row
      expect(record).toHaveBeenCalledWith('brick-1', 'job-1', [expect.objectContaining({ callId: 'c1', kind: 'fault' })]);
      expect(late).toHaveBeenCalledWith('job-1');
    }
    // Alone, such a row is a 400 and nothing is written
    jest.clearAllMocks();
    expect((await call({ faults: [{ ...arrival, reason: 'provider_5xx' }] })).status).toBe(400);
    expect(record).not.toHaveBeenCalled();
    // The arrival row itself, with or without a turn, still passes
    record.mockResolvedValue({ stored: 2, conflicts: 0 });
    expect((await call({ faults: [arrival, { ...arrival, callId: 'arrival_r-1_', turn: null }] })).status).toBe(200);
  });

  it('keeps the rows even when judging the job again fails', async () => {
    record.mockResolvedValue({ stored: 2 });
    late.mockRejectedValue(new Error('down'));
    expect((await call({ faults: [good, { ...good, callId: 'c2' }] })).status).toBe(200);
  });
});
