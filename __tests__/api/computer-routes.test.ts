/**
 * The routes for a Brick's computer (game #2000): who may ask, and what each answers. The owner's calls are for a signed-in person
 * and their own Brick only; the bot server's calls are for its token only and never take a person's word for who is the owner. Who
 * may do what and when is tested against a real database in computer-db.test.ts.
 */
import { NextRequest } from 'next/server';
import { GET as view, POST as give, DELETE as turnOff } from '@/app/api/bricks/[id]/computer/route';
import { POST as watch } from '@/app/api/bricks/[id]/computer/watch/route';
import { POST as stop } from '@/app/api/bricks/[id]/computer/stop/route';
import { POST as takeOverRoute } from '@/app/api/bricks/[id]/computer/take-over/route';
import { POST as handBackRoute } from '@/app/api/bricks/[id]/computer/hand-back/route';
import { POST as fillRoute } from '@/app/api/bricks/[id]/computer/fill-details/route';
import { POST as startRoute } from '@/app/api/bots/[id]/computer-jobs/route';
import { GET as getJobRoute, POST as jobAction } from '@/app/api/bots/[id]/computer-jobs/[jobId]/route';
import { POST as sweepRoute } from '@/app/api/computer/sweep/route';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { resolveUsagePerson } from '@/lib/usage-person';
import * as computer from '@/lib/computer';

jest.mock('@/lib/db', () => ({ prisma: { user: { findUnique: jest.fn() } } }));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn() }));
jest.mock('@/lib/usage-person', () => ({ resolveUsagePerson: jest.fn() }));
jest.mock('@/lib/computer');
jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));

const db = prisma as unknown as { user: { findUnique: jest.Mock } };
const session = getSessionUser as jest.Mock;
const resolve = resolveUsagePerson as jest.Mock;
const lib = computer as jest.Mocked<typeof computer>;

const SERVICE_TOKEN = 'bot-server-secret';
const BRICK = 'brick-1';
const JOB = 'job-1';
const params = { params: Promise.resolve({ id: BRICK }) };
const jobParams = { params: Promise.resolve({ id: BRICK, jobId: JOB }) };
const tokenBefore = process.env.BOT_SERVICE_TOKEN;

const call = (path: string, init: { method?: string; body?: unknown; token?: string | null } = {}) => {
  const token = init.token === undefined ? null : init.token;
  return new NextRequest(`http://localhost:3333${path}`, { method: init.method ?? 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {}, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) });
};
const asBot = (path: string, init: { method?: string; body?: unknown } = {}) => call(path, { ...init, token: SERVICE_TOKEN });
const job = { id: JOB, botId: BRICK, personId: 'u-sara', status: 'running', title: 'Visa form', detailsToFill: [] };

beforeEach(() => {
  jest.resetAllMocks();
  process.env.BOT_SERVICE_TOKEN = SERVICE_TOKEN;
  session.mockResolvedValue({ id: 'u-sara' });
  db.user.findUnique.mockResolvedValue({ isGuest: false });
});
afterAll(() => {
  if (tokenBefore === undefined) delete process.env.BOT_SERVICE_TOKEN;
  else process.env.BOT_SERVICE_TOKEN = tokenBefore;
});

