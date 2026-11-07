import { NextRequest } from 'next/server';
import {
  buildMobileCallbackRedirectUrl,
  DEFAULT_MOBILE_REDIRECT_URI,
  getAllowedRedirectUris,
  getMobileRedirectUri,
  isAllowedMobileOrigin,
  isCapacitorWebViewUserAgent,
  isMobileDeepLinkUri,
  isValidRedirectUri,
} from '@/app/api/auth/mobile-redirect';
import { GET as loginGet, POST as loginPost } from '@/app/api/auth/login/route';
import { OPTIONS as sessionOptions, POST as sessionPost } from '@/app/api/auth/session/route';
import { middleware } from '@/middleware';

jest.mock('@/lib/oidc-session-exchange', () => ({
  exchangeOidcAccessToken: jest.fn(async () => ({
    version: 2,
    sessionId: `orb_sess_v2_${'c'.repeat(64)}`,
    expiresAt: 999999,
  })),
  SessionExchangeError: class SessionExchangeError extends Error {
    constructor(public status: number, message: string) {
      super(message);
    }
  },
}));

describe('Mobile deep-link redirect URI validation', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      NEXT_PUBLIC_API_URL: 'https://orbit.bawes.net',
      NEXT_PUBLIC_PLAY_URL: 'https://universe.bawes.net',
    };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('resolves bawes://callback by default and respects MOBILE_REDIRECT_URI', () => {
    delete process.env.MOBILE_REDIRECT_URI;
    expect(getMobileRedirectUri()).toBe(DEFAULT_MOBILE_REDIRECT_URI);

    process.env.MOBILE_REDIRECT_URI = 'bawes://custom-callback';
    expect(getMobileRedirectUri()).toBe('bawes://custom-callback');
  });

  it('accepts bawes://callback alongside configured web redirect URIs', () => {
    expect(isValidRedirectUri('bawes://callback')).toBe(true);
    expect(isValidRedirectUri('bawes://callback?code=abc&state=xyz')).toBe(true);
    expect(isValidRedirectUri('https://orbit.bawes.net/admin/login')).toBe(true);
    expect(isValidRedirectUri('https://universe.bawes.net')).toBe(true);
    expect(getAllowedRedirectUris()).toContain('bawes://callback');
  });

  it('rejects untrusted hosts, invalid schemes, and arbitrary paths', () => {
    expect(isValidRedirectUri('bawes://evil-host')).toBe(false);
    expect(isValidRedirectUri('https://evil.example.com/callback')).toBe(false);
    expect(isValidRedirectUri('javascript:alert(1)')).toBe(false);
    expect(isValidRedirectUri('')).toBe(false);
  });

  it('identifies mobile custom-scheme URIs and builds callback URLs cleanly', () => {
    expect(isMobileDeepLinkUri('bawes://callback')).toBe(true);
    expect(isMobileDeepLinkUri('https://orbit.bawes.net/admin')).toBe(false);

    const target = buildMobileCallbackRedirectUrl({
      redirectUri: 'bawes://callback',
      params: { code: 'auth-code-123', state: 'nonce-456' },
    });
    expect(target).toBe('bawes://callback?code=auth-code-123&state=nonce-456');
  });
});

describe('Capacitor WebView origin and user-agent detection', () => {
  it('recognizes bawes:// and Capacitor localhost origins', () => {
    expect(isAllowedMobileOrigin('bawes://callback')).toBe(true);
    expect(isAllowedMobileOrigin('bawes://')).toBe(true);
    expect(isAllowedMobileOrigin('capacitor://localhost')).toBe(true);
    expect(isAllowedMobileOrigin('http://localhost')).toBe(true);
    expect(isAllowedMobileOrigin('https://evil.example.com')).toBe(false);
  });

  it('detects Android WebView, iOS WKWebView, and Capacitor user-agents', () => {
    const androidWv = 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/UQ1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36';
    const iosWkWebView = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
    const desktopChrome = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

    expect(isCapacitorWebViewUserAgent(androidWv)).toBe(true);
    expect(isCapacitorWebViewUserAgent(iosWkWebView)).toBe(true);
    expect(isCapacitorWebViewUserAgent('Capacitor/6.0.0 BAWESUniverse/1.0')).toBe(true);
    expect(isCapacitorWebViewUserAgent(desktopChrome)).toBe(false);
  });
});

describe('Auth routes and middleware mobile deep-link integration', () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_API_URL = 'https://orbit.bawes.net';
    process.env.NEXT_PUBLIC_PLAY_URL = 'https://universe.bawes.net';
    process.env.MOBILE_REDIRECT_URI = 'bawes://callback';
  });

  it('routes WebView GET /api/auth/login callbacks to bawes://callback', async () => {
    const webViewUa = 'Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36';
    const discoveryRes = await loginGet(new NextRequest('https://orbit.bawes.net/api/auth/login', {
      headers: { 'User-Agent': webViewUa },
    }));
    expect(discoveryRes.status).toBe(200);
    expect(await discoveryRes.json()).toEqual(expect.objectContaining({ redirectUri: 'bawes://callback' }));

    const handoffRes = await loginGet(new NextRequest(
      'https://orbit.bawes.net/api/auth/login?redirect_uri=bawes%3A%2F%2Fcallback&code=oidc_123&state=st_1',
      { headers: { 'User-Agent': webViewUa } },
    ));
    expect(handoffRes.status).toBe(302);
    expect(handoffRes.headers.get('location')).toBe('bawes://callback?code=oidc_123&state=st_1');
  });

  it('accepts bawes://callback in POST /api/auth/login and rejects invalid redirect_uri', async () => {
    const validRes = await loginPost(new NextRequest('https://orbit.bawes.net/api/auth/login', {
      method: 'POST',
      headers: { Origin: 'capacitor://localhost', 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessToken: 'valid-oidc-token', redirect_uri: 'bawes://callback' }),
    }));
    expect(validRes.status).toBe(200);
    expect(await validRes.json()).toEqual({
      version: 2,
      sessionId: `orb_sess_v2_${'c'.repeat(64)}`,
      expiresAt: 999999,
      redirectUri: 'bawes://callback',
    });

    const invalidRes = await loginPost(new NextRequest('https://orbit.bawes.net/api/auth/login', {
      method: 'POST',
      headers: { Origin: 'capacitor://localhost', 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessToken: 'valid-oidc-token', redirect_uri: 'https://evil.example/cb' }),
    }));
    expect(invalidRes.status).toBe(400);
  });

  it('permits bawes:// and Capacitor origins in /api/auth/session and middleware', async () => {
    const preflight = await sessionOptions(new NextRequest('https://orbit.bawes.net/api/auth/session', {
      method: 'OPTIONS',
      headers: { Origin: 'capacitor://localhost' },
    }));
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('capacitor://localhost');

    const exchange = await sessionPost(new NextRequest('https://orbit.bawes.net/api/auth/session', {
      method: 'POST',
      headers: { Origin: 'bawes://callback', Authorization: 'Bearer mobile-oidc-token' },
    }));
    expect(exchange.status).toBe(200);
    expect(exchange.headers.get('access-control-allow-origin')).toBe('bawes://callback');

    const mwRes = middleware(new NextRequest('https://orbit.bawes.net/api/auth/login', {
      headers: { Origin: 'bawes://callback' },
    }));
    expect(mwRes.headers.get('access-control-allow-origin')).toBe('bawes://callback');
  });
});
