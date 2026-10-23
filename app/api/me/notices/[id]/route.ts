import { NextRequest } from 'next/server';
import { getSessionUser } from '@/lib/auth-session';
import { meOriginAllowed, meRespond } from '@/lib/me-route';
import { dismissNotice } from '@/lib/notices';

export const runtime = 'nodejs';

const respond = (request: NextRequest, body: unknown, status = 200) => meRespond(request, body, status, 'DELETE, OPTIONS');

export async function OPTIONS(request: NextRequest) {
  return respond(request, {}, request.headers.get('origin') && meOriginAllowed(request) ? 204 : 403);
}

/** DELETE /api/me/notices/:id - dismisses one of the caller's notices. Someone else's, or one already gone, is a 404. */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!meOriginAllowed(request)) return respond(request, { error: 'Origin not allowed' }, 403);
  const user = await getSessionUser(request);
  if (!user) return respond(request, { error: 'Unauthorized' }, 401);
  const { id } = await params;
  try {
    if (!(await dismissNotice(user.id, id))) return respond(request, { error: 'Not found' }, 404);
    return respond(request, { status: 'dismissed' });
  } catch (error) {
    console.error('[Notices] Dismiss failed:', error instanceof Error ? error.message : 'unknown');
    return respond(request, { error: 'Internal server error' }, 500);
  }
}
