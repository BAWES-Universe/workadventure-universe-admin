import { NextRequest, NextResponse } from 'next/server';
import { validateAccessToken } from '@/lib/oidc';
import { prisma } from '@/lib/db';
import { sessionStore } from '@/lib/session-store';

// Ensure this route runs in Node.js runtime (not Edge) to support Redis and Prisma
export const runtime = 'nodejs';

// CORS headers helper
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Credentials': 'true',
  };
}

/**
 * OPTIONS /api/auth/login
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders() });
}

/**
 * POST /api/auth/login
 * Login with OIDC access token
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { accessToken } = body;

    if (!accessToken) {
      const response = NextResponse.json(
        { error: 'Access token required' },
        { status: 400 }
      );
      Object.entries(corsHeaders()).forEach(([key, value]) => {
        response.headers.set(key, value);
      });
      return response;
    }

    // Validate OIDC token
    const userInfo = await validateAccessToken(accessToken);
    
    if (!userInfo) {
      const response = NextResponse.json(
        { error: 'Invalid access token' },
        { status: 401 }
      );
      Object.entries(corsHeaders()).forEach(([key, value]) => {
        response.headers.set(key, value);
      });
      return response;
    }

    // Extract user identifier
    const identifier = userInfo.sub || userInfo.email || 'unknown';
    const email = userInfo.email || null;
    const name = userInfo.name || userInfo.preferred_username || null;
    
    // Extract tags
    let tags: string[] = [];
    if (userInfo.tags) {
      if (Array.isArray(userInfo.tags)) {
        tags = userInfo.tags;
      } else if (typeof userInfo.tags === 'string') {
        try {
          tags = JSON.parse(userInfo.tags);
        } catch {
          tags = [userInfo.tags];
        }
      }
    }

    // Find or create user in database
    let user = await prisma.user.findFirst({
      where: {
        OR: [
          { uuid: identifier },
          { email: email || undefined },
        ],
      },
    });

    if (!user) {
      // Create new user (authenticated users are not guests)
      user = await prisma.user.create({
        data: {
          uuid: identifier,
          email: email,
          name: name,
          isGuest: false, // Authenticated users are not guests
        },
      });
    } else {
      // Update existing user - mark as authenticated
      user = await prisma.user.update({
        where: { id: user.id },
        data: {
          email: email || user.email,
          name: name || user.name,
          isGuest: false, // User is authenticating, so they're not a guest
        },
      });
    }

    // Create session data with expiration
    const now = Date.now();
    const expiresAt = now + (7 * 24 * 60 * 60 * 1000); // 7 days
    const sessionData = {
      userId: user.id,
      uuid: user.uuid,
      email: user.email,
      name: user.name,
      tags,
      createdAt: now,
      expiresAt,
    };

    // Create session in server-side store (for server-side operations)
    const sessionId = await sessionStore.createSession({
      userId: user.id,
      uuid: user.uuid,
      email: user.email,
      name: user.name,
      tags,
    });

    // Encode session data as base64 for URL/cookie storage (fallback when store not available)
    const sessionToken = Buffer.from(JSON.stringify(sessionData)).toString('base64');

    // Return user info, session ID, and token (for iframe scenarios)
    const response = NextResponse.json({
      user: {
        id: user.id,
        uuid: user.uuid,
        email: user.email,
        name: user.name,
        tags,
      },
      sessionId, // For server-side store lookup
      sessionToken, // For cookie/URL fallback (base64 encoded session data)
      expiresAt: sessionData.expiresAt,
    });

    // Set secure cookie with session data (middleware can parse this directly)
    const isSecure = request.url.startsWith('https://') || process.env.NODE_ENV === 'production';
    
    // Store session data in cookie so middleware can validate without needing the store
    // This works even if the in-memory store is not shared between processes
    const sessionDataString = JSON.stringify(sessionData);
    response.cookies.set('user_session', sessionDataString, {
      httpOnly: true,
      secure: isSecure,
      sameSite: isSecure ? 'none' : 'lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 7, // 7 days
    });
    
    // Also set session ID cookie (for server-side store lookup when available)
    response.cookies.set('admin_session_id', sessionId, {
      httpOnly: true,
      secure: isSecure,
      sameSite: isSecure ? 'none' : 'lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 7,
    });
    
    if (process.env.NODE_ENV === 'development') {
      console.log('[Login] Session created with ID:', sessionId.substring(0, 8) + '...');
      console.log('[Login] Cookie set with sameSite:', isSecure ? 'none' : 'lax', 'secure:', isSecure);
    }

    // Add CORS headers
    Object.entries(corsHeaders()).forEach(([key, value]) => {
      response.headers.set(key, value);
    });

    return response;
  } catch (error) {
    console.error('Login error:', error);
    const response = NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
    Object.entries(corsHeaders()).forEach(([key, value]) => {
      response.headers.set(key, value);
    });
    return response;
  }
}

/**
 * GET /api/auth/me
 * Get current user from session
 */
export async function GET(request: NextRequest) {
  try {
    const sessionCookie = request.cookies.get('user_session');
    
    if (!sessionCookie) {
      return NextResponse.json(
        { error: 'Not authenticated' },
        { status: 401 }
      );
    }

    const session = JSON.parse(sessionCookie.value);
    
    // Verify user still exists
    const user = await prisma.user.findUnique({
      where: { id: session.userId },
      select: {
        id: true,
        uuid: true,
        email: true,
        name: true,
      },
    });

    if (!user) {
      return NextResponse.json(
        { error: 'User not found' },
        { status: 404 }
      );
    }

    return NextResponse.json({
      user: {
        ...user,
        tags: session.tags || [],
      },
    });
  } catch (error) {
    console.error('Get user error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

