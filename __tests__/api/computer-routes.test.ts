/**
 * The routes for a Brick's computer (game #2000): who may ask, and what each answers. The owner's calls are for a signed-in person
 * and their own Brick only; the bot server's calls are for its token only and never take a person's word for who is the owner. Who
 * may do what and when is tested against a real database in computer-db.test.ts.
 */
import { NextRequest } from 'next/server';
import { GET as view, POST as give, DELETE as turnOff } from '@/app/api/bricks/[id]/computer/route';
import { POST as stop } from '@/app/api/bricks/[id]/computer/stop/route';
import { POST as takeOverRoute } from '@/app/api/bricks/[id]/computer/take-over/route';
import { POST as handBackRoute } from '@/app/api/bricks/[id]/computer/hand-back/route';
import { POST as restartRoute } from '@/app/api/bricks/[id]/computer/restart/route';
import { POST as fillRoute } from '@/app/api/bricks/[id]/computer/fill-details/route';
import { POST as dismissRoute } from '@/app/api/bricks/[id]/computer/dismiss/route';
import { GET as stateRoute, POST as startRoute } from '@/app/api/bots/[id]/computer-jobs/route';
import { GET as getJobRoute, POST as jobAction } from '@/app/api/bots/[id]/computer-jobs/[jobId]/route';
import { GET as visitsRoute } from '@/app/api/bricks/[id]/computer/jobs/[jobId]/visits/route';
import { POST as sweepRoute } from '@/app/api/computer/sweep/route';
import { POST as reviewRoute } from '@/app/api/bots/[id]/computer-route-review/route';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { resolveUsagePerson } from '@/lib/usage-person';
import * as computer from '@/lib/computer';
import * as visitsLib from '@/lib/computer-visits';
import * as notesLib from '@/lib/computer-job-notes';
import * as spend from '@/lib/spend-rules';
import * as profiles from '@/lib/computer-browser-profile';
import { START_REFUSALS, startStateOf } from '@/lib/computer-values';

jest.mock('@/lib/db', () => ({ prisma: { user: { findUnique: jest.fn() } } }));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn() }));
jest.mock('@/lib/usage-person', () => ({ resolveUsagePerson: jest.fn() }));
jest.mock('@/lib/computer');
jest.mock('@/lib/computer-visits');
jest.mock('@/lib/computer-job-notes');
jest.mock('@/lib/spend-rules');
jest.mock('@/lib/computer-browser-profile');
jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));

const db = prisma as unknown as { user: { findUnique: jest.Mock } };
const session = getSessionUser as jest.Mock;
const resolve = resolveUsagePerson as jest.Mock;
const lib = computer as jest.Mocked<typeof computer>;
const visits = visitsLib as jest.Mocked<typeof visitsLib>;
const notes = notesLib as jest.Mocked<typeof notesLib>;
const rules = spend as jest.Mocked<typeof spend>;

const SERVICE_TOKEN = 'bot-server-secret';
const BRICK = 'brick-1';
const JOB = 'job-1';
const params = { params: Promise.resolve({ id: BRICK }) };
const jobParams = { params: Promise.resolve({ id: BRICK, jobId: JOB }) };
const tokenBefore = process.env.BOT_SERVICE_TOKEN;

const call = (path: string, init: { method?: string; body?: unknown; token?: string | null; headers?: Record<string, string> } = {}) => {
  const token = init.token === undefined ? null : init.token;
  return new NextRequest(`http://localhost:3333${path}`, { method: init.method ?? 'POST', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...init.headers }, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) });
};
const asBot = (path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) => call(path, { ...init, token: SERVICE_TOKEN });
const job = { id: JOB, botId: BRICK, personId: 'u-sara', status: 'running', title: 'Visa form', detailsToFill: [] };

beforeEach(() => {
  jest.resetAllMocks();
  process.env.BOT_SERVICE_TOKEN = SERVICE_TOKEN;
  session.mockResolvedValue({ id: 'u-sara' });
  db.user.findUnique.mockResolvedValue({ isGuest: false });
  rules.ownerSpendAllowed.mockResolvedValue({ ok: true });
  // A key is known by itself unless a test says another key came first (GPT eighth note, A2)
  lib.canonicalStartKey.mockImplementation(async (_brick: string, _person: string, startKey: string) => startKey);
});
afterAll(() => {
  if (tokenBefore === undefined) delete process.env.BOT_SERVICE_TOKEN;
  else process.env.BOT_SERVICE_TOKEN = tokenBefore;
});

describe('where a job’s computer browsed (R06)', () => {
  const path = `/api/bricks/${BRICK}/computer/jobs/${JOB}/visits`;
  const own = () => lib.brickOf.mockResolvedValue({ id: BRICK } as never);

  it('is for a signed-in person: nobody gets a 401, a guest a 403, and nothing is read', async () => {
    session.mockResolvedValue(null);
    expect((await visitsRoute(call(path, { method: 'GET' }), jobParams)).status).toBe(401);
    session.mockResolvedValue({ id: 'g1' });
    db.user.findUnique.mockResolvedValue({ isGuest: true });
    expect((await visitsRoute(call(path, { method: 'GET' }), jobParams)).status).toBe(403);
    expect(visits.visitsFor).not.toHaveBeenCalled();
  });

  it('is the same "not found" for a Brick that is not theirs and for a job that is not that Brick’s', async () => {
    lib.brickOf.mockResolvedValue(null);
    expect((await visitsRoute(call(path, { method: 'GET' }), jobParams)).status).toBe(404);
    expect(visits.visitsFor).not.toHaveBeenCalled();
    own();
    visits.visitsFor.mockResolvedValue(null);
    expect((await visitsRoute(call(path, { method: 'GET' }), jobParams)).status).toBe(404);
    expect(visits.visitsFor).toHaveBeenCalledWith(BRICK, JOB);
  });

  it('shows the owner their own job’s record, by the Brick and job named, and a token cannot ask for it', async () => {
    own();
    visits.visitsFor.mockResolvedValue({ state: 'complete', items: [] });
    expect(await (await visitsRoute(call(path, { method: 'GET' }), jobParams)).json()).toEqual({ visits: { state: 'complete', items: [] } });
    expect(lib.brickOf).toHaveBeenCalledWith(BRICK, 'u-sara');
    session.mockResolvedValue(null);
    expect((await visitsRoute(asBot(path, { method: 'GET' }), jobParams)).status).toBe(401);
  });
});

