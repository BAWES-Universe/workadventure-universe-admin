import { NextRequest } from 'next/server';
import { GET as loginGet, POST as loginPost } from '@/app/api/auth/login/route';
import { OPTIONS as sessionOptions, POST as sessionPost } from '@/app/api/auth/session/route';
import {
  DEFAULT_MOBILE_REDIRECT_URI,
  getMobileRedirectUri,
  isMobileOrigin,
  isMobileWebViewUserAgent,
  isValidRedirectUri,
  resolveRedirectUri,
} from '@/app/api/auth/redirect-uri';
import { middleware } from '@/middleware';
import { exchangeOidcAccessToken } from '@/lib/oidc-session-exchange';

jest.mock('@/lib/oidc-session-exchange', () => ({
  exchangeOidcAccessToken: jest.fn(async () => ({
    version: 2,
    sessionId: `orb_sess_v2_${'c'.repeat(64)}`,
    expiresAt: 654321,
  })),
  SessionExchangeError: class SessionExchangeError extends Error {
    constructor(public status: number, message: string) {
      super(message);
    }
  },
}));

describe('Mobile OIDC deep-link support (bawes://callback)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      NEXT_PUBLIC_API_URL: 'https://orbit.bawes.net',
      NEXT_PUBLIC_PLAY_URL: 'https://universe.bawes.net',
      MOBILE_REDIRECT_URI: 'bawes://callback',
    };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('redirect-uri validation and resolution', () => {
    it('accepts bawes://callback as a valid OIDC redirect URI alongside web URIs', () => {
      expect(getMobileRedirectUri()).toBe(DEFAULT_MOBILE_REDIRECT_URI);
      expect(isValidRedirectUri('bawes://callback')).toBe(true);
      expect(isValidRedirectUri('bawes://callback?code=abc&state=xyz')).toBe(true);
      expect(isValidRedirectUri('https://orbit.bawes.net/admin')).toBe(true);
      expect(isValidRedirectUri('https://universe.bawes.net/callback')).toBe(true);
    });

    it('rejects untrusted external origins and unsafe schemes', () => {
      expect(isValidRedirectUri('https://evil.example/callback')).toBe(false);
      expect(isValidRedirectUri('bawes://evil-host/callback')).toBe(false);
      expect(isValidRedirectUri('javascript:alert(1)')).toBe(false);
      expect(isValidRedirectUri('file:///etc/passwd')).toBe(false);
      expect(isValidRedirectUri('')).toBe(false);
    });

    it('recognizes Android WebView, iOS WKWebView, and Capacitor user agents', () => {
      const androidWv =
        'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/UQ1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/124.0.0.0 Mobile Safari/537.36';
      const iosWkWebView =
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
      const capacitorUa = 'Mozilla/5.0 Capacitor/6.0.0 net.bawes.universe';
      const desktopSafari =
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';

      expect(isMobileWebViewUserAgent(androidWv)).toBe(true);
      expect(isMobileWebViewUserAgent(iosWkWebView)).toBe(true);
      expect(isMobileWebViewUserAgent(capacitorUa)).toBe(true);
      expect(isMobileWebViewUserAgent(desktopSafari)).toBe(false);

      expect(resolveRedirectUri({ userAgent: androidWv })).toEqual({
        valid: true,
        redirectUri: 'bawes://callback',
        isMobile: true,
      });
      expect(resolveRedirectUri({ userAgent: desktopSafari })).toEqual({
        valid: true,
        redirectUri: 'https://orbit.bawes.net/admin',
        isMobile: false,
      });
    });

    it('validates bawes:// origin headers', () => {
      expect(isMobileOrigin('bawes://callback')).toBe(true);
      expect(isMobileOrigin('bawes://')).toBe(true);
      expect(isMobileOrigin('https://evil.example')).toBe(false);
      expect(isMobileOrigin(null)).toBe(false);
    });
  });

  describe('/api/auth/login route', () => {
    it('routes mobile WebView GET requests to bawes://callback', async () => {
      const req = new NextRequest('https://orbit.bawes.net/api/auth/login', {
        method: 'GET',
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/124.0.0.0 Mobile Safari/537.36',
        },
      });
      const res = await loginGet(req);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        redirectUri: 'bawes://callback',
        isMobile: true,
      });
    });

    it('accepts explicit redirect_uri=bawes://callback on GET and POST', async () => {
      const getRes = await loginGet(
        new NextRequest('https://orbit.bawes.net/api/auth/login?redirect_uri=bawes%3A%2F%2Fcallback'),
      );
      expect(getRes.status).toBe(200);
      expect(await getRes.json()).toEqual({
        redirectUri: 'bawes://callback',
        isMobile: true,
      });

      const postRes = await loginPost(
        new NextRequest('https://orbit.bawes.net/api/auth/login', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: 'bawes://callback',
          },
          body: JSON.stringify({
            accessToken: 'valid-mobile-token',
            redirect_uri: 'bawes://callback',
          }),
        }),
      );
      expect(postRes.status).toBe(200);
      expect(exchangeOidcAccessToken).toHaveBeenCalledWith('valid-mobile-token');
      expect(await postRes.json()).toEqual({
        version: 2,
        sessionId: `orb_sess_v2_${'c'.repeat(64)}`,
        expiresAt: 654321,
        redirectUri: 'bawes://callback',
      });
    });

    it('rejects invalid redirect_uri values on GET and POST', async () => {
      const getRes = await loginGet(
        new NextRequest('https://orbit.bawes.net/api/auth/login?redirect_uri=https://evil.example/cb'),
      );
      expect(getRes.status).toBe(400);

      const postRes = await loginPost(
        new NextRequest('https://orbit.bawes.net/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            accessToken: 'valid-mobile-token',
            redirect_uri: 'https://evil.example/cb',
          }),
        }),
      );
      expect(postRes.status).toBe(400);
      expect(exchangeOidcAccessToken).not.toHaveBeenCalled();
    });
  });

  describe('/api/auth/session and middleware with bawes:// origin', () => {
    it('allows OPTIONS and POST on /api/auth/session from bawes://callback origin', async () => {
      const optRes = await sessionOptions(
        new NextRequest('https://orbit.bawes.net/api/auth/session', {
          method: 'OPTIONS',
          headers: { Origin: 'bawes://callback' },
        }),
      );
      expect(optRes.status).toBe(204);
      expect(optRes.headers.get('access-control-allow-origin')).toBe('bawes://callback');

      const postRes = await sessionPost(
        new NextRequest('https://orbit.bawes.net/api/auth/session', {
          method: 'POST',
          headers: {
            Origin: 'bawes://callback',
            Authorization: 'Bearer mobile-oidc-token',
          },
        }),
      );
      expect(postRes.status).toBe(200);
      expect(postRes.headers.get('access-control-allow-origin')).toBe('bawes://callback');
    });

    it('does not block bawes:// origin in middleware', () => {
      const res = middleware(
        new NextRequest('https://orbit.bawes.net/api/auth/login', {
          method: 'POST',
          headers: { Origin: 'bawes://callback' },
        }),
      );
      expect(res.status).toBe(200);
      expect(res.headers.get('access-control-allow-origin')).toBe('bawes://callback');
    });
  });
});
