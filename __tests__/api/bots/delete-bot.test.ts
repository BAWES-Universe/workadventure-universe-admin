import { NextRequest } from 'next/server';
import { DELETE } from '@/app/api/bots/[id]/route';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { canManageBots } from '@/lib/bot-permissions';

jest.mock('@/lib/db', () => ({
  prisma: {
    bot: {
      findUnique: jest.fn(),
      deleteMany: jest.fn(),
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
  canManageBots: jest.fn(async () => true),
}));

jest.mock('@/lib/oidc', () => ({
  validateAccessToken: jest.fn(async () => null),
}));

const bot = { id: 'bot-1', roomId: 'room-123', name: 'Guide', room: { id: 'room-123' } };

function request() {
  return new NextRequest('http://localhost:3333/api/bots/bot-1', {
    method: 'DELETE',
    headers: { Authorization: `Bearer orb_sess_v2_${'a'.repeat(64)}` },
  });
}

const params = { params: Promise.resolve({ id: 'bot-1' }) };

describe('DELETE /api/bots/:id', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getSessionUser as jest.Mock).mockResolvedValue({ id: 'user-1', email: 'owner@example.com' });
    (canManageBots as jest.Mock).mockResolvedValue(true);
    (prisma.bot.findUnique as jest.Mock).mockResolvedValue(bot);
  });

  it('deletes the bot', async () => {
    (prisma.bot.deleteMany as jest.Mock).mockResolvedValue({ count: 1 });

    const response = await DELETE(request(), params);

    expect(response.status).toBe(204);
    expect(prisma.bot.deleteMany).toHaveBeenCalledWith({ where: { id: 'bot-1' } });
  });

  it('answers not found, not a server error, when an overlapping delete already removed the bot', async () => {
    // Both requests found the bot; the other one deleted it first.
    (prisma.bot.deleteMany as jest.Mock).mockResolvedValue({ count: 0 });

    const response = await DELETE(request(), params);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'Bot not found' });
  });

  it('refuses someone who cannot manage bots in the room', async () => {
    (canManageBots as jest.Mock).mockResolvedValue(false);

    const response = await DELETE(request(), params);

    expect(response.status).toBe(403);
    expect(prisma.bot.deleteMany).not.toHaveBeenCalled();
  });
});
