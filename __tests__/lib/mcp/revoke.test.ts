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

  it('tries the client in a Basic header when the app refuses the form, once, with the secret in only one of them', async () => {
    const fetchMock = jest.fn().mockResolvedValueOnce(new Response('', { status: 401 })).mockResolvedValueOnce(new Response('', { status: 200 }));
    global.fetch = fetchMock as unknown as typeof fetch;
    expect(await revokeAtApp({ authType: 'oauth', authConfig: config({ clientId: 'c:1', clientSecret: 's p' }) })).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(new URLSearchParams(first[1].body as string).get('client_secret')).toBe('s p');
    const second = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(second[0]).toBe('https://auth.example.com/revoke');
    expect((second[1].headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from('c%3A1:s%20p').toString('base64')}`);
    expect(Object.fromEntries(new URLSearchParams(second[1].body as string))).toEqual({ token: 'refresh', token_type_hint: 'refresh_token' });
    expect(second[1].redirect).toBe('error');
  });

  it('does not try again when the app accepted the form, or refused for another reason, or there is no secret to send', async () => {
    const ok = jest.fn(async () => new Response('', { status: 200 }));
    global.fetch = ok as unknown as typeof fetch;
    await revokeAtApp({ authType: 'oauth', authConfig: config() });
    expect(ok).toHaveBeenCalledTimes(1);
    const server = jest.fn(async () => new Response('', { status: 500 }));
    global.fetch = server as unknown as typeof fetch;
    expect(await revokeAtApp({ authType: 'oauth', authConfig: config() })).toBe(false);
    expect(server).toHaveBeenCalledTimes(1);
    const open = jest.fn(async () => new Response('', { status: 401 }));
    global.fetch = open as unknown as typeof fetch;
    expect(await revokeAtApp({ authType: 'oauth', authConfig: config({ clientSecret: undefined }) })).toBe(false);
    expect(open).toHaveBeenCalledTimes(1);
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

  it('gives up within the deadline when the name lookup of the destination check stalls, and sends nothing', async () => {
    jest.useFakeTimers();
    // AbortSignal.timeout runs on a timer of its own that the fake clock does not move: its deadline is made with the clock the test moves
    const timeout = jest.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      const control = new AbortController();
      setTimeout(() => control.abort(new DOMException('The operation timed out.', 'TimeoutError')), ms);
      return control.signal;
    });
    try {
      (checkOutboundUrl as jest.Mock).mockImplementation(() => new Promise(() => undefined));
      const fetchMock = jest.fn();
      global.fetch = fetchMock as unknown as typeof fetch;
      const done = revokeAtApp({ authType: 'oauth', authConfig: config() });
      await jest.advanceTimersByTimeAsync(5_100);
      expect(await done).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(timeout).toHaveBeenCalled();
    } finally {
      timeout.mockRestore();
      jest.useRealTimers();
    }
  });
});
