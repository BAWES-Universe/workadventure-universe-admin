import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth-session';
import { AppConnectionError } from '@/lib/app-connections';
import { meOriginAllowed, meRespond } from '@/lib/me-route';

/**
 * The shell every `/api/me/apps/*` route shares (game #2001): an allowed origin, a signed-in person who is not a guest, and the
 * answers for a problem. Everything under it is about the caller's OWN apps; someone else's id answers like one that does not
 * exist, so nothing is learned about it.
 */
export async function appsRoute(
  request: NextRequest,
  methods: string,
  what: string,
  run: (user: { id: string }, respond: (body: unknown, status?: number) => NextResponse) => Promise<NextResponse>,
): Promise<NextResponse> {
  const respond = (body: unknown, status = 200) => meRespond(request, body, status, methods);
  if (!meOriginAllowed(request)) return respond({ error: 'Origin not allowed' }, 403);
  const user = await getSessionUser(request);
  if (!user) return respond({ error: 'Unauthorized' }, 401);
  // A guest has no account of their own to connect an app to
  if ('isGuest' in user && (user as { isGuest?: boolean }).isGuest) return respond({ error: 'Sign in to connect apps' }, 403);
  try {
    return await run(user, respond);
  } catch (error) {
    if (error instanceof AppConnectionError) return respond({ error: error.message }, error.status);
    console.error(`[Apps] ${what} failed:`, error);
    return respond({ error: 'Internal server error' }, 500);
  }
}

export const preflight = (request: NextRequest, methods: string) =>
  meRespond(request, {}, request.headers.get('origin') && meOriginAllowed(request) ? 204 : 403, methods);
