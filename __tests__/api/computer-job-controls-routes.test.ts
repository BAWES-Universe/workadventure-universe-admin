/**
 * The owner's routes of the computer job controls: POST /api/bricks/:id/computer/jobs/:jobId/{pause,resume,first,cancel}. Only the owner, the answer is the computer view,
 * 404 for what is not theirs and 409 with a `reason` the game reads for every other refusal. The library is mocked: what it decides is tested against a real database.
 */
import { NextRequest } from 'next/server';
import { POST as pauseRoute } from '@/app/api/bricks/[id]/computer/jobs/[jobId]/pause/route';
import { POST as resumeRoute } from '@/app/api/bricks/[id]/computer/jobs/[jobId]/resume/route';
import { POST as firstRoute } from '@/app/api/bricks/[id]/computer/jobs/[jobId]/first/route';
import { POST as cancelRoute } from '@/app/api/bricks/[id]/computer/jobs/[jobId]/cancel/route';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import * as controls from '@/lib/computer-job-controls';

jest.mock('@/lib/db', () => ({ prisma: { user: { findUnique: jest.fn() } } }));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn() }));
jest.mock('@/lib/computer-job-controls');
jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));

const db = prisma as unknown as { user: { findUnique: jest.Mock } };
const session = getSessionUser as jest.Mock;
const lib = controls as jest.Mocked<typeof controls>;
const BRICK = 'brick-1';
const JOB = 'job-1';
const jobParams = { params: Promise.resolve({ id: BRICK, jobId: JOB }) };
const view = { available: true, on: true, machine: 'working', job: null, queued: [], month: null, files: { bytes: 0, savedAt: null, list: null }, restoredFrom: null, olderCopyUsed: false, packedAt: null, notice: null } as never;
const post = (verb: string, body?: string) => new NextRequest(`http://localhost:3333/api/bricks/${BRICK}/computer/jobs/${JOB}/${verb}`, { method: 'POST', ...(body === undefined ? {} : { body }) });

beforeEach(() => {
  jest.resetAllMocks();
  session.mockResolvedValue({ id: 'u-sara' });
  db.user.findUnique.mockResolvedValue({ isGuest: false });
});

describe('job control routes', () => {
  it.each([
    ['pause', pauseRoute, 'pauseJob'],
    ['resume', resumeRoute, 'resumeJob'],
    ['cancel', cancelRoute, 'cancelJob'],
  ] as const)('%s answers the computer view for the owner', async (verb, route, fn) => {
    (lib[fn] as jest.Mock).mockResolvedValue({ ok: true, view });
    const res = await route(post(verb), jobParams);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ computer: view });
    expect(lib[fn]).toHaveBeenCalledWith(BRICK, 'u-sara', JOB);
  });

  it('a refusal is 409 with its reason; not the owner’s is 404', async () => {
    lib.pauseJob.mockResolvedValue({ ok: false, reason: 'taken_over' });
    let res = await pauseRoute(post('pause'), jobParams);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ reason: 'taken_over' });
    for (const reason of ['over', 'ending', 'not_paused', 'not_queued', 'allowance', 'rule'] as const) {
      lib.resumeJob.mockResolvedValue({ ok: false, reason });
      res = await resumeRoute(post('resume'), jobParams);
      expect(res.status).toBe(409);
      expect((await res.json()).reason).toBe(reason);
    }
    lib.cancelJob.mockResolvedValue({ ok: false, reason: 'not_found' });
    res = await cancelRoute(post('cancel'), jobParams);
    expect(res.status).toBe(404);
  });

  it('signed out: nothing is asked of the library', async () => {
    session.mockResolvedValue(null);
    const res = await pauseRoute(post('pause'), jobParams);
    expect(res.status).toBe(401);
    expect(lib.pauseJob).not.toHaveBeenCalled();
  });

  it('first: no body, `{}` and `{ pauseRunning: false }` move it only; `{ pauseRunning: true }` pauses what runs; a body that is not JSON or a pauseRunning that is not a boolean is 400', async () => {
    lib.moveJobFirst.mockResolvedValue({ ok: true, view });
    expect((await firstRoute(post('first'), jobParams)).status).toBe(200);
    expect(lib.moveJobFirst).toHaveBeenLastCalledWith(BRICK, 'u-sara', JOB, { pauseRunning: false });
    await firstRoute(post('first', '{}'), jobParams);
    expect(lib.moveJobFirst).toHaveBeenLastCalledWith(BRICK, 'u-sara', JOB, { pauseRunning: false });
    await firstRoute(post('first', JSON.stringify({ pauseRunning: true })), jobParams);
    expect(lib.moveJobFirst).toHaveBeenLastCalledWith(BRICK, 'u-sara', JOB, { pauseRunning: true });
    lib.moveJobFirst.mockClear();
    expect((await firstRoute(post('first', 'nope'), jobParams)).status).toBe(400);
    expect((await firstRoute(post('first', JSON.stringify({ pauseRunning: 'yes' })), jobParams)).status).toBe(400);
    expect(lib.moveJobFirst).not.toHaveBeenCalled();
  });
});
