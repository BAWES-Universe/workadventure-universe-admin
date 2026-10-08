import { NextRequest } from 'next/server';
import { getSessionUser } from '@/lib/auth-session';
import { meOriginAllowed, meRespond } from '@/lib/me-route';
import { loadPassport } from '@/lib/passport';
import { prisma } from '@/lib/db';
import { SHARING_KEYS, sharePassportFromRows } from '@/lib/people-settings';

export const runtime = 'nodejs';

const respond = (request: NextRequest, body: unknown, status = 200) => meRespond(request, body, status, 'GET, OPTIONS');

export async function OPTIONS(request: NextRequest) {
  return respond(request, {}, request.headers.get('origin') && meOriginAllowed(request) ? 204 : 403);
}

/** GET /api/me/passport - the caller's own passport (every world they have been to) and who they show it to. */
export async function GET(request: NextRequest) {
  if (!meOriginAllowed(request)) return respond(request, { error: 'Origin not allowed' }, 403);
  const user = await getSessionUser(request);
  if (!user) return respond(request, { error: 'Unauthorized' }, 401);
  try {
    const [passport, rows] = await Promise.all([
      loadPassport(user.id, { owner: true }),
      prisma.userPreference.findMany({ where: { userId: user.id, key: { in: [...SHARING_KEYS] } }, select: { key: true, value: true } }),
    ]);
    return respond(request, { passport, audience: sharePassportFromRows(rows) });
  } catch (error) {
    console.error('[Passport] Load failed:', error);
    return respond(request, { error: 'Internal server error' }, 500);
  }
}
