import { NextRequest, NextResponse } from 'next/server';
import { exchangeOidcAccessToken, SessionExchangeError } from '@/lib/oidc-session-exchange';
import { resolveExpectedLoginOrigin } from '@/lib/auth';

export const runtime = 'nodejs';

function response(body: unknown, status = 200) {
  const result = NextResponse.json(body, { status });
  result.headers.set('Cache-Control', 'no-store');
  return result;
}

export async function POST(request: NextRequest) {
  const origin = request.headers.get('origin');
  if (origin) {
    try {
      const expected = resolveExpectedLoginOrigin(
        process.env.NEXT_PUBLIC_API_URL || process.env.ADMIN_API_URL,
        request.nextUrl.origin
      );
      if (new URL(origin).origin !== expected) return response({ error: 'Cross-origin login is not allowed' }, 403);
    } catch {
      return response({ error: 'Invalid origin' }, 403);
    }
  }

  try {
    const body: unknown = await request.json();
    const accessToken = typeof body === 'object' && body !== null && 'accessToken' in body
      ? (body as { accessToken?: unknown }).accessToken
      : null;
    if (typeof accessToken !== 'string' || !accessToken.trim()) {
      return response({ error: 'Access token required' }, 400);
    }
    return response(await exchangeOidcAccessToken(accessToken));
  } catch (error) {
    if (error instanceof SyntaxError) return response({ error: 'Invalid JSON body' }, 400);
    if (error instanceof SessionExchangeError) return response({ error: error.message }, error.status);
    console.error('[Login] Session exchange failed:', error);
    return response({ error: 'Internal server error' }, 500);
  }
}
