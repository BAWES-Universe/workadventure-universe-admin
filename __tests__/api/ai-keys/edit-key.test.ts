/**
 * Changing a saved key's address or model (#374): the row stays the same row, so lends and bots survive, and nothing is
 * saved until the new address answers the model list and one tiny chat reply.
 */
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { PATCH } from '@/app/api/me/ai-keys/[id]/route';
import { POST as listModels } from '@/app/api/me/ai-keys/[id]/models/route';
import { editSavedKey, listModelsForSavedKey } from '@/lib/ai-key-edit';
import { probeChat, probeModels, allowKeyAttempt } from '@/lib/ai-key-models';
import { markWorking } from '@/lib/ai-key-health';

jest.mock('@/lib/db', () => {
  const prisma: Record<string, unknown> = { botsAiProvider: { findFirst: jest.fn(), updateMany: jest.fn() }, bot: { updateMany: jest.fn() }, aiKeyLend: { findMany: jest.fn() }, $queryRaw: jest.fn() };
  prisma.$transaction = jest.fn((run: (tx: unknown) => unknown) => run(prisma));
  return { prisma };
});
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn() }));
jest.mock('@/lib/encryption', () => ({ decryptApiKey: jest.fn((value: string) => value.replace('enc:', '')) }));
jest.mock('@/lib/ai-key-lend', () => ({ moveBotsOffKey: jest.fn() }));
jest.mock('@/lib/ai-key-health', () => ({ ...jest.requireActual('@/lib/ai-key-health'), markWorking: jest.fn() }));
jest.mock('@/lib/ai-key-models', () => ({
  ...jest.requireActual('@/lib/ai-key-models'),
  probeModels: jest.fn(),
  probeChat: jest.fn(),
  allowKeyAttempt: jest.fn(() => true),
}));

const db = prisma as unknown as { botsAiProvider: Record<'findFirst' | 'updateMany', jest.Mock>; bot: { updateMany: jest.Mock }; aiKeyLend: { findMany: jest.Mock } };
const alice = { id: 'maker', uuid: 'uuid-a', email: 'a@example.com', name: 'A', tags: [], isSuperAdmin: false };

const lmStudio = {
  providerId: 'key-1', name: 'My LM Studio', ownerId: 'maker', endpoint: 'https://old.trycloudflare.com', apiKeyEncrypted: null,
  settings: { kind: 'lmstudio' }, model: 'qwen3-8b', downSince: null, ifDown: 'universe-ai', healthCheckedAt: null,
};
const openai = { ...lmStudio, providerId: 'key-2', name: 'My OpenAI', endpoint: 'https://api.openai.com/v1', apiKeyEncrypted: 'enc:sk-secret', settings: { kind: 'openai' }, model: 'gpt-4o-mini' };

