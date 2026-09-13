import { NextRequest } from 'next/server';
import {
  isValidRedirectUri,
  isAllowedLoginOrigin,
  getMobileRedirectUri,
  getAllowedRedirectUris,
} from './redirect-validator';
import { GET, POST } from './login/route';
import { validateAccessToken } from '@/lib/oidc';
import { prisma } from '@/lib/db';

jest.mock('@/lib/oidc', () => ({ validateAccessToken: jest.fn() }));
jest.mock('@/lib/session-store', () => ({
  sessionStore: { createSession: jest.fn(async () => ({ sessionId: `orb_sess_v2_${'a'.repeat(64)}`, expiresAt: 123456 })) },
}));
jest.mock('@/lib/db', () => ({
  prisma: { user: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() } },
}));

describe('redirect-validator', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('isValidRedirectUri', () => {
    it('accepts default mobile redirect URI bawes://callback', () => {
      expect(isValidRedirectUri('bawes://callback')).toBe(true);
      expect(isValidRedirectUri('bawes://callback?code=12345')).toBe(true);
      expect(isValidRedirectUri('bawes://callback#access_token=xyz')).toBe(true);
    });

    it('accepts custom MOBILE_REDIRECT_URI from env', () => {
      process.env.MOBILE_REDIRECT_URI = 'custom://mycallback';
      expect(isValidRedirectUri('custom://mycallback')).toBe(true);
      expect(isValidRedirectUri('custom://mycallback?state=abc')).toBe(true);
    });

    it('accepts configured web origins', () => {
      process.env.NEXT_PUBLIC_API_URL = 'https://admin.bawes.net';
      process.env.PLAY_URL = 'https://play.bawes.net';

      expect(isValidRedirectUri('https://admin.bawes.net')).toBe(true);
      expect(isValidRedirectUri('https://admin.bawes.net/admin/login')).toBe(true);
      expect(isValidRedirectUri('https://play.bawes.net')).toBe(true);
    });

    it('rejects unapproved or malicious URIs', () => {
      expect(isValidRedirectUri('')).toBe(false);
      expect(isValidRedirectUri('https://evil.com/callback')).toBe(false);
      expect(isValidRedirectUri('javascript:alert(1)')).toBe(false);
      expect(isValidRedirectUri('other://callback')).toBe(false);
    });
  });

  describe('isAllowedLoginOrigin', () => {
    it('permits standard web expected origin', () => {
      expect(isAllowedLoginOrigin('https://admin.bawes.net', 'https://admin.bawes.net')).toBe(true);
    });

    it('permits mobile Capacitor origins', () => {
      expect(isAllowedLoginOrigin('capacitor://localhost', 'https://admin.bawes.net')).toBe(true);
      expect(isAllowedLoginOrigin('https://localhost', 'https://admin.bawes.net')).toBe(true);
      expect(isAllowedLoginOrigin('http://localhost', 'https://admin.bawes.net')).toBe(true);
    });

    it('permits custom scheme origins and null origin', () => {
      expect(isAllowedLoginOrigin('bawes://', 'https://admin.bawes.net')).toBe(true);
      expect(isAllowedLoginOrigin('bawes://callback', 'https://admin.bawes.net')).toBe(true);
      expect(isAllowedLoginOrigin('null', 'https://admin.bawes.net')).toBe(true);
    });

    it('rejects cross-origin web origins', () => {
      expect(isAllowedLoginOrigin('https://evil.com', 'https://admin.bawes.net')).toBe(false);
      expect(isAllowedLoginOrigin('https://phishing.site', 'https://admin.bawes.net')).toBe(false);
    });
  });

  describe('GET /api/auth/login endpoint', () => {
    it('validates mobile redirect URI via query param', async () => {
      const req = new NextRequest('http://localhost:3333/api/auth/login?redirect_uri=bawes%3A%2F%2Fcallback');
      const res = await GET(req);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toEqual({ redirect_uri: 'bawes://callback', valid: true });
    });

    it('returns 400 for invalid redirect URI', async () => {
      const req = new NextRequest('http://localhost:3333/api/auth/login?redirect_uri=https%3A%2F%2Fevil.com');
      const res = await GET(req);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data).toEqual({ redirect_uri: 'https://evil.com', valid: false });
    });

    it('returns allowed list when no redirect_uri parameter given', async () => {
      const req = new NextRequest('http://localhost:3333/api/auth/login');
      const res = await GET(req);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.allowedRedirectUris).toContain('bawes://callback');
    });
  });

  describe('POST /api/auth/login mobile flow', () => {
    it('allows login request with Capacitor origin and bawes://callback', async () => {
      const user = { id: '1', uuid: 'user-123', email: 'test@example.com', name: 'Mobile User' };
      (validateAccessToken as jest.Mock).mockResolvedValue({ sub: 'user-123', email: user.email, name: user.name });
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(user);
      (prisma.user.update as jest.Mock).mockResolvedValue(user);

      const response = await POST(new NextRequest('http://localhost:3333/api/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'capacitor://localhost',
        },
        body: JSON.stringify({
          accessToken: 'valid-token',
          redirect_uri: 'bawes://callback',
        }),
      }));

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.version).toBe(2);
      expect(data.sessionId).toBeDefined();
    });

    it('rejects request with invalid redirect_uri', async () => {
      const response = await POST(new NextRequest('http://localhost:3333/api/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          accessToken: 'valid-token',
          redirect_uri: 'https://evil.com/phish',
        }),
      }));

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe('Invalid redirect_uri');
      expect(validateAccessToken).not.toHaveBeenCalled();
    });
  });
});
