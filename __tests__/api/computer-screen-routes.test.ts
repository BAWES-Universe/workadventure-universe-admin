/** The routes of the screen gateway's Orbit half: who may ask for a ticket, and that only the bot server opens or checks one. */
import { NextRequest } from 'next/server';
import { POST as ticketRoute } from '@/app/api/bricks/[id]/computer/screen/route';
import { POST as openRoute } from '@/app/api/computer/screen/open/route';
import { POST as checkRoute } from '@/app/api/computer/screen/check/route';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { resolveUsagePerson } from '@/lib/usage-person';
import * as screen from '@/lib/computer-screen';

jest.mock('@/lib/db', () => ({ prisma: { user: { findUnique: jest.fn() } } }));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn() }));
jest.mock('@/lib/usage-person', () => ({ resolveUsagePerson: jest.fn() }));
jest.mock('@/lib/computer-screen');
jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));

const db = prisma as unknown as { user: { findUnique: jest.Mock } };
const lib = screen as jest.Mocked<typeof screen>;
const TOKEN = 'bot-server-secret';
const params = { params: Promise.resolve({ id: 'brick-1' }) };
const before = process.env.BOT_SERVICE_TOKEN;

const call = (path: string, body?: unknown, token?: string) =>
  new NextRequest(`http://localhost:3333${path}`, { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {}, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

beforeEach(() => {
  jest.resetAllMocks();
  process.env.BOT_SERVICE_TOKEN = TOKEN;
  (getSessionUser as jest.Mock).mockResolvedValue({ id: 'u-sara' });
  (resolveUsagePerson as jest.Mock).mockResolvedValue({ personId: 'u-sara' });
  db.user.findUnique.mockResolvedValue({ isGuest: false });
});
afterAll(() => {
  if (before === undefined) delete process.env.BOT_SERVICE_TOKEN;
  else process.env.BOT_SERVICE_TOKEN = before;
});

describe('asking for a ticket', () => {
  const ask = (body?: unknown) => ticketRoute(call('/api/bricks/brick-1/computer/screen', body), params);

  it('is watch unless input is asked for, and the ticket is for the signed-in person only', async () => {
    lib.screenTicket.mockResolvedValue({ ok: true, ticket: 't', mode: 'watch', expiresAt: new Date('2026-11-15T12:01:00Z') });
    const response = await ask();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ticket: 't', mode: 'watch' });
    expect(lib.screenTicket).toHaveBeenCalledWith('brick-1', 'u-sara', 'watch');
    await ask({ mode: 'input' });
    expect(lib.screenTicket).toHaveBeenLastCalledWith('brick-1', 'u-sara', 'input');
  });

  it('refuses a mode it does not know, and says resting, not taken over, or not found as they are', async () => {
    expect((await ask({ mode: 'admin' })).status).toBe(400);
    lib.screenTicket.mockResolvedValueOnce({ ok: false, reason: 'resting' });
    expect((await ask()).status).toBe(409);
    lib.screenTicket.mockResolvedValueOnce({ ok: false, reason: 'not_taken_over' });
    expect(await (await ask({ mode: 'input' })).json()).toMatchObject({ notTakenOver: true });
    lib.screenTicket.mockResolvedValueOnce({ ok: false, reason: 'not_found' });
    expect((await ask()).status).toBe(404);
  });

  it('is for a signed-in person: nobody signed in gets no ticket', async () => {
    (getSessionUser as jest.Mock).mockResolvedValue(null);
    expect((await ask()).status).toBeGreaterThanOrEqual(401);
    expect(lib.screenTicket).not.toHaveBeenCalled();
  });
});

describe('opening and checking a socket', () => {
  it('is for the bot server only: no token or a person’s own session gets nothing, and nothing is looked at', async () => {
    for (const route of [openRoute, checkRoute]) {
      expect((await route(call('/x', { ticket: 't' }))).status).toBe(401);
      expect((await route(call('/x', { ticket: 't' }, 'a-persons-token'))).status).toBe(401);
    }
    expect(lib.openScreen).not.toHaveBeenCalled();
    expect(lib.checkScreen).not.toHaveBeenCalled();
  });

  it('hands the ticket to the library and answers what it says, never cached', async () => {
    lib.openScreen.mockResolvedValue({ ok: true, upstream: 'https://m.example.test/?t=1', mode: 'watch', checkEveryMs: 5000, maxMs: 1000 });
    const opened = await openRoute(call('/x', { ticket: 't' }, TOKEN));
    expect(opened.headers.get('Cache-Control')).toBe('no-store');
    expect(await opened.json()).toMatchObject({ ok: true, mode: 'watch' });
    expect(lib.openScreen).toHaveBeenCalledWith('t');
    lib.checkScreen.mockResolvedValue({ ok: false, reason: 'not_taken_over' });
    expect(await (await checkRoute(call('/x', { ticket: 't' }, TOKEN))).json()).toEqual({ ok: false, reason: 'not_taken_over' });
    await openRoute(call('/x', undefined, TOKEN));
    expect(lib.openScreen).toHaveBeenLastCalledWith(undefined);
  });
});
