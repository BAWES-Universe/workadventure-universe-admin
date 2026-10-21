import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { meOriginAllowed, meRespond } from '@/lib/me-route';
import { accessFor, worldsAllowing } from '@/lib/role-access';
import { canSeeUniverse } from '@/lib/room-visibility';
import { memberCan } from '@/lib/member-can';
import { membershipButton } from '@/lib/membership-button';
import { memberInclude } from '@/lib/universe-route';
import { SYSTEM_USER_EMAIL } from '@/lib/system-user';
import { parsePlayUri } from '@/lib/utils';

export const runtime = 'nodejs';

const respond = (request: NextRequest, body: unknown, status = 200) => meRespond(request, body, status, 'GET, OPTIONS');

export async function OPTIONS(request: NextRequest) {
  return respond(request, {}, request.headers.get('origin') && meOriginAllowed(request) ? 204 : 403);
}

const some = (worlds: 'all' | string[]) => worlds === 'all' || worlds.length > 0;

/**
 * GET /api/me/membership-button?roomId=<play address>&userUuid=<their game id> - what the membership button on their
 * card in the game says for you, in the universe of that room: Give membership, Pending invite, Roles or Membership.
 * `button` is null when you may do none of them (no rights, your own card, the owner, someone above your rank, a
 * guest, a universe you cannot see), and for anything Orbit doesn't know, so the card shows no button.
 */
export async function GET(request: NextRequest) {
  if (!meOriginAllowed(request)) return respond(request, { error: 'Origin not allowed' }, 403);
  const viewer = await getSessionUser(request);
  if (!viewer) return respond(request, { error: 'Unauthorized' }, 401);

  const none = () => respond(request, { button: null });
  try {
    const roomId = request.nextUrl.searchParams.get('roomId');
    const userUuid = request.nextUrl.searchParams.get('userUuid');
    if (!roomId || !userUuid || userUuid.length > 256) return none();

    let universeSlug: string;
    try {
      universeSlug = parsePlayUri(roomId).universe;
    } catch {
      return none();
    }
    const [universe, person] = await Promise.all([
      prisma.universe.findUnique({ where: { slug: universeSlug }, select: { id: true, ownerId: true, isPublic: true } }),
      prisma.user.findUnique({ where: { uuid: userUuid }, select: { id: true, isGuest: true, email: true } }),
    ]);
    if (!universe || !person || person.isGuest || person.email === SYSTEM_USER_EMAIL) return none();
    if (person.id === viewer.id || person.id === universe.ownerId) return none();

    const access = await accessFor(prisma, universe.id, viewer);
    // The same rule as every universe route: someone who cannot see the universe gets nothing, not even a hint of it
    if (!access || !canSeeUniverse(universe, viewer, access.inUniverse)) return none();
    const mayInvite = some(worldsAllowing(access, 'INVITE_AND_REMOVE'));
    const mayGiveSomewhere = some(worldsAllowing(access, 'GIVE_ROLES'));
    if (!mayInvite && !mayGiveSomewhere) return none();

    const [member, pending] = await Promise.all([
      prisma.universeMember.findUnique({ where: { universeId_userId: { universeId: universe.id, userId: person.id } }, include: memberInclude }),
      // An invitation sent the old way to one of its worlds counts too
      prisma.membershipInvitation.findFirst({
        where: { invitedUserId: person.id, status: 'pending', OR: [{ universeId: universe.id }, { world: { universeId: universe.id } }] },
        select: { id: true },
      }),
    ]);

    if (!member) return respond(request, { button: membershipButton({ status: pending ? 'invited' : 'none', mayInvite, mayGiveRoles: false, mayRemove: false }) });

    const roles = await prisma.role.findMany({
      where: { universeId: universe.id, key: { notIn: ['member', 'everyone'] } },
      select: { id: true, position: true },
    });
    const can = memberCan({ access, viewerId: viewer.id, userId: person.id, ownerId: universe.ownerId, member, roles });
    return respond(request, { button: membershipButton({ status: 'member', mayInvite, mayGiveRoles: can.giveRoleIds.length > 0, mayRemove: can.remove }) });
  } catch (error) {
    console.error('[MembershipButton] Failed:', error);
    return respond(request, { error: 'Internal server error' }, 500);
  }
}
