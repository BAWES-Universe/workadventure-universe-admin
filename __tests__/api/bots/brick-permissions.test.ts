/**
 * A Brick's Permissions (Slice 13): its owner reads and saves who may use it, the line refused people hear and the daily
 * limit. It stands in no universe, so there are no roles and no rows to name; anyone else, a super admin included, is told
 * the Brick is not there, and the bot server is told there is nothing for it.
 */
import { NextRequest } from 'next/server';
import { GET, PUT } from '@/app/api/bots/[id]/permissions/route';
import { PUT as PUT_RULE } from '@/app/api/bots/[id]/permissions/rules/route';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';

jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));
jest.mock('@/lib/db', () => ({ prisma: { bot: { findUnique: jest.fn(), update: jest.fn() } } }));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn() }));

const session = getSessionUser as jest.Mock;
const findBot = prisma.bot.findUnique as jest.Mock;
const updateBot = prisma.bot.update as jest.Mock;
const params = { params: Promise.resolve({ id: 'brick-1' }) };

const STORED = { id: 'brick-1', roomId: null, ownerId: 'u-sara', deletedAt: null as Date | null, privateBot: false, refusalReply: null, dailyReplyCap: null };

function call(handler: (r: NextRequest, c: typeof params) => Promise<Response>, method: string, body?: unknown, token?: string) {
  return handler(
    new NextRequest('http://localhost:3333/api/bots/brick-1/permissions', {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    params,
  );
}

beforeEach(() => {
  process.env.ADMIN_API_TOKEN = 'admin-secret';
  session.mockReset().mockResolvedValue({ id: 'u-sara', email: 'sara@example.com' });
  findBot.mockReset().mockImplementation(async () => ({ ...STORED }));
  updateBot.mockReset().mockResolvedValue({});
});

describe('a Brick\'s permissions', () => {
  it('reads them for its owner, with no universe, rows or roles', async () => {
    const response = await call(GET, 'GET');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ universe: null, privateBot: false, refusalReply: null, dailyReplyCap: null, rules: [], roles: [] });
  });

  it('saves what the owner sends on the Brick', async () => {
    const response = await call(PUT, 'PUT', { privateBot: true, refusalReply: '  Only for Sara. ', dailyReplyCap: 20 });
    expect(response.status).toBe(200);
    expect(updateBot).toHaveBeenCalledWith({ where: { id: 'brick-1' }, data: { privateBot: true, refusalReply: 'Only for Sara.', dailyReplyCap: 20 } });
  });

  it('refuses what is not a setting, and saves nothing', async () => {
    const response = await call(PUT, 'PUT', { ownerId: 'u-omar' });
    expect(response.status).toBe(400);
    expect(updateBot).not.toHaveBeenCalled();
  });

  it('is "not found" for anyone else and for a super admin, and saves nothing', async () => {
    session.mockResolvedValue({ id: 'u-omar', email: 'omar@example.com', isSuperAdmin: true });
    for (const response of [await call(GET, 'GET'), await call(PUT, 'PUT', { privateBot: true })]) {
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'Bot not found' });
    }
    expect(updateBot).not.toHaveBeenCalled();
  });

  it('is "not found" for a Brick its owner deleted', async () => {
    findBot.mockImplementation(async () => ({ ...STORED, deletedAt: new Date() }));
    expect((await call(GET, 'GET')).status).toBe(404);
  });

  it('asks the signed-out to sign in, and tells the bot server there is nothing for it', async () => {
    session.mockResolvedValue(null);
    expect((await call(GET, 'GET')).status).toBe(401);
    expect((await call(GET, 'GET', undefined, 'admin-secret')).status).toBe(404);
    expect((await call(PUT, 'PUT', { privateBot: true })).status).toBe(401);
  });

  it('has no rows to name: the rules route still says "not found" for a Brick', async () => {
    const response = await PUT_RULE(
      new NextRequest('http://localhost:3333/api/bots/brick-1/permissions/rules', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: 'u-omar', chat: 'yes' }) }),
      params,
    );
    expect(response.status).toBe(404);
  });
});