describe('the owner’s calls', () => {
  const calls: [string, (r: NextRequest) => Promise<Response>, string][] = [
    ['view', (r) => view(r, params), 'GET'],
    ['give', (r) => give(r, params), 'POST'],
    ['turn off', (r) => turnOff(r, params), 'DELETE'],
    ['watch', (r) => watch(r, params), 'POST'],
    ['stop', (r) => stop(r, params), 'POST'],
    ['take over', (r) => takeOverRoute(r, params), 'POST'],
    ['hand back', (r) => handBackRoute(r, params), 'POST'],
    ['fill in details', (r) => fillRoute(r, params), 'POST'],
  ];

  it.each(calls)('%s is for a signed-in person: nobody gets a 401, a guest gets a 403, and nothing is read or changed', async (_name, run, method) => {
    session.mockResolvedValue(null);
    expect((await run(call('/api/bricks/brick-1/computer', { method }))).status).toBe(401);
    session.mockResolvedValue({ id: 'g1' });
    db.user.findUnique.mockResolvedValue({ isGuest: true });
    expect((await run(call('/api/bricks/brick-1/computer', { method }))).status).toBe(403);
    for (const fn of Object.values(lib)) if (jest.isMockFunction(fn)) expect(fn).not.toHaveBeenCalled();
  });

  it('shows the computer, and gives it, to the owner: the person’s own id is what is asked, never one from the request', async () => {
    lib.computerView.mockResolvedValue({ on: true } as never);
    expect(await (await view(call('/api/bricks/brick-1/computer?owner=u-omar', { method: 'GET' }), params)).json()).toEqual({ computer: { on: true } });
    expect(lib.computerView).toHaveBeenCalledWith(BRICK, 'u-sara');
    lib.giveComputer.mockResolvedValue({ ok: true, view: { on: true } as never });
    expect((await give(call('/api/bricks/brick-1/computer'), params)).status).toBe(200);
    expect(lib.giveComputer).toHaveBeenCalledWith(BRICK, 'u-sara');
  });

  it('says "not found" for a Brick that is not theirs, the same for every call', async () => {
    lib.computerView.mockResolvedValue(null);
    lib.giveComputer.mockResolvedValue({ ok: false, reason: 'not_found' });
    lib.turnOffComputer.mockResolvedValue(null);
    lib.watchComputer.mockResolvedValue({ ok: false, reason: 'not_found' });
    lib.stopJobFor.mockResolvedValue(null);
    lib.takeOver.mockResolvedValue({ ok: false, reason: 'not_found' });
    lib.handBack.mockResolvedValue({ ok: false, reason: 'not_found' });
    lib.fillInDetails.mockResolvedValue({ ok: false, reason: 'not_found' });
    const answers = await Promise.all([
      view(call('/x', { method: 'GET' }), params),
      give(call('/x'), params),
      turnOff(call('/x', { method: 'DELETE' }), params),
      watch(call('/x'), params),
      stop(call('/x'), params),
      takeOverRoute(call('/x'), params),
      handBackRoute(call('/x'), params),
      fillRoute(call('/x', { body: { what: 'Your details', where: 'Step 1' } }), params),
    ]);
    expect(answers.map((a) => a.status)).toEqual(Array(8).fill(404));
  });

  it('says computers are not open yet where there is no provider', async () => {
    lib.giveComputer.mockResolvedValue({ ok: false, reason: 'not_open' });
    expect((await give(call('/x'), params)).status).toBe(503);
  });

  it('answers Watch with the screen, or "resting" (409) and nothing woken', async () => {
    lib.watchComputer.mockResolvedValue({ ok: true, url: 'https://screen.example/1', expiresAt: new Date('2026-11-15T12:05:00Z') });
    expect(await (await watch(call('/x'), params)).json()).toMatchObject({ url: 'https://screen.example/1' });
    lib.watchComputer.mockResolvedValue({ ok: false, reason: 'resting' });
    const resting = await watch(call('/x'), params);
    expect(resting.status).toBe(409);
    expect(await resting.json()).toMatchObject({ resting: true });
  });

  it('answers take over and hand back with the job, or 409 when nothing waits for the person', async () => {
    lib.takeOver.mockResolvedValue({ ok: true, job: { id: JOB } as never });
    expect(await (await takeOverRoute(call('/x'), params)).json()).toEqual({ job: { id: JOB } });
    lib.takeOver.mockResolvedValue({ ok: false, reason: 'nothing_waiting' });
    expect((await takeOverRoute(call('/x'), params)).status).toBe(409);
    lib.handBack.mockResolvedValue({ ok: false, reason: 'nothing_waiting' });
    expect((await handBackRoute(call('/x'), params)).status).toBe(409);
  });

  it('takes "Fill in my details" only with what and where, and only after a take over', async () => {
    expect((await fillRoute(call('/x', { body: { what: 'Your details' } }), params)).status).toBe(400);
    expect((await fillRoute(call('/x', { body: { what: 'Your details', where: 'Step 1', pay: true } }), params)).status).toBe(400);
    expect(lib.fillInDetails).not.toHaveBeenCalled();
    lib.fillInDetails.mockResolvedValue({ ok: false, reason: 'not_in_control' });
    expect((await fillRoute(call('/x', { body: { what: 'Your details', where: 'Step 1' } }), params)).status).toBe(409);
    lib.fillInDetails.mockResolvedValue({ ok: true, job: { id: JOB } as never });
    expect((await fillRoute(call('/x', { body: { what: 'Your details', where: 'Step 1' } }), params)).status).toBe(200);
    expect(lib.fillInDetails).toHaveBeenLastCalledWith(BRICK, 'u-sara', { what: 'Your details', where: 'Step 1' });
  });
});

