import { revokeAtApp } from '@/lib/mcp/revoke';
import { checkOutboundUrl } from '@/lib/mcp/outbound-guard';

jest.mock('@/lib/encryption', () => ({ decryptApiKey: (value: string) => value.replace(/^enc:/, '') }));
jest.mock('@/lib/mcp/outbound-guard', () => ({ checkOutboundUrl: jest.fn(async () => ({ allowed: true })) }));

const config = (extra: Record<string, unknown> = {}) =>
  `enc:${JSON.stringify({ clientId: 'c', clientSecret: 's', accessToken: 'access', refreshToken: 'refresh', revocationUrl: 'https://auth.example.com/revoke', ...extra })}`;
const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
  (checkOutboundUrl as jest.Mock).mockResolvedValue({ allowed: true });
});

describe('taking a sign-in back at the app (best effort)', () => {
  it('asks the app to revoke the refresh token, with the client, and says whether it accepted', async () => {
    const fetchMock = jest.fn(async () => new Response('', { status: 200 }));
    global.fetch = fetchMock as unknown as typeof fetch;
    expect(await revokeAtApp({ authType: 'oauth', authConfig: config() })).toBe(true);
    const [address, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(address).toBe('https://auth.example.com/revoke');
    const body = new URLSearchParams(init.body as string);
    expect(Object.fromEntries(body)).toEqual({ token: 'refresh', token_type_hint: 'refresh_token', client_id: 'c', client_secret: 's' });
    expect(init.redirect).toBe('error');
  });

  it('uses the access token when there is no refresh token', async () => {
    const fetchMock = jest.fn(async () => new Response('', { status: 200 }));
    global.fetch = fetchMock as unknown as typeof fetch;
    await revokeAtApp({ authType: 'oauth', authConfig: config({ refreshToken: undefined }) });
    expect(new URLSearchParams((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string).get('token')).toBe('access');
  });

  it('does nothing without an address from the app, without a token, or for an app that is not an OAuth sign-in', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    expect(await revokeAtApp({ authType: 'oauth', authConfig: config({ revocationUrl: undefined }) })).toBe(false);
    expect(await revokeAtApp({ authType: 'oauth', authConfig: config({ accessToken: undefined, refreshToken: undefined }) })).toBe(false);
    expect(await revokeAtApp({ authType: 'bearer', authConfig: 'enc:key' })).toBe(false);
    expect(await revokeAtApp({ authType: 'oauth', authConfig: null })).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never sends the token or the client secret over plain http, even to a public address', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    expect(await revokeAtApp({ authType: 'oauth', authConfig: config({ revocationUrl: 'http://auth.example.com/revoke' }) })).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never sends the token to an address that fails the destination check', async () => {
    (checkOutboundUrl as jest.Mock).mockResolvedValue({ allowed: false });
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    expect(await revokeAtApp({ authType: 'oauth', authConfig: config() })).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never throws: an app that is down, a refusal or a broken sign-in is just false', async () => {
    global.fetch = jest.fn(async () => { throw new Error('down'); }) as unknown as typeof fetch;
    expect(await revokeAtApp({ authType: 'oauth', authConfig: config() })).toBe(false);
    global.fetch = jest.fn(async () => new Response('', { status: 400 })) as unknown as typeof fetch;
    expect(await revokeAtApp({ authType: 'oauth', authConfig: config() })).toBe(false);
    expect(await revokeAtApp({ authType: 'oauth', authConfig: 'enc:not json' })).toBe(false);
  });
});
