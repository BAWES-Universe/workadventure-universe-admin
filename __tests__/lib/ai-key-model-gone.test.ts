import { prisma } from '@/lib/db';
import { addNotice } from '@/lib/notices';
import { keyModels } from '@/lib/ai-key-model-list';
import { moveBotsOffKey } from '@/lib/ai-key-lend';
import { probeChat } from '@/lib/ai-key-models';
import { decryptApiKey } from '@/lib/encryption';
import { LATE_REPORT_MS, moveBotOffGoneModel, noteModelChanged } from '@/lib/ai-key-model-gone';

/** A provider drops the model one bot uses (#575): that bot moves, the key stays Working. */

jest.mock('@/lib/db', () => ({
  prisma: { bot: { findUnique: jest.fn(), updateMany: jest.fn() }, aiKeyLend: { findUnique: jest.fn() }, botsAiProvider: { findUnique: jest.fn(), updateMany: jest.fn() } },
}));
jest.mock('@/lib/notices', () => ({ addNotice: jest.fn() }));
jest.mock('@/lib/ai-key-lend', () => ({ moveBotsOffKey: jest.fn() }));
jest.mock('@/lib/ai-key-model-list', () => ({ ...jest.requireActual('@/lib/ai-key-model-list'), keyModels: jest.fn() }));
jest.mock('@/lib/ai-key-models', () => ({ ...jest.requireActual('@/lib/ai-key-models'), probeChat: jest.fn() }));
jest.mock('@/lib/encryption', () => ({ decryptApiKey: jest.fn() }));

const db = prisma as unknown as { bot: Record<'findUnique' | 'updateMany', jest.Mock>; aiKeyLend: Record<'findUnique', jest.Mock>; botsAiProvider: Record<'findUnique' | 'updateMany', jest.Mock> };
const list = keyModels as jest.Mock;
const notice = addNotice as jest.Mock;
const chat = probeChat as jest.Mock;

const key = { providerId: 'key-1', name: 'My OpenRouter', ownerId: 'maker', endpoint: 'https://openrouter.ai/api/v1', apiKeyEncrypted: 'enc', settings: { kind: 'openrouter' }, model: 'openai/gpt-5-mini' };
// Each test gets a bot of its own, and a clock well past the last one's: a change in one test is not a late report in the next
let botCount = 0;
const realNow = Date.now;
const base = { id: 'b1', name: 'Guide', aiModel: 'meta-llama/llama-4-maverick', aiProviderRef: 'key-1', room: { world: { universe: { id: 'uni-1', name: 'Sandbox Universe' } } } };
let guide = base;

beforeEach(() => {
  jest.resetAllMocks();
  guide = { ...base, id: `bot-${++botCount}` };
  const shift = botCount * 3 * LATE_REPORT_MS;
  jest.spyOn(Date, 'now').mockImplementation(() => realNow() + shift);
  db.bot.findUnique.mockResolvedValue(guide);
  db.bot.updateMany.mockResolvedValue({ count: 1 });
  db.aiKeyLend.findUnique.mockResolvedValue({ models: null });
  db.botsAiProvider.updateMany.mockResolvedValue({ count: 1 });
  list.mockResolvedValue({ ok: true, models: ['deepseek/deepseek-v4-flash', 'openai/gpt-5-mini'], facts: {}, listed: true });
  chat.mockResolvedValue({ ok: true });
  (decryptApiKey as jest.Mock).mockReturnValue('sk-or-v1-abcdef1234');
});

