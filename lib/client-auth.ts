export const SESSION_STORAGE_KEY = 'orbit_session_v2';
export const SESSION_EXPIRES_KEY = 'orbit_session_v2_expires';

export function getClientSessionId(): string | null {
  if (typeof window === 'undefined') return null;
  return window.sessionStorage.getItem(SESSION_STORAGE_KEY);
}

export function storeClientSession(sessionId: string, expiresAt?: number): void {
  window.sessionStorage.setItem(SESSION_STORAGE_KEY, sessionId);
  if (expiresAt) window.sessionStorage.setItem(SESSION_EXPIRES_KEY, String(expiresAt));
  window.localStorage.removeItem('admin_session_id');
  window.localStorage.removeItem('admin_session_token');
  window.localStorage.removeItem('admin_session_expires');
}

export function clearClientSession(): void {
  if (typeof window === 'undefined') return;
  window.sessionStorage.removeItem(SESSION_STORAGE_KEY);
  window.sessionStorage.removeItem(SESSION_EXPIRES_KEY);
  window.localStorage.removeItem('admin_session_id');
  window.localStorage.removeItem('admin_session_token');
  window.localStorage.removeItem('admin_session_expires');
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
