import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { hiddenSystemOwnerId, notSystemWorld } from '@/lib/system-user';
import { accessFor, worldsAllowing } from '@/lib/role-access';
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

    const { universes, friend } = await invitableUniverses(sessionUser, userId, hidden);

    return NextResponse.json({ worlds: availableWorlds, universes, friend });
  } catch (error) {
    console.error('Error fetching worlds:', error);
    return NextResponse.json(
      { error: 'Failed to fetch worlds' },
      { status: 500 }
    );
  }
}


async function invitableUniverses(viewer: { id: string; isSuperAdmin: boolean }, personId: string, hidden: string | null) {
  if (viewer.id === personId) return { universes: [], friend: false };
  const candidates = await prisma.universe.findMany({
    where: {
      ...(hidden ? { ownerId: { not: hidden } } : {}),
      ...(viewer.isSuperAdmin ? {} : { OR: [{ ownerId: viewer.id }, { members: { some: { userId: viewer.id } } }] }),
      NOT: [{ ownerId: personId }, { members: { some: { userId: personId } } }, { membershipInvitations: { some: { invitedUserId: personId, status: 'pending' } } }],
    },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });
  // What the sheet says under their name, as the invite lists do: whether they are your friend, and when they last came
  // into this universe and where
  const [friendship, ...universes] = await Promise.all([
    prisma.friendship.findUnique({ where: { user1Id_user2Id: orderedPair(viewer.id, personId) }, select: { status: true } }),
    ...candidates.map(async (universe) => {
      const access = await accessFor(prisma, universe.id, viewer);
      if (!access) return null;
      const worlds = worldsAllowing(access, 'INVITE_AND_REMOVE');
      if (worlds !== 'all' && worlds.length === 0) return null;
      const visit = await prisma.roomAccess.findFirst({
        where: { universeId: universe.id, userId: personId },
        orderBy: { accessedAt: 'desc' },
        select: { accessedAt: true, room: { select: { name: true } }, world: { select: { name: true } } },
      });
      return {
        ...universe,
        visit: visit ? { at: visit.accessedAt.toISOString(), room: visit.room, world: visit.world } : null,
      };
    }),
  ]);
  return { universes: universes.filter((universe): universe is NonNullable<typeof universe> => !!universe), friend: friendship?.status === 'accepted' };
}
