/** @jest-environment jsdom */

import {
  SESSION_EXPIRES_KEY,
  SESSION_STORAGE_KEY,
  authenticatedFetch,
  purgeAccountState,
  rememberPlayUri,
  storeClientSession,
} from '@/lib/client-auth';

describe('client session storage', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.localStorage.clear();
  });

  it('removes a stale expiry when a replacement session has no expiry', () => {
    window.sessionStorage.setItem(SESSION_EXPIRES_KEY, '1');

    storeClientSession(`orb_sess_v2_${'a'.repeat(64)}`);

    expect(window.sessionStorage.getItem(SESSION_STORAGE_KEY)).toBe(`orb_sess_v2_${'a'.repeat(64)}`);
    expect(window.sessionStorage.getItem(SESSION_EXPIRES_KEY)).toBeNull();
  });

  it('preserves an explicitly supplied zero expiry', () => {
    storeClientSession(`orb_sess_v2_${'b'.repeat(64)}`, 0);

    expect(window.sessionStorage.getItem(SESSION_EXPIRES_KEY)).toBe('0');
  });
});

describe('the room the game opened Orbit from', () => {
  const ROOM = 'http://play.test/@/uni/world/room';
  const sessionId = `orb_sess_v2_${'c'.repeat(64)}`;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    window.sessionStorage.clear();
    fetchMock = jest.fn().mockResolvedValue({ status: 200 });
    global.fetch = fetchMock as unknown as typeof fetch;
    storeClientSession(sessionId);
  });

  const sentHeaders = () => fetchMock.mock.calls[0][1].headers as Headers;

  it('goes with every request while Orbit is inside the game', async () => {
    rememberPlayUri(ROOM, true);
    await authenticatedFetch('/api/admin/users');
    expect(sentHeaders().get('X-Orbit-Play-Uri')).toBe(ROOM);
    expect(sentHeaders().get('Authorization')).toBe(`Bearer ${sessionId}`);
  });

  it('is never kept outside the game, for an address that is not http(s), or when the game gave none', async () => {
    rememberPlayUri(ROOM, false);
    rememberPlayUri('javascript:alert(1)', true);
    rememberPlayUri('not an address', true);
    rememberPlayUri(null, true);
    await authenticatedFetch('/api/admin/users');
    expect(sentHeaders().has('X-Orbit-Play-Uri')).toBe(false);
  });

  it('is replaced by the next visit, and forgotten when the next visit has none', async () => {
    rememberPlayUri(ROOM, true);
    rememberPlayUri('http://play.test/@/other/world/room', true);
    await authenticatedFetch('/api/admin/users');
    expect(sentHeaders().get('X-Orbit-Play-Uri')).toBe('http://play.test/@/other/world/room');
    fetchMock.mockClear();
    rememberPlayUri(null, true);
    await authenticatedFetch('/api/admin/users');
    expect(sentHeaders().has('X-Orbit-Play-Uri')).toBe(false);
  });

  it('is dropped with everything else Orbit keeps for an account', async () => {
    rememberPlayUri(ROOM, true);
    purgeAccountState();
    storeClientSession(sessionId);
    await authenticatedFetch('/api/admin/users');
    expect(sentHeaders().has('X-Orbit-Play-Uri')).toBe(false);
  });
});
