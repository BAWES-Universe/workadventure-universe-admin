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
const CMD = '6f1c2b8e-3d4a-4c5b-9e6f-7a8b9c0d1e2f';
const post = (verb: string, body?: string, command: string | null = CMD) =>
  new NextRequest(`http://localhost:3333/api/bricks/${BRICK}/computer/jobs/${JOB}/${verb}`, { method: 'POST', ...(body === undefined ? {} : { body }), ...(command ? { headers: { 'x-computer-command': command } } : {}) });
const asked = [expect.any(Date), { id: CMD }] as const;

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
    expect(lib[fn]).toHaveBeenCalledWith(BRICK, 'u-sara', JOB, ...asked);
  });

  it.each([
    ['pause', pauseRoute, 'pauseJob'],
    ['resume', resumeRoute, 'resumeJob'],
    ['cancel', cancelRoute, 'cancelJob'],
    ['first', firstRoute, 'moveJobFirst'],
  ] as const)('finding 4: %s without its command id (or with one that is not a uuid) is 400 `command_missing`, and nothing is asked of the library', async (verb, route, fn) => {
    for (const command of [null, 'not-a-uuid']) {
      const res = await route(post(verb, undefined, command), jobParams);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ reason: 'command_missing' });
    }
    expect(lib[fn]).not.toHaveBeenCalled();
  });

  it('finding 4: a command id used for another control is 400 `command_reused`', async () => {
    lib.pauseJob.mockResolvedValue({ ok: false, reason: 'command_reused' });
    const res = await pauseRoute(post('pause'), jobParams);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ reason: 'command_reused' });
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

  it('Cancel guard: `{ expected: "not_started" }` is passed to the library, no body is the call it always was, and a `started` refusal is a 409 with its reason', async () => {
    lib.cancelJob.mockResolvedValue({ ok: true, view });
    await cancelRoute(post('cancel'), jobParams);
    expect(lib.cancelJob).toHaveBeenLastCalledWith(BRICK, 'u-sara', JOB, ...asked);
    expect((lib.cancelJob as jest.Mock).mock.calls[0]).toHaveLength(5);
    await cancelRoute(post('cancel', JSON.stringify({ expected: 'not_started' })), jobParams);
    expect(lib.cancelJob).toHaveBeenLastCalledWith(BRICK, 'u-sara', JOB, ...asked, 'not_started');
    lib.cancelJob.mockResolvedValue({ ok: false, reason: 'started' });
    const res = await cancelRoute(post('cancel', JSON.stringify({ expected: 'not_started' })), jobParams);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ reason: 'started' });
  });

  it('Cancel guard: a body that is not exactly `{ expected: "not_started" }` is 400 and nothing is asked of the library', async () => {
    for (const body of ['{"expected":"running"}', '{"expected":""}', '{"expected":"not_started","x":1}', '{nope', '[]', '"not_started"']) {
      const res = await cancelRoute(post('cancel', body), jobParams);
      expect(res.status).toBe(400);
    }
    expect(lib.cancelJob).not.toHaveBeenCalled();
  });

  it('N11 (d522f4b3 pass): a Cancel that left the job live is a retryable 503 with `retry: true`, never a 409 state of the job and never a 200', async () => {
    lib.cancelJob.mockResolvedValue({ ok: false, reason: 'not_ended' });
    const res = await cancelRoute(post('cancel'), jobParams);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ reason: 'not_ended', retry: true });
  });

  it('signed out: nothing is asked of the library', async () => {
    session.mockResolvedValue(null);
    const res = await pauseRoute(post('pause'), jobParams);
    expect(res.status).toBe(401);
    expect(lib.pauseJob).not.toHaveBeenCalled();
  });

  it('first: no body, `{}` and `{ pauseRunning: false }` move it only; `{ pauseRunning: true }` pauses what runs; a body that is not JSON or a pauseRunning that is not a boolean is 400', async () => {
    lib.moveJobFirst.mockResolvedValue({ ok: true, view });
    // Each request adds exactly one call (a request that returned without dispatching would leave the last call of the one before it to satisfy the check: CodeRabbit on #1025, 49)
    lib.moveJobFirst.mockClear();
    expect((await firstRoute(post('first'), jobParams)).status).toBe(200);
    expect(lib.moveJobFirst).toHaveBeenCalledTimes(1);
    expect(lib.moveJobFirst).toHaveBeenLastCalledWith(BRICK, 'u-sara', JOB, { pauseRunning: false }, ...asked);
    await firstRoute(post('first', '{}'), jobParams);
    expect(lib.moveJobFirst).toHaveBeenCalledTimes(2);
    expect(lib.moveJobFirst).toHaveBeenLastCalledWith(BRICK, 'u-sara', JOB, { pauseRunning: false }, ...asked);
    await firstRoute(post('first', JSON.stringify({ pauseRunning: true })), jobParams);
    expect(lib.moveJobFirst).toHaveBeenCalledTimes(3);
    expect(lib.moveJobFirst).toHaveBeenLastCalledWith(BRICK, 'u-sara', JOB, { pauseRunning: true }, ...asked);
    lib.moveJobFirst.mockClear();
    expect((await firstRoute(post('first', 'nope'), jobParams)).status).toBe(400);
    expect((await firstRoute(post('first', JSON.stringify({ pauseRunning: 'yes' })), jobParams)).status).toBe(400);
    expect(lib.moveJobFirst).not.toHaveBeenCalled();
  });
});
