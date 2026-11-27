import { NextRequest, NextResponse } from 'next/server';
import { exchangeOidcAccessToken, SessionExchangeError } from '@/lib/oidc-session-exchange';
import { resolveExpectedLoginOrigin } from '@/lib/auth';
import {
  isMobileOrigin,
  isValidRedirectUri,
  resolveRedirectUri,
} from '@/app/api/auth/redirect-uri';

export const runtime = 'nodejs';

function response(request: NextRequest, body: unknown, status = 200) {
  const result = status === 204 ? new NextResponse(null, { status }) : NextResponse.json(body, { status });
  result.headers.set('Cache-Control', 'no-store');
  const origin = request.headers.get('origin')?.trim();
  if (origin && isMobileOrigin(origin)) {
    result.headers.set('Access-Control-Allow-Origin', origin);
    result.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    result.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    result.headers.set('Vary', 'Origin');
  }
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

export async function OPTIONS(request: NextRequest) {
  const origin = request.headers.get('origin')?.trim();
  if (origin && isMobileOrigin(origin)) {
    return response(request, {}, 204);
  }
  return response(request, { error: 'Cross-origin preflight is not allowed' }, 403);
}

export async function GET(request: NextRequest) {
  const requestedRedirectUri =
    request.nextUrl.searchParams.get('redirect_uri') ??
    request.nextUrl.searchParams.get('redirectUri');
  const userAgent = request.headers.get('user-agent');
  const fallbackOrigin = process.env.NODE_ENV === 'production' ? '' : request.nextUrl.origin;

  const resolved = resolveRedirectUri({
    requestedRedirectUri,
    userAgent,
    fallbackOrigin,
  });

  if (!resolved.valid) {
    return response(request, { error: 'Invalid redirect_uri' }, 400);
  }

  return response(request, {
    redirectUri: resolved.redirectUri,
    isMobile: resolved.isMobile,
  });
}

export async function POST(request: NextRequest) {
  const origin = request.headers.get('origin');
  if (origin && !isMobileOrigin(origin)) {
    // Computed before the try so a missing production config surfaces as a loud
    // 500 with a clear message instead of a silent 403.
    const expected = loginExpectedOrigin(request);
    try {
      if (new URL(origin).origin !== expected) return response(request, { error: 'Cross-origin login is not allowed' }, 403);
    } catch {
      return response(request, { error: 'Invalid origin' }, 403);
    }
  }

  try {
    const body: unknown = await request.json();
    const record = typeof body === 'object' && body !== null
      ? (body as Record<string, unknown>)
      : null;

    const requestedRedirectUri =
      typeof record?.redirect_uri === 'string'
        ? record.redirect_uri
        : typeof record?.redirectUri === 'string'
          ? record.redirectUri
          : null;

    if (requestedRedirectUri !== null) {
      const fallbackOrigin = process.env.NODE_ENV === 'production' ? '' : request.nextUrl.origin;
      if (!isValidRedirectUri(requestedRedirectUri, fallbackOrigin)) {
        return response(request, { error: 'Invalid redirect_uri' }, 400);
      }
    }

    const accessToken = record && 'accessToken' in record ? record.accessToken : null;
    if (typeof accessToken !== 'string' || !accessToken.trim()) {
      return response(request, { error: 'Access token required' }, 400);
    }

    const session = await exchangeOidcAccessToken(accessToken);
    if (requestedRedirectUri !== null) {
      return response(request, { ...session, redirectUri: requestedRedirectUri.trim() });
    }
    return response(request, session);
  } catch (error) {
    if (error instanceof SyntaxError) return response(request, { error: 'Invalid JSON body' }, 400);
    if (error instanceof SessionExchangeError) return response(request, { error: error.message }, error.status);
    console.error('[Login] Session exchange failed:', error);
    return response(request, { error: 'Internal server error' }, 500);
  }
}
