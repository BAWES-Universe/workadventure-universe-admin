import { NextRequest, NextResponse } from 'next/server';
import { exchangeOidcAccessToken, SessionExchangeError } from '@/lib/oidc-session-exchange';
import { resolveExpectedLoginOrigin } from '@/lib/auth';
import {
  isMobileOrigin,
  isValidRedirectUri,
} from '@/app/api/auth/redirect-uri';

export const runtime = 'nodejs';

function applyMobileCorsHeaders(result: NextResponse, request?: NextRequest): NextResponse {
  result.headers.set('Cache-Control', 'no-store');
  if (!request) return result;
  const rawOrigin = request.headers.get('origin')?.trim() || '';
  const userAgent = request.headers.get('user-agent');
  if (rawOrigin && isMobileOrigin(rawOrigin, userAgent)) {
    result.headers.set('Access-Control-Allow-Origin', rawOrigin);
    result.headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    result.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    result.headers.set('Vary', 'Origin');
  }
  return result;
}

function response(body: unknown, status = 200, request?: NextRequest) {
  return applyMobileCorsHeaders(NextResponse.json(body, { status }), request);
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

export async function OPTIONS(request: NextRequest) {
  const rawOrigin = request.headers.get('origin')?.trim() || '';
  const userAgent = request.headers.get('user-agent');
  let allowedOrigin: string | null = null;
  if (rawOrigin && isMobileOrigin(rawOrigin, userAgent)) {
    allowedOrigin = rawOrigin;
  } else if (rawOrigin) {
    const expected = loginExpectedOrigin(request);
    try {
      if (new URL(rawOrigin).origin === expected) {
        allowedOrigin = expected;
      }
    } catch {
      allowedOrigin = null;
    }
  }
  if (!allowedOrigin) {
    const denied = NextResponse.json({ error: 'Cross-origin login is not allowed' }, { status: 403 });
    denied.headers.set('Cache-Control', 'no-store');
    denied.headers.set('Vary', 'Origin');
    return denied;
  }
  const preflight = new NextResponse(null, { status: 204 });
  preflight.headers.set('Cache-Control', 'no-store');
  preflight.headers.set('Access-Control-Allow-Origin', allowedOrigin);
  preflight.headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  preflight.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  preflight.headers.set('Vary', 'Origin');
  return preflight;
}

export async function POST(request: NextRequest) {
  const origin = request.headers.get('origin');
  const userAgent = request.headers.get('user-agent');
  if (origin && !isMobileOrigin(origin, userAgent)) {
    // Computed before the try so a missing production config surfaces as a loud
    // 500 with a clear message instead of a silent 403.
    const expected = loginExpectedOrigin(request);
    try {
      if (new URL(origin).origin !== expected) return response({ error: 'Cross-origin login is not allowed' }, 403, request);
    } catch {
      return response({ error: 'Invalid origin' }, 403, request);
    }
  }

  try {
    const body: unknown = await request.json();
    const rawRedirectUri =
      typeof body === 'object' && body !== null
        ? (body as { redirectUri?: unknown; redirect_uri?: unknown }).redirectUri ??
          (body as { redirectUri?: unknown; redirect_uri?: unknown }).redirect_uri
        : undefined;
    let validatedRedirectUri: string | undefined;
    if (rawRedirectUri !== undefined && rawRedirectUri !== null) {
      const fallbackOrigin =
        process.env.NODE_ENV === 'production' ? undefined : request.nextUrl.origin;
      if (typeof rawRedirectUri !== 'string' || !isValidRedirectUri(rawRedirectUri, fallbackOrigin)) {
        return response({ error: 'Invalid redirect_uri' }, 400, request);
      }
      validatedRedirectUri = rawRedirectUri.trim();
    }
    const accessToken = typeof body === 'object' && body !== null && 'accessToken' in body
      ? (body as { accessToken?: unknown }).accessToken
      : null;
    if (typeof accessToken !== 'string' || !accessToken.trim()) {
      return response({ error: 'Access token required' }, 400, request);
    }
    const session = await exchangeOidcAccessToken(accessToken);
    if (validatedRedirectUri) {
      return response({ ...session, redirectUri: validatedRedirectUri }, 200, request);
    }
    return response(session, 200, request);
  } catch (error) {
    if (error instanceof SyntaxError) return response({ error: 'Invalid JSON body' }, 400, request);
    if (error instanceof SessionExchangeError) return response({ error: error.message }, error.status, request);
    console.error('[Login] Session exchange failed:', error);
    return response({ error: 'Internal server error' }, 500, request);
  }
}
