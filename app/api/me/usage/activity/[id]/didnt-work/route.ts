import { NextRequest } from 'next/server';
import { getSessionUser } from '@/lib/auth-session';
import { meOriginAllowed, meRespond } from '@/lib/me-route';
import { reportProblem } from '@/lib/task-receipts';

export const runtime = 'nodejs';

const respond = (request: NextRequest, body: unknown, status = 200) => meRespond(request, body, status, 'POST, OPTIONS');

export async function OPTIONS(request: NextRequest) {
  return respond(request, {}, request.headers.get('origin') && meOriginAllowed(request) ? 204 : 403);
}

/**
 * POST /api/me/usage/activity/:id/didnt-work - "Didn't work?" on a task's receipt (the game's Usage page). Answers { outcome }:
 * `sent` when the report reached the people who run Universe; a task's own recovery answers `refunded`, `redelivered`, `retrying` or
 * `credit` here when it has made one. Reporting twice is the same report. A task that is not the caller's is 404.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!meOriginAllowed(request)) return respond(request, { error: 'Origin not allowed' }, 403);
  const user = await getSessionUser(request);
  if (!user) return respond(request, { error: 'Unauthorized' }, 401);
  try {
    const { id } = await params;
    const reported = await reportProblem(user.id, id);
    return reported.ok ? respond(request, { outcome: reported.outcome }) : respond(request, { error: 'Not found' }, 404);
  } catch (error) {
    console.error('[Usage] Didn\'t work failed:', error instanceof Error ? error.message : 'unknown');
    return respond(request, { error: 'Internal server error' }, 500);
  }
}
