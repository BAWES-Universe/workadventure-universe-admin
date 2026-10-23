import { NextRequest } from 'next/server';
import { POST } from '@/app/api/me/ai-keys/route';
import { POST as loadModelsRoute } from '@/app/api/me/ai-keys/models/route';
import { getSessionUser } from '@/lib/auth-session';
import { prisma } from '@/lib/db';
import { loadModels, probeChat } from '@/lib/ai-key-models';

jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn() }));
jest.mock('@/lib/db', () => ({ prisma: { botsAiProvider: { count: jest.fn(), create: jest.fn(), findMany: jest.fn() }, botsAiUsage: { groupBy: jest.fn() } } }));
jest.mock('@/lib/encryption', () => ({ encryptApiKey: jest.fn((key: string) => `enc(${key})`) }));
jest.mock('@/lib/ai-key-models', () => ({ ...jest.requireActual('@/lib/ai-key-models'), loadModels: jest.fn(), probeChat: jest.fn(), allowKeyAttempt: jest.fn(() => true) }));

const provider = prisma.botsAiProvider as unknown as Record<'count' | 'create', jest.Mock>;
const models = loadModels as jest.Mock;
const chat = probeChat as jest.Mock;
const alice = { id: 'user-a', uuid: 'uuid-a', email: 'a@example.com', name: 'A', tags: [], isSuperAdmin: false };

const post = (body: unknown, route: typeof POST = POST) =>
  route(new NextRequest('http://localhost:3333/api/me/ai-keys', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) }));

beforeEach(() => {
  jest.clearAllMocks();
  (getSessionUser as jest.Mock).mockResolvedValue(alice);
  provider.count.mockResolvedValue(0);
  provider.create.mockResolvedValue({ providerId: 'key-new' });
  models.mockResolvedValue({ ok: true, models: ['qwen3-8b', 'gemma-3-12b'], facts: {} });
  chat.mockResolvedValue({ ok: true });
});

