import { NextRequest, NextResponse } from 'next/server';
import { exchangeOidcAccessToken, SessionExchangeError } from '@/lib/oidc-session-exchange';
import { getPlayOrigin, requestOrigin } from '@/lib/origin-policy';
import { isAllowedMobileOrigin } from '../mobile-redirect';

export const runtime = 'nodejs';

interface CorsPayload {
  body: unknown;
  status?: number;
}

/**
 * Resolves the allowed CORS origin for session exchange: either the configured
 * Universe play origin or an allowlisted native mobile/Capacitor origin.
 */
function resolveAllowedOrigin(request: Request): string | null {
  const rawOrigin = request.headers.get('origin')?.trim() ?? '';
  if (!rawOrigin) {
    return null;
  }
  if (isAllowedMobileOrigin(rawOrigin)) {
    return rawOrigin;
  }
  if (requestOrigin(request) === getPlayOrigin()) {
    return getPlayOrigin();
  }
  return null;
}

function corsResponse(request: Request, payload: CorsPayload): NextResponse {
  const status = payload.status ?? 200;
  const result = status === 204 ? new NextResponse(null, { status }) : NextResponse.json(payload.body, { status });
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

function extractBearerToken(request: Request): string {
  const authorization = request.headers.get('authorization') ?? '';
  return authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length).trim() : '';
}

export async function OPTIONS(request: NextRequest) {
  const allowed = resolveAllowedOrigin(request) !== null;
  return corsResponse(request, { body: {}, status: allowed ? 204 : 403 });
}

export async function POST(request: NextRequest) {
  if (!resolveAllowedOrigin(request)) {
    return corsResponse(request, { body: { error: 'Origin not allowed' }, status: 403 });
  }

  const accessToken = extractBearerToken(request);
  if (!accessToken) {
    return corsResponse(request, { body: { error: 'Missing access token' }, status: 400 });
  }

  try {
    const exchanged = await exchangeOidcAccessToken(accessToken);
    return corsResponse(request, { body: exchanged });
  } catch (error) {
    if (error instanceof SessionExchangeError) {
      return corsResponse(request, { body: { error: error.message }, status: error.status });
    }
    console.error('[Session Exchange] Failed:', error);
    return corsResponse(request, { body: { error: 'Internal server error' }, status: 500 });
  }
}
