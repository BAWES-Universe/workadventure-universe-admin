import { NextRequest } from 'next/server';

jest.mock('@/lib/db', () => ({
  prisma: { botsAiProvider: { findUnique: jest.fn(), update: jest.fn() } },
}));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn() }));
jest.mock('@/lib/super-admin', () => ({ isSuperAdmin: jest.fn() }));
jest.mock('@/lib/encryption', () => ({ decryptApiKey: jest.fn() }));

import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { isSuperAdmin } from '@/lib/super-admin';
import { decryptApiKey } from '@/lib/encryption';
import { POST } from '@/app/api/admin/ai-providers/[id]/test/route';

const db = prisma.botsAiProvider as unknown as {
  findUnique: jest.Mock;
  update: jest.Mock;
};
const originalFetch = global.fetch;
const fetchMock = jest.fn();
const providerId = 'test-provider';

beforeEach(() => {
  jest.resetAllMocks();
  global.fetch = fetchMock;
  jest
    .mocked(getSessionUser)
    .mockResolvedValue({ email: 'admin@example.test' } as Awaited<
      ReturnType<typeof getSessionUser>
    >);
  jest.mocked(isSuperAdmin).mockReturnValue(true);
  jest.mocked(decryptApiKey).mockReturnValue('test-key');
  db.findUnique.mockResolvedValue({
    providerId,
    type: 'anthropic',
    apiKeyEncrypted: 'encrypted-key',
  });
  db.update.mockResolvedValue({});
});

afterAll(() => {
  global.fetch = originalFetch;
});

async function testConnection() {
  const response = await POST(
    new NextRequest(`http://localhost/api/admin/ai-providers/${providerId}/test`, {
      method: 'POST',
    }),
    { params: Promise.resolve({ id: providerId }) },
  );
  expect(response.status).toBe(200);
  const result = await response.json();
  expect(db.update).toHaveBeenCalledWith({
    where: { providerId },
    data: { tested: result.success, testedAt: expect.any(Date) },
  });
  return result;
}

describe('Anthropic credential test', () => {
  it('accepts 200 with one models GET, no message, body, or tokens', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
    expect(await testConnection()).toEqual({ success: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('https://api.anthropic.com/v1/models?limit=1', {
      method: 'GET',
      headers: { 'x-api-key': 'test-key', 'anthropic-version': '2023-06-01' },
      signal: expect.any(AbortSignal),
    });
  });

  it('reports Authentication failed for 401 and marks the provider untested', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 401 }));
    expect(await testConnection()).toEqual({ success: false, error: 'Authentication failed' });
  });

  it('does not request anything when the key is missing', async () => {
    db.findUnique.mockResolvedValue({ providerId, type: 'anthropic', apiKeyEncrypted: null });
    expect(await testConnection()).toEqual({
      success: false,
      error: 'API key required for Anthropic',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([201, 204, 400, 403, 404, 429, 500, 529])(
    'rejects %i with the status and a short reason',
    async (status) => {
      fetchMock.mockResolvedValue(
        new Response(null, { status, statusText: 'Provider unavailable' }),
      );
      expect(await testConnection()).toEqual({
        success: false,
        error: `Unexpected response: ${status}`,
        details: 'Provider unavailable',
      });
    },
  );

  it('bounds a JSON error reason to 200 characters', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'x'.repeat(500) } }), { status: 429 }),
    );
    expect(await testConnection()).toEqual({
      success: false,
      error: 'Unexpected response: 429',
      details: 'x'.repeat(200),
    });
  });

  it.each([null, {}, { error: { message: 42 } }, { error: { message: ' ' } }])(
    'handles an absent or malformed reason: %j',
    async (body) => {
      fetchMock.mockResolvedValue(new Response(JSON.stringify(body), { status: 500 }));
      expect(await testConnection()).toEqual({
        success: false,
        error: 'Unexpected response: 500',
        details: 'Request failed',
      });
    },
  );

  it('keeps network/timeout failures unsuccessful', async () => {
    fetchMock.mockRejectedValue(new Error('Request timed out'));
    expect(await testConnection()).toEqual({
      success: false,
      error: 'Connection test failed',
      details: 'Request timed out',
    });
  });
});

/** What the chat check sent: its address, headers and body. */
function sent(call = 0) {
  const [url, init] = fetchMock.mock.calls[call];
  return { url, headers: init.headers, body: JSON.parse(init.body), method: init.method };
}

const ok = () => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 });

