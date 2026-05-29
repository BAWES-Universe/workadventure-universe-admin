import { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { getSessionId, getSessionData } from './auth-token';
import { isSuperAdmin } from './super-admin';
import { prisma } from './db';

/**
 * Validates the Bearer token from the Authorization header
 */
export function validateAdminToken(request: Request | NextRequest): boolean {
  const authHeader = request.headers.get('authorization');
  
  if (!authHeader) {
    return false;
  }
  
  const token = authHeader.replace('Bearer ', '').trim();
  const expectedToken = process.env.ADMIN_API_TOKEN;
  
  if (!expectedToken) {
    throw new Error('ADMIN_API_TOKEN not configured');
  }
  
  return token === expectedToken;
}

/**
 * Requires authentication, throws error if not authenticated
 */
export function requireAuth(request: Request | NextRequest): void {
  if (!validateAdminToken(request)) {
    throw new Error('Unauthorized');
  }
}

/**
 * Gets the client IP address from request headers
 */
export function getClientIp(request: NextRequest): string {
  return (
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip') ||
    'unknown'
  );
}

/**
 * Require an admin session — validates that the caller has an active
 * OIDC session (from the admin web UI). Returns the acting user's ID.
 * Used by admin API routes that don't receive a request object.
 *
 * Reads session from: user_session cookie, admin_session_id cookie,
 * or _token URL query parameter (sent by authenticatedFetch).
 *
 * Throws 'Unauthorized' if no valid session exists.
 */
export async function requireAdminSession(): Promise<{ userId: string }> {
  const cookieStore = await cookies();
  const headersList = await import('next/headers').then(m => m.headers());

  // Try to find session ID/token from multiple sources
  let sessionId: string | null = null;

  // 1. Check user_session cookie (JSON session data)
  const userSession = cookieStore.get('user_session');
  if (userSession) {
    sessionId = userSession.value;
  }

  // 2. Check admin_session_id cookie
  if (!sessionId) {
    const sid = cookieStore.get('admin_session_id');
    if (sid) sessionId = sid.value;
  }

  // 3. Check Authorization header (Bearer token)
  if (!sessionId) {
    const auth = headersList.get('authorization');
    if (auth && auth.startsWith('Bearer ')) {
      sessionId = auth.replace('Bearer ', '').trim();
    }
  }

  // 4. Check _token URL query parameter (added by authenticatedFetch)
  if (!sessionId) {
    // The full URL including query params is needed — read from headers
    const proto = headersList.get('x-forwarded-proto') || 'http';
    const host = headersList.get('x-forwarded-host') || headersList.get('host') || 'localhost';
    const uri = headersList.get('x-forwarded-uri') || '';
    const fullUrl = `${proto}://${host}${uri}`;
    try {
      const url = new URL(fullUrl);
      const token = url.searchParams.get('_token');
      if (token) sessionId = token;
    } catch {
      // URL parsing failed, ignore
    }
  }

  // 5. Check _session URL query parameter (fallback)
  if (!sessionId) {
    const proto = headersList.get('x-forwarded-proto') || 'http';
    const host = headersList.get('x-forwarded-host') || headersList.get('host') || 'localhost';
    const uri = headersList.get('x-forwarded-uri') || '';
    const fullUrl = `${proto}://${host}${uri}`;
    try {
      const url = new URL(fullUrl);
      const session = url.searchParams.get('_session');
      if (session) sessionId = session;
    } catch {
      // URL parsing failed, ignore
    }
  }

  if (!sessionId) {
    console.error('[requireAdminSession] No session ID found from cookies or URL');
    throw new Error('Unauthorized');
  }

  // URL-decode in case the token came URL-encoded
  sessionId = decodeURIComponent(sessionId);

  console.error('[requireAdminSession] sessionId prefix:', sessionId.substring(0, 30), 'length:', sessionId.length, 'starts with base64?', /^[A-Za-z0-9+/=]+$/.test(sessionId.substring(0, 10)));

  const session = await getSessionData(sessionId);
  if (!session) {
    throw new Error('Unauthorized');
  }

  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { id: true, email: true },
  });

  if (!user) {
    throw new Error('Unauthorized');
  }

  return { userId: user.id };
}

/**
 * Requires the caller to be a super admin (authenticated session + super admin email).
 * Throws 'Unauthorized' or 'Forbidden' if the check fails.
 */
export async function requireSuperAdminSession(): Promise<{ userId: string }> {
  const { userId } = await requireAdminSession();

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true },
  });

  if (!user || !isSuperAdmin(user.email)) {
    throw new Error('Forbidden');
  }

  return { userId };
}

