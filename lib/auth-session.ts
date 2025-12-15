import { NextRequest } from 'next/server';
import { prisma } from './db';
import { getSessionId, getSessionData } from './auth-token';
import { isSuperAdmin } from './super-admin';

export interface SessionUser {
  id: string;
  uuid: string;
  email: string | null;
  name: string | null;
  tags: string[];
  isSuperAdmin: boolean;
}

/**
 * Get current user from session token (checks Authorization header first, then cookie)
 */
export async function getSessionUser(request: NextRequest): Promise<SessionUser | null> {
  try {
    // Check for session ID in cookie or URL
    const sessionId = getSessionId(request);
    
    if (!sessionId) {
      return null;
    }

    // Get session data from store or parse legacy token
    const session = await getSessionData(sessionId);
    
    if (!session) {
      return null;
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
      return null;
    }

    return {
      id: user.id,
      uuid: user.uuid,
      email: user.email,
      name: user.name,
      tags: session.tags || [],
      isSuperAdmin: isSuperAdmin(user.email),
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