describe('POST /api/me/ai-keys', () => {
  it('needs a signed-in user', async () => {
    (getSessionUser as jest.Mock).mockResolvedValue(null);
    expect((await post({})).status).toBe(401);
  });

  it('saves an own-computer key as the local type, on the typed origin, with no key', async () => {
    const response = await post({ kind: 'lmstudio', address: 'https://lm.example.com/v1', model: 'qwen3-8b', name: '  Home PC ' });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ id: 'key-new' });
    const data = provider.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      type: 'lmstudio', endpoint: 'https://lm.example.com', name: 'Home PC', model: 'qwen3-8b', ownerId: 'user-a', enabled: true,
      apiKeyEncrypted: null, apiKeyLast4: null, settings: { kind: 'lmstudio' }, tested: true,
    });
    expect(data.providerId).toMatch(/^key-[0-9a-f-]{36}$/);
  });

  it('saves a hosted key as the openai type on the provider’s own base, encrypted, remembering only the last four', async () => {
    const response = await post({ kind: 'deepseek', address: 'https://evil.example.com', apiKey: 'sk-abcdef4f2a', model: 'qwen3-8b' });
    expect(response.status).toBe(201);
    const data = provider.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ type: 'openai', endpoint: 'https://api.deepseek.com', apiKeyEncrypted: 'enc(sk-abcdef4f2a)', apiKeyLast4: '4f2a', name: 'My DeepSeek' });
    // The answer never carries the key.
    expect(JSON.stringify(await response.json())).not.toContain('sk-abcdef');
  });

  it('keeps no plain-text last four for a short key, which would be most of it', async () => {
    const response = await post({ kind: 'lmstudio', address: 'https://lm.example.com', apiKey: 'abc12', model: 'qwen3-8b' });
    expect(response.status).toBe(201);
    const data = provider.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ apiKeyEncrypted: 'enc(abc12)', apiKeyLast4: null });
  });

  it('refuses a key with a smart quote, a zero-width space or a space as a plain 400, saving nothing', async () => {
    for (const apiKey of ['sk-abc\u201Cdef', 'sk-\u200Babc', 'sk-a b', 'sk-é']) {
      const response = await post({ kind: 'deepseek', apiKey, model: 'm' });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'That key doesn’t look right. Paste it again.' });
    }
    expect(provider.create).not.toHaveBeenCalled();
  });

  it('asks the provider before saving: a key that does not answer is never saved', async () => {
    models.mockResolvedValue({ ok: false, message: 'DeepSeek didn’t accept this key.' });
    const response = await post({ kind: 'deepseek', apiKey: 'sk-bad', model: 'm' });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'DeepSeek didn’t accept this key.' });
    expect(provider.create).not.toHaveBeenCalled();
  });

  it('refuses a model the provider did not list', async () => {
    const response = await post({ kind: 'lmstudio', address: 'https://lm.example.com', model: 'made-up' });
    expect(response.status).toBe(400);
    expect(provider.create).not.toHaveBeenCalled();
  });

  it.each([
    ['no type', { model: 'm' }],
    ['no address on an own-computer type', { kind: 'lmstudio', model: 'qwen3-8b' }],
    ['a name that is too long', { kind: 'lmstudio', address: 'https://lm.example.com', model: 'qwen3-8b', name: 'x'.repeat(61) }],
    ['a key with a space in it', { kind: 'openai', apiKey: 'sk- abc', model: 'qwen3-8b' }],
  ])('refuses %s', async (_what, body) => {
    expect((await post(body)).status).toBe(400);
    expect(provider.create).not.toHaveBeenCalled();
  });

  it('stops at ten keys', async () => {
    provider.count.mockResolvedValue(10);
    const response = await post({ kind: 'lmstudio', address: 'https://lm.example.com', model: 'qwen3-8b' });
    expect(response.status).toBe(400);
    expect(provider.create).not.toHaveBeenCalled();
  });

  it('says so when the server cannot encrypt', async () => {
    const { encryptApiKey } = jest.requireMock('@/lib/encryption') as { encryptApiKey: jest.Mock };
    encryptApiKey.mockImplementationOnce(() => { throw new Error('ENCRYPTION_KEY environment variable is not set'); });
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const response = await post({ kind: 'deepseek', apiKey: 'sk-abcdef', model: 'qwen3-8b' });
    expect(response.status).toBe(500);
    expect((await response.json()).error).toMatch(/can’t be saved/);
    spy.mockRestore();
  });
});

describe('POST /api/me/ai-keys/models', () => {
  it('needs a signed-in user', async () => {
    (getSessionUser as jest.Mock).mockResolvedValue(null);
    expect((await post({}, loadModelsRoute)).status).toBe(401);
  });

  it('passes what was typed through and answers with the list, or a plain reason', async () => {
    models.mockResolvedValue({ ok: false, message: 'That address points to a private network, so Universe can’t reach it.' });
    const response = await post({ kind: 'lmstudio', address: 'https://nas.example.com' }, loadModelsRoute);
    expect(models).toHaveBeenCalledWith({ kind: 'lmstudio', address: 'https://nas.example.com' });
    expect(await response.json()).toEqual({ ok: false, message: 'That address points to a private network, so Universe can’t reach it.' });
  });

  it('refuses a body that is not an object', async () => {
    expect((await post('[1]', loadModelsRoute)).status).toBe(400);
    expect((await post('nope', loadModelsRoute)).status).toBe(400);
  });
});

