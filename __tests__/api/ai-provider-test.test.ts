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

describe.each([
  {
    type: 'openai',
    endpoint: 'https://api.deepseek.com/v1///',
    model: 'deepseek-v4-flash',
    url: 'https://api.deepseek.com/v1/models',
    key: 'test-key',
  },
  {
    type: 'deepseek',
    endpoint: 'https://api.deepseek.com/',
    model: 'deepseek-v4-flash',
    url: 'https://api.deepseek.com/v1/models',
    key: 'test-key',
  },
  {
    type: 'lmstudio',
    endpoint: 'http://localhost:1234/v1/',
    model: 'local-model',
    url: 'http://localhost:1234/v1/models',
    key: null,
  },
])('unchanged $type connection test', ({ type, endpoint, model, url, key }) => {
  beforeEach(() => {
    db.findUnique.mockResolvedValue({
      providerId,
      type,
      endpoint,
      model,
      apiKeyEncrypted: key ? 'encrypted-key' : null,
    });
  });

  it('keeps the same normalized URL, optional Bearer auth, and success result', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
    expect(await testConnection()).toEqual({ success: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      },
      signal: expect.any(AbortSignal),
    });
  });

  it('still accepts any successful HTTP status', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    expect(await testConnection()).toEqual({ success: true });
  });

  it('preserves provider error messages, including for 401', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'Invalid API key' } }), { status: 401 }),
    );
    expect(await testConnection()).toEqual({
      success: false,
      error: 'Connection failed: 401',
      details: 'Invalid API key',
    });
  });

  it('preserves the status text fallback for non-JSON errors', async () => {
    fetchMock.mockResolvedValue(
      new Response('unavailable', { status: 503, statusText: 'Service Unavailable' }),
    );
    expect(await testConnection()).toEqual({
      success: false,
      error: 'Connection failed: 503',
      details: 'Service Unavailable',
    });
  });

  it('preserves connection failures', async () => {
    fetchMock.mockRejectedValue(new Error('Connection refused'));
    expect(await testConnection()).toEqual({
      success: false,
      error: 'Connection test failed',
      details: 'Connection refused',
    });
  });
});

it.each(['lmstudio', 'deepseek'])('still requires an endpoint for %s', async (type) => {
  db.findUnique.mockResolvedValue({ providerId, type, endpoint: null });
  expect(await testConnection()).toEqual({ success: false, error: 'Endpoint not configured' });
  expect(fetchMock).not.toHaveBeenCalled();
});

it('still defaults only openai to the OpenAI endpoint', async () => {
  db.findUnique.mockResolvedValue({ providerId, type: 'openai', endpoint: null });
  fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
  expect(await testConnection()).toEqual({ success: true });
  expect(fetchMock).toHaveBeenCalledWith('https://api.openai.com/v1/models', expect.any(Object));
});
