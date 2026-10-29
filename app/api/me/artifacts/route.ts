import { NextRequest } from 'next/server';
import { getSessionUser } from '@/lib/auth-session';
import { meOriginAllowed, meRespond } from '@/lib/me-route';
import { listOwned } from '@/lib/artifact-service';

export const runtime = 'nodejs';

const respond = (request: NextRequest, body: unknown, status = 200) => meRespond(request, body, status, 'GET, OPTIONS');

export async function OPTIONS(request: NextRequest) {
  return respond(request, {}, request.headers.get('origin') && meOriginAllowed(request) ? 204 : 403);
}

/**
 * GET /api/me/artifacts - every artifact the caller owns, from all their chats with bots, the most recently changed
 * first, 50 at a time (`?offset=` the `next` of the page before). Only theirs (game #1474).
 */
export async function GET(request: NextRequest) {
  if (!meOriginAllowed(request)) return respond(request, { error: 'Origin not allowed' }, 403);
  const user = await getSessionUser(request);
  if (!user) return respond(request, { error: 'Unauthorized' }, 401);
  const offset = Number(request.nextUrl.searchParams.get('offset') ?? 0);
  if (!Number.isInteger(offset) || offset < 0 || offset > 1_000_000) return respond(request, { error: 'Invalid offset' }, 400);
  try {
    return respond(request, await listOwned(user.id, offset));
  } catch (error) {
    console.error('[Artifacts] Your list failed:', error instanceof Error ? error.message : 'unknown');
    return respond(request, { error: 'Internal server error' }, 500);
  }
}
