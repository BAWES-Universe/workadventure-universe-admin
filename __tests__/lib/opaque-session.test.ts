import { NextRequest } from 'next/server';
import { getSessionData, getSessionId } from '@/lib/auth-token';
import { isSessionId, sessionStore } from '@/lib/session-store';

describe('opaque iframe sessions', () => {
  const data = { userId: 'user-1', uuid: 'uuid-1', email: 'u@example.com', name: 'User', tags: ['admin'] };

  it('creates and resolves only opaque v2 IDs', async () => {
    const sessionId = await sessionStore.createSession(data);
    expect(isSessionId(sessionId)).toBe(true);
    await expect(getSessionData(sessionId)).resolves.toMatchObject(data);
  });

  it.each([
    JSON.stringify({ ...data, expiresAt: Date.now() + 60_000 }),
    Buffer.from(JSON.stringify({ ...data, expiresAt: Date.now() + 60_000 })).toString('base64'),
    'a'.repeat(64),
  ])('rejects forgeable legacy payload %s', async (credential) => {
    await expect(getSessionData(credential)).resolves.toBeNull();
  });

  it('ignores legacy cookies and URL parameters', () => {
    const forged = Buffer.from(JSON.stringify(data)).toString('base64');
    const request = new NextRequest(`https://orbit.example/admin?_token=${encodeURIComponent(forged)}`, {
      headers: { cookie: `user_session=${encodeURIComponent(JSON.stringify(data))}` },
    });
    expect(getSessionId(request)).toBeNull();
  });

  it('accepts a v2 ID only from Authorization', async () => {
    const sessionId = await sessionStore.createSession(data);
    const request = new NextRequest('https://orbit.example/api/auth/me', {
      headers: { authorization: `Bearer ${sessionId}` },
    });
    expect(getSessionId(request)).toBe(sessionId);
  });
});
