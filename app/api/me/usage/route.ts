import { NextRequest } from 'next/server';
import { getSessionUser } from '@/lib/auth-session';
import { meOriginAllowed, meRespond } from '@/lib/me-route';
import { memberUsage } from '@/lib/meter-usage';

export const runtime = 'nodejs';

const respond = (request: NextRequest, body: unknown, status = 200) => meRespond(request, body, status, 'GET, OPTIONS');

export async function OPTIONS(request: NextRequest) {
  return respond(request, {}, request.headers.get('origin') && meOriginAllowed(request) ? 204 : 403);
}

/**
 * GET /api/me/usage - the Usage page of the person asking (game #1999): one bar for chat and voice on Universe AI, the computer
 * allowance and the storage their Bricks keep (only for someone whose Brick uses a computer), and one line while they have extra
 * usage. Bars say what is left. Never a count of replies, never a price, and nothing about how extra usage was given.
 */
export async function GET(request: NextRequest) {
  if (!meOriginAllowed(request)) return respond(request, { error: 'Origin not allowed' }, 403);
  const user = await getSessionUser(request);
  if (!user) return respond(request, { error: 'Unauthorized' }, 401);
  try {
    return respond(request, await memberUsage(user.id));
  } catch (error) {
    console.error('[Usage] Load failed:', error instanceof Error ? error.message : 'unknown');
    return respond(request, { error: 'Internal server error' }, 500);
  }
}
