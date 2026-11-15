import { NextRequest } from 'next/server';
import { getSessionUser } from '@/lib/auth-session';
import { meOriginAllowed, meRespond } from '@/lib/me-route';
import { prisma } from '@/lib/db';
import { askForMore, type AskedFor } from '@/lib/meter-requests';
import { memberUsage } from '@/lib/meter-usage';

export const runtime = 'nodejs';

const respond = (request: NextRequest, body: unknown, status = 200) => meRespond(request, body, status, 'POST, OPTIONS');

export async function OPTIONS(request: NextRequest) {
  return respond(request, {}, request.headers.get('origin') && meOriginAllowed(request) ? 204 : 403);
}

/**
 * POST /api/me/usage/ask-for-more - "Ask for more" when computer time ran out (game #1999). It is only a request: it shows to the
 * Universe team in Orbit (Costs, and the person's page) and creates no debt and no grant. Asking again while one waits finds it.
 * Only offered when what it is for is used up: this month's computer allowance, or Instant Apps credit. The body may name which,
 * `{ "category": "apps" | "computer" }`; without one it is computer time, as before.
 */
export async function POST(request: NextRequest) {
  if (!meOriginAllowed(request)) return respond(request, { error: 'Origin not allowed' }, 403);
  const user = await getSessionUser(request);
  if (!user) return respond(request, { error: 'Unauthorized' }, 401);
  try {
    const body = (await request.json().catch(() => null)) as { category?: unknown } | null;
    const what: AskedFor = body?.category === 'apps' ? 'apps' : 'computer';
    if (body?.category !== undefined && body.category !== 'apps' && body.category !== 'computer') return respond(request, { error: 'category must be apps or computer' }, 400);
    const canAsk = (usage: Awaited<ReturnType<typeof memberUsage>>) => (what === 'apps' ? !!usage.apps && !('unavailable' in usage.apps && usage.apps.unavailable) && (usage.apps as { canAskForMore?: boolean }).canAskForMore === true : usage.computer?.canAskForMore === true);
    const used = what === 'apps' ? 'Instant Apps credit is not used up' : 'Computer time is not used up';
    const usage = await memberUsage(user.id);
    if (!canAsk(usage)) return respond(request, { error: used }, 409);
    const { request: open, created } = await askForMore(user.id, new Date(), what);
    if (created && !canAsk(await memberUsage(user.id))) {
      // Extra usage landed between the check and the insert: there is room again, so there is nothing to wait for
      await prisma.meterRequest.deleteMany({ where: { id: open.id, answeredAt: null } });
      return respond(request, { error: used }, 409);
    }
    return respond(request, { asked: true, created, askedAt: open.createdAt.toISOString() }, created ? 201 : 200);
  } catch (error) {
    console.error('[Usage] Ask for more failed:', error instanceof Error ? error.message : 'unknown');
    return respond(request, { error: 'Internal server error' }, 500);
  }
}
