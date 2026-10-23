import { prisma } from '@/lib/db';
import { addNotice } from '@/lib/notices';
import { keyModels } from '@/lib/ai-key-model-list';
import { moveBotsOffKey } from '@/lib/ai-key-lend';
import { probeChat } from '@/lib/ai-key-models';
import { decryptApiKey } from '@/lib/encryption';
import { moveBotOffGoneModel } from '@/lib/ai-key-model-gone';

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
// Each test gets a bot of its own
let botCount = 0;
const gone404 = { ok: false, reason: 'gone', message: 'OpenRouter doesn’t have that model.' };
const base = { id: 'b1', name: 'Guide', aiModel: 'meta-llama/llama-4-maverick', aiProviderRef: 'key-1', room: { world: { universe: { id: 'uni-1', name: 'Sandbox Universe' } } } };
let guide = base;

beforeEach(() => {
  jest.resetAllMocks();
  guide = { ...base, id: `bot-${++botCount}` };
  db.bot.findUnique.mockResolvedValue(guide);
  db.bot.updateMany.mockResolvedValue({ count: 1 });
  db.aiKeyLend.findUnique.mockResolvedValue({ models: null });
  db.botsAiProvider.updateMany.mockResolvedValue({ count: 1 });
  (moveBotsOffKey as jest.Mock).mockResolvedValue({ count: 0, universes: [] });
  list.mockResolvedValue({ ok: true, models: ['deepseek/deepseek-v4-flash', 'openai/gpt-5-mini'], facts: {}, listed: true });
  // The bot's model, asked once more, says again it has no such model; every other model answers
  chat.mockResolvedValueOnce(gone404).mockResolvedValue({ ok: true });
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
    chat.mockResolvedValue({ ok: false, reason: 'gone', message: 'OpenRouter doesn’t have that model.' });
    expect(await moveBotOffGoneModel(key, 'b1')).toBe(true);
    // The bot's own model was asked once more before anyone left the key
    expect(chat.mock.calls.map((call) => call[0].model)).toEqual(['meta-llama/llama-4-maverick']);
    expect(moveBotsOffKey).toHaveBeenCalledWith('key-1', { universeId: 'uni-1', actor: { id: '', name: 'OpenRouter' }, why: 'models-gone' });
    expect(db.bot.updateMany).not.toHaveBeenCalled();
    // The universe is the key owner's own: the universe owner's notice is theirs, so nothing more
    expect(notice).not.toHaveBeenCalled();
  });

  it('pulls nobody off the key when the owner changed the lend while the provider was asked', async () => {
    db.aiKeyLend.findUnique.mockResolvedValueOnce({ models: ['meta-llama/llama-4-maverick'] }).mockResolvedValueOnce({ models: null });
    chat.mockResolvedValue({ ok: false, reason: 'gone', message: 'OpenRouter doesn’t have that model.' });
    expect(await moveBotOffGoneModel(key, 'b1')).toBe(true);
    expect(moveBotsOffKey).not.toHaveBeenCalled();
    expect(db.bot.updateMany).not.toHaveBeenCalled();
  });

  it('tells the key’s owner too when the bots moved in someone else’s universe', async () => {
    db.aiKeyLend.findUnique.mockResolvedValue({ models: ['meta-llama/llama-4-maverick'] });
    (moveBotsOffKey as jest.Mock).mockResolvedValue({ count: 1, universes: [{ id: 'uni-1', name: 'Sandbox Universe', ownerId: 'someone', botNames: ['Guide'] }] });
    chat.mockResolvedValue({ ok: false, reason: 'gone', message: 'OpenRouter doesn’t have that model.' });
    expect(await moveBotOffGoneModel(key, guide.id)).toBe(true);
    expect(notice.mock.calls[0][0]).toMatchObject({ userId: 'maker', kind: 'ai-key-moved', title: 'Guide moved to Universe AI', href: '/admin/you/ai-keys' });
    expect(notice.mock.calls[0][0].body).toBe('OpenRouter no longer has any of the models My OpenRouter may use in Sandbox Universe, so Guide now replies on Universe AI.');
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

  it('can’t decide, and leaves it to the usual count, when the list fails or the provider has none', async () => {
    chat.mockResolvedValue(gone404);
    list.mockResolvedValueOnce({ ok: false, message: 'down' });
    expect(await moveBotOffGoneModel(key, 'b1')).toBe(false);
    list.mockResolvedValueOnce({ ok: true, models: ['openai/gpt-5-mini'], facts: {}, listed: false });
    expect(await moveBotOffGoneModel(key, 'b1')).toBe(false);
    expect(db.bot.updateMany).not.toHaveBeenCalled();
  });

  it('gives the key another check model when its own, still listed, won’t answer, and moves the bot off it', async () => {
    db.bot.findUnique.mockResolvedValue({ ...guide, aiModel: null });
    list.mockResolvedValue({ ok: true, models: ['openai/gpt-5-mini', 'qwen/qwen3-235b'], facts: {}, listed: true });
    expect(await moveBotOffGoneModel(key, guide.id)).toBe(true);
    // The failing model is asked once more, never again after that
    expect(chat.mock.calls.filter((call) => call[0].model === 'openai/gpt-5-mini')).toHaveLength(1);
    expect(db.botsAiProvider.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ model: 'qwen/qwen3-235b' }) }));
    expect(db.bot.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { aiModel: 'qwen/qwen3-235b' } }));
  });

  it('never moves a bot while the provider is busy, and decides again on the next report', async () => {
    list.mockResolvedValue({ ok: true, models: ['anthropic/claude-haiku-5-5', 'openai/gpt-5-mini'], facts: {}, listed: true });
    chat.mockResolvedValue({ ok: false, reason: 'busy', message: 'OpenRouter is busy right now.' });
    expect(await moveBotOffGoneModel(key, guide.id)).toBe(true);
    expect(db.bot.updateMany).not.toHaveBeenCalled();
    list.mockClear();
    chat.mockResolvedValueOnce(gone404).mockResolvedValue({ ok: true });
    expect(await moveBotOffGoneModel(key, guide.id)).toBe(true);
    expect(list).toHaveBeenCalled();
    expect(db.bot.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { aiModel: 'anthropic/claude-haiku-5-5' } }));
  });

  it('leaves it to the key’s own rules when the provider refuses the key while other models are asked', async () => {
    list.mockResolvedValue({ ok: true, models: ['anthropic/claude-haiku-5-5', 'openai/gpt-5-mini'], facts: {}, listed: true });
    chat.mockResolvedValue({ ok: false, reason: 'rejected', message: 'OpenRouter didn’t accept this key.' });
    expect(await moveBotOffGoneModel(key, guide.id)).toBe('rejected');
    expect(db.bot.updateMany).not.toHaveBeenCalled();
    expect(moveBotsOffKey).not.toHaveBeenCalled();
  });

  it('moves a bot off its own model when the provider still lists it but won’t answer with it, keeping the key Working', async () => {
    list.mockResolvedValue({ ok: true, models: ['meta-llama/llama-4-maverick', 'openai/gpt-5-mini'], facts: {}, listed: true });
    expect(await moveBotOffGoneModel(key, guide.id)).toBe(true);
    expect(db.bot.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { aiModel: 'openai/gpt-5-mini' } }));
    expect(chat.mock.calls.map((call) => call[0].model)).toEqual(['meta-llama/llama-4-maverick', 'openai/gpt-5-mini']);
    expect(notice.mock.calls[0][0].body).toBe('OpenRouter doesn’t answer with meta-llama/llama-4-maverick, so Guide in Sandbox Universe moved to openai/gpt-5-mini on My OpenRouter. Pick another model for it on its bot page if you like.');
  });

  it('moves nothing on a late report for a bot it just moved: its new model answers when asked, and a real 404 later moves it again', async () => {
    db.bot.findUnique.mockResolvedValue({ ...guide, id: 'b7' });
    expect(await moveBotOffGoneModel(key, 'b7')).toBe(true);
    db.bot.updateMany.mockClear();
    list.mockClear();
    // The bot is on its new model now; a reply already on its way reports the old one, and the new one answers
    db.bot.findUnique.mockResolvedValue({ ...guide, id: 'b7', aiModel: 'deepseek/deepseek-v4-flash' });
    expect(await moveBotOffGoneModel(key, 'b7')).toBe('count');
    expect(chat.mock.calls.at(-1)?.[0].model).toBe('deepseek/deepseek-v4-flash');
    expect(list).not.toHaveBeenCalled();
    expect(db.bot.updateMany).not.toHaveBeenCalled();
    // Later the provider says it has no such model either: the bot moves off that one too
    chat.mockResolvedValueOnce(gone404);
    expect(await moveBotOffGoneModel(key, 'b7')).toBe(true);
    expect(db.bot.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { aiModel: 'openai/gpt-5-mini' } }));
  });
  it('skips a listed model that doesn’t chat (an embedding model), for the bot and the check model alike, asking each once', async () => {
    db.bot.findUnique.mockResolvedValue({ ...guide, aiModel: null });
    list.mockResolvedValue({ ok: true, models: ['all-minilm', 'qwen/qwen3-235b'], facts: {}, listed: true });
    chat.mockImplementation(async ({ model }: { model: string }) => (model === 'all-minilm' ? { ok: false, reason: 'other', message: 'not a chat model' } : { ok: true }));
    await moveBotOffGoneModel(key, 'b1');
    expect(db.botsAiProvider.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ model: 'qwen/qwen3-235b' }) }));
    expect(db.bot.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { aiModel: 'qwen/qwen3-235b' } }));
    expect(chat.mock.calls.map((call) => call[0].model)).toEqual(['openai/gpt-5-mini', 'all-minilm', 'qwen/qwen3-235b']);
    expect(chat).toHaveBeenCalledWith(expect.objectContaining({ kind: 'openrouter', address: 'https://openrouter.ai/api/v1', apiKey: 'sk-or-v1-abcdef1234' }));
  });

  it('moves nobody when the provider doesn’t answer the tiny reply at all, asking only one other model', async () => {
    list.mockResolvedValue({ ok: true, models: ['deepseek/deepseek-v4-flash', 'openai/gpt-5-mini', 'qwen/qwen3-235b'], facts: {}, listed: true });
    chat.mockResolvedValue({ ok: false, reason: 'unreachable', message: 'OpenRouter didn’t answer.' });
    expect(await moveBotOffGoneModel(key, 'b1')).toBe(true);
    expect(chat).toHaveBeenCalledTimes(2);
    expect(db.bot.updateMany).not.toHaveBeenCalled();
  });

  it('moves the bots there to Universe AI when none of the other allowed models answers either, so bots never cycle', async () => {
    db.bot.findUnique.mockResolvedValue({ ...guide, id: 'b7' });
    list.mockResolvedValue({ ok: true, models: ['meta-llama/llama-4-maverick', 'openai/gpt-5-mini'], facts: {}, listed: true });
    chat.mockResolvedValue({ ok: false, reason: 'gone', message: 'OpenRouter doesn’t have that model.' });
    expect(await moveBotOffGoneModel(key, 'b7')).toBe(true);
    expect(moveBotsOffKey).toHaveBeenCalledWith('key-1', { universeId: 'uni-1', actor: { id: '', name: 'OpenRouter' }, why: 'models-gone' });
    expect(db.bot.updateMany).not.toHaveBeenCalled();
  });

  it('moves nobody off the key when one other allowed model failed for another reason than gone', async () => {
    list.mockResolvedValue({ ok: true, models: ['meta-llama/llama-4-maverick', 'm-1', 'm-2'], facts: {}, listed: true });
    chat.mockReset()
      .mockResolvedValueOnce({ ok: false, reason: 'gone', message: 'OpenRouter doesn’t have that model.' })
      .mockResolvedValueOnce({ ok: false, reason: 'other', message: 'Request timed out.' })
      .mockResolvedValue({ ok: false, reason: 'gone', message: 'OpenRouter doesn’t have that model.' });
    expect(await moveBotOffGoneModel(key, guide.id)).toBe(false);
    expect(moveBotsOffKey).not.toHaveBeenCalled();
    expect(db.bot.updateMany).not.toHaveBeenCalled();
  });

  it('leaves it to the key’s own rules when not every allowed model could be asked', async () => {
    db.bot.findUnique.mockResolvedValue({ ...guide, id: 'b8' });
    list.mockResolvedValue({ ok: true, models: ['meta-llama/llama-4-maverick', 'm-1', 'm-2', 'm-3', 'm-4', 'm-5'], facts: {}, listed: true });
    chat.mockResolvedValue({ ok: false, reason: 'gone', message: 'OpenRouter doesn’t have that model.' });
    expect(await moveBotOffGoneModel(key, 'b8')).toBe(false);
    expect(moveBotsOffKey).not.toHaveBeenCalled();
    expect(db.bot.updateMany).not.toHaveBeenCalled();
  });

  it('moves nobody when the lend’s only model answers when asked again, or no clear answer comes', async () => {
    db.bot.findUnique.mockResolvedValue({ ...guide, id: 'b4' });
    db.aiKeyLend.findUnique.mockResolvedValue({ models: ['meta-llama/llama-4-maverick'] });
    list.mockResolvedValue({ ok: true, models: ['meta-llama/llama-4-maverick', 'openai/gpt-5-mini'], facts: {}, listed: true });
    chat.mockReset().mockResolvedValue({ ok: true });
    expect(await moveBotOffGoneModel(key, 'b4')).toBe('count');
    chat.mockResolvedValue({ ok: false, reason: 'busy', message: 'OpenRouter is busy right now.' });
    expect(await moveBotOffGoneModel(key, 'b4')).toBe(true);
    // Any other error (a timeout, a conflict) says nothing sure about the model either
    chat.mockResolvedValue({ ok: false, reason: 'other', message: 'Request timed out.' });
    expect(await moveBotOffGoneModel(key, 'b4')).toBe(true);
    expect(list).not.toHaveBeenCalled();
    expect(moveBotsOffKey).not.toHaveBeenCalled();
    expect(db.bot.updateMany).not.toHaveBeenCalled();
  });

  it('moves the bots there to Universe AI when the lend’s only model is listed but the provider says it hasn’t it, the key staying Working', async () => {
    db.bot.findUnique.mockResolvedValue({ ...guide, id: 'b9' });
    db.aiKeyLend.findUnique.mockResolvedValue({ models: ['meta-llama/llama-4-maverick'] });
    list.mockResolvedValue({ ok: true, models: ['meta-llama/llama-4-maverick', 'openai/gpt-5-mini'], facts: {}, listed: true });
    chat.mockResolvedValue({ ok: false, reason: 'gone', message: 'OpenRouter doesn’t have that model.' });
    expect(await moveBotOffGoneModel(key, 'b9')).toBe(true);
    expect(moveBotsOffKey).toHaveBeenCalledWith('key-1', { universeId: 'uni-1', actor: { id: '', name: 'OpenRouter' }, why: 'models-gone' });
  });

  it('leaves it to the key’s own rules when the key is refused as the bot’s model is asked again', async () => {
    db.aiKeyLend.findUnique.mockResolvedValue({ models: ['meta-llama/llama-4-maverick'] });
    chat.mockReset().mockResolvedValue({ ok: false, reason: 'rejected', message: 'OpenRouter didn’t accept this key.' });
    expect(await moveBotOffGoneModel(key, guide.id)).toBe('rejected');
    chat.mockResolvedValue({ ok: false, reason: 'credit', message: 'OpenRouter says this key is out of credit.' });
    expect(await moveBotOffGoneModel(key, guide.id)).toBe('credit');
    expect(moveBotsOffKey).not.toHaveBeenCalled();
  });

  it('takes a 404 on a model the provider says calls no tools as real, without asking, and moves the bot to one that does', async () => {
    const toolless = { ...key, settings: { kind: 'openrouter', modelFacts: { 'meta-llama/llama-4-maverick': { tools: false } } } };
    list.mockResolvedValue({
      ok: true,
      models: ['meta-llama/llama-4-maverick', 'mistralai/mistral-7b', 'openai/gpt-5-mini'],
      facts: { 'meta-llama/llama-4-maverick': { tools: false }, 'mistralai/mistral-7b': { tools: false }, 'openai/gpt-5-mini': { tools: true } },
      listed: true,
    });
    chat.mockReset().mockResolvedValue({ ok: true });
    expect(await moveBotOffGoneModel(toolless, guide.id)).toBe(true);
    expect(chat.mock.calls.map((call) => call[0].model)).toEqual(['openai/gpt-5-mini']);
    expect(db.bot.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { aiModel: 'openai/gpt-5-mini' } }));
  });

  it('asks the provider once for replies in flight at once that report the same 404', async () => {
    list.mockResolvedValue({ ok: true, models: ['anthropic/claude-haiku-5-5', 'openai/gpt-5-mini'], facts: {}, listed: true });
    const answers = await Promise.all([moveBotOffGoneModel(key, guide.id), moveBotOffGoneModel(key, guide.id), moveBotOffGoneModel(key, guide.id)]);
    expect(answers).toEqual([true, true, true]);
    expect(list).toHaveBeenCalledTimes(1);
    expect(db.bot.updateMany).toHaveBeenCalledTimes(1);
  });

  it('asks every model with one tool, as a bot asks, so a model that chats but won’t take tools isn’t taken as answering', async () => {
    list.mockResolvedValue({ ok: true, models: ['anthropic/claude-haiku-5-5', 'openai/gpt-5-mini'], facts: {}, listed: true });
    expect(await moveBotOffGoneModel(key, guide.id)).toBe(true);
    expect(chat.mock.calls.length).toBeGreaterThan(1);
    for (const [asked] of chat.mock.calls) expect(asked.withTool).toBe(true);
  });

  it('never moves a bot to a model that refuses the call with a tool in it, since its replies always offer one', async () => {
    list.mockResolvedValue({ ok: true, models: ['anthropic/claude-haiku-5-5', 'openai/gpt-5-mini'], facts: {}, listed: true });
    chat.mockReset()
      .mockResolvedValueOnce(gone404)
      .mockResolvedValue({ ok: false, reason: 'request', message: 'Tools are not supported for this model.' });
    expect(await moveBotOffGoneModel(key, guide.id)).toBe(false);
    expect(db.bot.updateMany).not.toHaveBeenCalled();
    expect(moveBotsOffKey).not.toHaveBeenCalled();
  });

  it('shares what each model answered between bots on the key reporting at once, so no model is asked twice', async () => {
    list.mockResolvedValue({ ok: true, models: ['anthropic/claude-haiku-5-5', 'openai/gpt-5-mini'], facts: {}, listed: true });
    db.bot.findUnique.mockImplementation(({ where }: { where: { id: string } }) => Promise.resolve({ ...guide, id: where.id }));
    const both = await Promise.all([moveBotOffGoneModel(key, `${guide.id}-a`), moveBotOffGoneModel(key, `${guide.id}-b`)]);
    expect(both).toEqual([true, true]);
    // The bot's model once, and the model both move to once
    expect(chat.mock.calls.map((call) => call[0].model)).toEqual(['meta-llama/llama-4-maverick', 'anthropic/claude-haiku-5-5']);
    expect(db.bot.updateMany).toHaveBeenCalledTimes(2);
  });

  it('keeps the check model and the bot where they are when no listed model answers while the provider is busy', async () => {
    db.bot.findUnique.mockResolvedValue({ ...guide, aiModel: null });
    list.mockResolvedValue({ ok: true, models: ['deepseek/deepseek-v4-flash', 'qwen/qwen3-235b'], facts: {}, listed: true });
    chat.mockResolvedValue({ ok: false, reason: 'busy', message: 'OpenRouter is busy right now.' });
    expect(await moveBotOffGoneModel(key, guide.id)).toBe(true);
    expect(db.botsAiProvider.updateMany).not.toHaveBeenCalled();
    expect(db.bot.updateMany).not.toHaveBeenCalled();
  });

  it('lets a report go from a bot that follows the check model, just after the check model changed: the new one answers', async () => {
    // A bot of its own model moves the check model off a gone one...
    db.bot.findUnique.mockResolvedValue({ ...guide, aiModel: null });
    list.mockResolvedValue({ ok: true, models: ['deepseek/deepseek-v4-flash', 'qwen/qwen3-235b'], facts: {}, listed: true });
    await moveBotOffGoneModel(key, guide.id);
    // ...then another bot on the same key, with no model of its own, reports the old check model a moment later
    list.mockClear();
    db.bot.findUnique.mockResolvedValue({ ...guide, id: 'follower', aiModel: null });
    expect(await moveBotOffGoneModel({ ...key, model: 'deepseek/deepseek-v4-flash' }, 'follower')).toBe('count');
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
  });

  it('lets a report go from a bot that left this key while the reply was on its way, asking nothing', async () => {
    db.bot.findUnique.mockResolvedValue({ ...guide, aiProviderRef: 'universe-ai' });
    expect(await moveBotOffGoneModel(key, 'b1')).toBe(true);
    expect(chat).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
    expect(db.bot.updateMany).not.toHaveBeenCalled();
  });
});
