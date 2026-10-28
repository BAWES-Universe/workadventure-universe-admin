import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { isMobileOrigin } from '@/app/api/auth/redirect-uri';

/** Admin pages are a non-sensitive client shell. Authentication is enforced by
 * every data API with an opaque Authorization credential. This is intentional:
 * third-party cookies are unavailable in several supported iframe browsers. */
export function middleware(request: NextRequest) {
  const response = NextResponse.next();
  response.headers.set('Referrer-Policy', 'no-referrer');
  response.headers.set('X-Content-Type-Options', 'nosniff');

  // Allow mobile app deep-link / WebView origins to pass through with CORS headers and preflight support
  const origin = request.headers.get('origin')?.trim();
  if (origin && isMobileOrigin(origin) && request.nextUrl.pathname.startsWith('/api/auth')) {
    const corsHeaders: Record<string, string> = {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Vary': 'Origin',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    };
    if (request.method === 'OPTIONS') {
      return new NextResponse(null, { status: 204, headers: corsHeaders });
    }
    for (const [key, value] of Object.entries(corsHeaders)) {
      response.headers.set(key, value);
    }
  }

  // Never let old credential-bearing URLs become valid again.
  if (request.nextUrl.pathname.startsWith('/admin') &&
      (request.nextUrl.searchParams.has('_token') || request.nextUrl.searchParams.has('_session') || request.nextUrl.searchParams.has('accessToken'))) {
    const cleanUrl = request.nextUrl.clone();
    cleanUrl.searchParams.delete('_token');
    cleanUrl.searchParams.delete('_session');
    cleanUrl.searchParams.delete('accessToken');
    return NextResponse.redirect(cleanUrl);
  }
  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
};
