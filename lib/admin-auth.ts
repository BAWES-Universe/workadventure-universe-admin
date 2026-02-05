import { NextRequest } from 'next/server';
import { getSessionUser } from './auth-session';
import { validateAdminToken } from './auth';

/**
 * Require admin authentication - validates session or admin token
 * Returns user info if authenticated, throws error if not
 */
export async function requireAdminAuth(request: NextRequest): Promise<{ userId: string | null; isAdminToken: boolean }> {
  // Check session first (for admin UI)
  const sessionUser = await getSessionUser(request);
  if (sessionUser) {
    return { userId: sessionUser.id, isAdminToken: false };
  }

  // Check admin token (for API access)
  if (validateAdminToken(request)) {
    return { userId: null, isAdminToken: true };
  }

  throw new Error('Unauthorized: Admin authentication required');
}
