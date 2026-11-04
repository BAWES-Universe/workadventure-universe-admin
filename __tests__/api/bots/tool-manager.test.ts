/**
 * POST /api/bots/:id/tool-manager (#1656): only the bot server's service token gets in, and the answer is the same Manage
 * bots answer the Tools page uses.
 */
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/bots/[id]/tool-manager/route';
import { prisma } from '@/lib/db';
import { canManageBotMcpServers } from '@/lib/bot-permissions';
import { findUserByIdentifier } from '@/lib/user-identifier';

jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));
jest.mock('@/lib/db', () => ({ prisma: { bot: { findUnique: jest.fn() } } }));
jest.mock('@/lib/bot-permissions', () => ({ canManageBotMcpServers: jest.fn() }));
jest.mock('@/lib/user-identifier', () => ({ findUserByIdentifier: jest.fn() }));

const findBot = prisma.bot.findUnique as unknown as jest.Mock;
const canManage = canManageBotMcpServers as jest.Mock;
const findUser = findUserByIdentifier as unknown as jest.Mock;

const call = (body: unknown, token: string | null = 'service-secret') =>
  POST(
    new NextRequest('http://localhost:3333/api/bots/bot-1/tool-manager', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: 'bot-1' }) },
  );

beforeEach(() => {
  process.env.BOT_SERVICE_TOKEN = 'service-secret';
  findBot.mockReset().mockResolvedValue({ id: 'bot-1', createdById: 'u-creator', roomId: 'room-1' });
  findUser.mockReset().mockResolvedValue({ id: 'u-sara', email: 'sara@example.com', isGuest: false });
  canManage.mockReset().mockResolvedValue(true);
});

describe('who manages a bot’s tools', () => {
  it('needs the service token', async () => {
    for (const token of [null, 'wrong']) expect((await call({ identifier: 'uuid-sara' }, token)).status).toBe(401);
    process.env.ADMIN_API_TOKEN = 'admin-secret';
    expect((await call({ identifier: 'uuid-sara' }, 'admin-secret')).status).toBe(401);
    expect(canManage).not.toHaveBeenCalled();
  });

  it('answers with the Manage bots answer for that bot', async () => {
    const yes = await call({ identifier: 'uuid-sara' });
    expect(await yes.json()).toEqual({ canManage: true });
    expect(canManage).toHaveBeenCalledWith('u-sara', 'sara@example.com', { id: 'bot-1', createdById: 'u-creator', roomId: 'room-1' });
    canManage.mockResolvedValue(false);
    expect(await (await call({ identifier: 'uuid-sara' })).json()).toEqual({ canManage: false });
  });

  it('says no for a person Orbit has no account for, and for a guest', async () => {
    findUser.mockResolvedValue(null);
    expect(await (await call({ identifier: 'nobody' })).json()).toEqual({ canManage: false });
    findUser.mockResolvedValue({ id: 'u-guest', email: null, isGuest: true });
    expect(await (await call({ identifier: 'guest-uuid' })).json()).toEqual({ canManage: false });
    expect(canManage).not.toHaveBeenCalled();
  });

  it('is a 404 for a bot that is not there and a 400 for a body that is not valid', async () => {
    findBot.mockResolvedValue(null);
    expect((await call({ identifier: 'uuid-sara' })).status).toBe(404);
    expect((await call({})).status).toBe(400);
    expect((await call({ identifier: 'uuid-sara', extra: 1 })).status).toBe(400);
  });
});
