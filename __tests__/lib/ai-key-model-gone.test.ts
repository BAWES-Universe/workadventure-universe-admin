import { prisma } from '@/lib/db';
import { addNotice } from '@/lib/notices';
import { keyModels } from '@/lib/ai-key-model-list';
import { moveBotsOffKey } from '@/lib/ai-key-lend';
import { LATE_REPORT_MS, moveBotOffGoneModel } from '@/lib/ai-key-model-gone';

/** A provider drops the model one bot uses (#575): that bot moves, the key stays Working. */

jest.mock('@/lib/db', () => ({
  prisma: { bot: { findUnique: jest.fn(), updateMany: jest.fn() }, aiKeyLend: { findUnique: jest.fn() }, botsAiProvider: { updateMany: jest.fn() } },
}));
jest.mock('@/lib/notices', () => ({ addNotice: jest.fn() }));
jest.mock('@/lib/ai-key-lend', () => ({ moveBotsOffKey: jest.fn() }));
jest.mock('@/lib/ai-key-model-list', () => ({ ...jest.requireActual('@/lib/ai-key-model-list'), keyModels: jest.fn() }));

const db = prisma as unknown as { bot: Record<'findUnique' | 'updateMany', jest.Mock>; aiKeyLend: Record<'findUnique', jest.Mock>; botsAiProvider: Record<'updateMany', jest.Mock> };
const list = keyModels as jest.Mock;
const notice = addNotice as jest.Mock;

const key = { providerId: 'key-1', name: 'My OpenRouter', ownerId: 'maker', endpoint: 'https://openrouter.ai/api/v1', apiKeyEncrypted: 'enc', settings: { kind: 'openrouter' }, model: 'openai/gpt-5-mini' };
const guide = { id: 'b1', name: 'Guide', aiModel: 'meta-llama/llama-4-maverick', aiProviderRef: 'key-1', room: { world: { universe: { id: 'uni-1', name: 'Sandbox Universe' } } } };

beforeEach(() => {
  jest.resetAllMocks();
  db.bot.findUnique.mockResolvedValue(guide);
  db.bot.updateMany.mockResolvedValue({ count: 1 });
  db.aiKeyLend.findUnique.mockResolvedValue({ models: null });
  list.mockResolvedValue({ ok: true, models: ['deepseek/deepseek-v4-flash', 'openai/gpt-5-mini'], facts: {}, listed: true });
});

