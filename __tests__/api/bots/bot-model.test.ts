import { NextRequest } from 'next/server';
import { PUT } from '@/app/api/bots/[id]/route';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { checkAiProviderRef, checkBotModel } from '@/lib/ai-provider-ref';

/** A bot's own model on its maker's key is saved with the bot (#575), and belongs to that one key. */

jest.mock('@/lib/db', () => ({
  prisma: {
    bot: { findUnique: jest.fn(), update: jest.fn() },
    user: { findFirst: jest.fn(), findUnique: jest.fn(), create: jest.fn() },
  },
}));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn(async () => null) }));
jest.mock('@/lib/auth', () => ({ requireAuth: jest.fn() }));
jest.mock('@/lib/bot-permissions', () => ({ canManageBots: jest.fn(async () => true), canManageThisBot: jest.fn(async () => true) }));
jest.mock('@/lib/oidc', () => ({ validateAccessToken: jest.fn(async () => null) }));
jest.mock('@/lib/ai-provider-ref', () => ({ checkAiProviderRef: jest.fn(async () => null), checkBotModel: jest.fn(async () => null) }));

const stored = { id: 'bot-1', roomId: 'room-123', behaviorConfig: {}, aiProviderRef: 'key-1', aiModel: 'claude-sonnet-5-5', createdById: 'maker' };

function save(body: Record<string, unknown>) {
  return PUT(
    new NextRequest('http://localhost:3333/api/bots/bot-1', {
      method: 'PUT',
      headers: { Authorization: `Bearer orb_sess_v2_${'a'.repeat(64)}` },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: 'bot-1' }) }
  );
}

const saved = () => (prisma.bot.update as jest.Mock).mock.calls[0][0].data;

beforeEach(() => {
  jest.clearAllMocks();
  (getSessionUser as jest.Mock).mockResolvedValue({ id: 'maker', email: 'maker@example.com' });
  (prisma.bot.findUnique as jest.Mock).mockResolvedValue(stored);
  (prisma.bot.update as jest.Mock).mockImplementation(async ({ data }: { data: object }) => ({ ...stored, ...data }));
});

describe('PUT /api/bots/:id with aiModel', () => {
  it('saves the model picked on the key the bot is on, and says it back', async () => {
    const response = await save({ aiModel: 'claude-haiku-5-5' });
    expect(response.status).toBe(200);
    expect(checkBotModel).toHaveBeenCalledWith('claude-haiku-5-5', { ref: 'key-1', currentRef: 'key-1', currentModel: 'claude-sonnet-5-5', actorId: 'maker', makerId: 'maker', roomId: 'room-123' });
    expect(saved().aiModel).toBe('claude-haiku-5-5');
    expect((await response.json()).aiModel).toBe('claude-haiku-5-5');
  });

  it('checks the model against the key the bot moves to in the same save', async () => {
    await save({ aiProviderRef: 'key-2', aiModel: 'gpt-5-mini' });
    expect(checkBotModel).toHaveBeenCalledWith('gpt-5-mini', expect.objectContaining({ ref: 'key-2', currentRef: 'key-1' }));
    expect(saved()).toMatchObject({ aiProviderRef: 'key-2', aiModel: 'gpt-5-mini' });
  });

  it('forgets the model when the bot moves to another key, or off keys, without one', async () => {
    await save({ aiProviderRef: 'universe-ai' });
    expect(saved()).toMatchObject({ aiProviderRef: 'universe-ai', aiModel: null });
  });

  it('keeps the model on a save that leaves the key and the model out', async () => {
    await save({ name: 'Guide' });
    expect(saved()).not.toHaveProperty('aiModel');
    await save({ aiProviderRef: 'key-1', name: 'Guide' });
    expect((prisma.bot.update as jest.Mock).mock.calls[1][0].data).not.toHaveProperty('aiModel');
  });

  it('refuses a model the check refuses, and saves nothing', async () => {
    (checkBotModel as jest.Mock).mockResolvedValueOnce('That model isn’t on this key’s list. Pick one it has.');
    const response = await save({ aiModel: 'gpt-5' });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe('That model isn’t on this key’s list. Pick one it has.');
    expect(prisma.bot.update).not.toHaveBeenCalled();
    expect(checkAiProviderRef).not.toHaveBeenCalled();
  });

  it('refuses an empty or overlong model name', async () => {
    expect((await save({ aiModel: '' })).status).toBe(400);
    expect((await save({ aiModel: 'x'.repeat(256) })).status).toBe(400);
  });
});
