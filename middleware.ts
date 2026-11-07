import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { isAllowedMobileOrigin } from '@/app/api/auth/mobile-redirect';

const LEGACY_CREDENTIAL_PARAMS: readonly string[] = ['_token', '_session', 'accessToken'];

function hasLegacyCredentialParam(request: NextRequest): boolean {
  if (!request.nextUrl.pathname.startsWith('/admin')) {
    return false;
  }
  return LEGACY_CREDENTIAL_PARAMS.some((param) => request.nextUrl.searchParams.has(param));
}

function stripLegacyCredentialParams(request: NextRequest): NextResponse {
  const cleanUrl = request.nextUrl.clone();
  for (const param of LEGACY_CREDENTIAL_PARAMS) {
    cleanUrl.searchParams.delete(param);
  }
  return NextResponse.redirect(cleanUrl);
}

/**
 * Applies CORS headers for native mobile (`bawes://`) and Capacitor WebView
 * origins on `/api/auth` endpoints so WebView authentication requests pass
 * cleanly without origin blocking.
 */
function applyMobileAuthOriginHeaders(request: NextRequest, response: NextResponse): void {
  if (!request.nextUrl.pathname.startsWith('/api/auth')) {
    return;
  }
  const origin = request.headers.get('origin')?.trim() ?? '';
  if (!origin || !isAllowedMobileOrigin(origin)) {
    return;
  }
  response.headers.set('Access-Control-Allow-Origin', origin);
  response.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  response.headers.set('Vary', 'Origin');
}

/** Admin pages are a non-sensitive client shell. Authentication is enforced by
 * every data API with an opaque Authorization credential. This is intentional:
 * third-party cookies are unavailable in several supported iframe browsers. */
export function middleware(request: NextRequest) {
  if (hasLegacyCredentialParam(request)) {
    return stripLegacyCredentialParams(request);
  }

  const response = NextResponse.next();
  response.headers.set('Referrer-Policy', 'no-referrer');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  applyMobileAuthOriginHeaders(request, response);
  return response;
}

export const config = {
  // Not the artifact routes: they are called by servers, never a browser, and a song or video sent to them (#1510) is
  // larger than the body Next lets through a middleware (10 MB, cut off past that)
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api/artifacts(?:/|$)|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
};
