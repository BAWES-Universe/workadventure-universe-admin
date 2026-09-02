/** @jest-environment jsdom */

import {
  SESSION_EXPIRES_KEY,
  SESSION_STORAGE_KEY,
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
