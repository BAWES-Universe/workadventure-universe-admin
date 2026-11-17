/**
 * Discovery hands back where an app takes a sign-in back (RFC 7009) when the app says so, in the 401 answer too, and only over https:
 * the sign-in and the client secret are sent there when a person disconnects.
 */
import { NextRequest } from 'next/server';

jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn(async () => ({ id: 'someone' })) }));
jest.mock('dns/promises', () => ({ resolve4: jest.fn(async () => ['93.184.216.34']), resolve6: jest.fn(async () => []) }));

import { GET as discover } from '@/app/api/mcp/oauth-discover/route';

const originalFetch = global.fetch;
const adminUrlBefore = process.env.ADMIN_API_URL;
beforeAll(() => {
  process.env.ADMIN_API_URL = 'https://orbit.app.example';
});
afterAll(() => {
  if (adminUrlBefore === undefined) delete process.env.ADMIN_API_URL; else process.env.ADMIN_API_URL = adminUrlBefore;
});
afterEach(() => {
  global.fetch = originalFetch;
});

const ask = () => discover(new NextRequest('http://localhost/api/mcp/oauth-discover?serverUrl=' + encodeURIComponent('https://mcp.app.example/mcp')));
const answering = (extra: Record<string, unknown>) => {
  global.fetch = jest.fn(async () =>
    new Response(JSON.stringify({ error: { data: { authorization_endpoint: 'https://auth.app.example/a', token_endpoint: 'https://auth.app.example/t', ...extra } } }), { status: 401, headers: { 'content-type': 'application/json' } }),
  ) as unknown as typeof fetch;
};

describe('discovery: where the app takes a sign-in back', () => {
  it('keeps the revocation address the app names in its 401 answer', async () => {
    answering({ revocation_endpoint: 'https://auth.app.example/revoke' });
    const body = await (await ask()).json();
    expect(body).toMatchObject({ discovered: true, revocationUrl: 'https://auth.app.example/revoke' });
  });

  it('drops an address that is not https, or that is not public', async () => {
    answering({ revocation_endpoint: 'http://auth.app.example/revoke' });
    expect((await (await ask()).json()).revocationUrl).toBeNull();
    answering({ revocation_endpoint: 'https://10.0.0.5/revoke' });
    expect((await (await ask()).json()).revocationUrl).toBeNull();
    answering({});
    expect((await (await ask()).json()).revocationUrl).toBeNull();
  });
});
