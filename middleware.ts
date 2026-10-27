import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/** Admin pages are a non-sensitive client shell. Authentication is enforced by
 * every data API with an opaque Authorization credential. This is intentional:
 * third-party cookies are unavailable in several supported iframe browsers. */
export function middleware(request: NextRequest) {
  const response = NextResponse.next();
  response.headers.set('Referrer-Policy', 'no-referrer');
  response.headers.set('X-Content-Type-Options', 'nosniff');

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
  // Not the artifact routes: they are called by servers, never a browser, and a song or video sent to them (#1510) is
  // larger than the body Next lets through a middleware (10 MB, cut off past that)
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api/artifacts(?:/|$)|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
};