describe('moveBotOffGoneModel', () => {
  it('moves the bot to the first model the provider still lists, and tells its maker', async () => {
    list.mockResolvedValue({ ok: true, models: ['anthropic/claude-haiku-5-5', 'deepseek/deepseek-v4-flash', 'openai/gpt-5-mini'], facts: {}, listed: true });
    expect(await moveBotOffGoneModel(key, 'b1')).toBe(true);
    expect(list).toHaveBeenCalledWith(key, { fresh: true });
    expect(db.bot.updateMany).toHaveBeenCalledWith({ where: { id: 'b1', aiProviderRef: 'key-1', aiModel: 'meta-llama/llama-4-maverick' }, data: { aiModel: 'anthropic/claude-haiku-5-5' } });
    expect(notice.mock.calls[0][0]).toMatchObject({ userId: 'maker', kind: 'ai-key-moved', title: 'Guide now replies with anthropic/claude-haiku-5-5' });
    expect(notice.mock.calls[0][0].body).toBe('OpenRouter no longer has meta-llama/llama-4-maverick, so Guide in Sandbox Universe moved to anthropic/claude-haiku-5-5 on My OpenRouter. Pick another model for it on its bot page if you like.');
    // The key's check model is still there: the key is not touched
    expect(db.botsAiProvider.updateMany).not.toHaveBeenCalled();
  });

  it('keeps to the lend: the first model it allows that the provider still lists', async () => {
    db.aiKeyLend.findUnique.mockResolvedValue({ models: ['meta-llama/llama-4-maverick', 'openai/gpt-5-mini'] });
    await moveBotOffGoneModel(key, 'b1');
    expect(db.bot.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { aiModel: 'openai/gpt-5-mini' } }));
  });

  it('checks the model the reply was really asked of: the lend’s first when the bot’s own isn’t allowed there', async () => {
    db.bot.findUnique.mockResolvedValue({ ...guide, aiModel: 'openai/gpt-5-mini' });
    db.aiKeyLend.findUnique.mockResolvedValue({ models: ['x-ai/grok-old', 'deepseek/deepseek-v4-flash'] });
    expect(await moveBotOffGoneModel(key, 'b1')).toBe(true);
    expect(db.bot.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { aiModel: 'deepseek/deepseek-v4-flash' } }));
  });

  it('moves the bots there to Universe AI when the lend allows nothing the provider still lists', async () => {
    db.aiKeyLend.findUnique.mockResolvedValue({ models: ['meta-llama/llama-4-maverick'] });
    expect(await moveBotOffGoneModel(key, 'b1')).toBe(true);
    expect(moveBotsOffKey).toHaveBeenCalledWith('key-1', { universeId: 'uni-1', actor: { id: '', name: 'OpenRouter' }, why: 'models-gone' });
    expect(db.bot.updateMany).not.toHaveBeenCalled();
  });

  it('gives the key a new check model when the one that went was it', async () => {
    db.bot.findUnique.mockResolvedValue({ ...guide, aiModel: null });
    list.mockResolvedValue({ ok: true, models: ['deepseek/deepseek-v4-flash', 'qwen/qwen3-235b'], facts: {}, listed: true });
    await moveBotOffGoneModel(key, 'b1');
    expect(db.botsAiProvider.updateMany).toHaveBeenCalledWith({
      where: { providerId: 'key-1', ownerId: { not: null }, model: 'openai/gpt-5-mini' },
      data: { model: 'deepseek/deepseek-v4-flash', settings: { kind: 'openrouter' }, supportsVision: null },
    });
    expect(db.bot.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { aiModel: 'deepseek/deepseek-v4-flash' } }));
  });

  it('prefers the provider’s suggested model when it lists it (DeepSeek)', async () => {
    const deepseek = { ...key, settings: { kind: 'deepseek' }, model: 'deepseek-v4-flash' };
    db.bot.findUnique.mockResolvedValue({ ...guide, aiModel: 'deepseek-v3' });
    list.mockResolvedValue({ ok: true, models: ['deepseek-chat', 'deepseek-v4-flash'], facts: {}, listed: true });
    await moveBotOffGoneModel(deepseek, 'b1');
    expect(db.bot.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { aiModel: 'deepseek-v4-flash' } }));
  });

  it('can’t decide, and leaves it to the usual count, when the list fails, the provider has none, or the model is still listed', async () => {
    // A bot this file never moved, so no late report is in play
    db.bot.findUnique.mockResolvedValue({ ...guide, id: 'b9' });
    list.mockResolvedValueOnce({ ok: false, message: 'down' });
    expect(await moveBotOffGoneModel(key, 'b1')).toBe(false);
    list.mockResolvedValueOnce({ ok: true, models: ['openai/gpt-5-mini'], facts: {}, listed: false });
    expect(await moveBotOffGoneModel(key, 'b1')).toBe(false);
    list.mockResolvedValueOnce({ ok: true, models: ['meta-llama/llama-4-maverick'], facts: {}, listed: true });
    expect(await moveBotOffGoneModel(key, 'b1')).toBe(false);
    expect(db.bot.updateMany).not.toHaveBeenCalled();
  });

  it('lets a late report go for a bot it just moved, without moving it again, and counts it again later', async () => {
    db.bot.findUnique.mockResolvedValue({ ...guide, id: 'b7' });
    expect(await moveBotOffGoneModel(key, 'b7')).toBe(true);
    db.bot.updateMany.mockClear();
    // The bot is on its new model now, which the provider lists; a reply already on its way reports the old one
    db.bot.findUnique.mockResolvedValue({ ...guide, id: 'b7', aiModel: 'deepseek/deepseek-v4-flash' });
    expect(await moveBotOffGoneModel(key, 'b7')).toBe(true);
    expect(db.bot.updateMany).not.toHaveBeenCalled();
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now + LATE_REPORT_MS + 1);
    expect(await moveBotOffGoneModel(key, 'b7')).toBe(false);
    clock.mockRestore();
  });

  it('does nothing for a bot that is not on this key any more', async () => {
    db.bot.findUnique.mockResolvedValue({ ...guide, aiProviderRef: 'universe-ai' });
    expect(await moveBotOffGoneModel(key, 'b1')).toBe(false);
    expect(list).not.toHaveBeenCalled();
  });
});
