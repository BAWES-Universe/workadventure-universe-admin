import { NextRequest, NextResponse } from 'next/server';
import { exchangeOidcAccessToken, SessionExchangeError } from '@/lib/oidc-session-exchange';
import { resolveExpectedLoginOrigin } from '@/lib/auth';

export const runtime = 'nodejs';

function response(body: unknown, status = 200) {
  const result = NextResponse.json(body, { status });
  result.headers.set('Cache-Control', 'no-store');
  return result;
}

/**
 * Fail fast in production: the login origin check must never silently fall back
 * to request.nextUrl.origin (which is the internal proxy URL behind Coolify and
 * would reject every same-origin login POST). Require a real configured origin.
 * Dev/test keep the per-request nextUrl fallback for direct access.
 */
function loginExpectedOrigin(request: NextRequest): string {
  const configured = process.env.NEXT_PUBLIC_API_URL || process.env.ADMIN_API_URL;
  const expected = resolveExpectedLoginOrigin(configured, '');
  if (expected) {
    return expected;
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('NEXT_PUBLIC_API_URL or ADMIN_API_URL must be set in production for login origin validation');
  }
  return request.nextUrl.origin;
}

export async function POST(request: NextRequest) {
  const origin = request.headers.get('origin');
  if (origin) {
    // Computed before the try so a missing production config surfaces as a loud
    // 500 with a clear message instead of a silent 403.
    const expected = loginExpectedOrigin(request);
    try {
      if (new URL(origin).origin !== expected) return response({ error: 'Cross-origin login is not allowed' }, 403);
    } catch {
      return response({ error: 'Invalid origin' }, 403);
    }
  }

  try {
    const body: unknown = await request.json();
    const accessToken = typeof body === 'object' && body !== null && 'accessToken' in body
      ? (body as { accessToken?: unknown }).accessToken
      : null;
    if (typeof accessToken !== 'string' || !accessToken.trim()) {
      return response({ error: 'Access token required' }, 400);
    }
    return response(await exchangeOidcAccessToken(accessToken));
  } catch (error) {
    if (error instanceof SyntaxError) return response({ error: 'Invalid JSON body' }, 400);
    if (error instanceof SessionExchangeError) return response({ error: error.message }, error.status);
    console.error('[Login] Session exchange failed:', error);
    return response({ error: 'Internal server error' }, 500);
  }
}
