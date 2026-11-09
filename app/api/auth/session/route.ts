import { NextRequest, NextResponse } from 'next/server';
import { exchangeOidcAccessToken, SessionExchangeError } from '@/lib/oidc-session-exchange';
import { getPlayOrigin, requestOrigin } from '@/lib/origin-policy';
import { isMobileOrigin } from '@/app/api/auth/redirect-uri';

export const runtime = 'nodejs';

function resolveAllowedOrigin(request: Request): string | null {
  const rawOrigin = request.headers.get('origin')?.trim() || '';
  const userAgent = request.headers.get('user-agent');
  if (isMobileOrigin(rawOrigin, userAgent)) {
    return rawOrigin;
  }
  const playOrigin = getPlayOrigin();
  if (requestOrigin(request) === playOrigin) {
    return playOrigin;
  }
  return null;
}

function corsResponse(request: Request, body: unknown, status = 200) {
  const result = status === 204 ? new NextResponse(null, { status }) : NextResponse.json(body, { status });
  result.headers.set('Cache-Control', 'no-store');
  result.headers.set('Vary', 'Origin');
  const allowedOrigin = resolveAllowedOrigin(request);
  if (allowedOrigin) {
    result.headers.set('Access-Control-Allow-Origin', allowedOrigin);
    result.headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    result.headers.set('Access-Control-Allow-Headers', 'Authorization');
  }
  return result;
}

function hasAllowedOrigin(request: Request): boolean {
  return resolveAllowedOrigin(request) !== null;
}

export async function OPTIONS(request: NextRequest) {
  return corsResponse(request, {}, hasAllowedOrigin(request) ? 204 : 403);
}

export async function POST(request: NextRequest) {
  if (!hasAllowedOrigin(request)) return corsResponse(request, { error: 'Origin not allowed' }, 403);

  const authorization = request.headers.get('authorization');
  const accessToken = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length).trim() : '';
  if (!accessToken) return corsResponse(request, { error: 'Missing access token' }, 400);

  try {
    return corsResponse(request, await exchangeOidcAccessToken(accessToken));
  } catch (error) {
    if (error instanceof SessionExchangeError) return corsResponse(request, { error: error.message }, error.status);
    console.error('[Session Exchange] Failed:', error);
    return corsResponse(request, { error: 'Internal server error' }, 500);
  }
}
