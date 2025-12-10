import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSessionId, getSessionData } from '@/lib/auth-token';

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
 * OPTIONS /api/auth/me
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders() });
}

/**
 * GET /api/auth/me
 * Get current user from session
 */
export async function GET(request: NextRequest) {
  try {
    // Check for session ID in cookie or URL
    const sessionId = getSessionId(request);
    
    if (!sessionId) {
      const response = NextResponse.json(
        { error: 'Not authenticated' },
        { status: 401 }
      );
      Object.entries(corsHeaders()).forEach(([key, value]) => {
        response.headers.set(key, value);
      });
      return response;
    }

    // Get session data from store or parse legacy token
    const session = await getSessionData(sessionId);
    
    if (!session) {
      const response = NextResponse.json(
        { error: 'Invalid or expired session' },
        { status: 401 }
      );
      Object.entries(corsHeaders()).forEach(([key, value]) => {
        response.headers.set(key, value);
      });
      return response;
    }
    
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
      const response = NextResponse.json(
        { error: 'User not found' },
        { status: 404 }
      );
      Object.entries(corsHeaders()).forEach(([key, value]) => {
        response.headers.set(key, value);
      });
      return response;
    }

    const response = NextResponse.json({
      user: {
        ...user,
        tags: session.tags || [],
      },
    });
    Object.entries(corsHeaders()).forEach(([key, value]) => {
      response.headers.set(key, value);
    });
    return response;
  } catch (error) {
    console.error('Get user error:', error);
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

