import { validateAdminToken, requireAuth } from '@/lib/auth';
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

