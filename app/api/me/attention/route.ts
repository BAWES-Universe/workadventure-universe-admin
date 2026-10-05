import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { meOriginAllowed, meRespond } from '@/lib/me-route';
import { INVITATIONS_DISMISSED_KEY } from '@/lib/user-preferences';

export const runtime = 'nodejs';

const respond = (request: NextRequest, body: unknown, status = 200) => meRespond(request, body, status, 'GET, OPTIONS');

export async function OPTIONS(request: NextRequest) {
  return respond(request, {}, request.headers.get('origin') && meOriginAllowed(request) ? 204 : 403);
}

/**
 * GET /api/me/attention - how many things wait for the caller's answer, for the count on Orbit's You and the game's
 * Orbit button. Invitations for now: pending ones, less those dismissed on Orbit home. It only goes down when an
 * item is answered or dismissed, never just for being seen.
 */
export async function GET(request: NextRequest) {
  if (!meOriginAllowed(request)) return respond(request, { error: 'Origin not allowed' }, 403);
  const user = await getSessionUser(request);
  if (!user) return respond(request, { error: 'Unauthorized' }, 401);

  try {
    const [pending, dismissed] = await Promise.all([
      prisma.membershipInvitation.findMany({
        where: { invitedUserId: user.id, status: 'pending' },
        select: { id: true },
      }),
      prisma.userPreference.findUnique({
        where: { userId_key: { userId: user.id, key: INVITATIONS_DISMISSED_KEY } },
        select: { value: true },
      }),
    ]);
    const dismissedIds = new Set(dismissedInvitationIds(dismissed?.value));
    const invitations = pending.filter((invitation) => !dismissedIds.has(invitation.id)).length;
    return respond(request, { count: invitations, invitations });
  } catch (error) {
    console.error('[Attention] Count failed:', error);
    return respond(request, { error: 'Internal server error' }, 500);
  }
}

function dismissedInvitationIds(value: unknown): string[] {
  const ids = (value as { ids?: unknown } | null | undefined)?.ids;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
}
