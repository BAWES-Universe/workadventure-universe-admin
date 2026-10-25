import { NextRequest } from 'next/server';
import { getSessionUser } from '@/lib/auth-session';
import { meOriginAllowed, meRespond } from '@/lib/me-route';
import { readActivityReport, recordActivity } from '@/lib/push-activity';

export const runtime = 'nodejs';

const respond = (request: NextRequest, body: unknown, status = 200) => meRespond(request, body, status, 'POST, OPTIONS');

export async function OPTIONS(request: NextRequest) {
  return respond(request, {}, request.headers.get('origin') && meOriginAllowed(request) ? 204 : 403);
}

/**
 * POST /api/me/push/activity { tabId, front, chatRoomId } - the game, every 30 seconds while Universe is in front and
 * when it goes to the back, so direct messages someone is looking at send no notification.
 */
export async function POST(request: NextRequest) {
  if (!meOriginAllowed(request)) return respond(request, { error: 'Origin not allowed' }, 403);
  const user = await getSessionUser(request);
  if (!user) return respond(request, { error: 'Unauthorized' }, 401);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return respond(request, { error: 'Invalid JSON body' }, 400);
  }
  const report = readActivityReport(body);
  if (!report) return respond(request, { error: 'Expected { tabId, front, chatRoomId }' }, 400);
  try {
    await recordActivity(user.id, report);
    return respond(request, { status: 'ok' });
  } catch (error) {
    console.error('[Push] Activity failed:', error instanceof Error ? error.message : 'unknown');
    return respond(request, { error: 'Internal server error' }, 500);
  }
}
