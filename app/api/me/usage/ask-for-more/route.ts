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
 * Only offered when what it is for is used up: this month's computer allowance, Apps (Instant Apps credit, or the person's own monthly
 * allowance for connected Apps), or the person's own monthly speech allowance. The body may name which,
 * `{ "category": "apps" | "computer" | "speech" }`; without one it is computer time, as before. Never for a platform budget.
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
    if (category !== undefined && category !== 'apps' && category !== 'computer' && category !== 'speech') return respond(request, { error: 'category must be apps, computer or speech' }, 400);
    const what: AskedFor = category === 'apps' ? 'apps' : category === 'speech' ? 'speech' : 'computer';
    const canAsk = (usage: Awaited<ReturnType<typeof memberUsage>>) => {
      if (what === 'speech') return usage.speech?.canAskForMore === true;
      if (what === 'apps') {
        // Apps is one word: Instant Apps credit used up, or the person's own allowance for connected Apps used up
        const credit = !!usage.apps && !('unavailable' in usage.apps && usage.apps.unavailable) && (usage.apps as { canAskForMore?: boolean }).canAskForMore === true;
        return credit || usage.appUse?.canAskForMore === true;
      }
      return usage.computer?.canAskForMore === true;
    };
    const used = what === 'speech' ? 'Your speech allowance is not used up' : what === 'apps' ? 'Apps are not used up' : 'Computer time is not used up';
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