describe('POST /api/me/ai-keys with no model picked (#575)', () => {
  it('keeps the provider’s suggested model as the check model when it lists it, with what it says about it', async () => {
    models.mockResolvedValue({ ok: true, models: ['deepseek-chat', 'deepseek-v4-flash', 'deepseek-v4-pro'], facts: { 'deepseek-v4-flash': { vision: false, tools: true } } });
    const response = await post({ kind: 'deepseek', apiKey: 'sk-abcdef4f2a' });
    expect(response.status).toBe(201);
    expect(chat).toHaveBeenCalledTimes(1);
    expect(chat).toHaveBeenCalledWith(expect.objectContaining({ model: 'deepseek-v4-flash' }));
    expect(provider.create.mock.calls[0][0].data).toMatchObject({ model: 'deepseek-v4-flash', supportsVision: false, settings: { kind: 'deepseek', caps: { vision: false, tools: true } } });
    // How many models it has, for the key card
    expect(provider.create.mock.calls[0][0].data.settings.modelCount).toBe(3);
  });

  it('keeps the first listed model that answers when the provider suggests none', async () => {
    models.mockResolvedValue({ ok: true, models: ['a-gone', 'b-works', 'c'], facts: {} });
    chat.mockResolvedValueOnce({ ok: false, reason: 'gone', message: 'That model isn’t there.' }).mockResolvedValueOnce({ ok: true });
    const response = await post({ kind: 'lmstudio', address: 'https://lm.example.com' });
    expect(response.status).toBe(201);
    expect(chat.mock.calls.map((call) => call[0].model)).toEqual(['a-gone', 'b-works']);
    expect(provider.create.mock.calls[0][0].data.model).toBe('b-works');
  });

  it('stops at once when the key itself is refused, and says why, saving nothing', async () => {
    models.mockResolvedValue({ ok: true, models: ['a', 'b', 'c'], facts: {} });
    chat.mockResolvedValue({ ok: false, reason: 'rejected', message: 'DeepSeek didn’t accept this key.' });
    const response = await post({ kind: 'deepseek', apiKey: 'sk-bad' });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'DeepSeek didn’t accept this key.' });
    expect(chat).toHaveBeenCalledTimes(1);
    expect(provider.create).not.toHaveBeenCalled();
  });

  it('tries only a few models, then says why the last one failed', async () => {
    models.mockResolvedValue({ ok: true, models: ['a', 'b', 'c', 'd', 'e', 'f'], facts: {} });
    chat.mockResolvedValue({ ok: false, reason: 'gone', message: 'That model isn’t there.' });
    const response = await post({ kind: 'lmstudio', address: 'https://lm.example.com' });
    expect(response.status).toBe(400);
    expect(chat).toHaveBeenCalledTimes(4);
    expect(provider.create).not.toHaveBeenCalled();
  });

  it('prefers a model that really replies over one that only refused the tiny request, and keeps that one when none replies', async () => {
    models.mockResolvedValue({ ok: true, models: ['a-embed', 'b-chat', 'c'], facts: {} });
    chat.mockResolvedValueOnce({ ok: false, reason: 'request', message: 'a chat call to a-embed failed (400).' }).mockResolvedValueOnce({ ok: true });
    expect((await post({ kind: 'lmstudio', address: 'https://lm.example.com' })).status).toBe(201);
    expect(provider.create.mock.calls[0][0].data.model).toBe('b-chat');

    chat.mockReset();
    provider.create.mockClear();
    chat.mockResolvedValue({ ok: false, reason: 'request', message: 'a chat call failed (400).' });
    expect((await post({ kind: 'lmstudio', address: 'https://lm.example.com' })).status).toBe(201);
    expect(chat).toHaveBeenCalledTimes(3);
    expect(provider.create.mock.calls[0][0].data.model).toBe('a-embed');
  });

  it('tries models the provider says call tools first, ahead of a name-sorted list’s first ones', async () => {
    models.mockResolvedValue({ ok: true, models: ['aa-1', 'ab-2', 'ac-3', 'ad-4', 'zz-chat'], facts: { 'zz-chat': { tools: true } } });
    expect((await post({ kind: 'lmstudio', address: 'https://lm.example.com' })).status).toBe(201);
    expect(chat.mock.calls[0][0].model).toBe('zz-chat');
    expect(provider.create.mock.calls[0][0].data.model).toBe('zz-chat');
  });

  it('saves nothing when the key is refused after a model only refused the tiny request', async () => {
    models.mockResolvedValue({ ok: true, models: ['a', 'b', 'c'], facts: {} });
    chat
      .mockResolvedValueOnce({ ok: false, reason: 'request', message: 'a chat call to a failed (400).' })
      .mockResolvedValueOnce({ ok: false, reason: 'rejected', message: 'DeepSeek didn’t accept this key.' });
    const response = await post({ kind: 'deepseek', apiKey: 'sk-abcdef4f2a' });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'DeepSeek didn’t accept this key.' });
    expect(provider.create).not.toHaveBeenCalled();
  });

  it('moves past a model the key may not use (403) or has no quota for (429), but stops at a key refused outright (401)', async () => {
    models.mockResolvedValue({ ok: true, models: ['o3', 'gemini-pro', 'gpt-5-mini'], facts: {} });
    chat
      .mockResolvedValueOnce({ ok: false, reason: 'rejected', status: 403, message: 'OpenAI didn’t accept this key.' })
      .mockResolvedValueOnce({ ok: false, reason: 'busy', status: 429, message: 'OpenAI is busy right now. Try again in a moment.' })
      .mockResolvedValueOnce({ ok: true });
    expect((await post({ kind: 'deepseek', apiKey: 'sk-abcdef4f2a' })).status).toBe(201);
    expect(provider.create.mock.calls[0][0].data.model).toBe('gpt-5-mini');

    chat.mockReset();
    provider.create.mockClear();
    chat.mockResolvedValueOnce({ ok: false, reason: 'rejected', status: 401, message: 'DeepSeek didn’t accept this key.' });
    const response = await post({ kind: 'deepseek', apiKey: 'sk-abcdef4f2a' });
    expect(response.status).toBe(400);
    expect(chat).toHaveBeenCalledTimes(1);
    expect(provider.create).not.toHaveBeenCalled();
  });

  it('saves nothing, and says try again, when the other models were busy after one refused just the tiny request', async () => {
    models.mockResolvedValue({ ok: true, models: ['a', 'b'], facts: {} });
    chat
      .mockResolvedValueOnce({ ok: false, reason: 'request', message: 'a chat call to a failed (400).' })
      .mockResolvedValueOnce({ ok: false, reason: 'busy', status: 429, message: 'DeepSeek is busy right now. Try again in a moment.' })
      .mockResolvedValueOnce({ ok: false, reason: 'gone', message: 'DeepSeek no longer has the model c.' });
    models.mockResolvedValue({ ok: true, models: ['a', 'b', 'c'], facts: {} });
    const response = await post({ kind: 'deepseek', apiKey: 'sk-abcdef4f2a' });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'DeepSeek is busy right now. Try again in a moment.' });
    expect(provider.create).not.toHaveBeenCalled();
  });

  it('saves nothing, and says out of credit, when the only other model refused just the tiny request', async () => {
    models.mockResolvedValue({ ok: true, models: ['a', 'b'], facts: {} });
    chat
      .mockResolvedValueOnce({ ok: false, reason: 'request', message: 'a chat call to a failed (400).' })
      .mockResolvedValueOnce({ ok: false, reason: 'credit', message: 'OpenRouter says this key is out of credit.' });
    const response = await post({ kind: 'deepseek', apiKey: 'sk-abcdef4f2a' });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'OpenRouter says this key is out of credit.' });
    expect(provider.create).not.toHaveBeenCalled();
  });

  it('moves past a model with no credit to a free one the list has, and keeps that', async () => {
    models.mockResolvedValue({ ok: true, models: ['a', 'b', 'c', 'd', 'e', 'f-free:free'], facts: {} });
    chat
      .mockResolvedValueOnce({ ok: false, reason: 'credit', status: 402, message: 'OpenRouter says this key is out of credit.' })
      .mockResolvedValueOnce({ ok: false, reason: 'credit', status: 402, message: 'OpenRouter says this key is out of credit.' })
      .mockResolvedValueOnce({ ok: false, reason: 'credit', status: 402, message: 'OpenRouter says this key is out of credit.' })
      .mockResolvedValueOnce({ ok: false, reason: 'credit', status: 402, message: 'OpenRouter says this key is out of credit.' })
      .mockResolvedValueOnce({ ok: true });
    const response = await post({ kind: 'openrouter', apiKey: 'sk-or-v1-abcdef1234' });
    expect(response.status).toBe(201);
    expect(chat.mock.calls.map((call) => call[0].model)).toEqual(['a', 'b', 'c', 'd', 'f-free:free']);
    expect(provider.create.mock.calls[0][0].data.model).toBe('f-free:free');
  });

  it('says the key is out of credit, not a later model’s words, when nothing answers', async () => {
    models.mockResolvedValue({ ok: true, models: ['a', 'b'], facts: {} });
    chat
      .mockResolvedValueOnce({ ok: false, reason: 'credit', status: 402, message: 'OpenRouter says this key is out of credit.' })
      .mockResolvedValueOnce({ ok: false, reason: 'gone', message: 'That model isn’t there.' });
    const response = await post({ kind: 'openrouter', apiKey: 'sk-or-v1-abcdef1234' });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'OpenRouter says this key is out of credit.' });
  });

  it('moves past a model whose server errors, but stops when nobody answers at all', async () => {
    models.mockResolvedValue({ ok: true, models: ['a-broken', 'b-works', 'c'], facts: {} });
    chat.mockResolvedValueOnce({ ok: false, reason: 'unreachable', status: 500, message: 'A chat call to a-broken failed (500).' }).mockResolvedValueOnce({ ok: true });
    const moved = await post({ kind: 'lmstudio', address: 'https://lm.example.com' });
    expect(moved.status).toBe(201);
    expect(provider.create.mock.calls[0][0].data.model).toBe('b-works');

    chat.mockReset();
    chat.mockResolvedValue({ ok: false, reason: 'unreachable', message: 'LM Studio didn’t answer. Try again in a moment.' });
    const silent = await post({ kind: 'lmstudio', address: 'https://lm.example.com' });
    expect(silent.status).toBe(400);
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it('refuses a provider that lists no models, and a provider with no list unless the model is typed', async () => {
    models.mockResolvedValue({ ok: true, models: [], facts: {} });
    expect((await post({ kind: 'lmstudio', address: 'https://lm.example.com' })).status).toBe(400);
    models.mockResolvedValue({ ok: false, noList: true, message: 'Groq doesn’t share a list of its models.' });
    const response = await post({ kind: 'groq', apiKey: 'gsk-1234' });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe('Groq doesn’t share a list of its models. Type the model name.');
    expect(chat).not.toHaveBeenCalled();
    expect(provider.create).not.toHaveBeenCalled();
  });
});

