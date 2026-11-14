/**
 * The routes the bot server's runner uses to reach a computer through Orbit: service token only, bodies checked first, the answer says
 * why in a word, and a turn comes back as Server-Sent Events. What each does to a job and a machine is tested against a real database
 * in computer-broker-db.test.ts.
 */
import { NextRequest } from 'next/server';
import { POST as prepare } from '@/app/api/computer/jobs/[jobId]/prepare/route';
import { POST as turn } from '@/app/api/computer/jobs/[jobId]/turn/route';
import { POST as cancel } from '@/app/api/computer/jobs/[jobId]/cancel/route';
import { GET as stream } from '@/app/api/computer/jobs/[jobId]/stream/route';
import { GET as running } from '@/app/api/computer/jobs/running/route';
import * as computer from '@/lib/computer';
import * as broker from '@/lib/computer-broker';
import type { TurnEvent } from '@/lib/agent37/turn-events';

jest.mock('@/lib/db', () => ({ prisma: {} }));
jest.mock('@/lib/computer-broker');
jest.mock('@/lib/computer', () => ({ runnableJobs: jest.fn() }));
jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));

const SERVICE_TOKEN = 'bot-server-secret';
const before = process.env.BOT_SERVICE_TOKEN;
const lib = broker as jest.Mocked<typeof broker>;
const params = { params: Promise.resolve({ jobId: 'job-1' }) };