describe('the owner’s calls', () => {
  const calls: [string, (r: NextRequest) => Promise<Response>, string][] = [
    ['view', (r) => view(r, params), 'GET'],
    ['give', (r) => give(r, params), 'POST'],
    ['turn off', (r) => turnOff(r, params), 'DELETE'],
    ['stop', (r) => stop(r, params), 'POST'],
    ['take over', (r) => takeOverRoute(r, params), 'POST'],
    ['hand back', (r) => handBackRoute(r, params), 'POST'],
    ['fill in details', (r) => fillRoute(r, params), 'POST'],
    ['dismiss the notice', (r) => dismissRoute(r, params), 'POST'],
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
    lib.stopAll.mockResolvedValue({ ok: false, reason: 'not_found' });
    lib.takeOver.mockResolvedValue({ ok: false, reason: 'not_found' });
    lib.handBack.mockResolvedValue({ ok: false, reason: 'not_found' });
    lib.fillInDetails.mockResolvedValue({ ok: false, reason: 'not_found' });
    lib.dismissComputerNotice.mockResolvedValue({ ok: false, reason: 'not_found' });
    const answers = await Promise.all([
      view(call('/x', { method: 'GET' }), params),
      give(call('/x'), params),
      turnOff(call('/x', { method: 'DELETE' }), params),
      stop(call('/x'), params),
      takeOverRoute(call('/x'), params),
      handBackRoute(call('/x'), params),
      fillRoute(call('/x'), params),
      dismissRoute(call('/x', { body: { jobId: JOB } }), params),
    ]);
    expect(answers.map((a) => a.status)).toEqual(Array(8).fill(404));
  });

  it('finding 4: Stop with the panel’s command id passes it on; without one (the 0.4.3 game) it stops as before; an id that is not a uuid, or one used for another control, is 400', async () => {
    const cmd = '6f1c2b8e-3d4a-4c5b-9e6f-7a8b9c0d1e2f';
    lib.stopAll.mockResolvedValue({ ok: true, view: { on: true } as never });
    expect(await (await stop(call('/x'), params)).json()).toEqual({ computer: { on: true } });
    expect(lib.stopAll).toHaveBeenLastCalledWith(BRICK, 'u-sara', expect.any(Date), undefined);
    expect((await stop(call('/x', { headers: { 'x-computer-command': cmd } }), params)).status).toBe(200);
    expect(lib.stopAll).toHaveBeenLastCalledWith(BRICK, 'u-sara', expect.any(Date), { id: cmd });
    lib.stopAll.mockClear();
    const invalid = await stop(call('/x', { headers: { 'x-computer-command': 'nope' } }), params);
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ reason: 'command_missing' });
    expect(lib.stopAll).not.toHaveBeenCalled();
    // A header that is there and EMPTY is no id either (CodeRabbit on #1025, 46): never an unkeyed Stop
    const empty = await stop(call('/x', { headers: { 'x-computer-command': '' } }), params);
    expect(empty.status).toBe(400);
    expect(await empty.json()).toMatchObject({ reason: 'command_missing' });
    expect(lib.stopAll).not.toHaveBeenCalled();
    lib.stopAll.mockResolvedValue({ ok: false, reason: 'command_reused' });
    const reused = await stop(call('/x', { headers: { 'x-computer-command': cmd } }), params);
    expect(reused.status).toBe(400);
    expect(await reused.json()).toMatchObject({ reason: 'command_reused' });
  });

  it('I2 and N3: a Stop body that is there and is not a JSON object (malformed, null, an array, a string, a number) is 400 and stops nothing; no body and {} are the Stop as before (CodeRabbit on #1025)', async () => {
    lib.stopAll.mockResolvedValue({ ok: true, view: { on: true } as never });
    for (const bad of ['{"confirmedJobIds":', 'nonsense', '[1]', '[]', '1', '"x"', '42', 'null', ' null\n', 'true']) {
      const answer = await stop(new NextRequest('http://localhost:3333/x', { method: 'POST', body: bad }), params);
      expect(answer.status).toBe(400);
    }
    expect(lib.stopAll).not.toHaveBeenCalled();
    expect((await stop(call('/x'), params)).status).toBe(200);
    expect((await stop(call('/x', { body: {} }), params)).status).toBe(200);
    expect(lib.stopAll).toHaveBeenCalledTimes(2);
  });

  it('row 57: a Stop body with a key other than confirmedJobIds (a misspelt confirmedJobId, an extra field beside the set) is 400 and stops nothing, never the unrestricted Stop; the set alone, {} and no body still stop', async () => {
    lib.stopAll.mockResolvedValue({ ok: true, view: { on: true } as never, stopped: [], left: [] } as never);
    const job = '6f1c2b8e-3d4a-4c5b-9e6f-7a8b9c0d1e2f';
    for (const body of [{ confirmedJobId: job }, { confirmedJobId: [job] }, { jobId: job }, { confirmedJobIds: [job], extra: 1 }, { confirmedJobIds: undefined, other: true }, { other: null }]) {
      const answer = await stop(new NextRequest('http://localhost:3333/x', { method: 'POST', body: JSON.stringify(body) }), params);
      expect(answer.status).toBe(400);
    }
    expect(lib.stopAll).not.toHaveBeenCalled();
    // CONTROL: the real field, an empty object and no body are answered as before
    expect((await stop(call('/x', { body: { confirmedJobIds: [job] } }), params)).status).toBe(200);
    expect(lib.stopAll).toHaveBeenLastCalledWith(BRICK, 'u-sara', expect.any(Date), undefined, [job]);
    expect((await stop(call('/x', { body: {} }), params)).status).toBe(200);
    expect((await stop(call('/x'), params)).status).toBe(200);
    expect(lib.stopAll).toHaveBeenCalledTimes(3);
  });

  it('I10: a Stop that left a captured job live is a retryable 503, not a Stop', async () => {
    lib.stopAll.mockResolvedValue({ ok: false, reason: 'not_ended' });
    const answer = await stop(call('/x', { headers: { 'x-computer-command': '6f1c2b8e-3d4a-4c5b-9e6f-7a8b9c0d1e2f' } }), params);
    expect(answer.status).toBe(503);
    expect(await answer.json()).toMatchObject({ reason: 'not_ended', retry: true });
  });

  it('dismisses the notice of one named ending, for the person asking and nobody else', async () => {
    lib.dismissComputerNotice.mockResolvedValue({ ok: true, view: { on: true } as never });
    expect(await (await dismissRoute(call('/x', { body: { jobId: JOB, owner: 'u-omar' } }), params)).json()).toEqual({ computer: { on: true } });
    expect(lib.dismissComputerNotice).toHaveBeenCalledWith(BRICK, 'u-sara', JOB);
    // Without the ending it was shown for, nothing is dismissed
    lib.dismissComputerNotice.mockClear();
    expect((await dismissRoute(call('/x', { body: {} }), params)).status).toBe(400);
    expect((await dismissRoute(call('/x'), params)).status).toBe(400);
    expect((await dismissRoute(call('/x', { body: { jobId: 'x'.repeat(41) } }), params)).status).toBe(400);
    expect(lib.dismissComputerNotice).not.toHaveBeenCalled();
  });

  it('I1 and I8: a person lookup that failed is a retryable 503 before any not_owner; a refusal that could not be kept is a retryable 503, not a refusal', async () => {
    resolve.mockResolvedValue({ personId: null, guest: false, lookupFailed: true });
    const failed = await startRoute(asBot('/x', { body: { userId: 'wa-sara', title: 'Visa form' } }), params);
    expect(failed.status).toBe(503);
    expect(await failed.json()).toMatchObject({ retry: true });
    expect(lib.startJob).not.toHaveBeenCalled();
    resolve.mockResolvedValue({ personId: 'u-sara', guest: false });
    lib.startJob.mockResolvedValue({ ok: false, reason: 'not_kept' });
    const notKept = await startRoute(asBot('/x', { body: { userId: 'wa-sara', title: 'Visa form' } }), params);
    expect(notKept.status).toBe(503);
    expect(await notKept.json()).toMatchObject({ retry: true });
  });

  it('says computers are not open yet where there is no provider', async () => {
    lib.giveComputer.mockResolvedValue({ ok: false, reason: 'not_open' });
    expect((await give(call('/x'), params)).status).toBe(503);
  });

  it('answers take over and hand back with the job, or 409 when nothing waits for the person', async () => {
    lib.takeOver.mockResolvedValue({ ok: true, job: { id: JOB } as never });
    expect(await (await takeOverRoute(call('/x'), params)).json()).toEqual({ job: { id: JOB } });
    lib.takeOver.mockResolvedValue({ ok: false, reason: 'nothing_waiting' });
    expect((await takeOverRoute(call('/x'), params)).status).toBe(409);
    // Still changing hands, or the fence could not be proved: said as it is, never as success and never as "nothing waiting"
    lib.takeOver.mockResolvedValue({ ok: false, reason: 'in_progress' });
    expect(await (await takeOverRoute(call('/x'), params)).json()).toMatchObject({ inProgress: true });
    lib.takeOver.mockResolvedValue({ ok: false, reason: 'not_secured' });
    const unsecured = await takeOverRoute(call('/x'), params);
    expect(unsecured.status).toBe(409);
    expect(await unsecured.json()).toMatchObject({ notSecured: true, error: 'Couldn’t get the computer ready. Nothing was changed on it. Try again.' });
    lib.handBack.mockResolvedValue({ ok: false, reason: 'nothing_waiting' });
    expect((await handBackRoute(call('/x'), params)).status).toBe(409);
  });

  it('the honest check (1B): a program still running is a 409 that says so and whether a restart is offered, with no program named; "anyway" is only taken as the boolean true', async () => {
    lib.takeOver.mockResolvedValue({ ok: false, reason: 'still_running' });
    lib.restartOffered.mockResolvedValue(true);
    const blocked = await takeOverRoute(call('/x'), params);
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toEqual({ error: 'A program is still running on this computer.', reason: 'still_running', stillRunning: true, restartOffered: true });
    expect(lib.takeOver).toHaveBeenLastCalledWith(BRICK, 'u-sara', expect.any(Date), { anyway: false });
    lib.restartOffered.mockResolvedValue(false);
    expect(await (await takeOverRoute(call('/x', { body: { anyway: 'yes' } }), params)).json()).toMatchObject({ restartOffered: false });
    expect(lib.takeOver).toHaveBeenLastCalledWith(BRICK, 'u-sara', expect.any(Date), { anyway: false });
    lib.takeOver.mockResolvedValue({ ok: true, job: { id: JOB } as never });
    expect(await (await takeOverRoute(call('/x', { body: { anyway: true } }), params)).json()).toEqual({ job: { id: JOB } });
    expect(lib.takeOver).toHaveBeenLastCalledWith(BRICK, 'u-sara', expect.any(Date), { anyway: true });
  });

  it('Restart first (1B): the job when it was done, 409 notOffered when there is nothing to restart for, 409 inProgress while it is on its way, 404 for another person’s Brick', async () => {
    lib.restartComputer.mockResolvedValue({ ok: true, job: { id: JOB } as never });
    expect(await (await restartRoute(call('/x'), params)).json()).toEqual({ job: { id: JOB } });
    lib.restartComputer.mockResolvedValue({ ok: false, reason: 'not_offered' });
    const none = await restartRoute(call('/x'), params);
    expect(none.status).toBe(409);
    expect(await none.json()).toMatchObject({ notOffered: true });
    lib.restartComputer.mockResolvedValue({ ok: false, reason: 'in_progress' });
    expect(await (await restartRoute(call('/x'), params)).json()).toMatchObject({ inProgress: true });
    lib.restartComputer.mockResolvedValue({ ok: false, reason: 'not_found' });
    expect((await restartRoute(call('/x'), params)).status).toBe(404);
  });

  it('takes "Fill in my details" as one tap: only after a take over, and what the screen showed must still be what Brick named', async () => {
    lib.fillInDetails.mockResolvedValue({ ok: false, reason: 'not_in_control' });
    expect((await fillRoute(call('/x', { body: { what: 'Everything', where: 'anywhere' } }), params)).status).toBe(409);
    lib.fillInDetails.mockResolvedValue({ ok: false, reason: 'nothing_ready' });
    expect((await fillRoute(call('/x'), params)).status).toBe(409);
    lib.fillInDetails.mockResolvedValue({ ok: false, reason: 'changed' });
    const changed = await fillRoute(call('/x', { body: { what: 'Your name', where: 'visa-portal.example' } }), params);
    expect(changed.status).toBe(409);
    expect(await changed.json()).toEqual({ error: 'What Brick is ready to fill in has changed' });
    lib.fillInDetails.mockResolvedValue({ ok: true, job: { id: JOB } as never });
    expect((await fillRoute(call('/x'), params)).status).toBe(200);
    // No body, or anything but the two words the screen showed: nothing is passed to check
    expect(lib.fillInDetails).toHaveBeenLastCalledWith(BRICK, 'u-sara', null);
    expect((await fillRoute(call('/x', { body: { what: 3, where: [] } }), params)).status).toBe(200);
    expect(lib.fillInDetails).toHaveBeenLastCalledWith(BRICK, 'u-sara', null);
    // What the screen showed is passed on to be checked against what Brick named
    expect((await fillRoute(call('/x', { body: { what: 'Your name', where: 'visa-portal.example' } }), params)).status).toBe(200);
    expect(lib.fillInDetails).toHaveBeenLastCalledWith(BRICK, 'u-sara', { what: 'Your name', where: 'visa-portal.example' });
  });
});

