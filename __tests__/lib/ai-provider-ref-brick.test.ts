/**
 * What a Brick may be put on (game #2013): Universe AI, or one of its OWNER's own keys with any of that key's models. A key
 * is not lent to a universe for a Brick, because a Brick stands in none. Someone else's key reads as not there, a super
 * admin's included.
 */
import { checkAiProviderRef, checkBotModel } from '@/lib/ai-provider-ref';
import { prisma } from '@/lib/db';
import { keyModels } from '@/lib/ai-key-model-list';

jest.mock('@/lib/db', () => ({ prisma: { botsAiProvider: { findUnique: jest.fn(), findFirst: jest.fn() } } }));
jest.mock('@/lib/ai-key-model-list', () => ({ ...jest.requireActual('@/lib/ai-key-model-list'), keyModels: jest.fn() }));

const db = prisma as unknown as { botsAiProvider: Record<'findUnique' | 'findFirst', jest.Mock> };
const SARA = 'u-sara';
const OMAR = 'u-omar';
const brick = (actorId: string) => ({ actorId, makerId: SARA, roomId: null, ownerId: SARA, botId: 'brick-1' });

beforeEach(() => {
  jest.resetAllMocks();
  db.botsAiProvider.findUnique.mockImplementation(async ({ where }: { where: { providerId: string } }) => ({ providerId: where.providerId, ownerId: SARA, endpoint: null, apiKeyEncrypted: null, settings: {}, model: 'm-1' }));
  (keyModels as jest.Mock).mockResolvedValue({ ok: true, models: ['m-1', 'm-2'] });
});

describe('a Brick’s key', () => {
  it('is its owner’s own key, with no lend to a universe', async () => {
    expect(await checkAiProviderRef('key-1', 'universe-ai', brick(SARA))).toBeNull();
  });

  it('is refused when anyone but the Brick’s owner saves it: only its owner puts it on their key', async () => {
    expect(await checkAiProviderRef('key-1', 'universe-ai', brick(OMAR))).toBe('AI provider "key-1" does not exist');
  });

  it('is never a key of another person, whoever saves', async () => {
    db.botsAiProvider.findUnique.mockResolvedValue({ providerId: 'key-2', ownerId: OMAR });
    expect(await checkAiProviderRef('key-2', 'universe-ai', brick(SARA))).toBe('AI provider "key-2" does not exist');
  });

  it('lets any model on the key be picked that the key lists', async () => {
    expect(await checkBotModel('m-2', { ...brick(SARA), ref: 'key-1', currentRef: 'universe-ai', currentModel: null })).toBeNull();
    expect(await checkBotModel('m-9', { ...brick(SARA), ref: 'key-1', currentRef: 'key-1', currentModel: 'm-1' })).toBe('That model isn’t on this key’s list. Pick one it has.');
  });
});
