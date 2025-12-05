import { NextResponse } from 'next/server';

/**
 * POST /api/auth/logout
 * Logout and clear session
 */
export async function POST() {
  const response = NextResponse.json({ success: true });
  
  // Clear session cookie
  response.cookies.delete('user_session');
  
  return response;
}

