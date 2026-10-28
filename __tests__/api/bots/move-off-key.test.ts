import { NextRequest } from 'next/server';
import { PUT } from '@/app/api/bots/[id]/route';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { clearBotRunsOnNotices } from '@/lib/notices';
import { tellKeyOwnerMovedOff } from '@/lib/ai-key-moved-off';

/**
 * Anyone who manages a bot may move it off someone else's key (#709): to their own key or Universe AI. The key's owner is
 * told, and the bot's images stop going to that person's key with it.
 */

jest.mock('@/lib/db', () => ({
  prisma: {
    bot: { findUnique: jest.fn(), update: jest.fn() },
    botsAiProvider: { findUnique: jest.fn() },
    user: { findFirst: jest.fn(), findUnique: jest.fn(), create: jest.fn() },
  },
}));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn(async () => null) }));
jest.mock('@/lib/auth', () => ({ requireAuth: jest.fn() }));
jest.mock('@/lib/bot-permissions', () => ({ canManageBots: jest.fn(async () => true), canManageThisBot: jest.fn(async () => true) }));
jest.mock('@/lib/oidc', () => ({ validateAccessToken: jest.fn(async () => null) }));
jest.mock('@/lib/notices', () => ({ clearBotRunsOnNotices: jest.fn(async () => undefined) }));
jest.mock('@/lib/ai-key-moved-off', () => ({ tellKeyOwnerMovedOff: jest.fn(async () => undefined) }));
jest.mock('@/lib/ai-provider-ref', () => ({ checkAiProviderRef: jest.fn(async () => null), checkBotModel: jest.fn(async () => null) }));

const SARA_VISION = { choice: 'another', keyId: 'sara-vision', model: 'deepseek-v4-flash-vision-exp' };
const stored = { id: 'bot-1', name: 'Linear SH', roomId: 'room-1', behaviorConfig: { walkSpeed: 2, vision: SARA_VISION }, aiProviderRef: 'sara-key', aiModel: null, createdById: 'sara' };

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
  (getSessionUser as jest.Mock).mockResolvedValue({ id: 'khalid', email: 'khalid@example.com' });
  (prisma.bot.findUnique as jest.Mock).mockResolvedValue(stored);
  (prisma.bot.update as jest.Mock).mockImplementation(async ({ data }: { data: object }) => ({ ...stored, ...data }));
  (prisma.botsAiProvider.findUnique as jest.Mock).mockResolvedValue({ ownerId: 'sara' });
});

describe('moving a bot off someone else’s key (#709)', () => {
  it('moves it to the mover’s own key, tells the key’s owner, and drops images going to that person’s key', async () => {
    expect((await save({ aiProviderRef: 'khalid-key' })).status).toBe(200);
    expect(saved()).toMatchObject({ aiProviderRef: 'khalid-key', aiModel: null, behaviorConfig: { walkSpeed: 2 } });
    expect(saved().behaviorConfig).not.toHaveProperty('vision');
    expect(clearBotRunsOnNotices).toHaveBeenCalledWith('bot-1');
    expect(tellKeyOwnerMovedOff).toHaveBeenCalledWith({ bot: { id: 'bot-1', name: 'Linear SH' }, fromRef: 'sara-key', toRef: 'khalid-key', actorId: 'khalid' });
    // Told after the old "runs on" notices are cleared, so the new one stays
    expect((clearBotRunsOnNotices as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan((tellKeyOwnerMovedOff as jest.Mock).mock.invocationCallOrder[0]);
  });

  it('does the same for a move to Universe AI', async () => {
    await save({ aiProviderRef: 'universe-ai' });
    expect(saved().behaviorConfig).toEqual({ walkSpeed: 2 });
    expect(tellKeyOwnerMovedOff).toHaveBeenCalledWith(expect.objectContaining({ fromRef: 'sara-key', toRef: 'universe-ai' }));
  });

  it('keeps images on the mover’s own key', async () => {
    (prisma.bot.findUnique as jest.Mock).mockResolvedValue({ ...stored, behaviorConfig: { vision: { ...SARA_VISION, keyId: 'khalid-vision' } } });
    (prisma.botsAiProvider.findUnique as jest.Mock).mockResolvedValue({ ownerId: 'khalid' });
    await save({ aiProviderRef: 'khalid-key' });
    expect(saved()).not.toHaveProperty('behaviorConfig');
  });

  it('changes nothing and tells nobody when the key stays the same', async () => {
    await save({ name: 'Linear' });
    expect(saved()).not.toHaveProperty('behaviorConfig');
    expect(tellKeyOwnerMovedOff).not.toHaveBeenCalled();
    expect(clearBotRunsOnNotices).not.toHaveBeenCalled();
  });
});
