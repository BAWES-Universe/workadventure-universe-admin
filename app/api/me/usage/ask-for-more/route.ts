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
    // No body at all (nothing sent) is the old call (computer time); a body that was sent, even blank, must be a JSON object, with an optional category of apps or computer
    const text = await request.text();
    let body: unknown = {};
    if (text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        return respond(request, { error: 'The body must be JSON' }, 400);
      }
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return respond(request, { error: 'The body must be a JSON object' }, 400);
    const category = (body as { category?: unknown }).category;
    if (category !== undefined && category !== 'apps' && category !== 'computer') return respond(request, { error: 'category must be apps or computer' }, 400);
    const what: AskedFor = category === 'apps' ? 'apps' : 'computer';
    // Three answers, never two: room to ask, "not used up" (there is credit), or "cannot be read" (nothing is known, so nothing is claimed)
    type Standing = 'ask' | 'not_used_up' | 'unreadable';
    const standing = (usage: Awaited<ReturnType<typeof memberUsage>>): Standing => {
      if (what === 'apps') {
        const apps = usage.apps as ({ unavailable?: boolean; canAskForMore?: boolean } | null | undefined);
        if (!apps) return 'not_used_up';
        if (apps.unavailable) return 'unreadable';
        return apps.canAskForMore === true ? 'ask' : 'not_used_up';
      }
      if (usage.computer?.unavailable) return 'unreadable';
      return usage.computer?.canAskForMore === true ? 'ask' : 'not_used_up';
    };
    const used = what === 'apps' ? 'Instant Apps credit is not used up' : 'Computer time is not used up';
    const unreadable = what === 'apps' ? 'Instant Apps credit cannot be read right now, try again in a moment' : 'Computer time cannot be read right now, try again in a moment';
    const before = standing(await memberUsage(user.id));
    if (before === 'unreadable') return respond(request, { error: unreadable }, 503);
    if (before !== 'ask') return respond(request, { error: used }, 409);
    const { request: open, created } = await askForMore(user.id, new Date(), what);
    if (created && standing(await memberUsage(user.id)) === 'not_used_up') {
      // Extra usage landed between the check and the insert: there is room again, so there is nothing to wait for.
      // A part that cannot be read now proves nothing, so the ask made while it could be read stays.
      await prisma.meterRequest.deleteMany({ where: { id: open.id, answeredAt: null } });
      return respond(request, { error: used }, 409);
    }
    return respond(request, { asked: true, created, askedAt: open.createdAt.toISOString() }, created ? 201 : 200);
  } catch (error) {
    console.error('[Usage] Ask for more failed:', error instanceof Error ? error.message : 'unknown');
    return respond(request, { error: 'Internal server error' }, 500);
  }
}
