import { validateAdminToken, requireAuth, resolveExpectedLoginOrigin } from '@/lib/auth';
import { NextRequest } from 'next/server';

describe('Auth', () => {
  const originalToken = process.env.ADMIN_API_TOKEN;

  beforeEach(() => {
    process.env.ADMIN_API_TOKEN = 'test-token';
  });

  afterEach(() => {
    process.env.ADMIN_API_TOKEN = originalToken;
  });

  describe('validateAdminToken', () => {
    it('should return true with valid token', () => {
      const request = new NextRequest('http://localhost:3333/api/test', {
        headers: {
          Authorization: 'Bearer test-token',
        },
      });

      expect(validateAdminToken(request)).toBe(true);
    });

    it('should return false with invalid token', () => {
      const request = new NextRequest('http://localhost:3333/api/test', {
        headers: {
          Authorization: 'Bearer wrong-token',
        },
      });

      expect(validateAdminToken(request)).toBe(false);
    });

    it('should return false without authorization header', () => {
      const request = new NextRequest('http://localhost:3333/api/test');

      expect(validateAdminToken(request)).toBe(false);
    });

    it('should return false with malformed header', () => {
      const request = new NextRequest('http://localhost:3333/api/test', {
        headers: {
          Authorization: 'InvalidFormat test-token',
        },
      });

      expect(validateAdminToken(request)).toBe(false);
    });
  });

  describe('requireAuth', () => {
    it('should not throw with valid token', () => {
      const request = new NextRequest('http://localhost:3333/api/test', {
        headers: {
          Authorization: 'Bearer test-token',
        },
      });

      expect(() => requireAuth(request)).not.toThrow();
    });

    it('should throw with invalid token', () => {
      const request = new NextRequest('http://localhost:3333/api/test', {
        headers: {
          Authorization: 'Bearer wrong-token',
        },
      });

      expect(() => requireAuth(request)).toThrow('Unauthorized');
    });
  });
});


describe('resolveExpectedLoginOrigin', () => {
  it('prefers the configured public origin (proxy-safe)', () => {
    expect(resolveExpectedLoginOrigin('https://orbit.bawes.net', 'http://127.0.0.1:3000')).toBe('https://orbit.bawes.net');
  });

  it('normalizes trailing paths to a bare origin', () => {
    expect(resolveExpectedLoginOrigin('https://orbit.bawes.net/admin', 'http://127.0.0.1:3000')).toBe('https://orbit.bawes.net');
  });

  it('falls back to nextUrl origin when nothing is configured (local dev)', () => {
    expect(resolveExpectedLoginOrigin(undefined, 'http://localhost:8321')).toBe('http://localhost:8321');
  });

  it('falls back when the configured value is malformed', () => {
    expect(resolveExpectedLoginOrigin('not a url', 'http://localhost:8321')).toBe('http://localhost:8321');
  });
});

describe('resolveExpectedLoginOrigin scheme guard', () => {
  it('accepts http(s) configured origins, including internal dev hosts', () => {
    expect(resolveExpectedLoginOrigin('http://admin.bawes.localhost:8321', 'http://fallback')).toBe('http://admin.bawes.localhost:8321');
    expect(resolveExpectedLoginOrigin('https://orbit.bawes.net', 'http://fallback')).toBe('https://orbit.bawes.net');
  });

  it('rejects non-http(s) schemes and falls back', () => {
    expect(resolveExpectedLoginOrigin('file:///etc/passwd', 'http://localhost:8321')).toBe('http://localhost:8321');
    expect(resolveExpectedLoginOrigin('mailto:admin@bawes.net', 'http://localhost:8321')).toBe('http://localhost:8321');
  });
});
