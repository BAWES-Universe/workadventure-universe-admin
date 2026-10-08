import { NextRequest } from 'next/server';
import { GET as listConfigurations } from '@/app/api/bots/configuration/route';
import { GET as getConfiguration } from '@/app/api/bots/configuration/[id]/route';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { canManageBots } from '@/lib/bot-permissions';
import { isSuperAdmin } from '@/lib/super-admin';

jest.mock('@/lib/db', () => ({
  prisma: {
    bot: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
    },
    user: {
      findFirst: jest.fn(),
      create: jest.fn(),
    },
  },
}));

jest.mock('@/lib/auth-session', () => ({
  getSessionUser: jest.fn(async () => null),
}));

jest.mock('@/lib/auth', () => ({
  requireAuth: jest.fn(),
}));

jest.mock('@/lib/bot-permissions', () => ({
  canManageBots: jest.fn(async () => false),
}));

jest.mock('@/lib/super-admin', () => ({
  isSuperAdmin: jest.fn(() => false),
}));

jest.mock('@/lib/oidc', () => ({
  validateAccessToken: jest.fn(async () => null),
}));

jest.mock('@/lib/bot-config-helpers', () => ({
  resolveRoomIdFromPlayUri: jest.fn(async () => 'room-123'),
  transformBotToServerFormat: jest.fn(async (bot: unknown) => bot),
}));

const bot = { id: 'bot-1', roomId: 'room-123', name: 'Guide' };
const sessionUser = { id: 'user-1', email: 'player@example.com' };

function request(path: string, token?: string) {
  return new NextRequest(`http://localhost:3333${path}`, {
    method: 'GET',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe('GET /api/bots/configuration[/:id] authentication', () => {
  beforeAll(() => {
    process.env.ADMIN_API_TOKEN = 'test-admin-token';
  });

  beforeEach(() => {
    jest.clearAllMocks();
    (getSessionUser as jest.Mock).mockResolvedValue(null);
    (canManageBots as jest.Mock).mockResolvedValue(false);
    (isSuperAdmin as jest.Mock).mockReturnValue(false);
    (prisma.bot.findMany as jest.Mock).mockResolvedValue([bot]);
    (prisma.bot.findUnique as jest.Mock).mockResolvedValue(bot);
  });

  describe('list', () => {
    it('rejects an anonymous caller without reading bots', async () => {
      const res = await listConfigurations(request('/api/bots/configuration'));
      expect(res.status).toBe(401);
      expect(prisma.bot.findMany).not.toHaveBeenCalled();
    });

    it('rejects a wrong bearer token', async () => {
      const res = await listConfigurations(request('/api/bots/configuration', 'wrong-token'));
      expect(res.status).toBe(401);
      expect(prisma.bot.findMany).not.toHaveBeenCalled();
    });

    it('rejects a signed-in user who is not a super admin', async () => {
      (getSessionUser as jest.Mock).mockResolvedValue(sessionUser);
      const res = await listConfigurations(request('/api/bots/configuration'));
      expect(res.status).toBe(403);
      expect(prisma.bot.findMany).not.toHaveBeenCalled();
    });

    it('allows the bot server admin token', async () => {
      const res = await listConfigurations(request('/api/bots/configuration', 'test-admin-token'));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([bot]);
    });

    it('allows a super admin session', async () => {
      (getSessionUser as jest.Mock).mockResolvedValue(sessionUser);
      (isSuperAdmin as jest.Mock).mockReturnValue(true);
      const res = await listConfigurations(request('/api/bots/configuration'));
      expect(res.status).toBe(200);
    });
  });

  describe('single bot', () => {
    it('rejects an anonymous caller without reading the bot', async () => {
      const res = await getConfiguration(request('/api/bots/configuration/bot-1'), params('bot-1'));
      expect(res.status).toBe(401);
      expect(prisma.bot.findUnique).not.toHaveBeenCalled();
    });

    it('rejects a signed-in user who cannot manage the bot room', async () => {
      (getSessionUser as jest.Mock).mockResolvedValue(sessionUser);
      const res = await getConfiguration(request('/api/bots/configuration/bot-1'), params('bot-1'));
      expect(res.status).toBe(403);
      expect(canManageBots).toHaveBeenCalledWith('user-1', 'room-123');
    });

    it('allows a signed-in user who can manage the bot room', async () => {
      (getSessionUser as jest.Mock).mockResolvedValue(sessionUser);
      (canManageBots as jest.Mock).mockResolvedValue(true);
      const res = await getConfiguration(request('/api/bots/configuration/bot-1'), params('bot-1'));
      expect(res.status).toBe(200);
    });

    it('allows the bot server admin token', async () => {
      const res = await getConfiguration(
        request('/api/bots/configuration/bot-1', 'test-admin-token'),
        params('bot-1')
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(bot);
    });
  });
});
