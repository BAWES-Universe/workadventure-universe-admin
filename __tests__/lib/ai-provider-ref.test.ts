import { checkAiProviderRef } from '@/lib/ai-provider-ref';
import { prisma } from '@/lib/db';
import { checkKeyForBot } from '@/lib/ai-key-pay';

jest.mock('@/lib/ai-key-pay', () => ({
  ...jest.requireActual('@/lib/ai-key-pay'),
  checkKeyForBot: jest.fn(),
}));
jest.mock('@/lib/db', () => ({
  prisma: {
    botsAiProvider: {
      findUnique: jest.fn(),
    },
  },
}));

const findUnique = prisma.botsAiProvider.findUnique as jest.Mock;

describe('checkAiProviderRef', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it.each([undefined, null, ''])('accepts an empty ref (%p) without a lookup', async (ref) => {
    await expect(checkAiProviderRef(ref)).resolves.toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('accepts a ref that names an existing provider', async () => {
    findUnique.mockResolvedValueOnce({ providerId: 'deepseek' });
    await expect(checkAiProviderRef('deepseek')).resolves.toBeNull();
    expect(findUnique).toHaveBeenCalledWith({
      where: { providerId: 'deepseek' },
      select: { providerId: true, ownerId: true },
    });
  });

  it('rejects a ref that names someone\u2019s personal key (#374): no bot is pointed at a key by its id', async () => {
    findUnique.mockResolvedValueOnce({ providerId: 'key-1', ownerId: 'user-a' });
    await expect(checkAiProviderRef('key-1')).resolves.toBe('AI provider "key-1" does not exist');
  });

  it('rejects a ref that names no provider', async () => {
    findUnique.mockResolvedValueOnce(null);
    await expect(checkAiProviderRef('someone-elses-key')).resolves.toBe(
      'AI provider "someone-elses-key" does not exist'
    );
  });

  it('lets an unchanged ref through even if its provider was deleted', async () => {
    await expect(checkAiProviderRef('deleted-provider', 'deleted-provider')).resolves.toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('checks a changed ref against the providers table', async () => {
    findUnique.mockResolvedValueOnce(null);
    await expect(checkAiProviderRef('new-ref', 'old-ref')).resolves.toBe('AI provider "new-ref" does not exist');
  });

  describe('a personal key on a bot (#374)', () => {
    const ctx = { actorId: 'maker', makerId: 'maker', roomId: 'room-1' };
    const key = { providerId: 'key-1', ownerId: 'maker' };

    it('is accepted for its owner, who made the bot, when it is lent to the bot’s universe', async () => {
      findUnique.mockResolvedValueOnce(key);
      (checkKeyForBot as jest.Mock).mockResolvedValue({ ok: true });
      await expect(checkAiProviderRef('key-1', null, ctx)).resolves.toBeNull();
      expect(checkKeyForBot).toHaveBeenCalledWith({ keyId: 'key-1', keyOwnerId: 'maker', makerId: 'maker', roomId: 'room-1' });
    });

    it('tells the owner why when it is not lent there', async () => {
      findUnique.mockResolvedValueOnce(key);
      (checkKeyForBot as jest.Mock).mockResolvedValue({ ok: false, reason: 'not-lent' });
      await expect(checkAiProviderRef('key-1', null, ctx)).resolves.toBe('That key isn’t lent to this bot’s universe. Lend it from AI keys first.');
    });

    it('refuses the owner putting someone else’s bot on their own key', async () => {
      findUnique.mockResolvedValueOnce(key);
      await expect(checkAiProviderRef('key-1', null, { ...ctx, makerId: 'someone-else' })).resolves.toBe(
        'Only the person who made a bot can put it on their own key.',
      );
      expect(checkKeyForBot).not.toHaveBeenCalled();
    });

    it('says only "does not exist" to anyone who is not the key’s owner: a manager, a super admin, the bot server', async () => {
      for (const actorId of ['a-manager', null]) {
        findUnique.mockResolvedValueOnce(key);
        await expect(checkAiProviderRef('key-1', null, { ...ctx, actorId })).resolves.toBe('AI provider "key-1" does not exist');
      }
      expect(checkKeyForBot).not.toHaveBeenCalled();
    });

    it('lets a manager save someone’s bot that is already on the key, without changing it', async () => {
      await expect(checkAiProviderRef('key-1', 'key-1', { ...ctx, actorId: 'a-manager' })).resolves.toBeNull();
      expect(findUnique).not.toHaveBeenCalled();
    });
  });
});