const patch = (id: string, body: unknown) =>
  PATCH(new NextRequest(`http://localhost:3333/api/me/ai-keys/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });
const models = (id: string, body: unknown) =>
  listModels(new NextRequest(`http://localhost:3333/api/me/ai-keys/${id}/models`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });

beforeEach(() => {
  jest.clearAllMocks();
  (getSessionUser as jest.Mock).mockResolvedValue(alice);
  (allowKeyAttempt as jest.Mock).mockReturnValue(true);
  db.botsAiProvider.findFirst.mockReset().mockResolvedValue(lmStudio);
  db.botsAiProvider.updateMany.mockResolvedValue({ count: 1 });
  db.aiKeyLend.findMany.mockResolvedValue([]);
  (probeModels as jest.Mock).mockResolvedValue({ ok: true, models: ['qwen3-8b', 'llama-3.1-8b'], facts: {} });
  (probeChat as jest.Mock).mockResolvedValue({ ok: true });
});

describe('a key whose provider has no model list (#456)', () => {
  const groq = { ...openai, providerId: 'key-3', name: 'My Groq', settings: { kind: 'groq' }, model: 'old-model' };
  const noList = { ok: false, noList: true, reason: 'other', message: 'Groq doesn’t share a list of its models. Type the model name.' };
  beforeEach(() => {
    db.botsAiProvider.findFirst.mockResolvedValue(groq);
    (probeModels as jest.Mock).mockResolvedValue(noList);
  });

  it('tells the Edit sheet there is no list, so it asks for a typed name', async () => {
    const response = await models('key-3', {});
    expect(await response.json()).toMatchObject({ ok: false, noList: true });
  });

  it('saves a typed model after one tiny reply, leaving the saved model facts alone', async () => {
    expect(await editSavedKey('maker', 'key-3', { model: 'new-model' })).toMatchObject({ ok: true, model: 'new-model' });
    expect(probeChat).toHaveBeenCalledWith(expect.objectContaining({ model: 'new-model' }));
    expect(db.botsAiProvider.updateMany.mock.calls[0][0].data).not.toHaveProperty('settings');
  });

  it('does not save a typed model the provider refuses, even with a 400', async () => {
    (probeChat as jest.Mock).mockResolvedValue({ ok: false, reason: 'request', message: 'Groq lists its models, but a chat call to nope failed (400). Check the model.' });
    expect(await editSavedKey('maker', 'key-3', { model: 'nope' })).toMatchObject({ ok: false, status: 400 });
    expect(db.botsAiProvider.updateMany).not.toHaveBeenCalled();
  });
});

describe('editSavedKey', () => {
  it('moves a key to its new address on the SAME row, and never touches lends or bots', async () => {
    const result = await editSavedKey('maker', 'key-1', { address: 'https://new.trycloudflare.com/v1' });
    expect(result).toEqual({ ok: true, model: 'qwen3-8b', endpoint: 'https://new.trycloudflare.com' });
    expect(probeModels).toHaveBeenCalledWith(expect.objectContaining({ kind: 'lmstudio', address: 'https://new.trycloudflare.com/v1' }));
    expect(probeChat).toHaveBeenCalledWith(expect.objectContaining({ address: 'https://new.trycloudflare.com/v1', model: 'qwen3-8b' }));
    expect(db.botsAiProvider.updateMany).toHaveBeenCalledTimes(1);
    const call = db.botsAiProvider.updateMany.mock.calls[0][0];
    expect(call.where).toEqual({ providerId: 'key-1', ownerId: 'maker', model: 'qwen3-8b' });
    expect(call.data).toMatchObject({ endpoint: 'https://new.trycloudflare.com', model: 'qwen3-8b', tested: true });
    // Lends are other rows keyed on the provider; the edit only ever updates the one provider row
    // The model is on the list, so what the provider says about it is refreshed too; nothing else changes
    expect(Object.keys(call.data).sort()).toEqual(['endpoint', 'healthCheckedAt', 'model', 'settings', 'supportsVision', 'tested', 'testedAt']);
    expect(db.bot.updateMany).not.toHaveBeenCalled();
  });

  it('changes the model, checks it is on the list, and asks the saved key for a reply from it', async () => {
    db.botsAiProvider.findFirst.mockResolvedValue(openai);
    (probeModels as jest.Mock).mockResolvedValue({ ok: true, models: ['gpt-4o-mini', 'gpt-4.1'], facts: {} });
    const result = await editSavedKey('maker', 'key-2', { model: 'gpt-4.1' });
    expect(result).toMatchObject({ ok: true, model: 'gpt-4.1' });
    expect(probeModels).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'sk-secret' }));
    expect(probeChat).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'sk-secret', model: 'gpt-4.1' }));
    expect(db.botsAiProvider.updateMany.mock.calls[0][0].data.model).toBe('gpt-4.1');
  });

  it('saves what the provider says about the new model, keeping the key’s kind and region', async () => {
    db.botsAiProvider.findFirst.mockResolvedValue({ ...openai, endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1', settings: { kind: 'qwen', region: 'china', caps: { tools: true } } });
    (probeModels as jest.Mock).mockResolvedValue({ ok: true, models: ['gpt-4o-mini', 'qwen-vl'], facts: { 'qwen-vl': { vision: true, tools: false, context: 8192 } } });
    await editSavedKey('maker', 'key-2', { model: 'qwen-vl' });
    expect(db.botsAiProvider.updateMany.mock.calls[0][0].data).toMatchObject({
      supportsVision: true,
      settings: { kind: 'qwen', region: 'china', caps: { vision: true, tools: false, context: 8192 } },
    });
  });

  it('drops the old facts when the provider says nothing about the new model', async () => {
    db.botsAiProvider.findFirst.mockResolvedValue({ ...openai, settings: { kind: 'openai', caps: { tools: false } } });
    (probeModels as jest.Mock).mockResolvedValue({ ok: true, models: ['gpt-4o-mini', 'gpt-4.1'], facts: {} });
    await editSavedKey('maker', 'key-2', { model: 'gpt-4.1' });
    const data = db.botsAiProvider.updateMany.mock.calls[0][0].data;
    expect(data.settings).toEqual({ kind: 'openai', modelFacts: {} });
    expect(data.supportsVision).toBeNull();
  });

  it('leaves the saved model’s facts alone when the list misses it, and keeps the new list’s facts', async () => {
    db.botsAiProvider.findFirst.mockResolvedValue({ ...lmStudio, settings: { kind: 'lmstudio', caps: { tools: true } } });
    (probeModels as jest.Mock).mockResolvedValue({ ok: true, models: ['other-model'], facts: {} });
    await editSavedKey('maker', 'key-1', { address: 'https://new.trycloudflare.com' });
    const data = db.botsAiProvider.updateMany.mock.calls[0][0].data;
    expect(data.settings).toEqual({ kind: 'lmstudio', caps: { tools: true }, modelFacts: {} });
    expect(data.supportsVision).toBeUndefined();
  });

  it('replaces the old address’s model facts with the new address’s', async () => {
    db.botsAiProvider.findFirst.mockResolvedValue({ ...lmStudio, settings: { kind: 'lmstudio', modelFacts: { 'old-model': { vision: true } } } });
    (probeModels as jest.Mock).mockResolvedValue({ ok: true, models: ['qwen3-8b', 'qwen3-vl-8b'], facts: { 'qwen3-vl-8b': { vision: true } } });
    await editSavedKey('maker', 'key-1', { address: 'https://new.trycloudflare.com' });
    expect(db.botsAiProvider.updateMany.mock.calls[0][0].data.settings.modelFacts).toEqual({ 'qwen3-vl-8b': { vision: true } });
  });

  it('refuses a model that is not on the list, and saves nothing', async () => {
    const result = await editSavedKey('maker', 'key-1', { model: 'made-up' });
    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(probeChat).not.toHaveBeenCalled();
    expect(db.botsAiProvider.updateMany).not.toHaveBeenCalled();
  });

  it('keeps the saved model when only the address changes, even if the list misses it (the chat reply decides)', async () => {
    (probeModels as jest.Mock).mockResolvedValue({ ok: true, models: ['other-model'], facts: {} });
    const result = await editSavedKey('maker', 'key-1', { address: 'https://new.trycloudflare.com' });
    expect(result).toMatchObject({ ok: true, model: 'qwen3-8b' });
  });

  it('moves the bots still on the old model to the new one in the same save, never a bot given another model (#575)', async () => {
    db.botsAiProvider.findFirst.mockResolvedValue(openai);
    (probeModels as jest.Mock).mockResolvedValue({ ok: true, models: ['gpt-4o-mini', 'gpt-4.1'], facts: {} });
    await editSavedKey('maker', 'key-2', { model: 'gpt-4.1' });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(db.bot.updateMany).toHaveBeenCalledTimes(1);
    expect(db.bot.updateMany).toHaveBeenCalledWith({ where: { aiProviderRef: 'key-2', aiModel: 'gpt-4o-mini' }, data: { aiModel: 'gpt-4.1' } });
  });

  it('locks the key’s row before reading its model, so two saves at the same moment run one after the other', async () => {
    db.botsAiProvider.findFirst.mockResolvedValue(openai);
    (probeModels as jest.Mock).mockResolvedValue({ ok: true, models: ['gpt-4o-mini', 'gpt-4.1'], facts: {} });
    await editSavedKey('maker', 'key-2', { model: 'gpt-4.1' });
    const lock = (prisma.$queryRaw as jest.Mock).mock;
    expect(lock.calls).toHaveLength(1);
    expect(lock.calls[0][0].join('?')).toMatch(/FROM "bots_ai_providers" WHERE "provider_id" = \? AND "owner_id" = \? FOR UPDATE$/);
    expect(lock.calls[0].slice(1)).toEqual(['key-2', 'maker']);
    // Read after the lock: the model a save that went first committed
    expect(lock.invocationCallOrder[0]).toBeLessThan(db.botsAiProvider.findFirst.mock.invocationCallOrder[1]);
  });

  it('takes no lock when no bots can move (only the address changed)', async () => {
    await editSavedKey('maker', 'key-1', { address: 'https://new.trycloudflare.com/v1' });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('brings the bots back when another tab changed the model and this one types the model the key had before', async () => {
    // Opened on gpt-4o-mini; another tab saved gpt-4.1 (key and bots) while this one was checked; this one saves gpt-4o-mini
    db.botsAiProvider.findFirst.mockResolvedValueOnce(openai).mockResolvedValueOnce({ model: 'gpt-4.1' });
    (probeModels as jest.Mock).mockResolvedValue({ ok: true, models: ['gpt-4o-mini', 'gpt-4.1'], facts: {} });
    await editSavedKey('maker', 'key-2', { model: 'gpt-4o-mini' });
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(db.bot.updateMany).toHaveBeenCalledWith({ where: { aiProviderRef: 'key-2', aiModel: 'gpt-4.1' }, data: { aiModel: 'gpt-4o-mini' } });
  });

  it('moves the bots on the model the key has now, never one it had when this edit was opened', async () => {
    // Opened on gpt-4o-mini; another tab saved gpt-4o (and moved its bots) while this one was checked. A bot put on
    // gpt-4o-mini on purpose since then stays there; the bots on gpt-4o move to gpt-4.1
    db.botsAiProvider.findFirst.mockResolvedValueOnce(openai).mockResolvedValueOnce({ model: 'gpt-4o' });
    (probeModels as jest.Mock).mockResolvedValue({ ok: true, models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1'], facts: {} });
    await editSavedKey('maker', 'key-2', { model: 'gpt-4.1' });
    expect(db.bot.updateMany).toHaveBeenCalledTimes(1);
    expect(db.bot.updateMany).toHaveBeenCalledWith({ where: { aiProviderRef: 'key-2', aiModel: 'gpt-4o' }, data: { aiModel: 'gpt-4.1' } });
  });

  it('leaves the bots of a universe whose lend does not allow the new model on the old one', async () => {
    db.botsAiProvider.findFirst.mockResolvedValue(openai);
    (probeModels as jest.Mock).mockResolvedValue({ ok: true, models: ['gpt-4o-mini', 'gpt-4.1'], facts: {} });
    db.aiKeyLend.findMany.mockResolvedValue([
      { universeId: 'u-all', models: null },
      { universeId: 'u-old-only', models: ['gpt-4o-mini'] },
      { universeId: 'u-both', models: ['gpt-4o-mini', 'gpt-4.1'] },
    ]);
    await editSavedKey('maker', 'key-2', { model: 'gpt-4.1' });
    expect(db.bot.updateMany).toHaveBeenCalledWith({
      where: { aiProviderRef: 'key-2', aiModel: 'gpt-4o-mini', NOT: { room: { world: { universeId: { in: ['u-old-only'] } } } } },
      data: { aiModel: 'gpt-4.1' },
    });
  });

  it('moves no bots when the model stays the same or the key changed while it was checked', async () => {
    await editSavedKey('maker', 'key-1', { model: 'qwen3-8b' });
    db.botsAiProvider.updateMany.mockResolvedValueOnce({ count: 0 });
    const result = await editSavedKey('maker', 'key-1', { model: 'llama-3.1-8b' });
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(db.bot.updateMany).not.toHaveBeenCalled();
  });

  it('never puts back a check model that was swapped while only the address was checked (#575)', async () => {
    db.botsAiProvider.updateMany.mockResolvedValueOnce({ count: 0 });
    const result = await editSavedKey('maker', 'key-1', { address: 'https://new.trycloudflare.com/v1' });
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(db.botsAiProvider.updateMany.mock.calls[0][0].where).toEqual({ providerId: 'key-1', ownerId: 'maker', model: 'qwen3-8b' });
    expect(markWorking).not.toHaveBeenCalled();
  });

  it('saves a model the person picked whatever the key had meanwhile', async () => {
    await editSavedKey('maker', 'key-1', { model: 'llama-3.1-8b' });
    expect(db.botsAiProvider.updateMany.mock.calls[0][0].where).toEqual({ providerId: 'key-1', ownerId: 'maker' });
  });

  it('saves nothing when the new address does not answer', async () => {
    (probeModels as jest.Mock).mockResolvedValue({ ok: false, reason: 'unreachable', message: 'It didn’t answer. Is the server running and the tunnel up?' });
    const result = await editSavedKey('maker', 'key-1', { address: 'https://dead.trycloudflare.com' });
    expect(result).toEqual({ ok: false, status: 400, message: 'It didn’t answer. Is the server running and the tunnel up?' });
    expect(db.botsAiProvider.updateMany).not.toHaveBeenCalled();
  });

  it('saves nothing when the model lists but a chat reply fails', async () => {
    (probeChat as jest.Mock).mockResolvedValue({ ok: false, reason: 'gone', message: 'My LM Studio no longer has the model qwen3-8b.' });
    const result = await editSavedKey('maker', 'key-1', { address: 'https://new.trycloudflare.com' });
    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(db.botsAiProvider.updateMany).not.toHaveBeenCalled();
  });

  it('tells the person to pick a model when the new address does not have the saved one', async () => {
    (probeChat as jest.Mock).mockResolvedValue({ ok: false, reason: 'gone', message: 'My LM Studio no longer has the model qwen3-8b.' });
    expect(await editSavedKey('maker', 'key-1', { address: 'https://new.trycloudflare.com' })).toEqual({
      ok: false, status: 400, code: 'model-missing', message: 'That address doesn’t have qwen3-8b. Pick a model it has.',
    });
    // Another kind of failure on a listed model is not a missing model
    (probeChat as jest.Mock).mockResolvedValue({ ok: false, reason: 'unreachable', message: 'It didn’t answer.' });
    expect(await editSavedKey('maker', 'key-1', { address: 'https://new.trycloudflare.com' })).toEqual({ ok: false, status: 400, message: 'It didn’t answer.' });
    // A model that is not listed and gets a non-answer is a missing model too
    (probeModels as jest.Mock).mockResolvedValue({ ok: true, models: ['other-model'] });
    for (const reason of ['other', 'request']) {
      (probeChat as jest.Mock).mockResolvedValue({ ok: false, reason, message: 'It answered with an error (400).' });
      expect(await editSavedKey('maker', 'key-1', { address: 'https://new.trycloudflare.com' })).toMatchObject({ ok: false, code: 'model-missing' });
    }
    expect(db.botsAiProvider.updateMany).not.toHaveBeenCalled();
  });

  it('saves when the model is listed and the provider only refused the tiny reply with a 400', async () => {
    (probeChat as jest.Mock).mockResolvedValue({ ok: false, reason: 'request', message: 'a chat call failed (400).' });
    const result = await editSavedKey('maker', 'key-1', { address: 'https://new.trycloudflare.com' });
    expect(result).toMatchObject({ ok: true, model: 'qwen3-8b' });
    expect(db.botsAiProvider.updateMany).toHaveBeenCalledTimes(1);
  });

  it('saves the new address and a model picked on it in one step', async () => {
    (probeModels as jest.Mock).mockResolvedValue({ ok: true, models: ['llama-3.1-8b'], facts: {} });
    const result = await editSavedKey('maker', 'key-1', { address: 'https://new.trycloudflare.com', model: 'llama-3.1-8b' });
    expect(result).toEqual({ ok: true, model: 'llama-3.1-8b', endpoint: 'https://new.trycloudflare.com' });
    expect(db.botsAiProvider.updateMany.mock.calls[0][0].data).toMatchObject({ endpoint: 'https://new.trycloudflare.com', model: 'llama-3.1-8b' });
  });

  it('answers the route with the code so the page can offer the models', async () => {
    (probeChat as jest.Mock).mockResolvedValue({ ok: false, reason: 'gone', message: 'x' });
    const response = await patch('key-1', { address: 'https://new.trycloudflare.com' });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'That address doesn’t have qwen3-8b. Pick a model it has.', code: 'model-missing' });
  });

  it('turns a Down key Working once the new address answers', async () => {
    db.botsAiProvider.findFirst.mockResolvedValue({ ...lmStudio, downSince: new Date('2026-10-19T12:00:00Z') });
    await editSavedKey('maker', 'key-1', { address: 'https://new.trycloudflare.com' });
    expect(markWorking).toHaveBeenCalledWith({ providerId: 'key-1', ownerId: 'maker' });
  });

  it('does not touch Working state of a key that was already Working', async () => {
    await editSavedKey('maker', 'key-1', { address: 'https://new.trycloudflare.com' });
    expect(markWorking).not.toHaveBeenCalled();
  });

  it('refuses a typed address for a hosted kind with a fixed address', async () => {
    db.botsAiProvider.findFirst.mockResolvedValue({ ...openai, settings: { kind: 'deepseek' } });
    const result = await editSavedKey('maker', 'key-2', { address: 'https://evil.example.com' });
    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(probeModels).not.toHaveBeenCalled();
  });

  it('never sends a hosted key to a typed address, NVIDIA NIM included', async () => {
    db.botsAiProvider.findFirst.mockResolvedValue({ ...openai, settings: { kind: 'nim' }, endpoint: 'https://integrate.api.nvidia.com/v1' });
    const edited = await editSavedKey('maker', 'key-2', { address: 'https://attacker.example.com' });
    expect(edited).toMatchObject({ ok: false, status: 400 });
    const listed = await listModelsForSavedKey('maker', 'key-2', { address: 'https://attacker.example.com' });
    expect(listed).toMatchObject({ ok: false, status: 400 });
    expect(probeModels).not.toHaveBeenCalled();
    expect(probeChat).not.toHaveBeenCalled();
  });

  it('still changes the model of a NIM key, at its own address', async () => {
    db.botsAiProvider.findFirst.mockResolvedValue({ ...openai, settings: { kind: 'nim' }, endpoint: 'https://integrate.api.nvidia.com/v1' });
    (probeModels as jest.Mock).mockResolvedValue({ ok: true, models: ['gpt-4o-mini', 'llama-3.3'], facts: {} });
    expect(await editSavedKey('maker', 'key-2', { model: 'llama-3.3' })).toMatchObject({ ok: true, model: 'llama-3.3' });
  });

  it('finds only keys the caller owns, so a server provider or another person’s key is "not found"', async () => {
    db.botsAiProvider.findFirst.mockResolvedValue(null);
    const result = await editSavedKey('maker', 'deepseek-flash', { model: 'x' });
    expect(result).toEqual({ ok: false, status: 404, message: 'Key not found' });
    expect(db.botsAiProvider.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { providerId: 'deepseek-flash', ownerId: 'maker' } }));
  });

  it('asks for a change when there is none', async () => {
    const result = await editSavedKey('maker', 'key-1', {});
    expect(result).toMatchObject({ ok: false, status: 400 });
  });
});

