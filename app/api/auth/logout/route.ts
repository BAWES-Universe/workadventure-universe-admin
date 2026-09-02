import { NextRequest, NextResponse } from 'next/server';
import { getSessionId } from '@/lib/auth-token';
import { sessionStore } from '@/lib/session-store';

// Ensure this route runs in Node.js runtime (not Edge) to support Redis
export const runtime = 'nodejs';

/**
 * POST /api/auth/logout
 * Logout and clear session
 */
export async function POST(request: NextRequest) {
  // Get session ID and delete from store
  const sessionId = getSessionId(request);
  if (sessionId) {
    await sessionStore.deleteSession(sessionId);
  }
  
  const response = NextResponse.json({ success: true });
  response.headers.set('Cache-Control', 'no-store');
  
  // Clear cookies used by earlier releases. V2 sessions are header-only.
  response.cookies.set('admin_session_id', '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
  
  // Clear legacy cookie
  response.cookies.set('user_session', '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
  
  return response;
}
