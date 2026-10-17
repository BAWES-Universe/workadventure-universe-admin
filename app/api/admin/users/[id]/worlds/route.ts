import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { hiddenSystemOwnerId, notSystemWorld } from '@/lib/system-user';
import { accessFor, worldsAllowing } from '@/lib/role-access';

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

    const universes = await invitableUniverses(sessionUser, userId, hidden);

    return NextResponse.json({ worlds: availableWorlds, universes });
  } catch (error) {
    console.error('Error fetching worlds:', error);
    return NextResponse.json(
      { error: 'Failed to fetch worlds' },
      { status: 500 }
    );
  }
}


async function invitableUniverses(viewer: { id: string; isSuperAdmin: boolean }, personId: string, hidden: string | null) {
  if (viewer.id === personId) return [];
  const candidates = await prisma.universe.findMany({
    where: {
      ...(hidden ? { ownerId: { not: hidden } } : {}),
      ...(viewer.isSuperAdmin ? {} : { OR: [{ ownerId: viewer.id }, { members: { some: { userId: viewer.id } } }] }),
      NOT: [{ ownerId: personId }, { members: { some: { userId: personId } } }, { membershipInvitations: { some: { invitedUserId: personId, status: 'pending' } } }],
    },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });
  const universes: { id: string; name: string }[] = [];
  for (const universe of candidates) {
    const access = await accessFor(prisma, universe.id, viewer);
    if (!access) continue;
    const worlds = worldsAllowing(access, 'INVITE_AND_REMOVE');
    if (worlds === 'all' || worlds.length > 0) universes.push(universe);
  }
  return universes;
}
