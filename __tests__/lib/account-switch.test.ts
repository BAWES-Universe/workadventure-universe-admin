/** @jest-environment jsdom */

import {
  SESSION_EXPIRES_KEY,
  SESSION_STORAGE_KEY,
  SESSION_USER_KEY,
  adoptHandshakeSession,
  belongsToHandshakeUser,
  getClientSessionId,
  getStoredSessionUser,
  storeClientSession,
} from '@/lib/client-auth';

const SESSION_A = `orb_sess_v2_${'a'.repeat(64)}`;
const SESSION_B = `orb_sess_v2_${'b'.repeat(64)}`;

describe('same-tab account switch', () => {
  const fetchMock = jest.fn(async () => new Response('{}'));

  beforeEach(() => {
    window.sessionStorage.clear();
    window.localStorage.clear();
    fetchMock.mockClear();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it('only keeps account state for a known, identical user', () => {
    expect(belongsToHandshakeUser('uuid-a', 'uuid-a')).toBe(true);
    expect(belongsToHandshakeUser('uuid-a', 'uuid-b')).toBe(false);
    expect(belongsToHandshakeUser(null, 'uuid-a')).toBe(false);
    expect(belongsToHandshakeUser('uuid-a', null)).toBe(false);
    expect(belongsToHandshakeUser(null, null)).toBe(false);
  });

  it('clears the stored session of user A and every cache when the handshake is for user B', () => {
    storeClientSession(SESSION_A, 999, 'uuid-a');
    window.sessionStorage.setItem('orbit_auth_suppressed', 'true');
    window.sessionStorage.setItem('orbit.cache.bootstrap', '{"user":"a"}');
    window.localStorage.setItem('orbit.cache.worlds', '["a-world"]');
    window.localStorage.setItem('admin_session_id', 'legacy-a');
    window.localStorage.setItem('theme', 'dark');

    const result = adoptHandshakeSession({ sessionId: SESSION_B, expiresAt: 1234, userUuid: 'uuid-b' });

    expect(result.accountChanged).toBe(true);
    expect(getClientSessionId()).toBe(SESSION_B);
    expect(getClientSessionId()).not.toBe(SESSION_A);
    expect(getStoredSessionUser()).toBe('uuid-b');
    expect(window.sessionStorage.getItem(SESSION_EXPIRES_KEY)).toBe('1234');
    expect(window.sessionStorage.getItem('orbit_auth_suppressed')).toBeNull();
    expect(window.sessionStorage.getItem('orbit.cache.bootstrap')).toBeNull();
    expect(window.localStorage.getItem('orbit.cache.worlds')).toBeNull();
    expect(window.localStorage.getItem('admin_session_id')).toBeNull();
    // Browser-wide, not per account.
    expect(window.localStorage.getItem('theme')).toBe('dark');
    // A's old session is revoked with A's own credential.
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/logout', expect.objectContaining({
      method: 'POST',
      headers: { Authorization: `Bearer ${SESSION_A}` },
    }));
  });

  it('treats a stored session with no recorded owner as a different account', () => {
    window.sessionStorage.setItem(SESSION_STORAGE_KEY, SESSION_A);
    window.sessionStorage.setItem('orbit.cache.bootstrap', 'old');

    expect(adoptHandshakeSession({ sessionId: SESSION_B, userUuid: 'uuid-b' }).accountChanged).toBe(true);
    expect(getClientSessionId()).toBe(SESSION_B);
    expect(window.sessionStorage.getItem('orbit.cache.bootstrap')).toBeNull();
  });

  it('clears caches when the handshake user cannot be confirmed', () => {
    storeClientSession(SESSION_A, undefined, 'uuid-a');
    window.localStorage.setItem('orbit.cache.worlds', 'old');

    expect(adoptHandshakeSession({ sessionId: SESSION_B, userUuid: null }).accountChanged).toBe(true);
    expect(window.localStorage.getItem('orbit.cache.worlds')).toBeNull();
    expect(window.sessionStorage.getItem(SESSION_USER_KEY)).toBeNull();
  });

  it('keeps caches for the same user but still replaces the stored session', () => {
    storeClientSession(SESSION_A, 1, 'uuid-a');
    window.localStorage.setItem('orbit.cache.worlds', 'kept');

    expect(adoptHandshakeSession({ sessionId: SESSION_B, expiresAt: 2, userUuid: 'uuid-a' }).accountChanged).toBe(false);
    expect(getClientSessionId()).toBe(SESSION_B);
    expect(window.localStorage.getItem('orbit.cache.worlds')).toBe('kept');
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/logout', expect.anything());
  });
});