describe('moveBotOffGoneModel', () => {
  it('moves the bot to the first model the provider still lists, and tells its maker', async () => {
    list.mockResolvedValue({ ok: true, models: ['anthropic/claude-haiku-5-5', 'deepseek/deepseek-v4-flash', 'openai/gpt-5-mini'], facts: {}, listed: true });
    expect(await moveBotOffGoneModel(key, 'b1')).toBe(true);
    expect(list).toHaveBeenCalledWith(key, { fresh: true });
    expect(db.bot.updateMany).toHaveBeenCalledWith({ where: { id: guide.id, aiProviderRef: 'key-1', aiModel: 'meta-llama/llama-4-maverick' }, data: { aiModel: 'anthropic/claude-haiku-5-5' } });
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
    // The key's own check model, still listed, not answering: the key's failure, as before
    db.bot.findUnique.mockResolvedValue({ ...guide, id: 'b9', aiModel: null });
    list.mockResolvedValueOnce({ ok: true, models: ['openai/gpt-5-mini', 'qwen/qwen3-235b'], facts: {}, listed: true });
    expect(await moveBotOffGoneModel(key, 'b1')).toBe(false);
    expect(db.bot.updateMany).not.toHaveBeenCalled();
  });

  it('moves a bot off its own model when the provider still lists it but won’t answer with it, keeping the key Working', async () => {
    // A bot this file never moved, so no late report is in play
    db.bot.findUnique.mockResolvedValue({ ...guide, id: 'b5' });
    list.mockResolvedValue({ ok: true, models: ['meta-llama/llama-4-maverick', 'openai/gpt-5-mini'], facts: {}, listed: true });
    expect(await moveBotOffGoneModel(key, 'b5')).toBe(true);
    expect(db.bot.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { aiModel: 'openai/gpt-5-mini' } }));
    expect(chat.mock.calls.map((call) => call[0].model)).toEqual(['openai/gpt-5-mini']);
    expect(notice.mock.calls[0][0].body).toBe('OpenRouter doesn’t answer with meta-llama/llama-4-maverick, so Guide in Sandbox Universe moved to openai/gpt-5-mini on My OpenRouter. Pick another model for it on its bot page if you like.');
  });

  it('lets a late report go for a bot it just moved, without moving it again, and acts on it again later', async () => {
    db.bot.findUnique.mockResolvedValue({ ...guide, id: 'b7' });
    expect(await moveBotOffGoneModel(key, 'b7')).toBe(true);
    db.bot.updateMany.mockClear();
    // The bot is on its new model now, which the provider lists; a reply already on its way reports the old one
    db.bot.findUnique.mockResolvedValue({ ...guide, id: 'b7', aiModel: 'deepseek/deepseek-v4-flash' });
    expect(await moveBotOffGoneModel(key, 'b7')).toBe(true);
    expect(db.bot.updateMany).not.toHaveBeenCalled();
    // Even while the provider's list can't be loaded, the provider isn't asked at all
    list.mockClear();
    list.mockResolvedValueOnce({ ok: false, message: 'down' });
    expect(await moveBotOffGoneModel(key, 'b7')).toBe(true);
    expect(list).not.toHaveBeenCalled();
    list.mockReset();
    list.mockResolvedValue({ ok: true, models: ['deepseek/deepseek-v4-flash', 'openai/gpt-5-mini'], facts: {}, listed: true });
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now + LATE_REPORT_MS + 1);
    // Later, a 404 is news about the new model: the bot moves off that one too
    expect(await moveBotOffGoneModel(key, 'b7')).toBe(true);
    expect(db.bot.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { aiModel: 'openai/gpt-5-mini' } }));
    clock.mockRestore();
  });

  it('skips a listed model that doesn’t chat (an embedding model), for the bot and the check model alike, asking each once', async () => {
    db.bot.findUnique.mockResolvedValue({ ...guide, aiModel: null });
    list.mockResolvedValue({ ok: true, models: ['all-minilm', 'qwen/qwen3-235b'], facts: {}, listed: true });
    chat.mockImplementation(async ({ model }: { model: string }) => (model === 'all-minilm' ? { ok: false, reason: 'other', message: 'not a chat model' } : { ok: true }));
    await moveBotOffGoneModel(key, 'b1');
    expect(db.botsAiProvider.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ model: 'qwen/qwen3-235b' }) }));
    expect(db.bot.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { aiModel: 'qwen/qwen3-235b' } }));
    expect(chat.mock.calls.map((call) => call[0].model)).toEqual(['all-minilm', 'qwen/qwen3-235b']);
    expect(chat).toHaveBeenCalledWith(expect.objectContaining({ kind: 'openrouter', address: 'https://openrouter.ai/api/v1', apiKey: 'sk-or-v1-abcdef1234' }));
  });

  it('keeps the first model, as before, when the provider doesn’t answer the tiny reply at all', async () => {
    list.mockResolvedValue({ ok: true, models: ['deepseek/deepseek-v4-flash', 'openai/gpt-5-mini', 'qwen/qwen3-235b'], facts: {}, listed: true });
    chat.mockResolvedValue({ ok: false, reason: 'unreachable', message: 'OpenRouter didn’t answer.' });
    expect(await moveBotOffGoneModel(key, 'b1')).toBe(true);
    expect(chat).toHaveBeenCalledTimes(1);
    expect(db.bot.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { aiModel: 'deepseek/deepseek-v4-flash' } }));
  });

  it('leaves it to the key’s own rules when the lend’s only model is still listed but won’t answer', async () => {
    db.bot.findUnique.mockResolvedValue({ ...guide, id: 'b4' });
    db.aiKeyLend.findUnique.mockResolvedValue({ models: ['meta-llama/llama-4-maverick'] });
    list.mockResolvedValue({ ok: true, models: ['meta-llama/llama-4-maverick', 'openai/gpt-5-mini'], facts: {}, listed: true });
    expect(await moveBotOffGoneModel(key, 'b4')).toBe(false);
    expect(moveBotsOffKey).not.toHaveBeenCalled();
    expect(db.bot.updateMany).not.toHaveBeenCalled();
  });

  it('lets a report go just after the maker changed the bot’s model or key, since it is about the model it had', async () => {
    noteModelChanged(guide.id);
    expect(await moveBotOffGoneModel(key, guide.id)).toBe(true);
    expect(list).not.toHaveBeenCalled();
    expect(db.bot.updateMany).not.toHaveBeenCalled();
  });

  it('lets a report go from a bot that follows the check model, just after the check model changed', async () => {
    // A bot of its own model moves the check model off a gone one...
    db.bot.findUnique.mockResolvedValue({ ...guide, aiModel: null });
    list.mockResolvedValue({ ok: true, models: ['deepseek/deepseek-v4-flash', 'qwen/qwen3-235b'], facts: {}, listed: true });
    await moveBotOffGoneModel(key, guide.id);
    // ...then another bot on the same key, with no model of its own, reports the old check model a moment later
    list.mockClear();
    db.bot.findUnique.mockResolvedValue({ ...guide, id: 'follower', aiModel: null });
    expect(await moveBotOffGoneModel({ ...key, model: 'deepseek/deepseek-v4-flash' }, 'follower')).toBe(true);
    expect(list).not.toHaveBeenCalled();
  });

  it('keeps settings saved meanwhile, and leaves a model someone else picked meanwhile', async () => {
    db.bot.findUnique.mockResolvedValue({ ...guide, aiModel: null, aiProviderRef: 'key-9' });
    db.botsAiProvider.findUnique.mockResolvedValue({ settings: { kind: 'openrouter', label: 'Work' } });
    db.botsAiProvider.updateMany.mockResolvedValue({ count: 0 });
    list.mockResolvedValue({ ok: true, models: ['deepseek/deepseek-v4-flash', 'qwen/qwen3-235b'], facts: {}, listed: true });
    const other = { ...key, providerId: 'key-9' };
    await moveBotOffGoneModel(other, guide.id);
    expect(db.botsAiProvider.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ settings: { kind: 'openrouter', label: 'Work' } }) }));
    // The check model did not change here, so a follower's report is not a late one
    list.mockClear();
    db.bot.findUnique.mockResolvedValue({ ...guide, id: 'follower-9', aiModel: null, aiProviderRef: 'key-9' });
    await moveBotOffGoneModel({ ...other, model: 'deepseek/deepseek-v4-flash' }, 'follower-9');
    expect(list).toHaveBeenCalled();
  });

  it('does nothing for a bot that is not on this key any more', async () => {
    db.bot.findUnique.mockResolvedValue({ ...guide, aiProviderRef: 'universe-ai' });
    expect(await moveBotOffGoneModel(key, 'b1')).toBe(false);
    expect(list).not.toHaveBeenCalled();
  });
});
