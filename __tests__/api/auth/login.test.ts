import { NextRequest } from 'next/server';
import { POST } from '@/app/api/auth/login/route';
import { validateAccessToken } from '@/lib/oidc';
import { prisma } from '@/lib/db';

jest.mock('@/lib/oidc', () => ({ validateAccessToken: jest.fn() }));
jest.mock('@/lib/session-store', () => ({
  sessionStore: { createSession: jest.fn(async () => ({ sessionId: `orb_sess_v2_${'a'.repeat(64)}`, expiresAt: 123456 })) },
}));
jest.mock('@/lib/db', () => ({
  prisma: { user: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() } },
}));

describe('/api/auth/login', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns only the opaque v2 session contract', async () => {
    const user = { id: '1', uuid: 'user-123', email: 'test@example.com', name: 'Custom Name' };
    (validateAccessToken as jest.Mock).mockResolvedValue({ sub: 'user-123', email: user.email, name: 'OIDC Name', tags: ['admin'] });
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(user);
    (prisma.user.update as jest.Mock).mockResolvedValue(user);

    const response = await POST(new NextRequest('http://localhost:3333/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:3333' },
      body: JSON.stringify({ accessToken: 'valid-token' }),
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ version: 2, sessionId: `orb_sess_v2_${'a'.repeat(64)}`, expiresAt: 123456 });
    expect(response.cookies.get('user_session')).toBeUndefined();
    expect(response.cookies.get('admin_session_id')).toBeUndefined();
    expect(prisma.user.update).toHaveBeenCalledWith(expect.objectContaining({ data: { email: user.email, isGuest: false } }));
  });

  it('creates by validated subject only', async () => {
    const user = { id: '2', uuid: 'new-subject', email: 'new@example.com', name: 'New User' };
    (validateAccessToken as jest.Mock).mockResolvedValue({ sub: user.uuid, email: user.email, name: user.name });
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(null);
    (prisma.user.create as jest.Mock).mockResolvedValue(user);
    const response = await POST(new NextRequest('http://localhost:3333/api/auth/login', {
      method: 'POST', body: JSON.stringify({ accessToken: 'valid-token' }),
    }));
    expect(response.status).toBe(200);
    expect(prisma.user.create).toHaveBeenCalledWith({ data: { uuid: user.uuid, email: user.email, name: user.name, isGuest: false } });
  });

  it('fails closed when validated identity has no subject', async () => {
    (validateAccessToken as jest.Mock).mockResolvedValue({ email: 'test@example.com' });
    const response = await POST(new NextRequest('http://localhost:3333/api/auth/login', {
      method: 'POST', body: JSON.stringify({ accessToken: 'valid-token' }),
    }));
    expect(response.status).toBe(401);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('rejects cross-origin body login', async () => {
    const response = await POST(new NextRequest('http://localhost:3333/api/auth/login', {
      method: 'POST', headers: { Origin: 'https://evil.example' }, body: JSON.stringify({ accessToken: 'valid-token' }),
    }));
    expect(response.status).toBe(403);
    expect(validateAccessToken).not.toHaveBeenCalled();
  });
});
