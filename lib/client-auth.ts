export const SESSION_STORAGE_KEY = 'orbit_session_v2';
export const SESSION_EXPIRES_KEY = 'orbit_session_v2_expires';
/** Universe user uuid the stored session belongs to, recorded at login. */
export const SESSION_USER_KEY = 'orbit_session_v2_user';

/** localStorage keys Orbit may hold per account; anything else (e.g. theme) is per browser. */
const ACCOUNT_LOCAL_STORAGE_PREFIXES = ['orbit', 'admin_'];

export function isOpaqueSessionId(value: unknown): value is string {
  return typeof value === 'string' && /^orb_sess_v2_[0-9a-f]{64}$/.test(value);
}

export function getClientSessionId(): string | null {
  if (typeof window === 'undefined') return null;
  const sessionId = window.sessionStorage.getItem(SESSION_STORAGE_KEY);
  if (!isOpaqueSessionId(sessionId)) {
    if (sessionId) clearClientSession();
    return null;
  }
  return sessionId;
}

export function storeClientSession(sessionId: string, expiresAt?: number, userUuid?: string | null): void {
  if (!isOpaqueSessionId(sessionId)) throw new Error('Invalid Orbit session');
  window.sessionStorage.setItem(SESSION_STORAGE_KEY, sessionId);
  if (expiresAt !== undefined) {
    window.sessionStorage.setItem(SESSION_EXPIRES_KEY, String(expiresAt));
  } else {
    window.sessionStorage.removeItem(SESSION_EXPIRES_KEY);
  }
  if (userUuid) {
    window.sessionStorage.setItem(SESSION_USER_KEY, userUuid);
  } else {
    window.sessionStorage.removeItem(SESSION_USER_KEY);
  }
  window.localStorage.removeItem('admin_session_id');
  window.localStorage.removeItem('admin_session_token');
  window.localStorage.removeItem('admin_session_expires');
}

export function clearClientSession(): void {
  if (typeof window === 'undefined') return;
  window.sessionStorage.removeItem(SESSION_STORAGE_KEY);
  window.sessionStorage.removeItem(SESSION_EXPIRES_KEY);
  window.sessionStorage.removeItem(SESSION_USER_KEY);
  window.localStorage.removeItem('admin_session_id');
  window.localStorage.removeItem('admin_session_token');
  window.localStorage.removeItem('admin_session_expires');
}

export function getStoredSessionUser(): string | null {
  if (typeof window === 'undefined') return null;
  return window.sessionStorage.getItem(SESSION_USER_KEY) || null;
}

/**
 * Drop everything Orbit keeps for an account in this tab: the session, its
 * identity and every sessionStorage entry (the iframe's sessionStorage is
 * Orbit's alone), plus Orbit's per-account localStorage keys. In-memory state
 * (bootstrap context, WA scripting API subscriptions, pending bridge calls) is
 * dropped by the full document load that follows every login.
 */
export function purgeAccountState(): void {
  if (typeof window === 'undefined') return;
  clearClientSession();
  window.sessionStorage.clear();
  const localKeys: string[] = [];
  for (let index = 0; index < window.localStorage.length; index++) {
    const key = window.localStorage.key(index);
    if (key && ACCOUNT_LOCAL_STORAGE_PREFIXES.some((prefix) => key.startsWith(prefix))) localKeys.push(key);
  }
  for (const key of localKeys) window.localStorage.removeItem(key);
}

/**
 * Per-account state in this tab may only be kept when it is known to belong to
 * the user the game's handshake just signed in. Anything unknown is a mismatch.
 */
export function belongsToHandshakeUser(storedUserUuid: string | null, handshakeUserUuid: string | null): boolean {
  return storedUserUuid !== null && handshakeUserUuid !== null && storedUserUuid === handshakeUserUuid;
}

export interface HandshakeSession {
  sessionId: string;
  expiresAt?: number;
  /** Universe user uuid of the handshake's session, or null when it could not be confirmed. */
  userUuid: string | null;
}

/**
 * Store the session the game's handshake produced. The previously stored
 * session is never reused: it is revoked, and when it belonged to someone else
 * (or its owner is unknown) every per-account cache in this tab is cleared too.
 */
export function adoptHandshakeSession(incoming: HandshakeSession): { accountChanged: boolean } {
  const previousSessionId = getClientSessionId();
  const sameAccount = belongsToHandshakeUser(getStoredSessionUser(), incoming.userUuid);
  if (sameAccount) clearClientSession();
  else purgeAccountState();
  if (previousSessionId && previousSessionId !== incoming.sessionId) {
    void fetch('/api/auth/logout', {
      method: 'POST',
      headers: { Authorization: `Bearer ${previousSessionId}` },
      credentials: 'omit',
      keepalive: true,
    }).catch(() => undefined);
  }
  storeClientSession(incoming.sessionId, incoming.expiresAt, incoming.userUuid);
  return { accountChanged: !sameAccount };
}

export function isSessionExpired(): boolean {
  if (typeof window === 'undefined') return false;
  const expiresAt = window.sessionStorage.getItem(SESSION_EXPIRES_KEY);
  return expiresAt !== null && Date.now() >= Number(expiresAt);
}

export const isTokenExpired = isSessionExpired;
export const clearSession = clearClientSession;

export function getAuthHeaders(): HeadersInit {
  const sessionId = getClientSessionId();
  return sessionId ? { Authorization: `Bearer ${sessionId}` } : {};
}

export async function authenticatedFetch(url: string, options: RequestInit = {}): Promise<Response> {
  if (isSessionExpired()) clearClientSession();
  const sessionId = getClientSessionId();
  const headers = new Headers(options.headers);
  if (sessionId) headers.set('Authorization', `Bearer ${sessionId}`);
  if (options.body && !(options.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const response = await fetch(url, { ...options, headers, credentials: 'omit' });
  if (response.status === 401) clearClientSession();
  return response;
}
