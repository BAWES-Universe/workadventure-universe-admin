import { NextRequest } from 'next/server';

// Lazy-load session store to avoid Edge runtime bundling issues
// Only import when actually needed (in async functions that run in Node.js runtime)
let sessionStore: typeof import('./session-store').sessionStore | null = null;

async function getSessionStore() {
  if (!sessionStore) {
    const module = await import('./session-store');
    sessionStore = module.sessionStore;
  }
  return sessionStore;
}

/**
 * Get session ID from request (checks cookie first, then URL param for iframe scenarios)
 */
export function getSessionId(request: NextRequest): string | null {
  // Check user_session cookie first (contains full session data - preferred)
  // This works even if the in-memory store is not shared between processes
  const userSessionCookie = request.cookies.get('user_session');
  if (userSessionCookie) {
    // Return the cookie value - it contains JSON session data
    return userSessionCookie.value;
  }
  
  // Check admin_session_id cookie (session ID for store lookup)
  const sessionIdCookie = request.cookies.get('admin_session_id');
  if (sessionIdCookie) {
    return sessionIdCookie.value;
  }
  
  // Check URL query parameter _token (base64 encoded session data - for iframes)
  const urlToken = request.nextUrl.searchParams.get('_token');
  if (urlToken) {
    return urlToken;
  }
  
  // Check URL query parameter _session (session ID - fallback)
  const urlSessionId = request.nextUrl.searchParams.get('_session');
  if (urlSessionId) {
    return urlSessionId;
  }
  
  // Check Authorization header (for API requests)
  const authHeader = request.headers.get('authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.replace('Bearer ', '').trim();
  }
  
  return null;
}

/**
 * Get authentication token from request (legacy function name, now uses session IDs)
 * @deprecated Use getSessionId instead
 */
export function getAuthToken(request: NextRequest): string | null {
  return getSessionId(request);
}

/**
 * Get session data from session ID or legacy token
 * First tries to get from session store (new secure method)
 * Falls back to parsing legacy token format
 */
export async function getSessionData(sessionIdOrToken: string): Promise<{
  userId: string;
  uuid: string;
  email: string | null;
  name: string | null;
  tags: string[];
  createdAt: number;
  expiresAt: number;
} | null> {
  // Try to get from session store first (new secure method)
  // Only try if it looks like a session ID (64 hex chars)
  // Legacy tokens are longer base64 strings
  const isLikelySessionId = sessionIdOrToken.length === 64 && /^[0-9a-f]+$/.test(sessionIdOrToken);
  
  if (isLikelySessionId) {
    // Only try to get from store if we're in Node.js runtime (not Edge)
    // In Edge runtime, session IDs won't work - need to use tokens
    try {
      const store = await getSessionStore();
      const session = await store.getSession(sessionIdOrToken);
      if (session) {
        return session;
      }
      // If session ID format but not found in store, return null (don't try legacy parsing)
      if (process.env.NODE_ENV === 'development') {
        console.log('[Auth] Session ID not found in store:', sessionIdOrToken.substring(0, 8) + '...');
      }
      return null;
    } catch (error) {
      // If session store is not available (Edge runtime), return null
      // This allows fallback to token parsing
      if (process.env.NODE_ENV === 'development') {
        console.log('[Auth] Session store not available (likely Edge runtime), skipping store lookup');
      }
      return null;
    }
  }

  // Fallback to legacy token parsing (for backward compatibility)
  try {
    // Try to decode as base64 first (from localStorage token)
    const decoded = Buffer.from(sessionIdOrToken, 'base64').toString('utf-8');
    const legacySession = JSON.parse(decoded);
    
    // Check expiration
    if (legacySession.expiresAt && Date.now() > legacySession.expiresAt) {
      return null; // Expired
    }
    
    return legacySession;
  } catch {
    // If base64 decode fails, try direct JSON parse (from cookie)
    try {
      const legacySession = JSON.parse(sessionIdOrToken);
      
      // Check expiration
      if (legacySession.expiresAt && Date.now() > legacySession.expiresAt) {
        return null; // Expired
      }
      
      return legacySession;
    } catch {
      return null; // Invalid format
    }
  }
}

/**
 * Parse and validate session token (legacy function name)
 * @deprecated Use getSessionData instead
 */
export async function parseSessionToken(token: string): Promise<{
  userId: string;
  uuid: string;
  email: string | null;
  name: string | null;
  tags: string[];
  createdAt: number;
  expiresAt: number;
}> {
  const session = await getSessionData(token);
  if (!session) {
    throw new Error('Invalid or expired session token');
  }
  return session;
}

