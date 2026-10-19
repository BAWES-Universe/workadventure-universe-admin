import { NextRequest } from 'next/server';
import { getSessionUser } from '@/lib/auth-session';
import { meOriginAllowed, meRespond } from '@/lib/me-route';
import { openNotices } from '@/lib/notices';

export const runtime = 'nodejs';

const respond = (request: NextRequest, body: unknown, status = 200) => meRespond(request, body, status, 'GET, OPTIONS');

export async function OPTIONS(request: NextRequest) {
  return respond(request, {}, request.headers.get('origin') && meOriginAllowed(request) ? 204 : 403);
}

/** GET /api/me/notices - what Orbit has told the caller that they have not dismissed, newest first. */
export async function GET(request: NextRequest) {
  if (!meOriginAllowed(request)) return respond(request, { error: 'Origin not allowed' }, 403);
  const user = await getSessionUser(request);
  if (!user) return respond(request, { error: 'Unauthorized' }, 401);
  try {
    const notices = await openNotices(user.id);
    return respond(request, {
      notices: notices.map((notice) => ({
        id: notice.id,
        kind: notice.kind,
        title: notice.title,
        body: notice.body,
        badge: notice.badge,
        href: notice.href,
        createdAt: notice.createdAt.toISOString(),
      })),
    });
  } catch (error) {
    console.error('[Notices] List failed:', error instanceof Error ? error.message : 'unknown');
    return respond(request, { error: 'Internal server error' }, 500);
  }
}
