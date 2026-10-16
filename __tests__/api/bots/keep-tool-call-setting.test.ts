import { NextRequest } from 'next/server';
import { PUT } from '@/app/api/bots/[id]/route';
import { keepToolCallSetting } from '@/lib/bot-config-helpers';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { canManageBots } from '@/lib/bot-permissions';

jest.mock('@/lib/db', () => ({
  prisma: {
    bot: { findUnique: jest.fn(), update: jest.fn() },
    user: { findFirst: jest.fn(), findUnique: jest.fn(), create: jest.fn() },
  },
}));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn(async () => null) }));
jest.mock('@/lib/auth', () => ({ requireAuth: jest.fn() }));
jest.mock('@/lib/bot-permissions', () => ({ canManageBots: jest.fn(async () => true) }));
jest.mock('@/lib/oidc', () => ({ validateAccessToken: jest.fn(async () => null) }));

const stored = { moves: 'route', showToolCalls: true };

function save(behaviorConfig: Record<string, unknown>) {
  return PUT(
    new NextRequest('http://localhost:3333/api/bots/bot-1', {
      method: 'PUT',
      headers: { Authorization: `Bearer orb_sess_v2_${'a'.repeat(64)}` },
      body: JSON.stringify({ behaviorConfig }),
    }),
    { params: Promise.resolve({ id: 'bot-1' }) }
  );
}

function savedConfig() {
  return (prisma.bot.update as jest.Mock).mock.calls[0][0].data.behaviorConfig;
}

describe('PUT /api/bots/:id keeps "Show tool calls" for callers that do not send it', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getSessionUser as jest.Mock).mockResolvedValue({ id: 'user-1', email: 'owner@example.com' });
    (canManageBots as jest.Mock).mockResolvedValue(true);
    (prisma.bot.update as jest.Mock).mockResolvedValue({ id: 'bot-1', roomId: 'room-123' });
  });

  it('keeps the stored value when the new config leaves the key out', async () => {
    (prisma.bot.findUnique as jest.Mock).mockResolvedValue({ id: 'bot-1', roomId: 'room-123', behaviorConfig: stored });
    expect((await save({ moves: 'wander' })).status).toBe(200);
    expect(savedConfig()).toEqual({ moves: 'wander', showToolCalls: true });
  });

  it('lets an explicit false or true from the caller win', async () => {
    (prisma.bot.findUnique as jest.Mock).mockResolvedValue({ id: 'bot-1', roomId: 'room-123', behaviorConfig: stored });
    await save({ moves: 'wander', showToolCalls: false });
    expect(savedConfig()).toEqual({ moves: 'wander', showToolCalls: false });
  });
});

describe('keepToolCallSetting', () => {
  it('adds nothing when the bot never had the setting', () => {
    expect(keepToolCallSetting({ moves: 'route' }, { moves: 'wander' })).toEqual({ moves: 'wander' });
    expect(keepToolCallSetting(null, { moves: 'wander' })).toEqual({ moves: 'wander' });
  });

  it('keeps a stored false as well as a stored true', () => {
    expect(keepToolCallSetting({ showToolCalls: false }, {})).toEqual({ showToolCalls: false });
  });

  it('ignores a stored value that is not a boolean', () => {
    expect(keepToolCallSetting({ showToolCalls: 'yes' }, {})).toEqual({});
  });
});
