import { NextRequest, NextResponse } from 'next/server';
import { exchangeOidcAccessToken, SessionExchangeError } from '@/lib/oidc-session-exchange';
import { resolveExpectedLoginOrigin } from '@/lib/auth';
import {
  buildMobileCallbackRedirectUrl,
  getAllowedRedirectUris,
  getMobileRedirectUri,
  isAllowedMobileOrigin,
  isCapacitorWebViewUserAgent,
  isMobileDeepLinkUri,
  isValidRedirectUri,
} from '../mobile-redirect';

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

function validateOriginHeader(request: NextRequest): NextResponse | null {
  const origin = request.headers.get('origin');
  if (!origin || isAllowedMobileOrigin(origin)) {
    return null;
  }
  const expected = loginExpectedOrigin(request);
  try {
    return new URL(origin).origin === expected
      ? null
      : response({ error: 'Cross-origin login is not allowed' }, 403);
  } catch {
    return response({ error: 'Invalid origin' }, 403);
  }
}

function extractStringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value.trim() : '';
}

function queryRedirectParam(request: NextRequest): string {
  const snakeCase = request.nextUrl.searchParams.get('redirect_uri');
  const camelCase = request.nextUrl.searchParams.get('redirectUri');
  return (snakeCase ?? camelCase ?? '').trim();
}

interface ParsedLoginPayload {
  accessToken: string;
  redirectUri: string;
}

function parseLoginBody(body: unknown, request: NextRequest): ParsedLoginPayload {
  const record = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const accessToken = extractStringField(record, 'accessToken');
  const bodyRedirect = extractStringField(record, 'redirectUri') || extractStringField(record, 'redirect_uri');
  return {
    accessToken,
    redirectUri: bodyRedirect || queryRedirectParam(request),
  };
}

function resolveGetRedirectUri(request: NextRequest): string {
  const explicit = queryRedirectParam(request);
  if (explicit) {
    return explicit;
  }
  const isMobileUa = isCapacitorWebViewUserAgent(request.headers.get('user-agent'));
  return isMobileUa ? getMobileRedirectUri() : `${loginExpectedOrigin(request)}/admin/login`;
}

function extractCallbackParams(request: NextRequest): Record<string, string | undefined> {
  const params = request.nextUrl.searchParams;
  return {
    code: params.get('code') ?? undefined,
    state: params.get('state') ?? undefined,
    accessToken: params.get('accessToken') ?? params.get('_token') ?? undefined,
  };
}

function shouldRedirectToDeepLink(redirectUri: string, params: Record<string, string | undefined>): boolean {
  if (!isMobileDeepLinkUri(redirectUri)) {
    return false;
  }
  return Boolean(params.code || params.accessToken);
}

/**
 * Resolves and validates OIDC redirect URIs for WebView and mobile deep-link
 * callbacks (`bawes://callback`) during login discovery and callback handoff.
 */
export async function GET(request: NextRequest) {
  const redirectUri = resolveGetRedirectUri(request);
  if (!isValidRedirectUri(redirectUri, request.nextUrl)) {
    return response({ error: 'Invalid redirect_uri' }, 400);
  }
  const params = extractCallbackParams(request);
  if (shouldRedirectToDeepLink(redirectUri, params)) {
    const deepLinkTarget = buildMobileCallbackRedirectUrl({ redirectUri, params });
    const redirectResult = NextResponse.redirect(deepLinkTarget, 302);
    redirectResult.headers.set('Cache-Control', 'no-store');
    return redirectResult;
  }
  return response({
    redirectUri,
    allowedRedirectUris: getAllowedRedirectUris(request.nextUrl),
  });
}

function handleLoginError(error: unknown): NextResponse {
  if (error instanceof SyntaxError) {
    return response({ error: 'Invalid JSON body' }, 400);
  }
  if (error instanceof SessionExchangeError) {
    return response({ error: error.message }, error.status);
  }
  console.error('[Login] Session exchange failed:', error);
  return response({ error: 'Internal server error' }, 500);
}

export async function POST(request: NextRequest) {
  const originError = validateOriginHeader(request);
  if (originError) {
    return originError;
  }
  try {
    const { accessToken, redirectUri } = parseLoginBody(await request.json(), request);
    if (!accessToken) {
      return response({ error: 'Access token required' }, 400);
    }
    if (redirectUri && !isValidRedirectUri(redirectUri, request.nextUrl)) {
      return response({ error: 'Invalid redirect_uri' }, 400);
    }
    const session = await exchangeOidcAccessToken(accessToken);
    return response(redirectUri ? { ...session, redirectUri } : session);
  } catch (error) {
    return handleLoginError(error);
  }
}
