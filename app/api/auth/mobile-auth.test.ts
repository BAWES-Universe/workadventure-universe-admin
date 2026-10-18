import { NextRequest } from 'next/server';
import { POST as loginPost } from '@/app/api/auth/login/route';
import { OPTIONS as sessionOptions, POST as sessionPost } from '@/app/api/auth/session/route';
import {
  DEFAULT_MOBILE_REDIRECT_URI,
  getMobileRedirectUri,
  isMobileOrigin,
  isMobileRedirectUri,
  isMobileWebViewUserAgent,
  isValidRedirectUri,
  resolveOidcRedirectUri,
} from '@/app/api/auth/redirect-uri';
import { middleware } from '@/middleware';
import { validateAccessToken } from '@/lib/oidc';
import { prisma } from '@/lib/db';

jest.mock('@/lib/oidc', () => ({ validateAccessToken: jest.fn() }));
jest.mock('@/lib/session-store', () => ({
  sessionStore: {
    createSession: jest.fn(async () => ({
      sessionId: `orb_sess_v2_${'c'.repeat(64)}`,
      expiresAt: 999999,
    })),
  },
}));
jest.mock('@/lib/db', () => ({
  prisma: {
    user: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
  },
}));

describe('Mobile OIDC deep-link redirect & origin support (#6)', () => {
  const originalEnv = { ...process.env };
  const androidWebViewUa =
    'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/UQ1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/124.0.0.0 Mobile Safari/537.36';
  const desktopChromeUa =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NEXT_PUBLIC_API_URL = 'https://orbit.bawes.net';
    process.env.ADMIN_API_URL = 'https://orbit.bawes.net';
    process.env.NEXT_PUBLIC_PLAY_URL = 'https://universe.bawes.net';
    process.env.PLAY_URL = 'https://universe.bawes.net';
    delete process.env.MOBILE_REDIRECT_URI;
    delete process.env.MOBILE_ALLOWED_ORIGINS;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('redirect-uri validation', () => {
    it('defaults MOBILE_REDIRECT_URI to bawes://callback and supports custom mobile schemes/hosts', () => {
      expect(DEFAULT_MOBILE_REDIRECT_URI).toBe('bawes://callback');
      expect(getMobileRedirectUri()).toBe('bawes://callback');

      process.env.MOBILE_REDIRECT_URI = 'bawes://callback/auth';
      expect(getMobileRedirectUri()).toBe('bawes://callback/auth');
      expect(isMobileRedirectUri('bawes://callback/auth?code=1')).toBe(true);

      process.env.MOBILE_REDIRECT_URI = 'universe://auth-callback';
      expect(getMobileRedirectUri()).toBe('universe://auth-callback');
      expect(isMobileRedirectUri('universe://auth-callback?code=1')).toBe(true);
      expect(isMobileOrigin('universe://')).toBe(true);

      process.env.MOBILE_REDIRECT_URI = 'javascript:alert(1)';
      expect(getMobileRedirectUri()).toBe('bawes://callback');
    });

    it('accepts bawes://callback with query/hash (including .. in state) while rejecting path traversal', () => {
      expect(isMobileRedirectUri('bawes://callback')).toBe(true);
      expect(isMobileRedirectUri('bawes://callback?code=abc&state=a..b')).toBe(true);
      expect(isMobileRedirectUri('bawes://callback#access_token=tok..1')).toBe(true);
      expect(isValidRedirectUri('bawes://callback?state=nonce..123')).toBe(true);
      expect(isValidRedirectUri('https://orbit.bawes.net/admin/login?state=a..b')).toBe(true);

      expect(isValidRedirectUri('bawes://callback/../evil')).toBe(false);
      expect(isValidRedirectUri('https://orbit.bawes.net/../evil')).toBe(false);
    });

    it('accepts configured web redirect URIs and rejects arbitrary open redirects', () => {
      expect(isValidRedirectUri('https://orbit.bawes.net/admin/login')).toBe(true);
      expect(isValidRedirectUri('https://universe.bawes.net/oidc-callback')).toBe(true);

      expect(isValidRedirectUri('https://evil.example/callback')).toBe(false);
      expect(isValidRedirectUri('javascript:alert(1)')).toBe(false);
      expect(isValidRedirectUri('data:text/html,<script>alert(1)</script>')).toBe(false);
      expect(isValidRedirectUri('bawes://evil-host/callback')).toBe(false);
      expect(isValidRedirectUri('bawes://user:pass@callback')).toBe(false);
    });

    it('detects Capacitor and mobile WebView user agents and resolves bawes://callback or /admin/login', () => {
      const iosWkWebView =
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';

      expect(isMobileWebViewUserAgent(androidWebViewUa)).toBe(true);
      expect(isMobileWebViewUserAgent(iosWkWebView)).toBe(true);
      expect(isMobileWebViewUserAgent('Capacitor/6.0.0 bawes-mobile')).toBe(true);
      expect(isMobileWebViewUserAgent(desktopChromeUa)).toBe(false);

      expect(resolveOidcRedirectUri({ userAgent: androidWebViewUa })).toBe('bawes://callback');
      expect(resolveOidcRedirectUri({ userAgent: desktopChromeUa })).toBe(
        'https://orbit.bawes.net/admin/login'
      );
      expect(
        resolveOidcRedirectUri({
          requestedRedirectUri: 'bawes://callback',
          userAgent: desktopChromeUa,
        })
      ).toBe('bawes://callback');
      expect(
        resolveOidcRedirectUri({ requestedRedirectUri: 'https://evil.example/cb' })
      ).toBeNull();
    });

    it('permits Android https://localhost only for mobile WebView User-Agent or explicit MOBILE_ALLOWED_ORIGINS and rejects null/* entries', () => {
      expect(isMobileOrigin('https://localhost', desktopChromeUa)).toBe(false);
      expect(isMobileOrigin('https://localhost', androidWebViewUa)).toBe(true);

      process.env.MOBILE_ALLOWED_ORIGINS = 'null, *, https://localhost';
      expect(isMobileOrigin('null', desktopChromeUa)).toBe(false);
      expect(isMobileOrigin('*', desktopChromeUa)).toBe(false);
      expect(isMobileOrigin('https://localhost', desktopChromeUa)).toBe(true);
    });
  });

  describe('/api/auth/login mobile deep-link & origin handling', () => {

    it('permits iOS/Android mobile origins on POST /api/auth/login, echoes validated redirectUri, and rejects untrusted web origins', async () => {
      const user = { id: '1', uuid: 'mob-user', email: 'mob@bawes.net', name: 'Mobile User' };
      (validateAccessToken as jest.Mock).mockResolvedValue({
        sub: user.uuid,
        email: user.email,
        name: user.name,
        tags: ['member'],
      });
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(user);
      (prisma.user.update as jest.Mock).mockResolvedValue(user);

      for (const mobileOrigin of ['bawes://callback', 'bawes://', 'capacitor://localhost']) {
        const res = await loginPost(
          new NextRequest('https://orbit.bawes.net/api/auth/login', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Origin: mobileOrigin,
            },
            body: JSON.stringify({
              accessToken: 'valid-mobile-token',
              redirectUri: 'bawes://callback',
            }),
          })
        );
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
          version: 2,
          sessionId: `orb_sess_v2_${'c'.repeat(64)}`,
          expiresAt: 999999,
          redirectUri: 'bawes://callback',
        });
      }

      // Android Capacitor https://localhost with Android WebView User-Agent
      const androidRes = await loginPost(
        new NextRequest('https://orbit.bawes.net/api/auth/login', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: 'https://localhost',
            'User-Agent': androidWebViewUa,
          },
          body: JSON.stringify({
            accessToken: 'valid-mobile-token',
            redirectUri: 'bawes://callback',
          }),
        })
      );
      expect(androidRes.status).toBe(200);

      // Untrusted web origin must be rejected with 403
      const untrustedOriginRes = await loginPost(
        new NextRequest('https://orbit.bawes.net/api/auth/login', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: 'https://evil.example',
            'User-Agent': desktopChromeUa,
          },
          body: JSON.stringify({
            accessToken: 'valid-mobile-token',
          }),
        })
      );
      expect(untrustedOriginRes.status).toBe(403);

      // Desktop https://localhost without mobile User-Agent or MOBILE_ALLOWED_ORIGINS must be rejected with 403
      const desktopLocalhostRes = await loginPost(
        new NextRequest('https://orbit.bawes.net/api/auth/login', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: 'https://localhost',
            'User-Agent': desktopChromeUa,
          },
          body: JSON.stringify({
            accessToken: 'valid-mobile-token',
          }),
        })
      );
      expect(desktopLocalhostRes.status).toBe(403);

      const badRedirectRes = await loginPost(
        new NextRequest('https://orbit.bawes.net/api/auth/login', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: 'bawes://callback',
          },
          body: JSON.stringify({
            accessToken: 'valid-mobile-token',
            redirectUri: 'https://evil.example/steal',
          }),
        })
      );
      expect(badRedirectRes.status).toBe(400);
    });
  });

  describe('/api/auth/session & middleware mobile origin support', () => {
    it('grants CORS and session exchange for iOS and Android mobile origins on /api/auth/session', async () => {
      const user = { id: '1', uuid: 'mob-user', email: 'mob@bawes.net', name: 'Mobile User' };
      (validateAccessToken as jest.Mock).mockResolvedValue({
        sub: user.uuid,
        email: user.email,
        name: user.name,
      });
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(user);
      (prisma.user.update as jest.Mock).mockResolvedValue(user);

      const preflight = await sessionOptions(
        new NextRequest('https://orbit.bawes.net/api/auth/session', {
          method: 'OPTIONS',
          headers: { Origin: 'bawes://callback' },
        })
      );
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get('access-control-allow-origin')).toBe('bawes://callback');

      const postRes = await sessionPost(
        new NextRequest('https://orbit.bawes.net/api/auth/session', {
          method: 'POST',
          headers: {
            Origin: 'https://localhost',
            'User-Agent': androidWebViewUa,
            Authorization: 'Bearer valid-mobile-token',
          },
        })
      );
      expect(postRes.status).toBe(200);
      expect(postRes.headers.get('access-control-allow-origin')).toBe('https://localhost');
    });

    it('allows bawes:// and Android WebView origins on login/session routes without exposing other /api/auth/* routes', () => {
      const res = middleware(
        new NextRequest('https://orbit.bawes.net/api/auth/login', {
          headers: { Origin: 'bawes://callback' },
        })
      );
      expect(res.status).toBe(200);
      expect(res.headers.get('access-control-allow-origin')).toBe('bawes://callback');

      const logoutRes = middleware(
        new NextRequest('https://orbit.bawes.net/api/auth/logout', {
          headers: { Origin: 'bawes://callback' },
        })
      );
      expect(logoutRes.headers.get('access-control-allow-origin')).toBeNull();
    });
  });
});
