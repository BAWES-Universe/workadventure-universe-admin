import { NextRequest } from 'next/server';
import { getSessionData } from './auth-token';
import { isSuperAdmin } from './super-admin';
import { prisma } from './db';

/**
 * The origin that a same-origin login POST must carry.
 *
 * Next.js's `request.nextUrl.origin` is built from the internal URL the reverse
 * proxy used to reach the app, which does NOT match the public origin (e.g.
 * https://orbit.bawes.net) when deployed behind Coolify/Traefik. Origin checks
 * must therefore anchor to the configured public origin and only fall back to
 * `nextUrl` for direct (non-proxied) deployments such as local dev.
 */
export function resolveExpectedLoginOrigin(configured: string | undefined, fallbackOrigin: string): string {
  if (configured) {
    try {
      const parsed = new URL(configured);
      // Only real http(s) origins can appear in a browser Origin header. Accepting
      // file:, mailto:, or any other scheme would produce an origin nothing can match.
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        return parsed.origin;
      }
    } catch {
      // fall through to fallback
    }
  }
  return fallbackOrigin;
}

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
  const headersList = await import('next/headers').then(m => m.headers());
  const auth = headersList.get('authorization');
  const sessionId = auth?.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : null;
  if (!sessionId) throw new Error('Unauthorized');

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