describe('POST /api/me/ai-keys: the key must really answer, and regions', () => {
  it('asks the model for one tiny reply before saving, with the key and address that were typed', async () => {
    const response = await post({ kind: 'lmstudio', address: 'https://lm.example.com', apiKey: 'sk-1', model: 'qwen3-8b' });
    expect(response.status).toBe(201);
    expect(chat).toHaveBeenCalledWith(expect.objectContaining({ kind: 'lmstudio', address: 'https://lm.example.com', apiKey: 'sk-1', model: 'qwen3-8b' }));
  });

  it('saves nothing when the model lists but does not answer a chat call (a provider that lists models to anyone)', async () => {
    chat.mockResolvedValue({ ok: false, reason: 'rejected', message: 'Vercel AI Gateway didn’t accept this key.' });
    const response = await post({ kind: 'vercel', apiKey: 'sk-bad', model: 'qwen3-8b' });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Vercel AI Gateway didn’t accept this key.' });
    expect(provider.create).not.toHaveBeenCalled();
  });

  it('saves a listed model whose tiny reply the provider refused with a 400 (the request, not the key or the model)', async () => {
    chat.mockResolvedValue({ ok: false, reason: 'request', message: 'lists its models, but a chat call failed (400).' });
    const response = await post({ kind: 'lmstudio', address: 'https://lm.example.com', apiKey: 'sk-1', model: 'qwen3-8b' });
    expect(response.status).toBe(201);
    expect(provider.create).toHaveBeenCalledTimes(1);
  });

  it('saves a region kind on the base of the region picked, and remembers which', async () => {
    const response = await post({ kind: 'qwen', region: 'china', apiKey: 'sk-abcd1234', model: 'qwen3-8b' });
    expect(response.status).toBe(201);
    const data = provider.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ type: 'openai', endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1', settings: { kind: 'qwen', region: 'china' }, name: 'My Qwen' });
    expect(chat).toHaveBeenCalledWith(expect.objectContaining({ region: 'china' }));
  });

  it('asks for a region rather than guessing one', async () => {
    const response = await post({ kind: 'kimi', apiKey: 'sk-1', model: 'm' });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Pick a region first.' });
    expect(provider.create).not.toHaveBeenCalled();
  });

  it('ignores a typed address for a hosted kind, and does not keep a region for a kind without them', async () => {
    await post({ kind: 'groq', address: 'https://evil.example.com', region: 'china', apiKey: 'sk-1', model: 'qwen3-8b' });
    expect(provider.create.mock.calls[0][0].data).toMatchObject({ endpoint: 'https://api.groq.com/openai/v1', settings: { kind: 'groq' } });
    expect(provider.create.mock.calls[0][0].data.settings.region).toBeUndefined();
  });

  it('saves Any OpenAI-compatible as the local type with no key needed', async () => {
    const response = await post({ kind: 'custom', address: 'https://llm.example.com/v1', model: 'qwen3-8b' });
    expect(response.status).toBe(201);
    expect(provider.create.mock.calls[0][0].data).toMatchObject({ type: 'lmstudio', endpoint: 'https://llm.example.com', apiKeyEncrypted: null, settings: { kind: 'custom' } });
  });
});

