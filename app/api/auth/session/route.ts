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
 * OPTIONS /api/auth/session
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders() });
}

/**
 * POST /api/auth/session
 * Exchange OIDC accessToken for session token
 * Accepts accessToken in Authorization header (preferred) or request body (fallback)
 * 
 * Request:
 *   Headers: Authorization: Bearer <oidc_accessToken>
 *   OR
 *   Body: { "accessToken": "oidc_accessToken" }
 * 
 * Response (200):
 *   { "sessionToken": "base64-encoded-session-data", "expiresAt": 1768261238170 }
 * 
 * Response (400):
 *   { "error": "Missing access token" }
 * 
 * Response (401):
 *   { "error": "Invalid or expired access token" }
 */
export async function POST(request: NextRequest) {
  try {
    // Get accessToken from Authorization header (preferred) or request body (fallback)
    let accessToken: string | null = null;
    
    const authHeader = request.headers.get('authorization');
    if (authHeader && authHeader.startsWith('Bearer ')) {
      accessToken = authHeader.replace('Bearer ', '').trim();
    } else {
      // Fallback to request body
      try {
        const body = await request.json();
        accessToken = body.accessToken || null;
      } catch {
        // Body parsing failed or no body - will check accessToken below
      }
    }

    if (!accessToken) {
      const response = NextResponse.json(
        { error: 'Missing access token' },
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
        { error: 'Invalid or expired access token' },
        { status: 401 }
      );
      Object.entries(corsHeaders()).forEach(([key, value]) => {
        response.headers.set(key, value);
      });
      
      // Log failed token exchange for security monitoring
      if (process.env.NODE_ENV === 'development') {
        console.log('[Session Exchange] Failed token validation');
      }
      
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
          isGuest: false,
        },
      });
    } else {
      // Update existing user - mark as authenticated
      user = await prisma.user.update({
        where: { id: user.id },
        data: {
          email: email || user.email,
          name: name || user.name,
          isGuest: false,
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

    // Create session in server-side store
    const sessionId = await sessionStore.createSession({
      userId: user.id,
      uuid: user.uuid,
      email: user.email,
      name: user.name,
      tags,
    });

    // Encode session data as base64 for URL/cookie storage
    const sessionToken = Buffer.from(JSON.stringify(sessionData)).toString('base64');

    // Log successful token exchange for security monitoring
    if (process.env.NODE_ENV === 'development') {
      console.log('[Session Exchange] Created session for user:', user.email || user.uuid, 'Session ID:', sessionId.substring(0, 8) + '...');
    }

    // Return session token and expiration
    const response = NextResponse.json({
      sessionToken,
      expiresAt,
    });

    // Add CORS headers
    Object.entries(corsHeaders()).forEach(([key, value]) => {
      response.headers.set(key, value);
    });

    return response;
  } catch (error) {
    console.error('[Session Exchange] Error:', error);
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

