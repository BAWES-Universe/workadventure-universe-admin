/**
 * The three calls the bot server's model relay makes about a computer's model call: who the key belongs to, room before the call, and
 * the settlement after it. Service token only; the bodies are checked before anything is asked. What each does to the room and the books
 * is tested against a real database in computer-calls-db.test.ts.
 */
import { NextRequest } from 'next/server';
import { POST as identify } from '@/app/api/computer/llm/identify/route';
import { POST as authorize } from '@/app/api/computer/llm/authorize/route';
import { POST as settle } from '@/app/api/computer/llm/settle/route';
import * as token from '@/lib/computer-token';
import * as calls from '@/lib/computer-calls';

jest.mock('@/lib/db', () => ({ prisma: {} }));
jest.mock('@/lib/computer-token');
jest.mock('@/lib/computer-calls');
jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));

const SERVICE_TOKEN = 'bot-server-secret';
const before = process.env.BOT_SERVICE_TOKEN;
const lib = { token: token as jest.Mocked<typeof token>, calls: calls as jest.Mocked<typeof calls> };

const post = (body: unknown, auth: string | null = SERVICE_TOKEN) =>
  new NextRequest('http://localhost:3333/x', { method: 'POST', headers: auth ? { Authorization: `Bearer ${auth}` } : {}, body: JSON.stringify(body) });

beforeEach(() => {
  jest.resetAllMocks();
  process.env.BOT_SERVICE_TOKEN = SERVICE_TOKEN;
});
afterAll(() => {
  if (before === undefined) delete process.env.BOT_SERVICE_TOKEN;
  else process.env.BOT_SERVICE_TOKEN = before;
});

describe.each([
  ['identify', identify, { token: 'cjt_x' }],
  ['authorize', authorize, { token: 'cjt_x', callId: 'c1', estimateMicros: 5, payer: 'universe' }],
  ['settle', settle, { jobId: 'j1', callId: 'c1', costMicros: 5 }],
] as const)('%s', (_name, route, body) => {
  it('is for the bot server only', async () => {
    expect((await route(post(body, null))).status).toBe(401);
    expect((await route(post(body, 'someone-else'))).status).toBe(401);
    expect(lib.token.verifyJobToken).not.toHaveBeenCalled();
    expect(lib.calls.authorizeModelCall).not.toHaveBeenCalled();
    expect(lib.calls.settleModelCall).not.toHaveBeenCalled();
  });
  it('refuses a body with anything extra or missing, before asking anything', async () => {
    expect((await route(post({ ...body, extra: 1 }))).status).toBe(400);
    expect((await route(post({}))).status).toBe(400);
    expect(lib.token.verifyJobToken).not.toHaveBeenCalled();
  });
});

describe('authorize', () => {
  it('passes a good request on as it was parsed and gives back the books’ answer, never cached', async () => {
    const answer = { ok: true as const, jobId: 'j1', botId: 'b1', reservedMicros: 5 };
    lib.calls.authorizeModelCall.mockResolvedValueOnce(answer as never);
    const response = await authorize(post({ token: 'cjt_x', callId: 'c1', estimateMicros: 5, payer: 'own-key' }));
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual(answer);
    expect(lib.calls.authorizeModelCall).toHaveBeenCalledTimes(1);
    expect(lib.calls.authorizeModelCall).toHaveBeenCalledWith({ token: 'cjt_x', callId: 'c1', estimateMicros: 5, payer: 'own-key' });
  });
  it('hands a refusal on in the books’ own words, the same way', async () => {
    lib.calls.authorizeModelCall.mockResolvedValueOnce({ ok: false, reason: 'allowance' } as never);
    const response = await authorize(post({ token: 'cjt_x', callId: 'c2', estimateMicros: 9, payer: 'universe' }));
    expect(await response.json()).toEqual({ ok: false, reason: 'allowance' });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
  it('refuses a payer nobody knows and a negative estimate, before asking anything', async () => {
    expect((await authorize(post({ token: 'cjt_x', callId: 'c1', estimateMicros: 5, payer: 'stranger' }))).status).toBe(400);
    expect((await authorize(post({ token: 'cjt_x', callId: 'c1', estimateMicros: -1, payer: 'universe' }))).status).toBe(400);
    expect(lib.calls.authorizeModelCall).not.toHaveBeenCalled();
  });
});

describe('identify', () => {
  it('says whose job a good key is for, and gives the same answer for every key that is not good', async () => {
    lib.token.verifyJobToken.mockResolvedValueOnce({ ok: true, jobId: 'j1', botId: 'b1', personId: 'p1', tokenId: 't1', generation: 0 });
    expect(await (await identify(post({ token: 'cjt_x' }))).json()).toEqual({ ok: true, jobId: 'j1', botId: 'b1' });
    lib.token.verifyJobToken.mockResolvedValueOnce({ ok: false, reason: 'refused' });
    expect(await (await identify(post({ token: 'cjt_old' }))).json()).toEqual({ ok: false, reason: 'refused' });
  });
  it('never says who pays', async () => {
    lib.token.verifyJobToken.mockResolvedValueOnce({ ok: true, jobId: 'j1', botId: 'b1', personId: 'p-secret', tokenId: 't1', generation: 0 });
    expect(JSON.stringify(await (await identify(post({ token: 'cjt_x' }))).json())).not.toContain('p-secret');
  });
});

describe('settle', () => {
  it('turns a lost call into a 404, so the relay knows nothing was written', async () => {
    lib.calls.settleModelCall.mockResolvedValueOnce({ ok: false, reason: 'unknown_call' });
    expect((await settle(post({ jobId: 'j1', callId: 'ghost', costMicros: 5 }))).status).toBe(404);
  });
  it('gives the room back, and writes nothing, when the call was never sent', async () => {
    lib.calls.releaseModelCall.mockResolvedValueOnce(undefined);
    expect(await (await settle(post({ jobId: 'j1', callId: 'c1', sent: false }))).json()).toEqual({ ok: true });
    expect(lib.calls.releaseModelCall).toHaveBeenCalledWith('j1', 'c1');
    expect(lib.calls.settleModelCall).not.toHaveBeenCalled();
  });
  it('a call on the owner’s own key is the owner’s: the payer is the person, never us', async () => {
    lib.calls.settleModelCall.mockResolvedValueOnce({ ok: true });
    await settle(post({ jobId: 'j1', callId: 'c1', costMicros: 9, payerPersonId: 'p-owner' }));
    expect(lib.calls.settleModelCall).toHaveBeenCalledWith('j1', 'c1', expect.objectContaining({ payer: { kind: 'person', personId: 'p-owner' }, route: 'own-key' }));
  });
});
