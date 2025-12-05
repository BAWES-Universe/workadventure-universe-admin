import { NextRequest } from 'next/server';
import { prisma } from './db';

export interface SessionUser {
  id: string;
  uuid: string;
  email: string | null;
  name: string | null;
  tags: string[];
}

/**
 * Get current user from session cookie
 */
export async function getSessionUser(request: NextRequest): Promise<SessionUser | null> {
  try {
    const sessionCookie = request.cookies.get('user_session');
    
    if (!sessionCookie) {
      return null;
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
      return null;
    }

    return {
      id: user.id,
      uuid: user.uuid,
      email: user.email,
      name: user.name,
      tags: session.tags || [],
    };
  } catch (error) {
    console.error('Get session user error:', error);
    return null;
  }
}

/**
 * Require authentication - throws if not authenticated
 */
export async function requireSession(request: NextRequest): Promise<SessionUser> {
  const user = await getSessionUser(request);
  
  if (!user) {
    throw new Error('Unauthorized');
  }
  
  return user;
}