describe('the bot server’s calls', () => {
  it.each([
    ['read whether it is on', () => stateRoute(call('/x?userId=u', { method: 'GET' }), params)],
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
    expect(lib.startJob).toHaveBeenCalledWith(expect.objectContaining({ botId: BRICK, personId: 'u-sara', title: 'Visa form', origin: null }));
    // The chat it began in is kept, and only a direct chat can start computer work
    await startRoute(asBot('/x', { body: { userId: 'wa-sara', title: 'Visa form', origin: { kind: 'dm', ref: '!room:matrix' } } }), params);
    expect(lib.startJob).toHaveBeenLastCalledWith(expect.objectContaining({ origin: { kind: 'dm', ref: '!room:matrix' } }));
    const calls = lib.startJob.mock.calls.length;
    expect((await startRoute(asBot('/x', { body: { userId: 'wa-sara', title: 'Visa form', origin: { kind: 'group', ref: '!group:matrix' } } }), params)).status).toBe(400);
    expect(lib.startJob.mock.calls.length).toBe(calls);
    await startRoute(asBot('/x', { body: { userId: 'wa-sara', title: 'Visa form', brief: 'Two people, passport ready' } }), params);
    expect(lib.startJob).toHaveBeenLastCalledWith(expect.objectContaining({ brief: 'Two people, passport ready' }));
    expect((await startRoute(asBot('/x', { body: { userId: 'wa-sara', title: 'x', brief: 'y'.repeat(4001) } }), params)).status).toBe(400);
    resolve.mockResolvedValue({ personId: null, guest: true });
    expect(await (await startRoute(asBot('/x', { body: { userId: 'wa-guest', isGuest: true, title: 'x' } }), params)).json()).toEqual({ ok: false, reason: 'not_owner' });
    expect(lib.startJob).toHaveBeenCalledTimes(3);
  });

  it('answers every refusal of a start as an ordinary success (HTTP 200, `ok: false` and a reason from the known list), never 429 or another error status: a 429 on a start is an intermediary’s, and its outcome is not known', async () => {
    resolve.mockResolvedValue({ personId: 'u-sara', guest: false });
    for (const reason of START_REFUSALS) {
      if (reason === 'cheaper_route') lib.startJob.mockResolvedValue({ ok: false, reason, app: 'Gmail' });
      else if (reason === 'rule') lib.startJob.mockResolvedValue({ ok: false, reason, words: 'No more than $1.00 a month' });
      else if (reason === 'not_set') lib.startJob.mockResolvedValue({ ok: false, reason });
      else if (reason === 'cannot_continue') lib.startJob.mockResolvedValue({ ok: false, reason, why: 'not_continuable', job: { title: 'Visa form', status: 'stopped', endedBy: 'person' } });
      // A key the game retired is answered from the refusal kept on it (round 8)
      else if (reason === 'retired_by_game') lib.startJob.mockResolvedValue({ ok: false, reason: 'kept', body: { ok: false, reason } });
      else lib.startJob.mockResolvedValue({ ok: false, reason });
      const response = await startRoute(asBot('/x', { body: { userId: 'wa-sara', title: 'x' } }), params);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { ok: boolean; reason: string };
      expect(body).toMatchObject({ ok: false, reason });
      expect(START_REFUSALS).toContain(body.reason);
    }
    // The refusals Orbit decides in the route itself are the same: a guest, and a rule held before any job
    resolve.mockResolvedValue({ personId: null, guest: true });
    const guest = await startRoute(asBot('/x', { body: { userId: 'wa-guest', isGuest: true, title: 'x' } }), params);
    expect(guest.status).toBe(200);
    expect(await guest.json()).toEqual({ ok: false, reason: 'not_owner' });
    resolve.mockResolvedValue({ personId: 'u-sara', guest: false });
    rules.ownerSpendAllowed.mockResolvedValue({ ok: false, ruleId: 'r1', why: 'cap', leftMicros: 0, words: 'No more than $1.00 a month' });
    const ruled = await startRoute(asBot('/x', { body: { userId: 'wa-sara', title: 'x' } }), params);
    expect(ruled.status).toBe(200);
    expect(await ruled.json()).toMatchObject({ ok: false, reason: 'rule' });
    // What is NOT a refusal is an error without an `ok` field: invalid input, the wrong token, Orbit failing
    rules.ownerSpendAllowed.mockResolvedValue({ ok: true });
    expect((await startRoute(asBot('/x', { body: { userId: 'wa-sara' } }), params)).status).toBe(400);
    expect((await startRoute(call('/x', { body: { userId: 'wa-sara', title: 'x' } }), params)).status).toBe(401);
    lib.startJob.mockRejectedValue(new Error('db down'));
    const failed = await startRoute(asBot('/x', { body: { userId: 'wa-sara', title: 'x' } }), params);
    expect(failed.status).toBe(500);
    expect(await failed.json()).not.toHaveProperty('ok');
  });

  it('says one shared reading of the status of the job a key made: live (in line, running, waiting), done, or ended (stopped, failed)', () => {
    expect(['queued', 'running', 'waiting'].map(startStateOf)).toEqual(['live', 'live', 'live']);
    expect(startStateOf('done')).toBe('done');
    expect(['stopped', 'failed'].map(startStateOf)).toEqual(['ended', 'ended']);
    // A status it does not know is never read as over
    expect(startStateOf('something-new')).toBe('live');
  });

  it('says a rule the person said in chat stops it, with the rule’s own words, before any job is started', async () => {
    resolve.mockResolvedValue({ personId: 'u-sara', guest: false });
    rules.ownerSpendAllowed.mockResolvedValue({ ok: false, ruleId: 'r1', why: 'cap', leftMicros: 0, words: 'No more than $1.00 a month from your credit for Brick' });
    expect(await (await startRoute(asBot('/x', { body: { userId: 'wa-sara', title: 'x' } }), params)).json()).toEqual({
      ok: false,
      reason: 'rule',
      rule: { id: 'r1', why: 'cap', leftMicros: 0, words: 'No more than $1.00 a month from your credit for Brick' },
    });
    expect(rules.ownerSpendAllowed).toHaveBeenCalledWith(BRICK, 'u-sara', 'computer', expect.any(Date), null, null, null);
    expect(lib.startJob).not.toHaveBeenCalled();
  });

  it('keeps the rule’s words when a rule stops it on the try itself, after the first check let it through', async () => {
    resolve.mockResolvedValue({ personId: 'u-sara', guest: false });
    lib.startJob.mockResolvedValue({ ok: false, reason: 'rule', words: 'No more than $1.00 a month from your credit for Brick' } as never);
    expect(await (await startRoute(asBot('/x', { body: { userId: 'wa-sara', title: 'x' } }), params)).json()).toEqual({
      ok: false,
      reason: 'rule',
      rule: { id: null, why: null, leftMicros: null, words: 'No more than $1.00 a month from your credit for Brick' },
    });
  });

  describe('a start the game confirms it has the answer of (GPT round 4, second note, R1)', () => {
    // Round 8, A2: a start that acks carries its issue time in its key
    const KEY = `t${Date.now().toString(36)}-3f2b8c1e5d4a4e7b9a601c2d3e4f5a6b`;
    const own = () => resolve.mockResolvedValue({ personId: 'u-sara', guest: false });
    beforeEach(() => {
      lib.registerStart.mockResolvedValue({ registration: { opened: true, reopened: false, release: jest.fn(async () => undefined) } } as never);
    });

    it('row 58: the five-minute future tolerance is exact: a key issued up to and including 5 minutes ahead of the start\'s own moment is accepted, one millisecond more is 400 untimed_key', async () => {
      own();
      lib.registerStart.mockClear();
      lib.startJob.mockClear();
      lib.startJob.mockResolvedValue({ ok: true, job: { id: JOB } as never, restoredFrom: null });
      // Only the clock is pinned (the start reads its own moment from `new Date()` before anything else), so the boundary is exact
      const now = new Date('2026-11-24T10:00:00.000Z');
      jest.useFakeTimers({ now, doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask', 'performance', 'hrtime'] });
      try {
        const send = (issuedMs: number) =>
          startRoute(asBot('/x', { body: { userId: 'wa-sara', title: 'x' }, headers: { 'X-Computer-Start-Attempt': `t${issuedMs.toString(36)}-abcdef012345`, 'X-Computer-Start-Acks': '1' } }), params);
        const edge = await send(now.getTime() + 5 * 60_000);
        expect(edge.status).toBe(200);
        expect(lib.registerStart).toHaveBeenCalledTimes(1);
        lib.registerStart.mockClear();
        const past = await send(now.getTime() + 5 * 60_000 + 1);
        expect(past.status).toBe(400);
        expect(await past.json()).toMatchObject({ reason: 'untimed_key' });
        expect(lib.registerStart).not.toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });

    it('round 8, A2: a start that acks with a key that carries no issue time, or one more than 5 minutes in the future, is 400 and nothing is asked or made', async () => {
      own();
      lib.startJob.mockClear();
      lib.registerStart.mockClear();
      const suffix = 'abcdef012345';
      for (const key of ['3f2b8c1e-5d4a-4e7b-9a60-1c2d3e4f5a6b', `t${(Date.now() + 10 * 60_000).toString(36)}-${suffix}`]) {
        const response = await startRoute(asBot('/x', { body: { userId: 'wa-sara', title: 'x' }, headers: { 'X-Computer-Start-Attempt': key, 'X-Computer-Start-Acks': '1' } }), params);
        expect(response.status).toBe(400);
        // The reason is the untimed one for both (no time to read, and a time too far ahead): it is the answer the game reads, and an unrelated 400 would not carry it
        expect(await response.json()).toMatchObject({ reason: 'untimed_key' });
      }
      expect(lib.registerStart).not.toHaveBeenCalled();
      expect(lib.startJob).not.toHaveBeenCalled();
      // CONTROL: the same suffix with the CURRENT time is a timed key and is not refused: the future time (the skew check) is what was refused above, not the key's shape
      lib.startJob.mockResolvedValue({ ok: true, job: { id: JOB } as never, restoredFrom: null });
      const current = await startRoute(asBot('/x', { body: { userId: 'wa-sara', title: 'x' }, headers: { 'X-Computer-Start-Attempt': `t${Date.now().toString(36)}-${suffix}`, 'X-Computer-Start-Acks': '1' } }), params);
      expect(current.status).toBe(200);
      expect(await current.json()).not.toHaveProperty('reason');
      expect(lib.registerStart).toHaveBeenCalledTimes(1);
      lib.registerStart.mockClear();
      lib.startJob.mockClear();
      // Without acks an untimed key is the legacy start, as before
      lib.startJob.mockResolvedValue({ ok: true, job: { id: JOB } as never, restoredFrom: null });
      const legacy = await startRoute(asBot('/x', { body: { userId: 'wa-sara', title: 'x' }, headers: { 'X-Computer-Start-Attempt': '3f2b8c1e-5d4a-4e7b-9a60-1c2d3e4f5a6b' } }), params);
      expect(legacy.status).toBe(200);
      expect(lib.registerStart).not.toHaveBeenCalled();
    });

    it('round 8, A1: the start is registered with the request’s own moment BEFORE the earlier-start look and the spending rule; a key decided for good is answered from there, and nothing else is asked', async () => {
      own();
      const order: string[] = [];
      lib.registerStart.mockImplementationOnce(async () => {
        order.push('register');
        return { registration: { opened: true, reopened: false, release: jest.fn(async () => undefined) } } as never;
      });
      lib.earlierUnconfirmedStart.mockImplementationOnce(async () => {
        order.push('earlier');
        return null;
      });
      rules.ownerSpendAllowed.mockImplementationOnce(async () => {
        order.push('spend');
        return { ok: true } as never;
      });
      lib.startJob.mockResolvedValue({ ok: true, job: { id: JOB } as never, restoredFrom: null });
      // The clock is controlled (only Date is faked): reading the request's body takes 30 s, so a `began` taken after the body was read would be 30 s later than the moment the request arrived
      jest.useFakeTimers({ now: Date.now(), doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'queueMicrotask', 'hrtime', 'performance'] });
      const arrived = Date.now();
      try {
        const request = asBot('/x', { body: { userId: 'wa-sara', title: 'x' }, headers: { 'X-Computer-Start-Attempt': KEY, 'X-Computer-Start-Acks': '1' } });
        jest.spyOn(request, 'json').mockImplementation(async () => {
          jest.setSystemTime(arrived + 30_000);
          return { userId: 'wa-sara', title: 'x' };
        });
        await startRoute(request, params);
        expect(Date.now()).toBe(arrived + 30_000);
      } finally {
        jest.useRealTimers();
      }
      expect(order).toEqual(['register', 'earlier', 'spend']);
      const began = (lib.registerStart.mock.calls.at(-1) as unknown[])[3] as Date;
      // The moment the request arrived, before its body was read (never the moment after)
      expect(began.getTime()).toBe(arrived);
      expect(lib.startJob).toHaveBeenLastCalledWith(expect.objectContaining({ began, registration: expect.objectContaining({ opened: true }) }));
      // A terminal answer of the key: given as it is, nothing else asked
      lib.registerStart.mockResolvedValueOnce({ answer: { ok: false, reason: 'stale_consent' } } as never);
      lib.startJob.mockClear();
      rules.ownerSpendAllowed.mockClear();
      const stale = await startRoute(asBot('/x', { body: { userId: 'wa-sara', title: 'x' }, headers: { 'X-Computer-Start-Attempt': KEY, 'X-Computer-Start-Acks': '1' } }), params);
      expect(await stale.json()).toEqual({ ok: false, reason: 'stale_consent' });
      expect(rules.ownerSpendAllowed).not.toHaveBeenCalled();
      expect(lib.startJob).not.toHaveBeenCalled();
    });

    it('meets an earlier unconfirmed start BEFORE the spend rule: a chat-stated rule the earlier job used up is never a false `rule` (CodeRabbit)', async () => {
      own();
      const earlier = { id: 'job-0', status: 'running', state: 'live', attempt: 'older-key-0001' };
      lib.earlierUnconfirmedStart.mockResolvedValueOnce(earlier as never);
      rules.ownerSpendAllowed.mockClear();
      rules.ownerSpendAllowed.mockResolvedValue({ ok: false, ruleId: 'r1', why: 'cap', leftMicros: 0, words: 'No more than $1.00 a month' });
      lib.startJob.mockClear();
      const response = await startRoute(asBot('/x', { body: { userId: 'wa-sara', title: 'another' }, headers: { 'X-Computer-Start-Attempt': KEY, 'X-Computer-Start-Acks': '1' } }), params);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: false, reason: 'earlier', job: earlier });
      expect(lib.earlierUnconfirmedStart).toHaveBeenLastCalledWith(BRICK, 'u-sara', KEY);
      expect(rules.ownerSpendAllowed).not.toHaveBeenCalled();
      expect(lib.startJob).not.toHaveBeenCalled();
      // Nothing earlier: the spend rule is asked as before, and a start that does not ack never looks for one
      lib.earlierUnconfirmedStart.mockResolvedValue(null as never);
      const ruled = await startRoute(asBot('/x', { body: { userId: 'wa-sara', title: 'another' }, headers: { 'X-Computer-Start-Attempt': KEY, 'X-Computer-Start-Acks': '1' } }), params);
      expect(await ruled.json()).toMatchObject({ ok: false, reason: 'rule' });
      lib.earlierUnconfirmedStart.mockClear();
      await startRoute(asBot('/x', { body: { userId: 'wa-sara', title: 'another' }, headers: { 'X-Computer-Start-Attempt': KEY } }), params);
      expect(lib.earlierUnconfirmedStart).not.toHaveBeenCalled();
      rules.ownerSpendAllowed.mockResolvedValue({ ok: true });
    });

    it('N2: a refusal another request decided first is answered with the complete answer on record (the key’s own job included); with none to read it is a retryable 503, never this request’s own refusal', async () => {
      own();
      lib.earlierUnconfirmedStart.mockResolvedValue(null as never);
      rules.ownerSpendAllowed.mockResolvedValue({ ok: false, ruleId: 'r1', why: 'cap', leftMicros: 0, words: 'No more than $1.00 a month' });
      const ask = () => startRoute(asBot('/x', { body: { userId: 'wa-sara', title: 'x' }, headers: { 'X-Computer-Start-Attempt': KEY, 'X-Computer-Start-Acks': '1' } }), params);
      // Another request made this key's job between this one's look and its refusal: its job is the answer
      lib.refuseAttempt.mockResolvedValue('decided');
      lib.storedStartAnswer.mockResolvedValue({ ok: true, job: { id: JOB } });
      const made = await ask();
      expect(made.status).toBe(200);
      expect(await made.json()).toEqual({ ok: true, job: { id: JOB } });
      expect(lib.storedStartAnswer).toHaveBeenLastCalledWith(BRICK, 'u-sara', KEY);
      // Nothing can be read for the key: the game asks again
      lib.storedStartAnswer.mockResolvedValue(null);
      const none = await ask();
      expect(none.status).toBe(503);
      expect(await none.json()).toMatchObject({ retry: true });
      // The refusal that was stored is the answer, as before
      lib.refuseAttempt.mockResolvedValue('stored');
      lib.storedStartAnswer.mockClear();
      expect(await (await ask()).json()).toMatchObject({ ok: false, reason: 'rule' });
      expect(lib.storedStartAnswer).not.toHaveBeenCalled();
      rules.ownerSpendAllowed.mockResolvedValue({ ok: true });
    });

    it('says the start acks only with the header AND a key: without either the job is made as before', async () => {
      own();
      lib.startJob.mockResolvedValue({ ok: true, job: { id: JOB } as never, restoredFrom: null });
      await startRoute(asBot('/x', { body: { userId: 'wa-sara', title: 'x' }, headers: { 'X-Computer-Start-Attempt': KEY, 'X-Computer-Start-Acks': '1' } }), params);
      expect(lib.startJob).toHaveBeenLastCalledWith(expect.objectContaining({ startKey: KEY, acks: true }));
      await startRoute(asBot('/x', { body: { userId: 'wa-sara', title: 'x' }, headers: { 'X-Computer-Start-Attempt': KEY } }), params);
      expect(lib.startJob).toHaveBeenLastCalledWith(expect.objectContaining({ startKey: KEY, acks: false }));
      await startRoute(asBot('/x', { body: { userId: 'wa-sara', title: 'x' }, headers: { 'X-Computer-Start-Acks': '1' } }), params);
      expect(lib.startJob).toHaveBeenLastCalledWith(expect.objectContaining({ acks: false }));
      await startRoute(asBot('/x', { body: { userId: 'wa-sara', title: 'x' } }), params);
      expect(lib.startJob).toHaveBeenLastCalledWith(expect.objectContaining({ acks: false }));
    });

    it('answers an earlier unconfirmed start as HTTP 200 `earlier` with that job and the key it was made under, and it is not one of the known refusals', async () => {
      own();
      const earlier = { id: 'job-0', status: 'running', state: 'live', attempt: 'older-key-0001' };
      lib.startJob.mockResolvedValue({ ok: false, reason: 'earlier', job: earlier } as never);
      const response = await startRoute(asBot('/x', { body: { userId: 'wa-sara', title: 'another' }, headers: { 'X-Computer-Start-Attempt': KEY, 'X-Computer-Start-Acks': '1' } }), params);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: false, reason: 'earlier', job: earlier });
      expect(START_REFUSALS).not.toContain('earlier');
    });

    it('a look confirms nothing: found, not found, still going on or without a key, it only reads (GPT round 4, third note)', async () => {
      own();
      lib.computerView.mockResolvedValue({ available: true, on: true, job: null, queued: [] } as never);
      lib.startedJobFor.mockResolvedValue({ id: JOB, status: 'running' });
      await stateRoute(asBot(`/x?userId=wa-sara&attempt=${KEY}`, { method: 'GET' }), params);
      await stateRoute(asBot(`/x?userId=wa-sara&attempt=${KEY}`, { method: 'GET' }), params);
      lib.startedJobFor.mockResolvedValue(null);
      await stateRoute(asBot(`/x?userId=wa-sara&attempt=${KEY}`, { method: 'GET' }), params);
      lib.startedJobFor.mockResolvedValue({ inProgress: true });
      await stateRoute(asBot(`/x?userId=wa-sara&attempt=${KEY}`, { method: 'GET' }), params);
      await stateRoute(asBot('/x?userId=wa-sara', { method: 'GET' }), params);
      expect(lib.ackStart).not.toHaveBeenCalled();
    });

    it('takes the ack from the bot server only, for a key, and answers whether it has a job; a guest, a bad key or an unknown person change nothing', async () => {
      own();
      lib.ackStart.mockResolvedValue(true);
      const ack = (body: unknown, token: boolean = true) => startRoute(token ? asBot('/x', { body }) : call('/x', { body }), params);
      expect((await ack({ action: 'start-ack', userId: 'wa-sara', attempt: KEY }, false)).status).toBe(401);
      const done = await ack({ action: 'start-ack', userId: 'wa-sara', attempt: KEY });
      expect(done.status).toBe(200);
      expect(await done.json()).toEqual({ ok: true, acked: true });
      expect(lib.startJob).not.toHaveBeenCalled();
      expect(lib.ackStart).toHaveBeenCalledWith(BRICK, 'u-sara', KEY);
      lib.ackStart.mockClear();
      for (const body of [{ action: 'start-ack', userId: 'wa-sara' }, { action: 'start-ack', userId: 'wa-sara', attempt: 'short' }, { action: 'start-ack', userId: 'wa-sara', attempt: 'has space in it!' }, { action: 'start-ack', userId: 'wa-sara', attempt: KEY, extra: 1 }, { action: 'something-else', userId: 'wa-sara', attempt: KEY }]) {
        expect((await ack(body)).status).toBe(400);
      }
      resolve.mockResolvedValue({ personId: null, guest: true });
      expect(await (await ack({ action: 'start-ack', userId: 'wa-guest', isGuest: true, attempt: KEY })).json()).toEqual({ ok: true, acked: false });
      resolve.mockResolvedValue({ personId: null, guest: false, lookupFailed: true });
      expect((await ack({ action: 'start-ack', userId: 'wa-sara', attempt: KEY })).status).toBe(503);
      expect(lib.ackStart).not.toHaveBeenCalled();
    });
  });

  describe('whether a start that timed out reached Orbit: by the start’s own key (game #2114)', () => {
    const KEY = '3f2b8c1e-5d4a-4e7b-9a60-1c2d3e4f5a6b';
    const asked = `/x?userId=wa-sara&attempt=${KEY}`;
    const answer = async (path: string) => (await stateRoute(asBot(path, { method: 'GET' }), params)).json();

    it('carries `started` only when the caller asked for it with its key: an old caller gets the same answer as before', async () => {
      resolve.mockResolvedValue({ personId: 'u-sara', guest: false });
      lib.computerView.mockResolvedValue({ available: true, on: true, job: null, queued: [] } as never);
      lib.startedJobFor.mockResolvedValue({ id: JOB, status: 'running' });
      expect(await answer('/x?userId=wa-sara')).toEqual({ available: true, on: true, busy: false });
      expect(lib.startedJobFor).not.toHaveBeenCalled();
      expect(await answer(asked)).toEqual({ available: true, on: true, busy: false, started: { id: JOB, status: 'running', state: 'live', attempt: KEY } });
      expect(lib.startedJobFor).toHaveBeenCalledWith(BRICK, 'u-sara', KEY);
      lib.startedJobFor.mockResolvedValue(null);
      expect(await answer(asked)).toEqual({ available: true, on: true, busy: false, started: null });
    });

    it('looks by the key alone: the chat, the title and the age a caller may still send are not what it looks for', async () => {
      resolve.mockResolvedValue({ personId: 'u-sara', guest: false });
      lib.computerView.mockResolvedValue({ available: true, on: true, job: null, queued: [] } as never);
      lib.startedJobFor.mockResolvedValue(null);
      await answer(`${asked}&originRef=dm-1&title=Visa%20form&sinceSeconds=45`);
      expect(lib.startedJobFor).toHaveBeenCalledTimes(1);
      expect(lib.startedJobFor).toHaveBeenCalledWith(BRICK, 'u-sara', KEY);
      // Without the key, a title and an age alone ask nothing
      lib.startedJobFor.mockClear();
      expect(await answer('/x?userId=wa-sara&originRef=dm-1&title=Visa%20form&sinceSeconds=45')).toEqual({ available: true, on: true, busy: false });
      expect(lib.startedJobFor).not.toHaveBeenCalled();
    });

    it('says `started: null` for a guest and for a Brick that is not theirs, and never looks for a job for either', async () => {
      resolve.mockResolvedValue({ personId: null, guest: true });
      lib.computerView.mockResolvedValue(null);
      expect(await answer(`${asked}&isGuest=true`)).toEqual({ available: false, on: false, busy: false, started: null });
      expect(lib.startedJobFor).not.toHaveBeenCalled();
      // Someone who is signed in, on a Brick that is not theirs: only the owner starts work on it, so no job of theirs can be there to find, and the lookup is not made (the mocked job would be found if it were)
      resolve.mockResolvedValue({ personId: 'u-omar', guest: false });
      lib.startedJobFor.mockResolvedValue({ id: JOB, status: 'running' });
      expect(await answer(asked)).toEqual({ available: false, on: false, busy: false, started: null });
      expect(lib.computerView).toHaveBeenLastCalledWith(BRICK, 'u-omar');
      expect(lib.startedJobFor).not.toHaveBeenCalled();
    });

    it('does not answer "no job reached Orbit" when who this was for could not be looked up: it answers retry (503), and reads nothing', async () => {
      resolve.mockResolvedValue({ personId: null, guest: false, lookupFailed: true });
      lib.startedJobFor.mockResolvedValue(null);
      const response = await stateRoute(asBot(asked, { method: 'GET' }), params);
      expect(response.status).toBe(503);
      const body = await response.json();
      expect(body.retry).toBe(true);
      expect(body).not.toHaveProperty('started');
      expect(lib.startedJobFor).not.toHaveBeenCalled();
      expect(lib.computerView).not.toHaveBeenCalled();
      // A caller that did not ask whether a start reached Orbit keeps the answer it always had
      const old = await stateRoute(asBot('/x?userId=wa-sara', { method: 'GET' }), params);
      expect(old.status).toBe(200);
      expect(await old.json()).toEqual({ available: false, on: false, busy: false });
    });

    it('answers retry (503, inProgress) while a start with that key is still going on: not `started: null`, which says no job was made', async () => {
      resolve.mockResolvedValue({ personId: 'u-sara', guest: false });
      lib.computerView.mockResolvedValue({ available: true, on: true, job: null, queued: [] } as never);
      lib.startedJobFor.mockResolvedValue({ inProgress: true });
      const response = await stateRoute(asBot(asked, { method: 'GET' }), params);
      expect(response.status).toBe(503);
      const body = await response.json();
      expect(body).toMatchObject({ retry: true, inProgress: true });
      expect(body).not.toHaveProperty('started');
      lib.startedJobFor.mockResolvedValue(null);
      expect(await answer(asked)).toEqual({ available: true, on: true, busy: false, started: null });
    });

    it('refuses a key that is not one (too short, too long, other characters), and reads nothing', async () => {
      resolve.mockResolvedValue({ personId: 'u-sara', guest: false });
      for (const key of ['', 'short', 'a'.repeat(65), 'has space in it', 'semi;colon-in-it', '..%2F..%2Fetc']) {
        expect((await stateRoute(asBot(`/x?userId=u&attempt=${key}`, { method: 'GET' }), params)).status).toBe(400);
      }
      expect(lib.startedJobFor).not.toHaveBeenCalled();
    });

    it('the start takes the key from the header `X-Computer-Start-Attempt`, passes it on, and refuses one that is not a key; a start without one is as before', async () => {
      resolve.mockResolvedValue({ personId: 'u-sara', guest: false });
      lib.startJob.mockResolvedValue({ ok: false, reason: 'off' } as never);
      const body = { userId: 'wa-sara', title: 'x', origin: { kind: 'dm', ref: 'dm-1' } };
      expect((await startRoute(asBot('/x', { body, headers: { 'X-Computer-Start-Attempt': KEY } }), params)).status).toBe(200);
      expect(lib.startJob).toHaveBeenLastCalledWith(expect.objectContaining({ botId: BRICK, personId: 'u-sara', startKey: KEY }));
      // The spend check before the start knows the key too, so a retry of a start that used the allowance up reaches the start and finds its job
      expect(rules.ownerSpendAllowed).toHaveBeenLastCalledWith(BRICK, 'u-sara', 'computer', expect.any(Date), null, KEY, null);
      lib.startJob.mockClear();
      for (const bad of ['no', 'has space in it', 'a'.repeat(65), '']) {
        expect((await startRoute(asBot('/x', { body, headers: { 'X-Computer-Start-Attempt': bad } }), params)).status).toBe(400);
      }
      expect(lib.startJob).not.toHaveBeenCalled();
      await startRoute(asBot('/x', { body }), params);
      expect(lib.startJob).toHaveBeenLastCalledWith(expect.objectContaining({ startKey: undefined }));
    });

    it('the key is never a body field: the body stays strict, so a start that carries it there is refused', async () => {
      resolve.mockResolvedValue({ personId: 'u-sara', guest: false });
      expect((await startRoute(asBot('/x', { body: { userId: 'wa-sara', title: 'x', startKey: KEY } }), params)).status).toBe(400);
      expect(lib.startJob).not.toHaveBeenCalled();
    });

    it('one title for the start: trimmed before its length is read, never empty, never past 200 (the start stores it exactly so)', async () => {
      resolve.mockResolvedValue({ personId: 'u-sara', guest: false });
      lib.startJob.mockResolvedValue({ ok: false, reason: 'off' } as never);
      expect((await startRoute(asBot('/x', { body: { userId: 'wa-sara', title: `${'a'.repeat(200)} ` } }), params)).status).toBe(200);
      expect((await startRoute(asBot('/x', { body: { userId: 'wa-sara', title: '   ' } }), params)).status).toBe(400);
      expect((await startRoute(asBot('/x', { body: { userId: 'wa-sara', title: 'a'.repeat(201) } }), params)).status).toBe(400);
    });
  });

  it('says whether the computer is on for its owner, read only, and "off" for anyone else', async () => {
    resolve.mockResolvedValue({ personId: 'u-sara', guest: false });
    lib.computerView.mockResolvedValue({ available: true, on: true, job: null, queued: [] } as never);
    expect(await (await stateRoute(asBot('/x?userId=wa-sara', { method: 'GET' }), params)).json()).toEqual({ available: true, on: true, busy: false });
    lib.computerView.mockResolvedValue({ available: true, on: true, job: { id: JOB }, queued: [] } as never);
    expect(await (await stateRoute(asBot('/x?userId=wa-sara', { method: 'GET' }), params)).json()).toEqual({ available: true, on: true, busy: true });
    lib.computerView.mockResolvedValue(null);
    expect(await (await stateRoute(asBot('/x?userId=wa-omar', { method: 'GET' }), params)).json()).toEqual({ available: false, on: false, busy: false });
    resolve.mockResolvedValue({ personId: null, guest: true });
    expect(await (await stateRoute(asBot('/x?userId=wa-guest&isGuest=true', { method: 'GET' }), params)).json()).toEqual({ available: false, on: false, busy: false });
    expect((await stateRoute(asBot('/x', { method: 'GET' }), params)).status).toBe(400);
    expect(lib.startJob).not.toHaveBeenCalled();
  });

  it('says why a job could not start', async () => {
    resolve.mockResolvedValue({ personId: 'u-sara', guest: false });
    lib.startJob.mockResolvedValue({ ok: false, reason: 'off' });
    expect(await (await startRoute(asBot('/x', { body: { userId: 'wa-sara', title: 'x' } }), params)).json()).toEqual({ ok: false, reason: 'off' });
    expect((await startRoute(asBot('/x', { body: { title: 'x' } }), params)).status).toBe(400);
  });

  it('passes the way the Brick proposes to the start, and says which app to use instead when one would do it for less', async () => {
    resolve.mockResolvedValue({ personId: 'u-sara', guest: false });
    lib.startJob.mockResolvedValue({ ok: false, reason: 'cheaper_route', app: 'Notion' });
    const plan = { app: 'Notion', steps: 3, appCannot: null };
    expect(await (await startRoute(asBot('/x', { body: { userId: 'wa-sara', title: 'x', plan } }), params)).json()).toEqual({ ok: false, reason: 'cheaper_route', app: 'Notion' });
    expect(lib.startJob).toHaveBeenCalledWith(expect.objectContaining({ plan }));
    // A plan with something else in it, or a step count that is not a number, is not accepted
    expect((await startRoute(asBot('/x', { body: { userId: 'wa-sara', title: 'x', plan: { app: 'Notion', steps: 'many' } } }), params)).status).toBe(400);
    expect((await startRoute(asBot('/x', { body: { userId: 'wa-sara', title: 'x', plan: { app: 'Notion', price: 1 } } }), params)).status).toBe(400);
  });

  it('answers the review at 20 app steps for the bot server only, for the person it resolves, and a guest never has one', async () => {
    resolve.mockResolvedValue({ personId: 'u-sara', guest: false });
    lib.reviewAppSteps.mockResolvedValue({ review: true });
    expect((await reviewRoute(call('/x', { body: { userId: 'wa-sara', app: 'Notion', steps: 20 } }), params)).status).toBe(401);
    expect(await (await reviewRoute(asBot('/x', { body: { userId: 'wa-sara', app: 'Notion', steps: 20 } }), params)).json()).toEqual({ review: true });
    expect(lib.reviewAppSteps).toHaveBeenCalledWith(BRICK, 'u-sara', { app: 'Notion', steps: 20 });
    expect((await reviewRoute(asBot('/x', { body: { userId: 'wa-sara', app: 'Notion', steps: 'many' } }), params)).status).toBe(400);
    resolve.mockResolvedValue({ personId: null, guest: true });
    expect(await (await reviewRoute(asBot('/x', { body: { userId: 'wa-guest', isGuest: true, app: 'Notion', steps: 20 } }), params)).json()).toEqual({ review: false });
  });

  it('reaches a job only through its own Brick', async () => {
    lib.getJob.mockResolvedValue({ ...job, botId: 'another-brick' } as never);
    expect((await getJobRoute(asBot('/x', { method: 'GET' }), jobParams)).status).toBe(404);
    expect((await jobAction(asBot('/x', { body: { action: 'finish', outcome: 'done' } }), jobParams)).status).toBe(404);
    expect(lib.finishJobUnder).not.toHaveBeenCalled();
    expect(lib.recordFinishIntent).not.toHaveBeenCalled();
  });

  it('names the run on every renew, finish and stop (R2b-2): the run is passed on whole, a renewal from a replaced run is answered as the library answers it, and a run that is not a run is refused', async () => {
    lib.getJob.mockResolvedValue(job as never);
    lib.renewJob.mockResolvedValue({ ok: false, reason: 'stale', run: 'superseded' });
    expect(await (await jobAction(asBot('/x', { body: { action: 'renew', run: 'mi8x3k2a1b2c3d4e' } }), jobParams)).json()).toEqual({ ok: false, reason: 'stale', run: 'superseded' });
    expect(lib.renewJob).toHaveBeenLastCalledWith(JOB, expect.any(Date), { epoch: undefined });
    await jobAction(asBot('/x', { body: { action: 'renew' } }), jobParams);
    expect(lib.renewJob).toHaveBeenLastCalledWith(JOB, expect.any(Date), { epoch: undefined });
    for (const run of ['x'.repeat(41), '', 'has space', 5]) expect((await jobAction(asBot('/x', { body: { action: 'renew', run } }), jobParams)).status).toBe(400);
    // A finish names its run with no turns at all, and a stale one is answered HTTP 200 with the job
    lib.finishJobUnder.mockResolvedValue({ job: { id: JOB }, stale: true, superseded: true } as never);
    const late = await jobAction(asBot('/x', { body: { action: 'finish', outcome: 'done', run: 'r1' } }), jobParams);
    expect(late.status).toBe(200);
    expect(await late.json()).toMatchObject({ ok: false, reason: 'stale', run: 'superseded' });
    expect(lib.finishJobUnder).toHaveBeenLastCalledWith(JOB, undefined, 'done', expect.any(Date), undefined, undefined, undefined, 'r1', undefined);
  });

  it('claims a job by the epoch it last saw (GPT round 5): an owner gets its epoch, a worker that saw an older one is told `superseded` with the epoch to claim again from; a kept intent, a cutoff or an over job take no ownership; a claim names a number', async () => {
    lib.getJob.mockResolvedValue({ ...job, finishPending: null } as never);
    lib.claimJob.mockResolvedValueOnce({ ok: true, epoch: 3 } as never);
    const won = await jobAction(asBot('/x', { body: { action: 'claim', run: 'rB', seen: 2 } }), jobParams);
    expect(won.status).toBe(200);
    expect(await won.json()).toEqual({ ok: true, epoch: 3, job: expect.objectContaining({ id: JOB }) });
    expect(lib.claimJob).toHaveBeenLastCalledWith(JOB, { run: 'rB', seen: 2 });
    lib.claimJob.mockResolvedValueOnce({ ok: false, reason: 'superseded', ownerEpoch: 4 } as never);
    const lost = await jobAction(asBot('/x', { body: { action: 'claim', seen: 2 } }), jobParams);
    expect(lost.status).toBe(200);
    expect(await lost.json()).toEqual({ ok: false, reason: 'stale', run: 'superseded', ownerEpoch: 4, job: expect.objectContaining({ id: JOB }) });
    expect(lib.claimJob).toHaveBeenLastCalledWith(JOB, { run: null, seen: 2 });
    for (const reason of ['cutoff', 'over', 'not_running']) {
      lib.claimJob.mockResolvedValueOnce({ ok: false, reason } as never);
      const refused = await jobAction(asBot('/x', { body: { action: 'claim', seen: 0 } }), jobParams);
      expect(refused.status).toBe(200);
      expect(await refused.json()).toMatchObject({ ok: false, reason, job: expect.objectContaining({ id: JOB }) });
    }
    const pending = { outcome: 'done', run: 'r1', at: '2026-11-22T10:00:00.000Z' };
    lib.getJob.mockResolvedValue({ ...job, finishPending: pending } as never);
    lib.claimJob.mockResolvedValueOnce({ ok: false, reason: 'finish_pending' } as never);
    expect(await (await jobAction(asBot('/x', { body: { action: 'claim', seen: 0 } }), jobParams)).json()).toMatchObject({ ok: false, reason: 'finish_pending', finishPending: pending });
    lib.claimJob.mockResolvedValueOnce({ ok: false, reason: 'not_found' } as never);
    expect((await jobAction(asBot('/x', { body: { action: 'claim', seen: 0 } }), jobParams)).status).toBe(404);
    const calls = lib.claimJob.mock.calls.length;
    for (const seen of [-1, 1.5, '2', null, undefined]) expect((await jobAction(asBot('/x', { body: { action: 'claim', seen } }), jobParams)).status).toBe(400);
    expect(lib.claimJob.mock.calls.length).toBe(calls);
  });

  it('names its epoch on every request after the claim, and answers an old worker the game’s `superseded` shape: renew, progress, hand-over, finish and finish-intent', async () => {
    lib.getJob.mockResolvedValue(job as never);
    lib.renewJob.mockResolvedValue({ ok: false, reason: 'stale', run: 'superseded' });
    await jobAction(asBot('/x', { body: { action: 'renew', epoch: 3 } }), jobParams);
    expect(lib.renewJob).toHaveBeenLastCalledWith(JOB, expect.any(Date), { epoch: 3 });
    lib.reportProgressAs.mockResolvedValue({ job: { id: JOB }, applied: false, superseded: true } as never);
    expect(await (await jobAction(asBot('/x', { body: { action: 'progress', stepDone: 1, stepTotal: 2, label: 'x', epoch: 2 } }), jobParams)).json()).toEqual({ ok: false, reason: 'stale', run: 'superseded', job: { id: JOB } });
    expect(lib.reportProgressAs).toHaveBeenLastCalledWith(JOB, { stepDone: 1, stepTotal: 2, label: 'x' }, { epoch: 2 });
    lib.reportProgressAs.mockResolvedValue({ job: { id: JOB }, applied: true, superseded: false } as never);
    expect(await (await jobAction(asBot('/x', { body: { action: 'progress', stepDone: 1, stepTotal: 2, label: 'x', epoch: 3 } }), jobParams)).json()).toEqual({ job: { id: JOB } });
    lib.requestHandoverAs.mockResolvedValueOnce({ job: { id: JOB }, refused: 'superseded' } as never);
    expect(await (await jobAction(asBot('/x', { body: { action: 'handover', waitingFor: 'signin', epoch: 2, generation: 0, responseId: 'resp-1' } }), jobParams)).json()).toEqual({ ok: false, reason: 'stale', run: 'superseded', job: { id: JOB } });
    expect(lib.requestHandoverAs).toHaveBeenLastCalledWith(JOB, 'signin', expect.any(Date), undefined, { epoch: 2, generation: 0, responseId: 'resp-1' });
    for (const refused of ['stale', 'not_current'] as const) {
      lib.requestHandoverAs.mockResolvedValueOnce({ job: { id: JOB }, refused } as never);
      expect(await (await jobAction(asBot('/x', { body: { action: 'handover', waitingFor: 'signin', epoch: 3 } }), jobParams)).json()).toEqual({ ok: false, reason: refused, job: { id: JOB } });
    }
    lib.requestHandoverAs.mockResolvedValueOnce({ job: { id: JOB }, refused: null } as never);
    expect(await (await jobAction(asBot('/x', { body: { action: 'handover', waitingFor: 'signin', epoch: 3 } }), jobParams)).json()).toEqual({ job: { id: JOB } });
    lib.finishJobUnder.mockResolvedValue({ job: { id: JOB }, stale: false } as never);
    await jobAction(asBot('/x', { body: { action: 'finish', outcome: 'done', run: 'r1', epoch: 3 } }), jobParams);
    expect(lib.finishJobUnder).toHaveBeenLastCalledWith(JOB, undefined, 'done', expect.any(Date), undefined, undefined, undefined, 'r1', 3);
    lib.recordFinishIntent.mockResolvedValue({ ok: false, reason: 'stale', run: 'superseded' } as never);
    await jobAction(asBot('/x', { body: { action: 'finish-intent', outcome: 'done', epoch: 3 } }), jobParams);
    expect(lib.recordFinishIntent).toHaveBeenLastCalledWith(JOB, expect.objectContaining({ epoch: 3 }));
    for (const epoch of [-1, 1.5, '3']) expect((await jobAction(asBot('/x', { body: { action: 'renew', epoch } }), jobParams)).status).toBe(400);
  });

  it('shows the job’s owner epoch and run when the bot server reads it (the epoch a runner claims from)', async () => {
    lib.getJob.mockResolvedValue({ ...job, ownerEpoch: 5, ownerRun: 'rB' } as never);
    const read = await getJobRoute(asBot('/x', { method: 'GET' }), jobParams);
    expect(await read.json()).toMatchObject({ job: { id: JOB, ownerEpoch: 5, ownerRun: 'rB' } });
  });

  it('gives the runner the person’s pending notes with the job, and takes `notes-sent` from the owner (the epoch it names)', async () => {
    lib.getJob.mockResolvedValue({ ...job, ownerEpoch: 5 } as never);
    notes.pendingNotes.mockResolvedValue([{ seq: 1, text: 'use 12 March' }]);
    const read = await getJobRoute(asBot('/x', { method: 'GET' }), jobParams);
    expect(await read.json()).toMatchObject({ job: { id: JOB, notes: [{ seq: 1, text: 'use 12 March' }] } });
    notes.notesSent.mockResolvedValue({ ok: true, sent: 1 });
    expect(await (await jobAction(asBot('/x', { body: { action: 'notes-sent', epoch: 5, through: 1 } }), jobParams)).json()).toEqual({ ok: true, sent: 1 });
    expect(notes.notesSent).toHaveBeenLastCalledWith(JOB, { through: 1, epoch: 5 });
    notes.notesSent.mockResolvedValue({ ok: false, reason: 'stale', run: 'superseded' });
    expect(await (await jobAction(asBot('/x', { body: { action: 'notes-sent', epoch: 4, through: 1 } }), jobParams)).json()).toEqual({ ok: false, reason: 'stale', run: 'superseded' });
    for (const through of [0, -1, 1.5, '1']) expect((await jobAction(asBot('/x', { body: { action: 'notes-sent', epoch: 5, through } }), jobParams)).status).toBe(400);
  });

  it('takes what a running job says: steps, renewing, hand-over, finishing, and outside effects before they are tried', async () => {
    lib.getJob.mockResolvedValue(job as never);
    lib.reportProgressAs.mockResolvedValue({ job: { id: JOB }, applied: true, superseded: false } as never);
    lib.renewJob.mockResolvedValue({ ok: false, reason: 'allowance' });
    lib.requestHandoverAs.mockResolvedValue({ job: { id: JOB }, refused: null } as never);
    lib.finishJobUnder.mockResolvedValue({ job: { id: JOB }, stale: false } as never);
    lib.planEffect.mockResolvedValue({ ok: false, reason: 'look_up', evidence: 'draft pull request' });
    lib.settleEffectAs.mockResolvedValue({ ok: true, superseded: false });
    await jobAction(asBot('/x', { body: { action: 'progress', stepDone: 2, stepTotal: 5, label: 'Your visa form' } }), jobParams);
    expect(lib.reportProgressAs).toHaveBeenCalledWith(JOB, { stepDone: 2, stepTotal: 5, label: 'Your visa form' }, { epoch: undefined });
    expect(await (await jobAction(asBot('/x', { body: { action: 'renew' } }), jobParams)).json()).toEqual({ ok: false, reason: 'allowance' });
    await jobAction(asBot('/x', { body: { action: 'handover', waitingFor: 'details', ready: { what: 'Your details', where: 'visa-portal.example' } } }), jobParams);
    expect(lib.requestHandoverAs).toHaveBeenCalledWith(JOB, 'details', expect.any(Date), { what: 'Your details', where: 'visa-portal.example' }, { epoch: undefined, generation: undefined, responseId: undefined });
    await jobAction(asBot('/x', { body: { action: 'finish', outcome: 'done' } }), jobParams);
    expect(lib.finishJobUnder).toHaveBeenCalledWith(JOB, undefined, 'done', expect.any(Date), undefined, undefined, undefined, undefined, undefined);
    // A failure carries the computer's own sentence about why, kept cleaned for the message that tells the person
    await jobAction(asBot('/x', { body: { action: 'finish', outcome: 'failed', why: 'The site kept showing an error' } }), jobParams);
    expect(lib.finishJobUnder).toHaveBeenLastCalledWith(JOB, undefined, 'failed', expect.any(Date), 'The site kept showing an error', undefined, undefined, undefined, undefined);
    // Who a failure is down to travels with it (only `ours` is given back); a word it does not know is refused
    await jobAction(asBot('/x', { body: { action: 'finish', outcome: 'failed', cause: 'ours' } }), jobParams);
    expect(lib.finishJobUnder).toHaveBeenLastCalledWith(JOB, undefined, 'failed', expect.any(Date), undefined, 'ours', undefined, undefined, undefined);
    // ...with the turns the runner judged failed: Orbit decides from the relay's rows for them (the cause is only a hint)
    await jobAction(asBot('/x', { body: { action: 'finish', outcome: 'failed', cause: 'ours', turns: [3, 4, 5] } }), jobParams);
    expect(lib.finishJobUnder).toHaveBeenLastCalledWith(JOB, undefined, 'failed', expect.any(Date), undefined, 'ours', [3, 4, 5], undefined, undefined);
    // ...and the run those turns were numbered in (a restart makes a new run that numbers turns again), up to 40 characters
    await jobAction(asBot('/x', { body: { action: 'finish', outcome: 'failed', cause: 'ours', turns: [1, 2, 3], run: 'mi8x3k2a1b2c3d4e' } }), jobParams);
    expect(lib.finishJobUnder).toHaveBeenLastCalledWith(JOB, undefined, 'failed', expect.any(Date), undefined, 'ours', [1, 2, 3], 'mi8x3k2a1b2c3d4e', undefined);
    for (const run of ['x'.repeat(41), '', 'has space', 5]) {
      expect((await jobAction(asBot('/x', { body: { action: 'finish', outcome: 'failed', cause: 'ours', turns: [1], run } }), jobParams)).status).toBe(400);
    }
    expect((await jobAction(asBot('/x', { body: { action: 'finish', outcome: 'failed', cause: 'ours', turns: [-1] } }), jobParams)).status).toBe(400);
    expect((await jobAction(asBot('/x', { body: { action: 'finish', outcome: 'failed', cause: 'theirs' } }), jobParams)).status).toBe(400);
    expect(await (await jobAction(asBot('/x', { body: { action: 'plan-effect', key: 'pr-1', kind: 'publish' } }), jobParams)).json()).toEqual({ ok: false, reason: 'look_up', evidence: 'draft pull request' });
    expect(await (await jobAction(asBot('/x', { body: { action: 'settle-effect', key: 'pr-1', state: 'done', evidence: 'pull request 12' } }), jobParams)).json()).toEqual({ ok: true });
  });

  it('GPT round 6, finding 3: a claim refused because the owner still holds the job answers `held` with the time to look again, and `beat` and `release` are the owner’s own', async () => {
    const until = new Date('2026-11-23T10:01:30.000Z');
    lib.getJob.mockResolvedValue({ ...job, finishPending: null } as never);
    lib.claimJob.mockResolvedValueOnce({ ok: false, reason: 'held', until } as never);
    const held = await jobAction(asBot('/x', { body: { action: 'claim', seen: 1 } }), jobParams);
    expect(held.status).toBe(200);
    expect(await held.json()).toEqual({ ok: false, reason: 'held', until: until.toISOString(), job: expect.objectContaining({ id: JOB }) });
    // The beat: the owner's epoch goes with it, and a worker that was replaced is answered the game's superseded shape as business
    lib.beatJob.mockResolvedValueOnce({ ok: true, until } as never);
    const beaten = await jobAction(asBot('/x', { body: { action: 'beat', epoch: 4 } }), jobParams);
    expect(beaten.status).toBe(200);
    expect(await beaten.json()).toEqual({ ok: true, until: until.toISOString() });
    expect(lib.beatJob).toHaveBeenLastCalledWith(JOB, expect.any(Date), { epoch: 4 });
    lib.beatJob.mockResolvedValueOnce({ ok: false, reason: 'stale', run: 'superseded' } as never);
    expect(await (await jobAction(asBot('/x', { body: { action: 'beat', epoch: 3 } }), jobParams)).json()).toEqual({ ok: false, reason: 'stale', run: 'superseded' });
    lib.beatJob.mockResolvedValueOnce({ ok: false, reason: 'not_found' } as never);
    expect((await jobAction(asBot('/x', { body: { action: 'beat', epoch: 3 } }), jobParams)).status).toBe(404);
    // The release, on a graceful stop
    lib.releaseJob.mockResolvedValueOnce({ ok: true } as never);
    const released = await jobAction(asBot('/x', { body: { action: 'release', epoch: 4 } }), jobParams);
    expect(released.status).toBe(200);
    expect(await released.json()).toEqual({ ok: true });
    expect(lib.releaseJob).toHaveBeenLastCalledWith(JOB, { epoch: 4 });
    const beats = lib.beatJob.mock.calls.length;
    for (const epoch of ['4', -1, 1.5]) expect((await jobAction(asBot('/x', { body: { action: 'beat', epoch } }), jobParams)).status).toBe(400);
    expect(lib.beatJob.mock.calls.length).toBe(beats);
  });

  it('plan-effect and settle-effect name the epoch the worker owns the job by; a replaced worker is answered `superseded` as business (HTTP 200), and the epoch must be a whole number', async () => {
    lib.getJob.mockResolvedValue(job as never);
    lib.planEffect.mockResolvedValueOnce({ ok: false, reason: 'stale', run: 'superseded' });
    const planned = await jobAction(asBot('/x', { body: { action: 'plan-effect', epoch: 4, key: 'pr-1', kind: 'publish' } }), jobParams);
    expect(planned.status).toBe(200);
    expect(await planned.json()).toEqual({ ok: false, reason: 'stale', run: 'superseded' });
    expect(lib.planEffect).toHaveBeenLastCalledWith(JOB, { key: 'pr-1', kind: 'publish', evidence: undefined }, { epoch: 4 });
    lib.settleEffectAs.mockResolvedValueOnce({ ok: false, superseded: true });
    const settled = await jobAction(asBot('/x', { body: { action: 'settle-effect', epoch: 4, key: 'pr-1', state: 'done' } }), jobParams);
    expect(settled.status).toBe(200);
    expect(await settled.json()).toEqual({ ok: false, reason: 'stale', run: 'superseded' });
    expect(lib.settleEffectAs).toHaveBeenLastCalledWith(JOB, 'pr-1', 'done', undefined, { epoch: 4 });
    // CONTROL: the owner's settle answers `{ ok }`; a worker that names no epoch is passed on as one that knows none
    lib.settleEffectAs.mockResolvedValueOnce({ ok: true, superseded: false });
    expect(await (await jobAction(asBot('/x', { body: { action: 'settle-effect', key: 'pr-1', state: 'done' } }), jobParams)).json()).toEqual({ ok: true });
    expect(lib.settleEffectAs).toHaveBeenLastCalledWith(JOB, 'pr-1', 'done', undefined, { epoch: undefined });
    for (const epoch of ['4', -1, 1.5]) expect((await jobAction(asBot('/x', { body: { action: 'plan-effect', epoch, key: 'pr-1', kind: 'publish' } }), jobParams)).status).toBe(400);
  });

  it('says a finish from an older control generation is stale as business (HTTP 200), and passes the generation it was given', async () => {
    lib.getJob.mockResolvedValue(job as never);
    lib.finishJobUnder.mockResolvedValueOnce({ job: { id: JOB }, stale: true } as never);
    const stale = await jobAction(asBot('/x', { body: { action: 'finish', outcome: 'done', generation: 1 } }), jobParams);
    expect(stale.status).toBe(200);
    expect(await stale.json()).toEqual({ ok: false, reason: 'stale', job: { id: JOB } });
    expect(lib.finishJobUnder).toHaveBeenLastCalledWith(JOB, 1, 'done', expect.any(Date), undefined, undefined, undefined, undefined, undefined);
    expect((await jobAction(asBot('/x', { body: { action: 'finish', outcome: 'done', generation: -1 } }), jobParams)).status).toBe(400);
  });

  it('keeps the runner’s committed word that a job is to end, and answers every business outcome as HTTP 200', async () => {
    lib.getJob.mockResolvedValue(job as never);
    const pending = { outcome: 'failed', cause: 'ours', run: 'r1', generation: 2, turns: [3], why: 'It stopped', at: '2026-11-22T10:00:00.000Z' };
    lib.recordFinishIntent.mockResolvedValueOnce({ ok: true, already: false, pending } as never);
    const kept = await jobAction(asBot('/x', { body: { action: 'finish-intent', outcome: 'failed', cause: 'ours', turns: [3], run: 'r1', why: 'It stopped', generation: 2 } }), jobParams);
    expect(kept.status).toBe(200);
    expect(await kept.json()).toEqual({ ok: true, already: false, finishPending: pending });
    expect(lib.recordFinishIntent).toHaveBeenLastCalledWith(JOB, { outcome: 'failed', cause: 'ours', why: 'It stopped', turns: [3], run: 'r1', generation: 2, basis: undefined, epoch: undefined });
    // A stop that rests on the pool alone says so (`basis`): that is what lets Orbit answer it stale once a call was admitted for its turn
    lib.recordFinishIntent.mockResolvedValueOnce({ ok: false, reason: 'stale' } as never);
    await jobAction(asBot('/x', { body: { action: 'finish-intent', outcome: 'failed', cause: 'ours', turns: [3], run: 'r1', basis: 'pool' } }), jobParams);
    expect(lib.recordFinishIntent).toHaveBeenLastCalledWith(JOB, expect.objectContaining({ turns: [3], run: 'r1', basis: 'pool' }));
    lib.recordFinishIntent.mockResolvedValueOnce({ ok: true, already: true, pending } as never);
    expect(await (await jobAction(asBot('/x', { body: { action: 'finish-intent', outcome: 'done' } }), jobParams)).json()).toMatchObject({ ok: true, already: true });
    for (const reason of ['stale', 'cutoff']) {
      lib.recordFinishIntent.mockResolvedValueOnce({ ok: false, reason } as never);
      const refused = await jobAction(asBot('/x', { body: { action: 'finish-intent', outcome: 'done' } }), jobParams);
      expect(refused.status).toBe(200);
      expect(await refused.json()).toMatchObject({ ok: false, reason, job: { id: JOB } });
    }
  });

  it('a finish intent from a REPLACED run is answered `stale` WITH `run: superseded` and the job (so the old run exits); a stale control generation, a job that is over and a cutoff carry NO run key', async () => {
    lib.getJob.mockResolvedValue(job as never);
    lib.recordFinishIntent.mockResolvedValueOnce({ ok: false, reason: 'stale', run: 'superseded' } as never);
    const superseded = await jobAction(asBot('/x', { body: { action: 'finish-intent', outcome: 'failed', cause: 'ours', turns: [1], run: 'r1', basis: 'pool' } }), jobParams);
    expect(superseded.status).toBe(200);
    expect(await superseded.json()).toEqual({ ok: false, reason: 'stale', run: 'superseded', job: expect.objectContaining({ id: JOB }) });
    for (const reason of ['stale', 'cutoff']) {
      lib.recordFinishIntent.mockResolvedValueOnce({ ok: false, reason } as never);
      const plain = await jobAction(asBot('/x', { body: { action: 'finish-intent', outcome: 'done', generation: 1, run: 'r1' } }), jobParams);
      expect(plain.status).toBe(200);
      const body = await plain.json();
      expect(body).toMatchObject({ ok: false, reason, job: { id: JOB } });
      expect(body).not.toHaveProperty('run');
    }
    // The same for a finish: only a replaced run says `superseded`
    lib.finishJobUnder.mockResolvedValue({ job: { id: JOB }, stale: true } as never);
    const generation = await (await jobAction(asBot('/x', { body: { action: 'finish', outcome: 'done', generation: 0, run: 'r1' } }), jobParams)).json();
    expect(generation).toMatchObject({ ok: false, reason: 'stale' });
    expect(generation).not.toHaveProperty('run');
  });

  it('a finish intent for a job that disappeared meanwhile is a 404, as everywhere on this route; `stale` and `cutoff` stay HTTP 200 (CodeRabbit)', async () => {
    lib.getJob.mockResolvedValue(job as never);
    lib.recordFinishIntent.mockResolvedValueOnce({ ok: false, reason: 'not_found' } as never);
    const gone = await jobAction(asBot('/x', { body: { action: 'finish-intent', outcome: 'done' } }), jobParams);
    expect(gone.status).toBe(404);
    expect(await gone.json()).toEqual({ error: 'Job not found' });
  });

  it('refuses a finish intent that is not well formed or not from the bot server, and keeps nothing', async () => {
    lib.getJob.mockResolvedValue(job as never);
    lib.recordFinishIntent.mockClear();
    expect((await jobAction(call('/x', { body: { action: 'finish-intent', outcome: 'done' } }), jobParams)).status).toBe(401);
    for (const body of [{ action: 'finish-intent' }, { action: 'finish-intent', outcome: 'maybe' }, { action: 'finish-intent', outcome: 'failed', cause: 'theirs' }, { action: 'finish-intent', outcome: 'failed', turns: [-1] }, { action: 'finish-intent', outcome: 'failed', run: 'has space' }, { action: 'finish-intent', outcome: 'done', generation: 1.5 }, { action: 'finish-intent', outcome: 'failed', basis: 'agent' }]) {
      expect((await jobAction(asBot('/x', { body }), jobParams)).status).toBe(400);
    }
    expect(lib.recordFinishIntent).not.toHaveBeenCalled();
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
    expect(profiles.sweepPausedSignIns).toHaveBeenCalledTimes(1);
  });

  it('the cleanup of expired sign-ins still runs when the main sweep fails, and the main sweep’s failure is still the answer (500)', async () => {
    lib.sweepComputers.mockRejectedValue(new Error('a query rejected'));
    const mute = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect((await sweepRoute(asBot('/x'))).status).toBe(500);
    } finally {
      mute.mockRestore();
    }
    expect(profiles.sweepPausedSignIns).toHaveBeenCalledTimes(1);
  });
});
