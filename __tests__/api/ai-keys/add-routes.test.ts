import { NextRequest } from 'next/server';
import { POST } from '@/app/api/me/ai-keys/route';
import { POST as loadModelsRoute } from '@/app/api/me/ai-keys/models/route';
import { getSessionUser } from '@/lib/auth-session';
import { prisma } from '@/lib/db';
import { loadModels } from '@/lib/ai-key-models';

jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn() }));
jest.mock('@/lib/db', () => ({ prisma: { botsAiProvider: { count: jest.fn(), create: jest.fn(), findMany: jest.fn() }, botsAiUsage: { groupBy: jest.fn() } } }));
jest.mock('@/lib/encryption', () => ({ encryptApiKey: jest.fn((key: string) => `enc(${key})`) }));
jest.mock('@/lib/ai-key-models', () => ({ ...jest.requireActual('@/lib/ai-key-models'), loadModels: jest.fn(), allowKeyAttempt: jest.fn(() => true) }));

const provider = prisma.botsAiProvider as unknown as Record<'count' | 'create', jest.Mock>;
const models = loadModels as jest.Mock;
const alice = { id: 'user-a', uuid: 'uuid-a', email: 'a@example.com', name: 'A', tags: [], isSuperAdmin: false };

const post = (body: unknown, route: typeof POST = POST) =>
  route(new NextRequest('http://localhost:3333/api/me/ai-keys', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) }));

beforeEach(() => {
  jest.clearAllMocks();
  (getSessionUser as jest.Mock).mockResolvedValue(alice);
  provider.count.mockResolvedValue(0);
  provider.create.mockResolvedValue({ providerId: 'key-new' });
  models.mockResolvedValue({ ok: true, models: ['qwen3-8b', 'gemma-3-12b'] });
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
    ['no model', { kind: 'lmstudio', address: 'https://lm.example.com' }],
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
