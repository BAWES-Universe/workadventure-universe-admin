/**
 * The key route of a job's computer (GPT round 5): a runner names the epoch it won by claiming the job; an old worker is answered the game's `superseded` shape (HTTP 409) and is given no key. What the key does is tested against a real
 * database in computer-ownership-db.test.ts and computer-broker-db.test.ts.
 */
import { NextRequest } from 'next/server';
import { POST as token } from '@/app/api/computer/jobs/[jobId]/token/route';
import * as keys from '@/lib/computer-token';

jest.mock('@/lib/db', () => ({ prisma: {} }));
jest.mock('@/lib/computer-token');
jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));

const SERVICE_TOKEN = 'bot-server-secret';
const before = process.env.BOT_SERVICE_TOKEN;
const lib = keys as jest.Mocked<typeof keys>;
const params = { params: Promise.resolve({ jobId: 'job-1' }) };
const req = (body?: unknown, auth: string | null = SERVICE_TOKEN) => new NextRequest('http://localhost:3333/x', { method: 'POST', headers: auth ? { Authorization: `Bearer ${auth}` } : {}, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

beforeEach(() => {
  jest.resetAllMocks();
  process.env.BOT_SERVICE_TOKEN = SERVICE_TOKEN;
});
afterAll(() => {
  if (before === undefined) delete process.env.BOT_SERVICE_TOKEN;
  else process.env.BOT_SERVICE_TOKEN = before;
});

describe('the job key route', () => {
  it('is for the bot server only', async () => {
    expect((await token(req({}, null), params)).status).toBe(401);
    expect((await token(req({}, 'nope'), params)).status).toBe(401);
    expect(lib.mintJobToken).not.toHaveBeenCalled();
  });

  it('gives the key once, to the epoch it was asked for, and never stores it in a cache', async () => {
    lib.mintJobToken.mockResolvedValueOnce({ ok: true, token: 'k-1', expiresAt: new Date('2026-11-15T12:15:00Z'), epoch: 2 } as never);
    const answer = await token(req({ epoch: 2 }), params);
    expect(answer.status).toBe(200);
    expect(answer.headers.get('cache-control')).toBe('no-store');
    expect(await answer.json()).toEqual({ token: 'k-1', expiresAt: '2026-11-15T12:15:00.000Z' });
    expect(lib.mintJobToken).toHaveBeenLastCalledWith('job-1', 'model', expect.any(Date), undefined, { epoch: 2 });
    lib.mintJobToken.mockResolvedValueOnce({ ok: true, token: 'k-2', expiresAt: new Date('2026-11-15T12:15:00Z'), epoch: 0 } as never);
    await token(req(), params);
    expect(lib.mintJobToken).toHaveBeenLastCalledWith('job-1', 'model', expect.any(Date), undefined, { epoch: null });
  });

  it('an old worker is answered `superseded` (HTTP 409, the game’s shape) and given no key; the other refusals keep their words and statuses', async () => {
    lib.mintJobToken.mockResolvedValueOnce({ ok: false, reason: 'superseded' } as never);
    const old = await token(req({ epoch: 1 }), params);
    expect(old.status).toBe(409);
    expect(await old.json()).toEqual({ ok: false, reason: 'stale', run: 'superseded' });
    lib.mintJobToken.mockResolvedValueOnce({ ok: false, reason: 'not_found' } as never);
    expect((await token(req({ epoch: 1 }), params)).status).toBe(404);
    for (const reason of ['not_running', 'preparing', 'finish_pending']) {
      lib.mintJobToken.mockResolvedValueOnce({ ok: false, reason } as never);
      const refused = await token(req({ epoch: 1 }), params);
      expect(refused.status).toBe(409);
      expect(await refused.json()).toEqual({ error: reason });
    }
  });

  it('refuses a bad epoch or anything extra before asking', async () => {
    for (const bad of [{ epoch: -1 }, { epoch: 1.5 }, { epoch: '1' }, { other: 1 }]) expect((await token(req(bad), params)).status).toBe(400);
    expect(lib.mintJobToken).not.toHaveBeenCalled();
  });
});
