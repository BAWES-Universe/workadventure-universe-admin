import { checkAiProviderRef, checkBotModel } from '@/lib/ai-provider-ref';
import { keyModels } from '@/lib/ai-key-model-list';
import { prisma } from '@/lib/db';
import { checkKeyForBot } from '@/lib/ai-key-pay';

jest.mock('@/lib/ai-key-pay', () => ({
  ...jest.requireActual('@/lib/ai-key-pay'),
  checkKeyForBot: jest.fn(),
}));
jest.mock('@/lib/ai-key-model-list', () => ({ ...jest.requireActual('@/lib/ai-key-model-list'), keyModels: jest.fn() }));
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
    const ctx = { actorId: 'maker', makerId: 'maker', roomId: 'room-1', botId: 'bot-1' };
    const key = { providerId: 'key-1', ownerId: 'maker' };

    it('is accepted for its owner, who made the bot, when it is lent to the bot’s universe', async () => {
      findUnique.mockResolvedValueOnce(key);
      (checkKeyForBot as jest.Mock).mockResolvedValue({ ok: true });
      await expect(checkAiProviderRef('key-1', null, ctx)).resolves.toBeNull();
      expect(checkKeyForBot).toHaveBeenCalledWith({ keyId: 'key-1', keyOwnerId: 'maker', bot: { id: 'bot-1', createdById: 'maker', roomId: 'room-1' } });
    });

    it('tells the owner why when it is not lent there', async () => {
      findUnique.mockResolvedValueOnce(key);
      (checkKeyForBot as jest.Mock).mockResolvedValue({ ok: false, reason: 'not-lent' });
      await expect(checkAiProviderRef('key-1', null, ctx)).resolves.toBe('That key isn’t lent to this bot’s universe. Lend it from AI keys first.');
    });

    it('lets anyone who manages someone else’s bot put it on their own key (#709): the maker stays the maker', async () => {
      findUnique.mockResolvedValueOnce(key);
      (checkKeyForBot as jest.Mock).mockResolvedValue({ ok: true });
      await expect(checkAiProviderRef('key-1', 'sara-key', { ...ctx, makerId: 'sara' })).resolves.toBeNull();
      expect(checkKeyForBot).toHaveBeenCalledWith({ keyId: 'key-1', keyOwnerId: 'maker', bot: { id: 'bot-1', createdById: 'sara', roomId: 'room-1' } });
    });

    it('refuses their own key when they can’t manage the bot', async () => {
      findUnique.mockResolvedValueOnce(key);
      (checkKeyForBot as jest.Mock).mockResolvedValue({ ok: false, reason: 'no-access' });
      await expect(checkAiProviderRef('key-1', null, { ...ctx, makerId: 'sara' })).resolves.toBe('You need Manage bots here to run this bot on your key.');
    });

    it('never puts a bot on someone else’s key, not even for its maker', async () => {
      findUnique.mockResolvedValueOnce({ providerId: 'sara-key', ownerId: 'sara' });
      await expect(checkAiProviderRef('sara-key', 'key-1', ctx)).resolves.toBe('AI provider "sara-key" does not exist');
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

describe('checkBotModel (#575)', () => {
  const key = { providerId: 'key-1', ownerId: 'maker', endpoint: 'https://api.anthropic.com/v1', apiKeyEncrypted: 'enc', settings: { kind: 'claude' }, model: 'claude-sonnet-5-5' };
  const context = { ref: 'key-1', currentRef: 'key-1', currentModel: 'claude-sonnet-5-5', actorId: 'maker', makerId: 'maker', roomId: 'room-1', botId: 'bot-1' };
  beforeEach(() => {
    jest.clearAllMocks();
    findUnique.mockResolvedValue(key);
    (checkKeyForBot as jest.Mock).mockResolvedValue({ ok: true, lendModels: null });
    (keyModels as jest.Mock).mockResolvedValue({ ok: true, models: ['claude-haiku-5-5', 'claude-opus-5-5', 'claude-sonnet-5-5'], facts: {}, listed: true });
  });

  it('lets through no model, null, and the model the bot already has on the same key, without a lookup', async () => {
    await expect(checkBotModel(undefined, context)).resolves.toBeNull();
    await expect(checkBotModel(null, context)).resolves.toBeNull();
    await expect(checkBotModel('claude-sonnet-5-5', { ...context, actorId: null })).resolves.toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('accepts a model the key lists, picked by the key’s owner, whoever made the bot', async () => {
    await expect(checkBotModel('claude-haiku-5-5', context)).resolves.toBeNull();
    expect(checkKeyForBot).toHaveBeenCalledWith({ keyId: 'key-1', keyOwnerId: 'maker', bot: { id: 'bot-1', createdById: 'maker', roomId: 'room-1' } });
    await expect(checkBotModel('claude-haiku-5-5', { ...context, makerId: 'someone-else' })).resolves.toBeNull();
  });

  it('refuses a model the key doesn’t list, or the lend leaves out', async () => {
    await expect(checkBotModel('gpt-5', context)).resolves.toBe('That model isn’t on this key’s list. Pick one it has.');
    (checkKeyForBot as jest.Mock).mockResolvedValue({ ok: true, lendModels: ['claude-sonnet-5-5'] });
    await expect(checkBotModel('claude-haiku-5-5', context)).resolves.toBe('That model isn’t allowed in this universe. Pick one the key allows here.');
  });

  it('refuses anyone but the key’s owner, and the bot server’s token', async () => {
    await expect(checkBotModel('claude-haiku-5-5', { ...context, actorId: 'manager' })).resolves.toBe('Only the key’s owner can pick its model.');
    await expect(checkBotModel('claude-haiku-5-5', { ...context, actorId: null })).resolves.toBe('Only the key’s owner can pick its model.');
  });

  it('refuses a model for a bot on Universe AI or a server provider', async () => {
    findUnique.mockResolvedValueOnce(null);
    await expect(checkBotModel('deepseek-v4-pro', { ...context, ref: 'universe-ai' })).resolves.toBe('A model can be picked only for a bot on your own AI key.');
    findUnique.mockResolvedValue({ ...key, ownerId: null });
    await expect(checkBotModel('deepseek-v4-pro', { ...context, ref: 'deepseek' })).resolves.toBe('A model can be picked only for a bot on your own AI key.');
  });

  it('says why the key can’t run the bot, or its list can’t be loaded', async () => {
    (checkKeyForBot as jest.Mock).mockResolvedValue({ ok: false, reason: 'not-lent' });
    await expect(checkBotModel('claude-haiku-5-5', context)).resolves.toBe('That key isn’t lent to this bot’s universe. Lend it from AI keys first.');
    (checkKeyForBot as jest.Mock).mockResolvedValue({ ok: true, lendModels: null });
    (keyModels as jest.Mock).mockResolvedValue({ ok: false, message: 'Claude didn’t accept this key.' });
    await expect(checkBotModel('claude-haiku-5-5', context)).resolves.toBe('Claude didn’t accept this key.');
  });
});