describe('the bot server’s calls', () => {
  it.each([
    ['start a job', () => startRoute(call('/x', { body: { userId: 'u', title: 't' } }), params)],
    ['read a job', () => getJobRoute(call('/x', { method: 'GET' }), jobParams)],
    ['tell a job something', () => jobAction(call('/x', { body: { action: 'renew' } }), jobParams)],
    ['sweep', () => sweepRoute(call('/x'))],
  ])('%s is for its token only', async (_name, run) => {
    expect((await run()).status).toBe(401);
    expect(lib.startJob).not.toHaveBeenCalled();
    expect(lib.sweepComputers).not.toHaveBeenCalled();
  });

  it('starts a job for the person it resolves, and a guest, who has no Brick, is never the owner', async () => {
    resolve.mockResolvedValue({ personId: 'u-sara', guest: false });
    lib.startJob.mockResolvedValue({ ok: true, job: { id: JOB, status: 'queued', queuedFor: 'allowance' } as never, restoredFrom: null });
    const started = await startRoute(asBot('/x', { body: { userId: 'wa-sara', title: 'Visa form' } }), params);
    expect(await started.json()).toEqual({ ok: true, job: { id: JOB, status: 'queued', queuedFor: 'allowance' }, restoredFrom: null });
    expect(lib.startJob).toHaveBeenCalledWith({ botId: BRICK, personId: 'u-sara', title: 'Visa form', writes: undefined });
    resolve.mockResolvedValue({ personId: null, guest: true });
    expect(await (await startRoute(asBot('/x', { body: { userId: 'wa-guest', isGuest: true, title: 'x' } }), params)).json()).toEqual({ ok: false, reason: 'not_owner' });
    expect(lib.startJob).toHaveBeenCalledTimes(1);
  });

  it('says why a job could not start', async () => {
    resolve.mockResolvedValue({ personId: 'u-sara', guest: false });
    lib.startJob.mockResolvedValue({ ok: false, reason: 'off' });
    expect(await (await startRoute(asBot('/x', { body: { userId: 'wa-sara', title: 'x' } }), params)).json()).toEqual({ ok: false, reason: 'off' });
    expect((await startRoute(asBot('/x', { body: { title: 'x' } }), params)).status).toBe(400);
  });

  it('reaches a job only through its own Brick', async () => {
    lib.getJob.mockResolvedValue({ ...job, botId: 'another-brick' } as never);
    expect((await getJobRoute(asBot('/x', { method: 'GET' }), jobParams)).status).toBe(404);
    expect((await jobAction(asBot('/x', { body: { action: 'finish', outcome: 'done' } }), jobParams)).status).toBe(404);
    expect(lib.finishJob).not.toHaveBeenCalled();
  });

  it('takes what a running job says: steps, renewing, hand-over, finishing, and outside effects before they are tried', async () => {
    lib.getJob.mockResolvedValue(job as never);
    lib.reportProgress.mockResolvedValue({ id: JOB } as never);
    lib.renewJob.mockResolvedValue({ ok: false, reason: 'allowance' });
    lib.requestHandover.mockResolvedValue({ id: JOB } as never);
    lib.finishJob.mockResolvedValue({ id: JOB } as never);
    lib.planEffect.mockResolvedValue({ ok: false, reason: 'look_up', evidence: 'draft pull request' });
    lib.settleEffect.mockResolvedValue(true);
    await jobAction(asBot('/x', { body: { action: 'progress', stepDone: 2, stepTotal: 5, label: 'Your visa form' } }), jobParams);
    expect(lib.reportProgress).toHaveBeenCalledWith(JOB, { stepDone: 2, stepTotal: 5, label: 'Your visa form' });
    expect(await (await jobAction(asBot('/x', { body: { action: 'renew' } }), jobParams)).json()).toEqual({ ok: false, reason: 'allowance' });
    await jobAction(asBot('/x', { body: { action: 'handover', waitingFor: 'pay' } }), jobParams);
    expect(lib.requestHandover).toHaveBeenCalledWith(JOB, 'pay');
    await jobAction(asBot('/x', { body: { action: 'finish', outcome: 'done' } }), jobParams);
    expect(lib.finishJob).toHaveBeenCalledWith(JOB, 'done');
    expect(await (await jobAction(asBot('/x', { body: { action: 'plan-effect', key: 'pr-1', kind: 'publish' } }), jobParams)).json()).toEqual({ ok: false, reason: 'look_up', evidence: 'draft pull request' });
    expect(await (await jobAction(asBot('/x', { body: { action: 'settle-effect', key: 'pr-1', state: 'done', evidence: 'pull request 12' } }), jobParams)).json()).toEqual({ ok: true });
  });

  it('refuses a word it does not know: no action, no kind, no wait', async () => {
    lib.getJob.mockResolvedValue(job as never);
    for (const body of [{ action: 'restart' }, { action: 'handover', waitingFor: 'coffee' }, { action: 'plan-effect', key: 'k', kind: 'steal' }, { action: 'finish', outcome: 'maybe' }, null]) {
      expect((await jobAction(asBot('/x', { body }), jobParams)).status).toBe(400);
    }
  });

  it('sweeps', async () => {
    lib.sweepComputers.mockResolvedValue({ stopped: 1, released: 0, started: 2 });
    expect(await (await sweepRoute(asBot('/x'))).json()).toEqual({ stopped: 1, released: 0, started: 2 });
  });
});
