import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getSessionId, getSessionData } from '@/lib/auth-token';

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  
  // Allow login page and API routes
  if (pathname === '/admin/login' || pathname.startsWith('/api/')) {
    return NextResponse.next();
  }
  
  // If accessing admin routes, validate session
  if (pathname.startsWith('/admin')) {
    // Get session ID from cookie or URL
    const sessionId = getSessionId(request);
    
    if (process.env.NODE_ENV === 'development') {
      console.log('[Middleware] Checking session for path:', pathname);
      console.log('[Middleware] Session ID found:', !!sessionId);
      if (sessionId) {
        console.log('[Middleware] Session ID type:', sessionId.length === 64 && /^[0-9a-f]+$/.test(sessionId) ? 'session ID (64 hex)' : sessionId.length > 100 ? 'likely token (base64)' : 'short string');
        console.log('[Middleware] Session ID preview:', sessionId.substring(0, 20) + '...');
      }
      console.log('[Middleware] URL params:', Array.from(request.nextUrl.searchParams.entries()));
      const cookies = request.cookies.getAll();
      console.log('[Middleware] Cookies:', cookies.map(c => `${c.name}=${c.value.substring(0, 20)}...`));
    }
    
    if (!sessionId) {
      if (process.env.NODE_ENV === 'development') {
        console.log('[Middleware] No session ID found, redirecting to login');
      }
      const loginUrl = new URL('/admin/login', request.url);
      loginUrl.searchParams.set('redirect', pathname);
      return NextResponse.redirect(loginUrl);
    }
    
    // Parse session data synchronously (middleware can't be async)
    // The cookie contains JSON session data, URL token is base64 encoded
    let session: {
      userId: string;
      uuid: string;
      email: string | null;
      name: string | null;
      tags: string[];
      createdAt: number;
      expiresAt: number;
    } | null = null;

    try {
      // Try to parse as JSON first (from cookie)
      session = JSON.parse(sessionId);
      
      if (process.env.NODE_ENV === 'development') {
        console.log('[Middleware] Parsed as JSON from cookie');
      }
      
      // Check expiration
      if (session.expiresAt && Date.now() > session.expiresAt) {
        if (process.env.NODE_ENV === 'development') {
          console.log('[Middleware] Session expired:', new Date(session.expiresAt).toISOString(), 'now:', new Date().toISOString());
        }
        session = null;
      } else if (process.env.NODE_ENV === 'development') {
        console.log('[Middleware] Session valid, expires:', new Date(session.expiresAt).toISOString());
      }
    } catch {
      // Not JSON, try base64 decode (from URL token)
      try {
        const decoded = Buffer.from(sessionId, 'base64').toString('utf-8');
        session = JSON.parse(decoded);
        
        if (process.env.NODE_ENV === 'development') {
          console.log('[Middleware] Parsed as base64 token from URL');
        }
        
        // Check expiration
        if (session.expiresAt && Date.now() > session.expiresAt) {
          if (process.env.NODE_ENV === 'development') {
            console.log('[Middleware] Token expired:', new Date(session.expiresAt).toISOString());
          }
          session = null;
        } else if (process.env.NODE_ENV === 'development') {
          console.log('[Middleware] Token valid, expires:', new Date(session.expiresAt).toISOString());
        }
      } catch (parseError) {
        // If it's a session ID (64 hex chars), we can't look it up synchronously
        // In this case, we'll need to rely on the cookie or URL token
        // For now, reject session IDs in middleware (they need async lookup)
        if (process.env.NODE_ENV === 'development') {
          console.log('[Middleware] Failed to parse session:', parseError instanceof Error ? parseError.message : String(parseError));
          console.log('[Middleware] Session ID format detected but cannot lookup synchronously');
        }
        session = null;
      }
    }
    
    if (!session || !session.userId) {
      if (process.env.NODE_ENV === 'development') {
        console.log('[Middleware] Invalid or expired session. SessionId:', sessionId?.substring(0, 8) + '...');
      }
      const loginUrl = new URL('/admin/login', request.url);
      loginUrl.searchParams.set('redirect', pathname);
      return NextResponse.redirect(loginUrl);
    }
    
    if (process.env.NODE_ENV === 'development') {
      console.log('[Middleware] Session validated successfully for user:', session.userId);
    }

    // ALWAYS set the cookie if we have a valid session
    // This ensures cookies work on subsequent navigations when possible
    const response = NextResponse.next();
    const sessionDataString = JSON.stringify(session);
    const isSecure = request.url.startsWith('https://') || process.env.NODE_ENV === 'production';
    
    // Always set cookie (works in HTTPS, may not work in HTTP iframes but we try)
    response.cookies.set('user_session', sessionDataString, {
      httpOnly: true,
      secure: isSecure,
      sameSite: isSecure ? 'none' : 'lax', // 'none' for HTTPS iframes, 'lax' for HTTP
      path: '/',
      maxAge: 60 * 60 * 24 * 7, // 7 days
    });
    
    // If session came from URL token, preserve it in response headers
    // The client-side code will use this to preserve token during navigation
    const isUrlToken = request.nextUrl.searchParams.has('_token') || request.nextUrl.searchParams.has('_session');
    if (isUrlToken) {
      // Token is already in URL, client will preserve it
      if (process.env.NODE_ENV === 'development') {
        console.log('[Middleware] Session validated, cookie set, URL token preserved');
      }
    } else {
      // No URL token - add it so client-side navigation works
      // Encode session data as base64 token
      const token = Buffer.from(sessionDataString).toString('base64');
      response.headers.set('x-session-token', token);
      
      if (process.env.NODE_ENV === 'development') {
        console.log('[Middleware] Session validated, cookie set, token added to header for client');
      }
    }
    
    return response;
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

