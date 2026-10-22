import { NextRequest } from 'next/server';
import { getSessionUser } from '@/lib/auth-session';
import { listAiKeys } from '@/lib/ai-keys';
import { meOriginAllowed, meRespond } from '@/lib/me-route';

export const runtime = 'nodejs';

const respond = (request: NextRequest, body: unknown, status = 200) => meRespond(request, body, status, 'GET, OPTIONS');

export async function OPTIONS(request: NextRequest) {
  return respond(request, {}, request.headers.get('origin') && meOriginAllowed(request) ? 204 : 403);
}

/** GET /api/me/ai-keys - the caller's own AI keys (#374), with what each spent this month. Never returns a key. */
export async function GET(request: NextRequest) {
  if (!meOriginAllowed(request)) return respond(request, { error: 'Origin not allowed' }, 403);
  const user = await getSessionUser(request);
  if (!user) return respond(request, { error: 'Unauthorized' }, 401);
  try {
    return respond(request, { keys: await listAiKeys(user.id) });
  } catch (error) {
    console.error('[AiKeys] List failed:', error);
    return respond(request, { error: 'Internal server error' }, 500);
  }
}
