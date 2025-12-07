import { NextRequest, NextResponse } from 'next/server';
import { validateAccessToken } from '@/lib/oidc';
import { prisma } from '@/lib/db';

/**
 * POST /api/auth/login
 * Login with OIDC access token
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { accessToken } = body;

    if (!accessToken) {
      return NextResponse.json(
        { error: 'Access token required' },
        { status: 400 }
      );
    }

    // Validate OIDC token
    const userInfo = await validateAccessToken(accessToken);
    
    if (!userInfo) {
      return NextResponse.json(
        { error: 'Invalid access token' },
        { status: 401 }
      );
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
      // Create new user
      user = await prisma.user.create({
        data: {
          uuid: identifier,
          email: email,
          name: name,
        },
      });
    } else {
      // Update existing user
      user = await prisma.user.update({
        where: { id: user.id },
        data: {
          email: email || user.email,
          name: name || user.name,
        },
      });
    }

    // Create session (in production, use proper session management)
    // For now, return user info that client can store
    const response = NextResponse.json({
      user: {
        id: user.id,
        uuid: user.uuid,
        email: user.email,
        name: user.name,
        tags,
      },
    });

    // Set secure cookie with user session (in production, use httpOnly, secure, sameSite)
    response.cookies.set('user_session', JSON.stringify({
      userId: user.id,
      uuid: user.uuid,
      email: user.email,
      name: user.name,
      tags,
    }), {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 7, // 7 days
    });

    return response;
  } catch (error) {
    console.error('Login error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
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

