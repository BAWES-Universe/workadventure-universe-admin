import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  
  // Allow login page and API routes
  if (pathname === '/admin/login' || pathname.startsWith('/api/')) {
    return NextResponse.next();
  }
  
  // Check for session cookie
  const sessionCookie = request.cookies.get('user_session');
  
  // Debug: Log cookie status (remove in production)
  if (process.env.NODE_ENV === 'development' && pathname.startsWith('/admin')) {
    console.log('[Middleware] Path:', pathname);
    console.log('[Middleware] Cookie exists:', !!sessionCookie);
    console.log('[Middleware] All cookies:', Array.from(request.cookies.getAll()).map(c => c.name));
  }
  
  // If accessing admin routes, validate session cookie
  if (pathname.startsWith('/admin')) {
    if (!sessionCookie) {
      if (process.env.NODE_ENV === 'development') {
        console.log('[Middleware] No session cookie, redirecting to login');
      }
      const loginUrl = new URL('/admin/login', request.url);
      // Preserve the original URL as a redirect parameter
      loginUrl.searchParams.set('redirect', pathname);
      return NextResponse.redirect(loginUrl);
    }
    
    // Validate cookie value is valid JSON (basic check)
    try {
      const sessionValue = sessionCookie.value;
      if (process.env.NODE_ENV === 'development') {
        console.log('[Middleware] Cookie value length:', sessionValue?.length || 0);
        console.log('[Middleware] Cookie value preview:', sessionValue?.substring(0, 100));
      }
      
      if (!sessionValue || sessionValue.trim() === '') {
        if (process.env.NODE_ENV === 'development') {
          console.log('[Middleware] Empty session cookie value');
        }
        const loginUrl = new URL('/admin/login', request.url);
        loginUrl.searchParams.set('redirect', pathname);
        return NextResponse.redirect(loginUrl);
      }
      
      // Try to parse to ensure it's valid JSON
      const parsed = JSON.parse(sessionValue);
      if (process.env.NODE_ENV === 'development') {
        console.log('[Middleware] Parsed session keys:', Object.keys(parsed));
        console.log('[Middleware] Has userId:', !!parsed.userId);
      }
      
      if (!parsed.userId) {
        if (process.env.NODE_ENV === 'development') {
          console.log('[Middleware] Invalid session structure, missing userId. Parsed:', parsed);
        }
        const loginUrl = new URL('/admin/login', request.url);
        loginUrl.searchParams.set('redirect', pathname);
        return NextResponse.redirect(loginUrl);
      }
      
      if (process.env.NODE_ENV === 'development') {
        console.log('[Middleware] Session validated successfully');
      }
    } catch (error) {
      // Invalid cookie, redirect to login
      if (process.env.NODE_ENV === 'development') {
        console.log('[Middleware] Cookie parse error:', error);
        console.log('[Middleware] Error details:', error instanceof Error ? error.message : String(error));
      }
      const loginUrl = new URL('/admin/login', request.url);
      loginUrl.searchParams.set('redirect', pathname);
      return NextResponse.redirect(loginUrl);
    }
  }
  
  return NextResponse.next();
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - public folder
     */
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};