describe('PATCH /api/me/ai-keys/:id', () => {
  it('still sets "If this is down" and nothing else', async () => {
    const res = await patch('key-1', { ifDown: 'stop' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'saved', ifDown: 'stop' });
    expect(db.botsAiProvider.updateMany).toHaveBeenCalledWith({ where: { providerId: 'key-1', ownerId: 'maker' }, data: { ifDown: 'stop' } });
    expect(probeModels).not.toHaveBeenCalled();
  });

  it('rejects a body with nothing to change', async () => {
    expect((await patch('key-1', {})).status).toBe(400);
    expect((await patch('key-1', { ifDown: 'bad' })).status).toBe(400);
  });

  it('changes the address after the checks pass', async () => {
    const res = await patch('key-1', { address: 'https://new.trycloudflare.com' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'saved' });
  });

  it('answers 400 with the plain reason when the new address fails', async () => {
    (probeModels as jest.Mock).mockResolvedValue({ ok: false, reason: 'rejected', message: 'The server asked for a key, or didn’t accept the one you gave.' });
    const res = await patch('key-1', { address: 'https://new.trycloudflare.com' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/asked for a key/);
  });

  it('answers 404 for a key that is not theirs', async () => {
    db.botsAiProvider.findFirst.mockResolvedValue(null);
    expect((await patch('nope', { model: 'x' })).status).toBe(404);
  });

  it('is rate limited like the other routes that call out to typed addresses', async () => {
    (allowKeyAttempt as jest.Mock).mockReturnValue(false);
    expect((await patch('key-1', { address: 'https://new.trycloudflare.com' })).status).toBe(429);
    expect(probeModels).not.toHaveBeenCalled();
  });

  it('needs a signed-in person', async () => {
    (getSessionUser as jest.Mock).mockResolvedValue(null);
    expect((await patch('key-1', { model: 'x' })).status).toBe(401);
  });
});

describe('POST /api/me/ai-keys/:id/models', () => {
  it('lists models with the saved key, never returning the key', async () => {
    db.botsAiProvider.findFirst.mockResolvedValue(openai);
    (probeModels as jest.Mock).mockResolvedValue({ ok: true, models: ['gpt-4.1'], facts: { 'gpt-4.1': { tools: true } } });
    const res = await models('key-2', {});
    const body = await res.json();
    expect(body).toEqual({ ok: true, models: ['gpt-4.1'], facts: { 'gpt-4.1': { tools: true } } });
    expect(JSON.stringify(body)).not.toContain('sk-secret');
    expect(probeModels).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'sk-secret', address: 'https://api.openai.com/v1' }));
  });

  it('tries a new address when one is given', async () => {
    await models('key-1', { address: 'https://new.trycloudflare.com' });
    expect(probeModels).toHaveBeenCalledWith(expect.objectContaining({ address: 'https://new.trycloudflare.com' }));
  });

  it('says why when the provider does not answer', async () => {
    (probeModels as jest.Mock).mockResolvedValue({ ok: false, reason: 'unreachable', message: 'It didn’t answer.' });
    expect(await (await models('key-1', {})).json()).toEqual({ ok: false, message: 'It didn’t answer.' });
  });

  it('answers 404 for a key that is not theirs, and 401 signed out', async () => {
    db.botsAiProvider.findFirst.mockResolvedValue(null);
    expect((await models('nope', {})).status).toBe(404);
    (getSessionUser as jest.Mock).mockResolvedValue(null);
    expect((await models('key-1', {})).status).toBe(401);
  });
});