describe('POST /api/me/ai-keys: what the provider said about the model is saved on the key', () => {
  it('saves the facts of the model picked, and the provider’s word on images', async () => {
    models.mockResolvedValue({ ok: true, models: ['qwen3-8b', 'gemma-3-12b'], facts: { 'qwen3-8b': { tools: false, vision: true, context: 32768 }, 'gemma-3-12b': { tools: true } } });
    await post({ kind: 'lmstudio', address: 'https://lm.example.com', model: 'qwen3-8b' });
    expect(provider.create.mock.calls[0][0].data).toMatchObject({ supportsVision: true, settings: { kind: 'lmstudio', caps: { tools: false, vision: true, context: 32768 } } });
  });

  it('says false on images when the provider said the model takes none, and null when it said nothing', async () => {
    models.mockResolvedValue({ ok: true, models: ['qwen3-8b', 'gemma-3-12b'], facts: { 'qwen3-8b': { vision: false } } });
    await post({ kind: 'lmstudio', address: 'https://lm.example.com', model: 'qwen3-8b' });
    expect(provider.create.mock.calls[0][0].data.supportsVision).toBe(false);
    await post({ kind: 'lmstudio', address: 'https://lm.example.com', model: 'gemma-3-12b' });
    expect(provider.create.mock.calls[1][0].data).toMatchObject({ supportsVision: null });
    expect(provider.create.mock.calls[1][0].data.settings.caps).toBeUndefined();
  });

  it('takes the facts from the provider’s list, never from the request', async () => {
    await post({ kind: 'lmstudio', address: 'https://lm.example.com', model: 'qwen3-8b', caps: { tools: true }, facts: { 'qwen3-8b': { tools: true } } });
    expect(provider.create.mock.calls[0][0].data.settings.caps).toBeUndefined();
  });
});

