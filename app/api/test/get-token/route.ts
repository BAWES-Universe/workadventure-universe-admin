import { NextRequest, NextResponse } from 'next/server';
import { getOidcClient } from '@/lib/oidc';

/**
 * GET /api/test/get-token
 * Helper endpoint to get an OIDC token for testing
 * This simulates what WorkAdventure would send
 */
export async function GET(request: NextRequest) {
  try {
    // This is a test endpoint - in production, remove or protect it
    const { searchParams } = new URL(request.url);
    const username = searchParams.get('username') || 'User1';
    const password = searchParams.get('password') || 'pwd';

    // For testing, we'll create a mock token
    // In real usage, you'd get this from WorkAdventure's OIDC flow
    const client = await getOidcClient();
    
    // Try to get token from OIDC provider
    // Note: This is a simplified version - real OIDC flow requires authorization code
    const issuerUrl = process.env.OIDC_ISSUER;
    
    return NextResponse.json({
      message: 'To get a real token:',
      instructions: [
        '1. Log into WorkAdventure at http://play.workadventure.localhost',
        '2. Open browser DevTools → Network tab',
        '3. Look for API calls to your admin API',
        '4. Find the accessToken parameter in the request',
        '5. Copy that token and use it in /admin/login',
        '',
        'Or use the OIDC mock directly:',
        `- OIDC Issuer: ${issuerUrl}`,
        '- Test users: User1, User2, UserMatrix (password: pwd)',
        '- Get token via OIDC authorization code flow',
      ],
      oidcIssuer: issuerUrl,
      testUsers: [
        { username: 'User1', password: 'pwd', email: 'john.doe@example.com' },
        { username: 'User2', password: 'pwd', email: 'alice.doe@example.com' },
        { username: 'UserMatrix', password: 'pwd', email: 'john.doe@example.com' },
      ],
    });
  } catch (error) {
    console.error('Error:', error);
    return NextResponse.json(
      { error: 'Failed to get token info' },
      { status: 500 }
    );
  }
}

