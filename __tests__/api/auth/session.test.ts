import { NextRequest } from 'next/server';
import { OPTIONS, POST } from '@/app/api/auth/session/route';
import { exchangeOidcAccessToken } from '@/lib/oidc-session-exchange';
import { getPlayOrigin } from '@/lib/origin-policy';

jest.mock('@/lib/oidc-session-exchange', () => ({
  exchangeOidcAccessToken: jest.fn(async () => ({ version: 2, sessionId: `orb_sess_v2_${'b'.repeat(64)}`, expiresAt: 123456 })),
  SessionExchangeError: class SessionExchangeError extends Error { constructor(public status: number, message: string) { super(message); } },
}));

describe('/api/auth/session CORS and transport', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NEXT_PUBLIC_PLAY_URL = 'https://play.example.com';
  });

  it('grants only the configured play origin and Authorization header', async () => {
    const response = await OPTIONS(new NextRequest('https://admin.example.com/api/auth/session', {
      method: 'OPTIONS', headers: { Origin: 'https://play.example.com' },
    }));
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('https://play.example.com');
    expect(response.headers.get('access-control-allow-headers')).toBe('Authorization');
    expect(response.headers.get('access-control-allow-credentials')).toBeNull();
    expect(response.headers.get('vary')).toContain('Origin');
  });

  it('does not grant an unknown origin', async () => {
    const response = await POST(new NextRequest('https://admin.example.com/api/auth/session', {
      method: 'POST', headers: { Origin: 'https://evil.example', Authorization: 'Bearer oidc-token' },
    }));
    expect(response.status).toBe(403);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect(exchangeOidcAccessToken).not.toHaveBeenCalled();
  });

  it('accepts the OIDC credential only from Authorization', async () => {
    const response = await POST(new NextRequest('https://admin.example.com/api/auth/session', {
      method: 'POST', headers: { Origin: 'https://play.example.com', Authorization: 'Bearer oidc-token' },
      body: JSON.stringify({ accessToken: 'ignored-body-token' }),
    }));
    expect(response.status).toBe(200);
    expect(exchangeOidcAccessToken).toHaveBeenCalledWith('oidc-token');
    expect(await response.json()).toEqual({ version: 2, sessionId: `orb_sess_v2_${'b'.repeat(64)}`, expiresAt: 123456 });
  });

  it('rejects a plaintext configured play origin in production', () => {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    process.env.NEXT_PUBLIC_PLAY_URL = 'http://play.example.com';

    try {
      expect(() => getPlayOrigin()).toThrow('NEXT_PUBLIC_PLAY_URL must use https in production');
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
    }
  });
});