describe('POST /api/me/ai-keys: Claude (#975)', () => {
  it('saves a Claude key as the anthropic type on Anthropic’s own base, encrypted, with what the list said about the model', async () => {
    models.mockResolvedValue({ ok: true, models: ['claude-haiku-4-5'], facts: { 'claude-haiku-4-5': { vision: true, context: 200000 } } });
    const response = await post({ kind: 'claude', address: 'https://evil.example.com', apiKey: 'sk-ant-api03-abcd', model: 'claude-haiku-4-5' });
    expect(response.status).toBe(201);
    const data = provider.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      type: 'anthropic', endpoint: 'https://api.anthropic.com/v1', apiKeyEncrypted: 'enc(sk-ant-api03-abcd)', apiKeyLast4: 'abcd', name: 'My Claude',
      model: 'claude-haiku-4-5', supportsVision: true, settings: { kind: 'claude', caps: { vision: true, context: 200000 } }, tested: true,
    });
    expect(chat).toHaveBeenCalledWith(expect.objectContaining({ kind: 'claude', apiKey: 'sk-ant-api03-abcd', model: 'claude-haiku-4-5' }));
    expect(JSON.stringify(await response.json())).not.toContain('sk-ant');
  });

  it('saves nothing when the model lists but Claude does not answer a chat call (a key with no credit)', async () => {
    models.mockResolvedValue({ ok: true, models: ['claude-haiku-4-5'], facts: {} });
    chat.mockResolvedValue({ ok: false, reason: 'credit', message: 'Claude says this key is out of credit.' });
    const response = await post({ kind: 'claude', apiKey: 'sk-ant-api03-abcd', model: 'claude-haiku-4-5' });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Claude says this key is out of credit.' });
    expect(provider.create).not.toHaveBeenCalled();
  });

  describe('a provider with no model list (#456)', () => {
    beforeEach(() => models.mockResolvedValue({ ok: false, noList: true, message: 'Groq doesn’t share a list of its models. Type the model name.' }));

    it('saves the typed model once one tiny reply proves the key and the model, with no model facts', async () => {
      const response = await post({ kind: 'groq', apiKey: 'gsk-abcdef4f2a', model: 'llama-3.3-70b' });
      expect(response.status).toBe(201);
      expect(chat).toHaveBeenCalledWith(expect.objectContaining({ kind: 'groq', model: 'llama-3.3-70b' }));
      expect(provider.create.mock.calls[0][0].data).toMatchObject({ model: 'llama-3.3-70b', supportsVision: null, settings: { kind: 'groq' }, tested: true });
    });

    it('saves nothing when the reply fails, even a 400 that a listed model would be forgiven', async () => {
      chat.mockResolvedValue({ ok: false, reason: 'request', message: 'Groq lists its models, but a chat call to nope failed (400). Check the model.' });
      expect((await post({ kind: 'groq', apiKey: 'gsk-abcdef4f2a', model: 'nope' })).status).toBe(400);
      chat.mockResolvedValue({ ok: false, reason: 'rejected', message: 'Groq didn’t accept this key.' });
      expect((await post({ kind: 'groq', apiKey: 'gsk-abcdef4f2a', model: 'llama-3.3-70b' })).status).toBe(400);
      expect(provider.create).not.toHaveBeenCalled();
    });

    it('still refuses a listed provider’s model that is not on its list', async () => {
      models.mockResolvedValue({ ok: true, models: ['a'], facts: {} });
      expect((await post({ kind: 'groq', apiKey: 'gsk-abcdef4f2a', model: 'b' })).status).toBe(400);
    });

    it('still stops on any other failed list (a wrong key, a busy provider)', async () => {
      models.mockResolvedValue({ ok: false, message: 'Groq didn’t accept this key.' });
      expect((await post({ kind: 'groq', apiKey: 'gsk-abcdef4f2a', model: 'llama-3.3-70b' })).status).toBe(400);
      expect(chat).not.toHaveBeenCalled();
    });
  });
});
