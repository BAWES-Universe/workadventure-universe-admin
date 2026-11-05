/**
 * PUT /api/bots/:id/mcp-servers/:serverId/sign-in (game #1819): only the bot server may report, the body is checked, and the
 * answer says whether anything changed.
 */
import { NextRequest } from 'next/server';
import { PUT } from '@/app/api/bots/[id]/mcp-servers/[serverId]/sign-in/route';
import * as signIn from '@/lib/tool-signin';

jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));
jest.mock('@/lib/tool-signin', () => ({ reportToolSignIn: jest.fn() }));

const report = signIn.reportToolSignIn as jest.Mock;
const params = { params: Promise.resolve({ id: 'bot-1', serverId: 'srv-1' }) };
const call = (body: unknown, token?: string) =>
  PUT(
    new NextRequest('http://localhost:3333/api/bots/bot-1/mcp-servers/srv-1/sign-in', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    params,
  );

beforeEach(() => {
  jest.resetAllMocks();
  process.env.ADMIN_API_TOKEN = 'bot-server-token';
});

describe('reporting a tool sign-in', () => {
  it('turns away anyone but the bot server', async () => {
    expect((await call({ state: 'expired' })).status).toBe(401);
    expect((await call({ state: 'expired' }, 'wrong')).status).toBe(401);
    expect(report).not.toHaveBeenCalled();
  });

  it('turns everyone away when no token is configured', async () => {
    delete process.env.ADMIN_API_TOKEN;
    expect((await call({ state: 'expired' }, 'undefined')).status).toBe(401);
  });

  it('refuses a bad body', async () => {
    for (const body of [{ state: 'broken' }, {}, { state: 'expired', status: 500 }, { state: 'expired', at: 'yesterday' }, 'not json']) {
      expect((await call(body, 'bot-server-token')).status).toBe(400);
    }
    expect(report).not.toHaveBeenCalled();
  });

  it('passes the report on and answers whether anything changed', async () => {
    report.mockResolvedValue({ changed: true });
    const response = await call({ state: 'expired', at: '2026-11-05T09:54:00.000Z', status: 401 }, 'bot-server-token');
    expect([response.status, await response.json()]).toEqual([200, { changed: true }]);
    expect(report).toHaveBeenCalledWith('bot-1', 'srv-1', { state: 'expired', at: new Date('2026-11-05T09:54:00.000Z'), status: 401 });
  });

  it('takes "no-answer" and "ok" with no time or status', async () => {
    report.mockResolvedValue({ changed: false });
    expect((await call({ state: 'no-answer' }, 'bot-server-token')).status).toBe(200);
    expect((await call({ state: 'ok' }, 'bot-server-token')).status).toBe(200);
    expect(report).toHaveBeenLastCalledWith('bot-1', 'srv-1', { state: 'ok', at: undefined, status: null });
  });

  it('is a 404 when the bot has no such server', async () => {
    report.mockResolvedValue(null);
    expect((await call({ state: 'ok' }, 'bot-server-token')).status).toBe(404);
  });

  it('is a 500 that is reported when saving fails', async () => {
    report.mockRejectedValue(new Error('db down'));
    expect((await call({ state: 'ok' }, 'bot-server-token')).status).toBe(500);
  });
});