const req = (method: string, body?: unknown, auth: string | null = SERVICE_TOKEN) =>
  new NextRequest('http://localhost:3333/x', { method, headers: auth ? { Authorization: `Bearer ${auth}` } : {}, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const events = (...list: TurnEvent[]) =>
  (async function* () {
    for (const event of list) yield event;
  })();

beforeEach(() => {
  jest.resetAllMocks();
  process.env.BOT_SERVICE_TOKEN = SERVICE_TOKEN;
});
afterAll(() => {
  if (before === undefined) delete process.env.BOT_SERVICE_TOKEN;
  else process.env.BOT_SERVICE_TOKEN = before;
});

describe('every route', () => {
  it.each([
    ['prepare', () => prepare(req('POST', { relay: 'https://x.example' }, null), params), () => prepare(req('POST', { relay: 'https://x.example' }, 'nope'), params)],
    ['turn', () => turn(req('POST', { input: 'hi' }, null), params), () => turn(req('POST', { input: 'hi' }, 'nope'), params)],
    ['cancel', () => cancel(req('POST', {}, null), params), () => cancel(req('POST', {}, 'nope'), params)],
    ['stream', () => stream(req('GET', undefined, null), params), () => stream(req('GET', undefined, 'nope'), params)],
  ])('%s is for the bot server only', async (_name, none, wrong) => {
    expect((await none()).status).toBe(401);
    expect((await wrong()).status).toBe(401);
    expect(lib.prepareJob).not.toHaveBeenCalled();
    expect(lib.startTurn).not.toHaveBeenCalled();
    expect(lib.cancelJobTurn).not.toHaveBeenCalled();
    expect(lib.reattachJobTurn).not.toHaveBeenCalled();
  });
});

describe('prepare', () => {
  it('says the key will last and never gives it back', async () => {
    lib.prepareJob.mockResolvedValueOnce({ ok: true, expiresAt: new Date('2026-11-15T12:15:00Z') });
    const answer = await prepare(req('POST', { relay: 'https://bot.example.test' }), params);
    expect(await answer.json()).toEqual({ ok: true, expiresAt: '2026-11-15T12:15:00.000Z' });
    expect(lib.prepareJob).toHaveBeenCalledWith('job-1', 'https://bot.example.test');
  });
  it('checks the body first, and says why in a word and a status', async () => {
    expect((await prepare(req('POST', { relay: 'x', extra: 1 }), params)).status).toBe(400);
    expect((await prepare(req('POST', {}), params)).status).toBe(400);
    expect(lib.prepareJob).not.toHaveBeenCalled();
    for (const [reason, status] of [['not_found', 404], ['bad_relay', 400], ['failed', 502], ['not_running', 409], ['person_has_it', 409], ['no_machine', 409]] as const) {
      lib.prepareJob.mockResolvedValueOnce({ ok: false, reason });
      const answer = await prepare(req('POST', { relay: 'https://bot.example.test' }), params);
      expect(answer.status).toBe(status);
      expect(await answer.json()).toEqual({ ok: false, reason });
    }
  });
});

describe('turn', () => {
  it('comes back as events, one name and one JSON line each, with a comment for a keep-alive and nothing a tool was given', async () => {
    lib.startTurn.mockResolvedValueOnce({
      ok: true,
      events: events({ type: 'created', id: 'r1', sessionId: 's1' }, { type: 'keepalive' }, { type: 'tool', state: 'started', tool: 'browser', label: 'Opening the form' }, { type: 'completed', outputText: 'done', usage: null }),
    });
    const answer = await turn(req('POST', { input: 'Fill the form' }), params);
    expect(answer.status).toBe(200);
    expect(answer.headers.get('content-type')).toContain('text/event-stream');
    const text = await answer.text();
    expect(text).toContain('event: created\ndata: {"type":"created","id":"r1","sessionId":"s1"}\n\n');
    expect(text).toContain(': keepalive\n\n');
    expect(text).toContain('event: tool\n');
    expect(text.trimEnd().endsWith('}')).toBe(true);
    expect(lib.startTurn).toHaveBeenCalledWith('job-1', 'Fill the form', expect.any(AbortSignal));
  });

  it('says a turn that broke on the way, never leaves it looking alive', async () => {
    lib.startTurn.mockResolvedValueOnce({
      ok: true,
      events: (async function* () {
        yield { type: 'created', id: 'r1', sessionId: 's1' } as TurnEvent;
        throw new Error('boom');
      })(),
    });
    const text = await (await turn(req('POST', { input: 'x' }), params)).text();
    expect(text).toContain('event: failed');
    expect(text).toContain('stream_broke');
  });

  it('says why a turn was not started, with the running turn’s id when the agent is busy', async () => {
    lib.startTurn.mockResolvedValueOnce({ ok: false, reason: 'busy', responseId: 'resp-9' });
    const busy = await turn(req('POST', { input: 'x' }), params);
    expect(busy.status).toBe(409);
    expect(await busy.json()).toEqual({ ok: false, reason: 'busy', responseId: 'resp-9' });
    lib.startTurn.mockResolvedValueOnce({ ok: false, reason: 'person_has_it' });
    expect((await turn(req('POST', { input: 'x' }), params)).status).toBe(409);
    lib.startTurn.mockResolvedValueOnce({ ok: false, reason: 'not_found' });
    expect((await turn(req('POST', { input: 'x' }), params)).status).toBe(404);
    lib.startTurn.mockResolvedValueOnce({ ok: false, reason: 'failed' });
    expect((await turn(req('POST', { input: 'x' }), params)).status).toBe(502);
  });

  it('refuses a body with no input, or anything extra, before asking', async () => {
    expect((await turn(req('POST', {}), params)).status).toBe(400);
    expect((await turn(req('POST', { input: '' }), params)).status).toBe(400);
    expect((await turn(req('POST', { input: 'x', sessionId: 'someone-elses' }), params)).status).toBe(400);
    expect(lib.startTurn).not.toHaveBeenCalled();
  });
});

describe('cancel and stream', () => {
  it('cancels the job’s own turn, naming none', async () => {
    lib.cancelJobTurn.mockResolvedValueOnce({ ok: true, cancelled: true });
    expect(await (await cancel(req('POST', {}), params)).json()).toEqual({ ok: true, cancelled: true });
    expect(lib.cancelJobTurn).toHaveBeenCalledWith('job-1');
    lib.cancelJobTurn.mockResolvedValueOnce({ ok: false, reason: 'not_found' });
    expect((await cancel(req('POST', {}), params)).status).toBe(404);
  });

  it('reconnects to the job’s own turn, and says "no turn" with a 404', async () => {
    lib.reattachJobTurn.mockResolvedValueOnce({ ok: true, events: events({ type: 'completed', outputText: 'x', usage: null }) });
    const text = await (await stream(req('GET'), params)).text();
    expect(text).toContain('event: completed');
    lib.reattachJobTurn.mockResolvedValueOnce({ ok: false, reason: 'no_turn' });
    const none = await stream(req('GET'), params);
    expect(none.status).toBe(404);
    expect(await none.json()).toEqual({ ok: false, reason: 'no_turn' });
    lib.reattachJobTurn.mockResolvedValueOnce({ ok: false, reason: 'person_has_it' });
    expect((await stream(req('GET'), params)).status).toBe(409);
  });
});

describe('the running jobs', () => {
  it('are for the bot server only, and come with the words for the agent', async () => {
    const list = computer.runnableJobs as jest.Mock;
    expect((await running(req('GET', undefined, null))).status).toBe(401);
    expect((await running(req('GET', undefined, 'nope'))).status).toBe(401);
    expect(list).not.toHaveBeenCalled();
    list.mockResolvedValueOnce([{ jobId: 'j', botId: 'b', title: 'Visa', brief: 'Fill it', writes: true, hasTurn: false }]);
    const answer = await running(req('GET'));
    expect(await answer.json()).toEqual({ jobs: [{ jobId: 'j', botId: 'b', title: 'Visa', brief: 'Fill it', writes: true, hasTurn: false }] });
    expect(answer.headers.get('Cache-Control')).toBe('no-store');
    list.mockRejectedValueOnce(new Error('db'));
    expect((await running(req('GET'))).status).toBe(500);
  });
});