describe('OpenAI-compatible providers are checked at the address bots call (#703)', () => {
  it('DeepSeek on the openai type: one tiny chat with its model and one tool, with its key', async () => {
    db.findUnique.mockResolvedValue({ providerId, type: 'openai', endpoint: 'https://api.deepseek.com', model: 'deepseek-v4-flash', apiKeyEncrypted: 'encrypted-key' });
    fetchMock.mockResolvedValue(ok());
    expect(await testConnection()).toEqual({ success: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = sent();
    expect(call.url).toBe('https://api.deepseek.com/chat/completions');
    expect(call.method).toBe('POST');
    expect(call.headers).toEqual({ 'Content-Type': 'application/json', Authorization: 'Bearer test-key' });
    expect(call.body).toMatchObject({ model: 'deepseek-v4-flash', stream: false, max_tokens: 16 });
    expect(call.body.tools).toHaveLength(1);
  });

  it('LM Studio as set up today: the bots\' /v1/chat/completions, with no key, as the bot server sends none', async () => {
    db.findUnique.mockResolvedValue({ providerId, type: 'lmstudio', endpoint: 'http://localhost:1234', model: 'qwen3-8b', apiKeyEncrypted: 'encrypted-key' });
    fetchMock.mockResolvedValue(ok());
    expect(await testConnection()).toEqual({ success: true });
    expect(sent().url).toBe('http://localhost:1234/v1/chat/completions');
    expect(sent().headers).toEqual({ 'Content-Type': 'application/json' });
  });

  it.each([
    ['openai', 'https://api.openai.com', 'https://api.openai.com/chat/completions'],
    ['openai', 'https://generativelanguage.googleapis.com/v1beta/openai', 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'],
    ['openai', 'https://openrouter.ai/api/v1/', 'https://openrouter.ai/api/v1/chat/completions'],
    ['openai', null, 'https://api.openai.com/v1/chat/completions'],
    ['lmstudio', 'http://host:1234/v1', 'http://host:1234/v1/v1/chat/completions'],
    ['lmstudio', 'http://host:1234///', 'http://host:1234/v1/chat/completions'],
  ])('%s at %s is called at %s', async (type, endpoint, url) => {
    db.findUnique.mockResolvedValue({ providerId, type, endpoint, model: 'some-model', apiKeyEncrypted: 'encrypted-key' });
    fetchMock.mockResolvedValue(ok());
    await testConnection();
    expect(sent().url).toBe(url);
  });

  it('fails where bots fail: an address without its /v1 answers 404, and the address called is named', async () => {
    db.findUnique.mockResolvedValue({ providerId, type: 'openai', endpoint: 'https://api.openai.com', model: 'gpt-4o-mini', apiKeyEncrypted: 'encrypted-key' });
    fetchMock.mockResolvedValue(new Response('not found', { status: 404, statusText: 'Not Found' }));
    expect(await testConnection()).toEqual({
      success: false,
      error: 'Connection failed: 404',
      details: 'Not Found (POST https://api.openai.com/chat/completions)',
    });
  });

  it('fails a wrong key even where the model list is public (OpenRouter)', async () => {
    db.findUnique.mockResolvedValue({ providerId, type: 'openai', endpoint: 'https://openrouter.ai/api/v1', model: 'deepseek/deepseek-v4-flash', apiKeyEncrypted: 'encrypted-key' });
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { message: 'No auth credentials found' } }), { status: 401 }));
    expect(await testConnection()).toEqual({
      success: false,
      error: 'Connection failed: 401',
      details: 'No auth credentials found (POST https://openrouter.ai/api/v1/chat/completions)',
    });
  });

  it('asks again with max_completion_tokens when a reasoning model refuses max_tokens, as bots do', async () => {
    db.findUnique.mockResolvedValue({ providerId, type: 'openai', endpoint: null, model: 'o4-mini', apiKeyEncrypted: 'encrypted-key' });
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'unsupported_parameter', param: 'max_tokens', message: "Unsupported parameter: 'max_tokens'. Use 'max_completion_tokens' instead." } }), { status: 400 }))
      .mockResolvedValueOnce(ok());
    expect(await testConnection()).toEqual({ success: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sent(1).body.max_tokens).toBeUndefined();
    expect(sent(1).body.max_completion_tokens).toBe(16);
  });

  it('asks again with thinking off when a thinking model refuses a non-streaming call', async () => {
    db.findUnique.mockResolvedValue({ providerId, type: 'openai', endpoint: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', model: 'qwen3-8b', apiKeyEncrypted: 'encrypted-key' });
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'parameter.enable_thinking only support stream call' } }), { status: 400 }))
      .mockResolvedValueOnce(ok());
    expect(await testConnection()).toEqual({ success: true });
    expect(sent(1).body.enable_thinking).toBe(false);
  });

  it('does not ask again for any other refusal', async () => {
    db.findUnique.mockResolvedValue({ providerId, type: 'openai', endpoint: 'https://api.deepseek.com', model: 'deepseek-v4-flash', apiKeyEncrypted: 'encrypted-key' });
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { message: 'Model Not Exist' } }), { status: 400 }));
    expect(await testConnection()).toEqual({
      success: false,
      error: 'Connection failed: 400',
      details: 'Model Not Exist (POST https://api.deepseek.com/chat/completions)',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('says so, and calls nothing, when no model is set', async () => {
    db.findUnique.mockResolvedValue({ providerId, type: 'openai', endpoint: 'https://api.deepseek.com', model: null, apiKeyEncrypted: 'encrypted-key' });
    expect(await testConnection()).toEqual({ success: false, error: 'Model not configured' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps connection failures unsuccessful', async () => {
    db.findUnique.mockResolvedValue({ providerId, type: 'lmstudio', endpoint: 'http://localhost:1234', model: 'qwen3-8b', apiKeyEncrypted: null });
    fetchMock.mockRejectedValue(new Error('Connection refused'));
    expect(await testConnection()).toEqual({
      success: false,
      error: 'Connection test failed',
      details: 'Connection refused',
    });
  });
});

it.each(['lmstudio', 'deepseek'])('still requires an endpoint for %s', async (type) => {
  db.findUnique.mockResolvedValue({ providerId, type, endpoint: null, model: 'some-model' });
  expect(await testConnection()).toEqual({ success: false, error: 'Endpoint not configured' });
  expect(fetchMock).not.toHaveBeenCalled();
});
