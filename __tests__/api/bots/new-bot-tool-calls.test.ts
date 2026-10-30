import { NextRequest } from 'next/server';
import { POST } from '@/app/api/bots/configuration/route';
import { startWithToolCallsOn } from '@/lib/bot-tool-call-default';
import { prisma } from '@/lib/db';

jest.mock('@/lib/db', () => ({
  prisma: {
    bot: { create: jest.fn(), update: jest.fn(), findUnique: jest.fn() },
    room: { findUnique: jest.fn() },
    user: { findFirst: jest.fn(), create: jest.fn() },
    botsAiProvider: { findUnique: jest.fn() },
  },
}));
jest.mock('@/lib/notices', () => ({ clearBotRunsOnNotices: jest.fn(async () => undefined) }));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn(async () => null) }));
jest.mock('@/lib/auth', () => ({ requireAuth: jest.fn() }));
jest.mock('@/lib/bot-permissions', () => ({
  canManageBots: jest.fn(async () => true),
  canManageThisBot: jest.fn(async () => true),
}));
jest.mock('@/lib/super-admin', () => ({ isSuperAdmin: jest.fn(() => true) }));
jest.mock('@/lib/oidc', () => ({ validateAccessToken: jest.fn(async () => null) }));
jest.mock('@/lib/bot-config-helpers', () => ({
  resolveRoomIdFromPlayUri: jest.fn(async () => 'room-123'),
  transformBotToServerFormat: jest.fn(async (bot: unknown) => bot),
}));

function create(behaviorConfig?: Record<string, unknown>) {
  return POST(
    new NextRequest('http://localhost:3333/api/bots/configuration', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-admin-token' },
      body: JSON.stringify({
        name: 'Test Bot',
        roomUrl: 'https://play.bawes.net/~/room/test',
        behaviorType: 'idle',
        ...(behaviorConfig ? { behaviorConfig } : {}),
      }),
    })
  );
}

describe('a new bot starts with "Show tool calls" on', () => {
  beforeAll(() => {
    process.env.ADMIN_API_TOKEN = 'test-admin-token';
  });

  beforeEach(() => {
    jest.clearAllMocks();
    (prisma.bot.create as jest.Mock).mockResolvedValue({ id: 'bot-1', name: 'Test Bot' });
    (prisma.bot.update as jest.Mock).mockResolvedValue({ id: 'bot-1', name: 'Test Bot' });
    (prisma.bot.findUnique as jest.Mock).mockResolvedValue({ behaviorConfig: null });
  });

  it('turns it on when the caller does not say', () => {
    expect(startWithToolCallsOn({ moves: 'route' })).toEqual({ moves: 'route', showToolCalls: true });
  });

  it('lets an explicit false or true from the caller win', () => {
    expect(startWithToolCallsOn({ showToolCalls: false })).toEqual({ showToolCalls: false });
    expect(startWithToolCallsOn({ showToolCalls: true })).toEqual({ showToolCalls: true });
  });

  it('saves it on for a bot created without it', async () => {
    expect((await create()).status).toBe(201);
    expect((prisma.bot.create as jest.Mock).mock.calls[0][0].data.behaviorConfig.showToolCalls).toBe(true);
  });

  it('keeps an explicit off on a created bot', async () => {
    await create({ showToolCalls: false });
    expect((prisma.bot.create as jest.Mock).mock.calls[0][0].data.behaviorConfig.showToolCalls).toBe(false);
  });

  it('does not turn it on for a bot that already exists', async () => {
    (prisma.bot.findUnique as jest.Mock).mockResolvedValue({ behaviorConfig: { moves: 'route' } });
    const response = await POST(
      new NextRequest('http://localhost:3333/api/bots/configuration', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-admin-token' },
        body: JSON.stringify({
          botId: '00000000-0000-4000-8000-000000000001',
          name: 'Test Bot',
          roomUrl: 'https://play.bawes.net/~/room/test',
          behaviorType: 'idle',
        }),
      })
    );
    expect(response.status).toBe(200);
    expect(prisma.bot.create).not.toHaveBeenCalled();
    expect((prisma.bot.update as jest.Mock).mock.calls[0][0].data.behaviorConfig).not.toHaveProperty('showToolCalls');
  });
});
