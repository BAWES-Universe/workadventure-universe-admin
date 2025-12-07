import { NextResponse } from 'next/server';

/**
 * POST /api/auth/logout
 * Logout and clear session
 */
export async function POST() {
  const response = NextResponse.json({ success: true });
  
  // Clear session cookie (must match the path used when setting it)
  response.cookies.set('user_session', '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
  
  return response;
}

