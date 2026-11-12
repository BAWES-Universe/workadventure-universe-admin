import { NextRequest } from 'next/server';
import { getSessionUser } from '@/lib/auth-session';
import { meOriginAllowed, meRespond } from '@/lib/me-route';
import { prisma } from '@/lib/db';
import { askForMore } from '@/lib/meter-requests';
import { memberUsage } from '@/lib/meter-usage';

export const runtime = 'nodejs';

const respond = (request: NextRequest, body: unknown, status = 200) => meRespond(request, body, status, 'POST, OPTIONS');

export async function OPTIONS(request: NextRequest) {
  return respond(request, {}, request.headers.get('origin') && meOriginAllowed(request) ? 204 : 403);
}

/**
 * POST /api/me/usage/ask-for-more - "Ask for more" when computer time ran out (game #1999). It is only a request: it shows to the
 * Universe team in Orbit (Costs, and the person's page) and creates no debt and no grant. Asking again while one waits finds it.
 * Only offered when this month's computer allowance is used up.
 */
export async function POST(request: NextRequest) {
  if (!meOriginAllowed(request)) return respond(request, { error: 'Origin not allowed' }, 403);
  const user = await getSessionUser(request);
  if (!user) return respond(request, { error: 'Unauthorized' }, 401);
  try {
    const usage = await memberUsage(user.id);
    if (!usage.computer?.canAskForMore) return respond(request, { error: 'Computer time is not used up' }, 409);
    const { request: open, created } = await askForMore(user.id);
    if (created && !(await memberUsage(user.id)).computer?.canAskForMore) {
      // Extra usage landed between the check and the insert: there is room again, so there is nothing to wait for
      await prisma.meterRequest.deleteMany({ where: { id: open.id, answeredAt: null } });
      return respond(request, { error: 'Computer time is not used up' }, 409);
    }
    return respond(request, { asked: true, created, askedAt: open.createdAt.toISOString() }, created ? 201 : 200);
  } catch (error) {
    console.error('[Usage] Ask for more failed:', error instanceof Error ? error.message : 'unknown');
    return respond(request, { error: 'Internal server error' }, 500);
  }
}
