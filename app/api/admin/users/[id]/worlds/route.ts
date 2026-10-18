import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { hiddenSystemOwnerId, notSystemWorld } from '@/lib/system-user';
import { accessForMany, worldsAllowing } from '@/lib/role-access';
import { orderedPair } from '@/lib/friends';

// GET /api/admin/users/[id]/worlds - Get list of worlds current user can invite this user to, and the universes they can
// invite this user to (the invite sheet's): Invite and remove people somewhere in it, and the person is not in it yet
// and has no invitation waiting.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const sessionUser = await getSessionUser(request);
    if (!sessionUser) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id: userId } = await params;

    // Get all worlds where user is universe owner or world admin, never System's once they are hidden
    const hidden = await hiddenSystemOwnerId();
    const worlds = await prisma.world.findMany({
      where: {
        ...notSystemWorld(hidden),
        OR: [
          {
            universe: {
              ownerId: sessionUser.id,
            },
          },
          {
            members: {
              some: {
                userId: sessionUser.id,
                tags: { has: 'admin' },
              },
            },
          },
        ],
      },
      include: {
        universe: {
          select: {
            id: true,
            name: true,
            slug: true,
          },
        },
        members: {
          where: {
            userId: userId,
          },
        },
      },
    });

    // Filter out worlds where user is already a member
    const availableWorlds = worlds
      .filter(world => world.members.length === 0)
      .map(world => ({
        id: world.id,
        name: world.name,
        slug: world.slug,
        universe: world.universe,
      }));

    const { universes, taken, friend } = await invitableUniverses(sessionUser, userId, hidden);

    return NextResponse.json({ worlds: availableWorlds, universes, taken, friend });
  } catch (error) {
    console.error('Error fetching worlds:', error);
    return NextResponse.json(
      { error: 'Failed to fetch worlds' },
      { status: 500 }
    );
  }
}


async function invitableUniverses(viewer: { id: string; isSuperAdmin: boolean }, personId: string, hidden: string | null) {
  if (viewer.id === personId) return { universes: [], taken: [], friend: false };
  const candidates = await prisma.universe.findMany({
    where: {
      ...(hidden ? { ownerId: { not: hidden } } : {}),
      ...(viewer.isSuperAdmin ? {} : { OR: [{ ownerId: viewer.id }, { members: { some: { userId: viewer.id } } }] }),
    },
    select: {
      id: true,
      name: true,
      ownerId: true,
      members: { where: { userId: personId }, select: { id: true } },
      membershipInvitations: { where: { invitedUserId: personId, status: 'pending' }, select: { id: true } },
    },
    orderBy: { name: 'asc' },
  });
  // What the sheet says under their name, as the invite lists do: whether they are your friend, and when they last came
  // into this universe and where. Access to every candidate comes in one go, and so do the visits of the ones that pass.
  const [friendship, accesses] = await Promise.all([
    prisma.friendship.findUnique({ where: { user1Id_user2Id: orderedPair(viewer.id, personId) }, select: { status: true } }),
    accessForMany(prisma, candidates.map((universe) => universe.id), viewer),
  ]);
  const yours = candidates.filter((universe) => {
    const access = accesses.get(universe.id);
    if (!access) return false;
    const worlds = worldsAllowing(access, 'INVITE_AND_REMOVE');
    return worlds === 'all' || worlds.length > 0;
  });
  // The sheet shows the ones they already belong to or are invited to, so it is clear why they can't be picked.
  const status = (universe: (typeof yours)[number]) =>
    universe.ownerId === personId || universe.members.length > 0 ? 'member' : universe.membershipInvitations.length > 0 ? 'invited' : null;
  const invitable = yours.filter((universe) => !status(universe)).map(({ id, name }) => ({ id, name }));
  const taken = yours.flatMap((universe) => {
    const value = status(universe);
    return value ? [{ id: universe.id, name: universe.name, status: value }] : [];
  });
  // Their latest visit in each of these universes: the newest row of each
  const visits = invitable.length
    ? await prisma.roomAccess.findMany({
        where: { universeId: { in: invitable.map((universe) => universe.id) }, userId: personId },
        orderBy: { accessedAt: 'desc' },
        distinct: ['universeId'],
        select: { universeId: true, accessedAt: true, room: { select: { name: true } }, world: { select: { name: true } } },
      })
    : [];
  const universes = invitable.map((universe) => {
    const visit = visits.find((row) => row.universeId === universe.id);
    return { ...universe, visit: visit ? { at: visit.accessedAt.toISOString(), room: visit.room, world: visit.world } : null };
  });
  return { universes, taken, friend: friendship?.status === 'accepted' };
}
