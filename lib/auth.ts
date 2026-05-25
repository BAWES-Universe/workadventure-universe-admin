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
 * Throws 'Unauthorized' if no valid session exists.
 */
export async function requireAdminSession(): Promise<{ userId: string }> {
  const cookieStore = await cookies();
  
  // Build a minimal Request-like object for getSessionId
  const req = new NextRequest('http://localhost', {
    headers: {
      cookie: cookieStore.toString(),
    },
  });

  const sessionId = getSessionId(req);
  if (!sessionId) {
    throw new Error('Unauthorized');
  }

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

