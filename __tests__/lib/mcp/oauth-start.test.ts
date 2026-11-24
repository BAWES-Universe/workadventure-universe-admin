import { NextRequest } from 'next/server';
import { startOAuth } from '@/lib/mcp/oauth-start';

jest.mock('@/lib/encryption', () => ({ encryptApiKey: (value: string) => `enc:${value}`, decryptApiKey: (value: string) => value.replace(/^enc:/, '') }));

const original = process.env.ADMIN_API_URL;
beforeAll(() => {
  process.env.ADMIN_API_URL = 'https://orbit.example.test';
});
afterAll(() => {
  process.env.ADMIN_API_URL = original;
});

const start = (serverUrl: string | null, authorizeUrl: string) =>
  startOAuth({ request: new NextRequest('https://orbit.example.test/api/x'), oauthConfig: { clientId: 'c', authorizeUrl, scopes: 'read' }, serverUrl, fallbackPath: '/done', state: { botId: 'b' } });

const stateOf = (url: string) => JSON.parse(String(new URL(url).searchParams.get('state')).replace(/^enc:/, '')) as Record<string, unknown>;

describe('the sign-in start keeps the resource in the address and in the state the same', () => {
  it('names the app’s link in both when there is one, replacing one the provider’s own address carried', () => {
    const result = start('https://mcp.example.test/v1', 'https://auth.example.test/authorize?resource=https%3A%2F%2Fother.example.test');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const url = new URL(result.authorizeUrl);
    expect(url.searchParams.getAll('resource')).toEqual(['https://mcp.example.test/v1']);
    expect(stateOf(result.authorizeUrl).resource).toBe('https://mcp.example.test/v1');
  });

  it('names no resource in either when none is intended, even if the provider’s own address carried one', () => {
    const result = start(null, 'https://auth.example.test/authorize?resource=https%3A%2F%2Fother.example.test');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(new URL(result.authorizeUrl).searchParams.has('resource')).toBe(false);
    expect(stateOf(result.authorizeUrl)).not.toHaveProperty('resource');
  });
});
